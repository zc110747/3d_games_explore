/**
 * P1 InputManager —— 3D 画布输入的统一入口。
 *
 * - 只监听 3D stage 容器；HTML UI（data-p1-ui 下的可交互块）天然不会把点击送到这里。
 * - 弹窗打开时 setUIOpen(true) 双重阻断，点击不穿透。
 * - 指针移动超过阈值才算拖动，拖动结束不触发 click（避免地图拖动误选城市）。
 * - 滚轮只在 3D 画布上 preventDefault，不影响 UI 面板滚动。
 * - 使用 Pointer Events，后续可直接扩展触摸手势。
 */
import { INPUT_CONFIG } from './config.mjs';

const TYPES = new Set(['pointerdown', 'pointermove', 'pointerup', 'click', 'drag', 'wheel', 'keydown', 'keyup']);

export class InputManager {
  constructor({ container, config = INPUT_CONFIG }) {
    if (!container) throw new TypeError('InputManager 需要 3D 容器');
    this.container = container;
    this.config = config;
    this._handlers = new Map();
    this._uiOpen = false;
    this._down = null;
    this._last = null;
    this._dragging = false;
    this.stats = { events: 0, blocked: 0, clicks: 0, drags: 0, wheels: 0 };
    this._bind();
  }

  on(type, fn, { owner = null } = {}) {
    if (!TYPES.has(type)) throw new Error(`未知输入事件: ${type}`);
    let set = this._handlers.get(type);
    if (!set) this._handlers.set(type, set = new Set());
    const entry = { fn, owner };
    set.add(entry);
    return () => { set.delete(entry); if (!set.size) this._handlers.delete(type); };
  }

  _emit(type, payload) {
    const set = this._handlers.get(type);
    if (!set) return;
    for (const entry of [...set]) {
      try { entry.fn(payload); } catch (e) { console.error(`[P1] 输入处理器异常 ${type}:`, e); }
    }
  }

  setUIOpen(open) { this._uiOpen = !!open; }
  get uiOpen() { return this._uiOpen; }

  _blocked(e) {
    if (this._uiOpen) { this.stats.blocked++; return true; }
    // 事件若来自 UI 可交互块（例如覆盖层），不转发给 3D
    const t = e && e.target;
    if (t && typeof t.closest === 'function' && t.closest('[data-p1-ui-block]')) {
      this.stats.blocked++;
      return true;
    }
    return false;
  }

  _local(e) {
    const rect = this.container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return {
      x, y,
      ndcX: rect.width ? (x / rect.width) * 2 - 1 : 0,
      ndcY: rect.height ? -(y / rect.height) * 2 + 1 : 0,
      width: rect.width, height: rect.height,
      clientX: e.clientX, clientY: e.clientY,
      button: e.button, pointerId: e.pointerId,
      originalEvent: e,
    };
  }

  _bind() {
    const c = this.container;
    this._h = {
      down: (e) => {
        if (this._blocked(e)) return;
        this.stats.events++;
        const p = this._local(e);
        this._down = p; this._last = p; this._dragging = false;
        this._emit('pointerdown', p);
      },
      move: (e) => {
        if (this._blocked(e)) return;
        const p = this._local(e);
        this._emit('pointermove', p);
        if (!this._down) return;
        const dx = p.x - this._last.x, dy = p.y - this._last.y;
        const total = Math.hypot(p.x - this._down.x, p.y - this._down.y);
        if (total > this.config.dragThresholdPx) this._dragging = true;
        if (this._dragging) {
          this.stats.drags++;
          this._emit('drag', { ...p, dx, dy, total });
        }
        this._last = p;
      },
      up: (e) => {
        if (this._blocked(e)) return;
        const p = this._local(e);
        const wasDown = this._down;
        this._emit('pointerup', p);
        if (wasDown && !this._dragging && Math.hypot(p.x - wasDown.x, p.y - wasDown.y) <= this.config.dragThresholdPx) {
          this.stats.clicks++;
          this._emit('click', p);
        }
        this._down = null; this._last = null; this._dragging = false;
      },
      cancel: () => { this._down = null; this._last = null; this._dragging = false; },
      wheel: (e) => {
        if (this._blocked(e)) return;
        e.preventDefault();                 // 只作用于 3D 画布
        this.stats.wheels++;
        this._emit('wheel', { ...this._local(e), deltaY: e.deltaY, deltaX: e.deltaX });
      },
      contextmenu: (e) => e.preventDefault(),
      keydown: (e) => {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (this._uiOpen) return;
        this._emit('keydown', { key: e.key, code: e.code, repeat: e.repeat, originalEvent: e });
      },
      keyup: (e) => this._emit('keyup', { key: e.key, code: e.code }),
    };
    c.addEventListener('pointerdown', this._h.down);
    c.addEventListener('pointermove', this._h.move);
    c.addEventListener('pointerup', this._h.up);
    c.addEventListener('pointercancel', this._h.cancel);
    c.addEventListener('wheel', this._h.wheel, { passive: false });
    c.addEventListener('contextmenu', this._h.contextmenu);
    window.addEventListener('keydown', this._h.keydown);
    window.addEventListener('keyup', this._h.keyup);
  }

  getStats() { return { ...this.stats, uiOpen: this._uiOpen, subscriptions: this._handlers.size }; }

  dispose() {
    const c = this.container, h = this._h;
    c.removeEventListener('pointerdown', h.down);
    c.removeEventListener('pointermove', h.move);
    c.removeEventListener('pointerup', h.up);
    c.removeEventListener('pointercancel', h.cancel);
    c.removeEventListener('wheel', h.wheel);
    c.removeEventListener('contextmenu', h.contextmenu);
    window.removeEventListener('keydown', h.keydown);
    window.removeEventListener('keyup', h.keyup);
    this._handlers.clear();
  }
}
