/**
 * P1 EventManager —— 表现层事件总线。
 *
 * 事件来源（P0 结论：原版没有事件系统）：
 *   1) GameAdapter 包装原版输入入口 l.input.waitMsg()，输入完成后做状态 diff；
 *   2) GameAdapter 包装原版已有的 window.__SGBY_CTX 钩子，取得指令上下文；
 *   3) 低频 watchdog diff（兜底，不在渲染循环里）；
 *   4) 表现层 UI 自身的选中/场景切换，由调用方显式 emit。
 *
 * 约束：事件只读不改游戏逻辑；同一状态变化不重复派发；owner 释放后自动取消订阅。
 */

export const EVENTS = Object.freeze({
  GAME_INITIALIZED: 'GAME_INITIALIZED',
  GAME_STATE_UPDATED: 'GAME_STATE_UPDATED',
  CITY_SELECTED: 'CITY_SELECTED',
  CITY_UPDATED: 'CITY_UPDATED',
  CITY_OWNER_CHANGED: 'CITY_OWNER_CHANGED',
  OFFICER_UPDATED: 'OFFICER_UPDATED',
  BATTLE_STARTED: 'BATTLE_STARTED',
  BATTLE_STATE_UPDATED: 'BATTLE_STATE_UPDATED',
  UNIT_SELECTED: 'UNIT_SELECTED',
  UNIT_MOVED: 'UNIT_MOVED',
  UNIT_ATTACKED: 'UNIT_ATTACKED',
  BATTLE_FINISHED: 'BATTLE_FINISHED',
  TURN_CHANGED: 'TURN_CHANGED',
  // P1 附加（真实来源，非虚构）：
  ORDER_CONTEXT_CHANGED: 'ORDER_CONTEXT_CHANGED',   // 原版 window.__SGBY_CTX
  SCENE_CHANGED: 'SCENE_CHANGED',                  // SceneManager
  RENDERER_ERROR: 'RENDERER_ERROR',                // RenderManager
});

const ALL = new Set(Object.values(EVENTS));

export class EventManager {
  constructor() {
    this._handlers = new Map();      // type -> Set<{fn,owner,once}>
    this._owners = new Map();        // owner -> Set<entry>
    this._stats = { emitted: 0, deduped: 0, handlerErrors: 0, subscriptions: 0 };
    this._recent = new Map();        // dedupeKey -> timestamp
    this._dedupeWindowMs = 60;
  }

  /** 返回 unsubscribe 函数；owner 可用于批量释放。 */
  on(type, fn, { owner = null, once = false } = {}) {
    if (!ALL.has(type)) throw new Error(`未知事件类型: ${type}`);
    if (typeof fn !== 'function') throw new TypeError('事件处理器必须是函数');
    let set = this._handlers.get(type);
    if (!set) this._handlers.set(type, set = new Set());
    const entry = { fn, owner, once };
    set.add(entry);
    if (owner) {
      let owned = this._owners.get(owner);
      if (!owned) this._owners.set(owner, owned = new Set());
      owned.add(entry);
    }
    this._stats.subscriptions++;
    return () => this._remove(type, entry);
  }

  once(type, fn, opts = {}) { return this.on(type, fn, { ...opts, once: true }); }

  _remove(type, entry) {
    const set = this._handlers.get(type);
    if (set) { set.delete(entry); if (!set.size) this._handlers.delete(type); }
    if (entry.owner) {
      const owned = this._owners.get(entry.owner);
      if (owned) { owned.delete(entry); if (!owned.size) this._owners.delete(entry.owner); }
    }
  }

  off(type, fn) {
    const set = this._handlers.get(type);
    if (!set) return;
    for (const entry of [...set]) if (entry.fn === fn) this._remove(type, entry);
  }

  /** 释放某个 owner 的全部订阅（场景 dispose 时调用，避免监听器泄漏）。 */
  releaseOwner(owner) {
    const owned = this._owners.get(owner);
    if (!owned) return 0;
    let n = 0;
    for (const entry of [...owned]) {
      for (const [type, set] of this._handlers) if (set.delete(entry)) { if (!set.size) this._handlers.delete(type); break; }
      n++;
    }
    this._owners.delete(owner);
    return n;
  }

  /**
   * 派发。dedupeKey 相同且在时间窗内会被丢弃（防止同一状态变化被多条通道重复处理）。
   */
  emit(type, payload = {}, { dedupeKey = null } = {}) {
    if (!ALL.has(type)) throw new Error(`未知事件类型: ${type}`);
    const now = Date.now();
    if (dedupeKey) {
      const last = this._recent.get(dedupeKey);
      if (last !== undefined && now - last < this._dedupeWindowMs) { this._stats.deduped++; return false; }
      this._recent.set(dedupeKey, now);
      if (this._recent.size > 256) {
        for (const [k, t] of this._recent) if (now - t > 1000) this._recent.delete(k);
      }
    }
    this._stats.emitted++;
    const set = this._handlers.get(type);
    if (!set) return true;
    for (const entry of [...set]) {
      try { entry.fn(Object.freeze({ type, ...payload, at: now })); }
      catch (e) { this._stats.handlerErrors++; console.error(`[P1] 事件处理器异常 ${type}:`, e); }
      if (entry.once) this._remove(type, entry);
    }
    return true;
  }

  getStats() { return { ...this._stats, activeTypes: this._handlers.size, owners: this._owners.size }; }

  dispose() {
    this._handlers.clear();
    this._owners.clear();
    this._recent.clear();
  }
}
