/**
 * P1 SceneManager —— 三个场景框架统一注册/切换/生命周期。
 *
 * - 场景实例复用，不重复创建全局 Renderer，也不重复注册全局事件。
 * - 切换路径按 P0 真实流程限定：战略↔城市、战略↔战斗。
 * - exit() 取消该场景的事件订阅；dispose() 释放其资源。
 * - 切换场景不触碰原版 Dn 状态。
 */
import { EVENTS } from './EventManager.mjs';
import { SCENE_IDS, SCENE_TRANSITIONS } from './config.mjs';

export class SceneManager {
  constructor({ events, adapter = null }) {
    this.events = events;
    this.adapter = adapter;
    this._factories = new Map();
    this._instances = new Map();
    this._currentId = null;
    this.stats = { switches: 0, rejected: 0 };
  }

  register(id, factory) {
    if (typeof factory !== 'function') throw new TypeError('场景工厂必须是函数');
    this._factories.set(id, factory);
    return this;
  }

  get currentId() { return this._currentId; }
  get current() { return this._currentId ? this._instances.get(this._currentId) : null; }
  getIds() { return [...this._factories.keys()]; }

  /** 合法切换路径校验：首次进入允许任意场景。 */
  canSwitch(to) {
    if (!this._factories.has(to)) return { ok: false, reason: `未注册场景: ${to}` };
    if (!this._currentId) return { ok: true };
    const allowed = SCENE_TRANSITIONS[this._currentId] || [];
    return allowed.includes(to)
      ? { ok: true }
      : { ok: false, reason: `不允许 ${this._currentId} -> ${to}；允许: ${allowed.join(',') || '无'}` };
  }

  switchTo(id, context = {}) {
    const check = this.canSwitch(id);
    if (!check.ok) { this.stats.rejected++; throw new Error(check.reason); }

    const previous = this.current;
    const from = this._currentId;
    if (previous) previous.exit();

    let instance = this._instances.get(id);
    if (!instance) {
      instance = this._factories.get(id)();
      if (!instance || !instance.scene || typeof instance.enter !== 'function') {
        throw new Error(`场景工厂 ${id} 返回了无效实例`);
      }
      this._instances.set(id, instance);
    }
    instance.enter(context);
    this._currentId = id;
    this.stats.switches++;
    if (this.adapter) this.adapter.setCurrentScene(id);
    this.events.emit(EVENTS.SCENE_CHANGED, { from, to: id, context },
      { dedupeKey: `scene:${from}:${id}:${this.stats.switches}` });
    return instance;
  }

  update(dt) { const s = this.current; if (s) s.update(dt); }
  render(renderManager) { const s = this.current; return s ? s.render(renderManager) : false; }

  /** 销毁全部场景，同时释放其事件订阅与自有资源。 */
  dispose() {
    for (const s of this._instances.values()) s.dispose();
    this._instances.clear();
    this._factories.clear();
    this._currentId = null;
  }
}

export { SCENE_IDS };
