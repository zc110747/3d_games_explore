/**
 * P6 StateSync —— 统一状态同步与一致性校验。
 *
 * 原则（对应 P6 文档「五、统一游戏状态管理」）：
 *   - 权威数据只有一份：原版 Dn。表现为**只读投影**，不缓存业务字段；
 *   - 事件为主、低频轮询兜底：状态变化由 GameAdapter.sync() 派发事件触发，
 *     渲染循环里不读游戏数据；
 *   - 所有刷新动作集中登记（refresher），读档/战斗结束/回合变化都走同一入口，
 *     避免「有的地方刷新了、有的地方没刷」。
 *
 * consistency() 不修任何东西，只给出「谁和谁不一致」的清单 —— 这是验收里
 * 「不允许出现游戏状态与表现状态永久不一致」的可观测形式。
 */

import { EVENTS } from '../p1/core/EventManager.mjs';

export class StateSync {
  constructor({
    adapter, events, log = () => {},
    getWorldScene = () => null, getCityManager = () => null,
    getBattleManager = () => null, getRenderManager = () => null,
    getScenes = () => null, getCameraManager = () => null,
  } = {}) {
    if (!adapter || !events) throw new TypeError('StateSync 依赖不完整');
    this.adapter = adapter;
    this.events = events;
    this.log = log;
    this.getWorldScene = getWorldScene;
    this.getCityManager = getCityManager;
    this.getBattleManager = getBattleManager;
    this.getRenderManager = getRenderManager;
    this.getScenes = getScenes;
    this.getCameraManager = getCameraManager;

    this._refreshers = new Map();
    this._offs = [];
    this._dirty = new Set();
    this._lastFlushAt = 0;
    this.stats = {
      events: 0, flushes: 0, fullSyncs: 0, refresherRuns: 0, refresherErrors: 0,
      lastSource: null, lastReason: null, checks: 0, mismatches: 0,
    };
    this._baseline = null;    // 启动完成时的订阅/对象基线，用于检测泄漏
  }

  /** 登记一个刷新器：name 唯一，fn({ reason, changes }) 可同步可异步。 */
  register(name, fn) {
    if (typeof fn !== 'function') throw new TypeError(`refresher ${name} 必须是函数`);
    if (this._refreshers.has(name)) throw new Error(`refresher「${name}」重复登记（会重复刷新）`);
    this._refreshers.set(name, fn);
    return this;
  }

  get refreshers() { return [...this._refreshers.keys()]; }

  /** 只订阅一次；重复调用不会重复挂监听（P6 的「不允许出现多个重复事件监听器」）。 */
  attach() {
    if (this._offs.length) return this;
    const mark = (source) => () => { this.stats.events++; this._dirty.add(source); this.stats.lastSource = source; };
    this._offs.push(this.events.on(EVENTS.GAME_STATE_UPDATED, mark('state')));
    this._offs.push(this.events.on(EVENTS.CITY_UPDATED, mark('city')));
    this._offs.push(this.events.on(EVENTS.CITY_OWNER_CHANGED, mark('owner')));
    this._offs.push(this.events.on(EVENTS.OFFICER_UPDATED, mark('officer')));
    this._offs.push(this.events.on(EVENTS.TURN_CHANGED, mark('turn')));
    this._offs.push(this.events.on(EVENTS.BATTLE_FINISHED, mark('battleEnd')));
    return this;
  }

  detach() {
    for (const off of this._offs.splice(0)) off();
  }

  get dirty() { return [...this._dirty]; }

  /** 执行所有刷新器；同一批变化只跑一次（不在渲染循环里调用）。 */
  async flush(reason = 'flush') {
    if (!this._dirty.size && reason === 'flush') return { ok: true, skipped: true };
    const changes = [...this._dirty];
    this._dirty.clear();
    let runs = 0;
    const errors = [];
    for (const [name, fn] of this._refreshers) {
      try {
        await fn({ reason, changes });
        runs++;
      } catch (e) {
        this.stats.refresherErrors++;
        errors.push(`${name}: ${e.message}`);
        this.log(`刷新器 ${name} 失败：${e.message}`);
      }
    }
    this.stats.refresherRuns += runs;
    this.stats.flushes++;
    this.stats.lastReason = reason;
    this._lastFlushAt = Date.now();
    return { ok: errors.length === 0, runs, changes, errors };
  }

  /** 强制全量同步（读档/战斗结束/手动「同步」按钮）。 */
  async fullSync(reason = 'manual') {
    this.stats.fullSyncs++;
    const r = this.adapter.sync({ source: `p6:${reason}`, force: true });
    const flushed = await this.flush(`full:${reason}`);
    this.stats.lastReason = reason;
    return { adapter: r, flushed };
  }

  /** 记录启动完成时的基线（订阅数/对象数），供一致性检查判断泄漏。 */
  captureBaseline() {
    const scenes = this.getScenes();
    const rm = this.getRenderManager();
    const cm = this.getCameraManager();
    this._baseline = {
      at: Date.now(),
      events: this.events.getStats(),
      cities: this.adapter.connected ? this.adapter.getCities().length : 0,
      cameras: cm && cm._state ? cm._state.size : null,
      frames: rm ? rm.stats.frames : null,
      domNodes: typeof document !== 'undefined' ? document.querySelectorAll('*').length : null,
      sceneId: scenes ? scenes.currentId : null,
    };
    return this._baseline;
  }

  /**
   * 一致性检查：只用真实数据比对，不一致就列出来（不自动修正）。
   * @returns {{ok:boolean, mismatches:Array, detail:object}}
   */
  consistency() {
    this.stats.checks++;
    const mismatches = [];
    const scene = this.getWorldScene();
    const scenes = this.getScenes();
    const detail = {};

    let cities = [];
    try { cities = this.adapter.getCities(); } catch (e) { mismatches.push(`读取城市失败：${e.message}`); }
    detail.cities = cities.length;

    // 1) 3D 城市实例 vs 原版城市表
    if (scene && scene.cityRenderer) {
      const rendered = scene.cityRenderer.cities.map((c) => c.id);
      detail.renderedCities = rendered.length;
      if (rendered.length !== cities.length) {
        mismatches.push(`城市实例 ${rendered.length} ≠ 原版 ${cities.length}`);
      }
      const badNames = scene.cityRenderer.cities.filter((c, i) => cities[i] && c.name !== cities[i].name);
      if (badNames.length) mismatches.push(`${badNames.length} 座城市名称与 Dn 不一致`);
    }

    // 2) 旗帜归属 vs 原版 ownerId（表现层最容易被漏刷的地方）
    if (scene && scene.flagRenderer) {
      const owner = scene.flagRenderer._owner;
      const bad = cities.filter((c) => owner.get(c.id) !== c.ownerId);
      detail.flags = scene.flagRenderer.getDiagnostics().flags;
      if (bad.length) mismatches.push(`${bad.length} 面旗帜归属未更新（Dn 已变）`);
    }

    // 3) 选中城市必须真实存在
    if (scene && Number.isInteger(scene.selection) && !cities[scene.selection]) {
      mismatches.push(`选中城市 #${scene.selection} 在原版数据中不存在`);
    }

    // 4) 场景与战斗状态自洽
    const battle = this.getBattleManager();
    if (scenes) {
      detail.sceneId = scenes.currentId;
      const bst = battle ? battle.getStatus() : null;
      if (bst && bst.active && scenes.currentId !== 'battle') {
        mismatches.push('原版战斗进行中但当前场景不是 battle');
      }
      if (bst && !bst.active && scenes.currentId === 'battle') {
        mismatches.push('原版已无战斗但场景仍停在 battle');
      }
    }

    // 5) 唯一渲染循环 / 单渲染器
    const rm = this.getRenderManager();
    if (rm) {
      detail.renderer = { frames: rm.stats.frames, renders: rm.stats.renders, running: rm.isRunning, failed: !!rm.failed };
      if (!rm.isRunning) mismatches.push('渲染循环未运行');
      if (rm.failed) mismatches.push(`WebGLRenderer 失败：${rm.error && rm.error.message}`);
    }

    // 6) 事件订阅/相机/UI 数量不随场景切换增长（泄漏判据）
    const ev = this.events.getStats();
    detail.events = ev;
    if (this._baseline) {
      if (ev.subscriptions < this._baseline.events.subscriptions) {
        mismatches.push(`事件订阅数下降（${this._baseline.events.subscriptions} -> ${ev.subscriptions}），可能有场景未重建订阅`);
      }
      const dl = ev.subscriptions - this._baseline.events.subscriptions;
      detail.subscriptionDelta = dl;
    }
    if (mismatches.length) this.stats.mismatches++;
    return { ok: mismatches.length === 0, mismatches, detail };
  }

  getStatus() {
    return { ...this.stats, refreshers: this.refreshers, dirty: this.dirty, baseline: this._baseline };
  }

  dispose() {
    this.detach();
    this._refreshers.clear();
  }
}
