/**
 * P6 SceneDirector —— 场景切换的唯一编排点。
 *
 * 完成 P6 文档「四、统一场景管理」的三条流程，并把 P1~P5 里散落的切换动作收敛到一处：
 *
 *   流程 A  战略地图 -> 城市管理 -> 战略地图
 *     城市管理是 P3 的 HTML 覆盖层（cityIsOverlay=true），**不切换 Three 场景**：
 *     原版 ka() 的生命周期本来就横跨「选城 -> 菜单 -> 指令 -> 回选城」，
 *     把它做成独立场景会切断原版协程。这里只登记覆盖层开关并保存/恢复地图状态。
 *
 *   流程 B  战略地图 -> 战斗
 *     切场景前先把战略地图的「表现状态」（选中城市 / 相机 target+zoom / 面板）存档，
 *     因为 BaseScene.exit() 会取消订阅，但不会保存任何视图状态。
 *
 *   流程 C  战斗 -> 战略地图
 *     战斗结束后不是简单切回：必须按最新 Dn 全量重建（城市归属/旗帜/武将可能已变），
 *     再把 B 步骤存下的表现状态恢复回来。恢复只动相机与选中高亮，不改任何游戏数据。
 *
 * 另外两件事：
 *   - 切换锁：切换过程中再次请求直接拒绝（用户快速连点 / 事件重入）；
 *   - 循环检测：1 秒内同一目标切超过配置次数即判定为「无限循环切换」，抛错并留痕。
 */

import { RUNTIME } from './config.mjs';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class SceneDirector {
  constructor({
    scenes, adapter, events, uiStack = null, presentation = null,
    getWorldScene = () => null, getCamera = () => null, cameraManager = null, worldCamera = null,
    getCitySession = () => null, log = () => {},
  }) {
    if (!scenes || !adapter) throw new TypeError('SceneDirector 依赖不完整');
    this.scenes = scenes;
    this.adapter = adapter;
    this.events = events;
    this.uiStack = uiStack;
    this.presentation = presentation;
    this.getWorldScene = getWorldScene;
    this.getCamera = getCamera;
    this.cameraManager = cameraManager;
    this.worldCamera = worldCamera;
    this.getCitySession = getCitySession;
    this.log = log;

    this._switching = false;
    this._internal = 0;              // >0 表示切换由本模块发起（SCENE_CHANGED 回调需跳过）
    this._recent = [];               // [{ to, at }]
    this._worldState = null;         // 进入战斗/城市前保存的战略地图表现状态
    this._cityOverlay = null;        // { cityId, openedAt }
    this.stats = {
      transitions: 0, rejected: 0, loops: 0, restores: 0, cityOpens: 0, cityCloses: 0,
      battleEnters: 0, battleExits: 0, resyncs: 0, lastReason: null, lastFrom: null, lastTo: null,
    };
  }

  // ------------------------------------------------------------- 状态快照
  /** 战略地图的**表现**状态（不含任何游戏数据）。 */
  captureWorldState(why = 'capture') {
    const scene = this.getWorldScene();
    const cam = this.getCamera() || (scene ? scene.camera : null);
    if (!cam) return null;
    const cs = this.cameraManager ? this.cameraManager.getState(cam) : null;
    const state = {
      why,
      at: now(),
      selection: scene && Number.isInteger(scene.selection) ? scene.selection : null,
      camera: cs ? { target: [...cs.target], zoom: cs.zoom } : null,
      sceneId: this.scenes.currentId,
    };
    this._worldState = state;
    return state;
  }

  /** 恢复相机与选中高亮。只还原视图，不碰 Dn。 */
  restoreWorldState(state = this._worldState) {
    if (!state) return { ok: false, reason: '没有可恢复的战略地图状态' };
    const scene = this.getWorldScene();
    const cam = this.getCamera() || (scene ? scene.camera : null);
    let camera = false;
    if (cam && state.camera && this.cameraManager && typeof this.cameraManager.setView === 'function') {
      camera = this.cameraManager.setView(cam, state.camera);
    }
    let selection = false;
    if (scene && Number.isInteger(state.selection) && typeof scene.setSelection === 'function') {
      // 选中只做高亮；若该城在读档后已不存在（越界）就跳过，绝不造一个假选中
      if (state.selection < this.adapter.getCities().length) {
        scene.setSelection(state.selection);
        selection = true;
      }
    }
    this.stats.restores++;
    return { ok: true, camera, selection, state };
  }

  // ------------------------------------------------------------- 准入与防重
  _checkLoop(to) {
    const t = now();
    this._recent = this._recent.filter((r) => t - r.at <= RUNTIME.switchWindowMs);
    const same = this._recent.filter((r) => r.to === to).length;
    if (same >= RUNTIME.maxSameTargetSwitches) {
      this.stats.loops++;
      throw new Error(`疑似无限循环切换：${RUNTIME.switchWindowMs}ms 内切到 ${to} ${same + 1} 次，已拒绝`);
    }
    this._recent.push({ to, at: t });
  }

  /** 所有切换的唯一入口：带锁、带规则、带统计。 */
  switchTo(to, context = {}) {
    if (this._switching) {
      this.stats.rejected++;
      this.log(`场景切换被拒绝（上一次切换尚未完成）：-> ${to}`);
      return { ok: false, reason: '上一次场景切换尚未完成', currentId: this.scenes.currentId };
    }
    this._switching = true;
    const from = this.scenes.currentId;
    try {
      this._checkLoop(to);
      const check = this.scenes.canSwitch(to);
      if (!check.ok) {
        this.stats.rejected++;
        throw new Error(check.reason);
      }
      // 切换前先落一份表现状态：exit() 只取消订阅，不会替我们保存视图
      if (from === 'world') this.captureWorldState(`离开 world -> ${to}`);
      this._internal++;
      let instance;
      try {
        instance = this.scenes.switchTo(to, { ...context, via: 'SceneDirector' });
      } finally {
        this._internal--;
      }
      this.stats.transitions++;
      // SCENE_CHANGED 由 SceneManager 同步派发；_internal>0 时 noteSceneChange 会自动跳过，
      // 所以这里显式补一次，保证「无论从哪条路径切过来」的统计与恢复完全一致。
      this._applyTransition(from, to, context.reason || '');
      return { ok: true, from, to, instance };
    } finally {
      this._switching = false;
    }
  }

  /**
   * 统一处理一次已发生的场景变化（无论由本模块、P1 测试入口还是 P4 boot 触发）。
   * 幂等：同一 (from,to) 重复通知不会重复恢复/重复统计。
   */
  _applyTransition(from, to, reason) {
    this.stats.lastFrom = from;
    this.stats.lastTo = to;
    this.stats.lastReason = reason || '';
    if (from === to) return;
    if (from === 'world' && to === 'battle') {
      this.stats.battleEnters++;
      if (!this._worldState) this.captureWorldState('进入战斗前');
      // 进战斗时 P6 自己的弹窗必须收起（战斗输入不能被动遮挡）
      if (this.uiStack) this.uiStack.closeOwner('p6-battle');
    } else if (from === 'battle' && to === 'world') {
      this.stats.battleExits++;
      this.restoreWorldState();
      // 数据重建放到微任务：此时 P4 的 onExit 还没走完（事件是同步派发的）
      const run = () => this.resyncWorld('战斗结束');
      if (typeof queueMicrotask === 'function') queueMicrotask(run); else setTimeout(run, 0);
      this.captureWorldState('战斗结束回到战略地图');
    }
  }

  /** 由 boot 订阅 SCENE_CHANGED 调用；本模块自己发起时跳过（已在 switchTo 里处理）。 */
  noteSceneChange(from, to, reason = '') {
    if (this._internal > 0) return { skipped: true, internal: true };
    this._applyTransition(from, to, reason);
    return { skipped: false };
  }

  // ------------------------------------------------------------- 流程 A：城市覆盖层
  /**
   * 城市管理是覆盖层：只登记，不切场景。真正的开启/关闭由原版 ka()/ei() 驱动，
   * 这里保存地图状态以便关闭后恢复（例如玩家在城市里点过别的城）。
   */
  openCityOverlay(cityId) {
    if (this.scenes.currentId !== 'world') {
      return { ok: false, reason: `当前场景 ${this.scenes.currentId} 不能打开城市管理` };
    }
    if (this._cityOverlay) return { ok: true, already: true, cityId: this._cityOverlay.cityId };
    this.captureWorldState('打开城市管理前');
    this._cityOverlay = { cityId, openedAt: now() };
    this.stats.cityOpens++;
    return { ok: true, cityId };
  }

  closeCityOverlay(reason = 'close') {
    if (!this._cityOverlay) return { ok: true, already: true };
    const cityId = this._cityOverlay.cityId;
    this._cityOverlay = null;
    this.stats.cityCloses++;
    this.log(`城市管理覆盖层关闭：城 #${cityId}（${reason}）`);
    return { ok: true, cityId };
  }

  get cityOverlay() { return this._cityOverlay; }

  // ------------------------------------------------------------- 流程 B/C：战斗
  enterBattle(context = {}) {
    return this.switchTo('battle', { reason: context.reason || '原版进入战斗' });
  }

  exitBattle(context = {}) {
    // 先按最新 Dn 重建世界，再切场景，避免「先显示旧数据再刷新」的闪动
    const resync = this.resyncWorld('战斗结束');
    const res = this.switchTo('world', { reason: context.reason || '原版战斗结束' });
    return { ...res, resync };
  }

  // ------------------------------------------------------------- 数据重建
  /**
   * 按最新 Dn 全量刷新战略地图表现（城市归属/旗帜/道路/选中）。
   * 读档与战斗结束都必须走这里 —— 这是「不存在第二个权威数据源」的落地点。
   */
  resyncWorld(reason = 'resync') {
    const scene = this.getWorldScene();
    let cities = 0;
    let flags = 0;
    try {
      const list = this.adapter.getCities();
      if (scene && scene.cityRenderer) {
        for (const c of list) { if (scene.refreshCity(c.id)) cities++; }
      }
      if (scene && scene.flagRenderer) {
        scene.flagRenderer.syncAll();
        flags = scene.flagRenderer.getDiagnostics().flags;
      }
      // 选中若已失效（城市数量/ID 变化）就清掉，不留一个指向不存在城市的高亮
      if (scene && Number.isInteger(scene.selection) && scene.selection >= list.length) {
        scene.setSelection(null);
      }
      this.stats.resyncs++;
      return { ok: true, cities, flags, reason };
    } catch (e) {
      this.log(`战略地图重建失败（${reason}）：${e.message}`);
      return { ok: false, error: e.message, reason };
    }
  }

  /** 读档成功后的表现层重建：UI 栈清空 -> 强制同步 -> 世界重建 -> 恢复视图。 */
  afterLoad({ slot, reason } = {}) {
    const cleared = this.uiStack ? this.uiStack.clear(`读档 #${(slot ?? 0) + 1}`) : 0;
    this.closeCityOverlay('读档');
    const resync = this.resyncWorld(`读档 #${(slot ?? 0) + 1}`);
    // 读档后场景必须是战略地图（原版 oc() 不会切场景，这里保证表现层一致）
    let scene = { ok: true, already: true };
    if (this.scenes.currentId !== 'world') {
      scene = this.switchTo('world', { reason: `读档后回到战略地图（${reason || 'load'}）` });
    }
    const state = this.presentation ? this.presentation.get() : null;
    const restore = state && state.camera
      ? this.restoreWorldState({ camera: { target: [state.camera.x, 0, state.camera.z], zoom: state.camera.zoom }, selection: null })
      : null;
    this.log(`读档后重建完成：清空 UI ${cleared} 层，城市 ${resync.cities} 座，旗帜 ${resync.flags} 面`);
    return { ok: true, cleared, resync, scene, restore };
  }

  getStatus() {
    return {
      ...this.stats,
      currentId: this.scenes.currentId,
      switching: this._switching,
      cityOverlay: this._cityOverlay,
      worldState: this._worldState
        ? {
          selection: this._worldState.selection,
          camera: this._worldState.camera,
          why: this._worldState.why,
        }
        : null,
      transitionsById: this.scenes.stats,
    };
  }
}
