/**
 * P6 UIManager —— 全局 UI 的唯一装配点（弹窗 / 提示 / 致命错误横幅）。
 *
 * 与 UIStack 的分工：
 *   UIStack 决定「输入是否被阻断」（纯逻辑、可测）；
 *   UIManager 负责真正建 DOM、定位层级、收尾清理。
 *
 * 三条硬规则（都是 P3/P4 踩过的坑，这里统一收口）：
 *   1) 根容器 `pointer-events:none`，只有可交互部件 `auto` —— 否则整块遮罩吞掉地图点击；
 *   2) 阻断标记 `data-p1-ui-block` 只挂在真正可见的部件上；
 *   3) 同一个 id 的弹窗不会建第二份 DOM（重复调用返回同一个 Promise）。
 */

import { UI_LAYERS } from './config.mjs';
import { UIStack } from './UIStack.mjs';

export class UIManager {
  constructor({ host = null, input = null, log = () => {} } = {}) {
    this.host = host || (typeof document !== 'undefined' ? document.getElementById('p1-ui') : null);
    this.log = log;
    this.stack = new UIStack({ input, log });
    this._modals = new Map();       // id -> { node, resolve, token, actions }
    this._toasts = [];
    this._fatal = null;
    this.mounted = false;
    this.stats = { modals: 0, toasts: 0, fatals: 0, dismissAll: 0 };
    this.dom = {};
  }

  mount() {
    if (this.mounted || !this.host || typeof document === 'undefined') return this;
    const doc = document;
    const layer = doc.createElement('div');
    layer.id = 'p6-layer';
    layer.className = 'p6-layer';
    layer.style.zIndex = String(UI_LAYERS.DIALOG);
    this.host.append(layer);

    const toast = doc.createElement('div');
    toast.id = 'p6-toast';
    toast.className = 'p6-toast';
    toast.setAttribute('aria-live', 'polite');

    const modal = doc.createElement('div');
    modal.id = 'p6-modal-layer';
    modal.className = 'p6-modal-layer';
    modal.hidden = true;

    const fatal = doc.createElement('div');
    fatal.id = 'p6-fatal';
    fatal.className = 'p6-fatal';
    fatal.hidden = true;
    fatal.style.zIndex = String(UI_LAYERS.ERROR);

    layer.append(toast, modal, fatal);
    this.dom = { layer, toast, modal, fatal };
    this.mounted = true;
    return this;
  }

  // ------------------------------------------------------------------ 提示
  toast(text, kind = 'info', ms = 2600) {
    if (!this.mounted || !this.dom.toast) return null;
    const doc = document;
    const el = doc.createElement('div');
    el.className = `p6-toast-item p6-${kind}`;
    el.textContent = String(text);
    this.dom.toast.append(el);
    this._toasts.push(el);
    while (this._toasts.length > 4) { const old = this._toasts.shift(); old.remove(); }
    this.stats.toasts++;
    if (ms > 0) setTimeout(() => { el.remove(); this._toasts = this._toasts.filter((x) => x !== el); }, ms);
    return el;
  }

  // ------------------------------------------------------------------ 弹窗
  /**
   * @param {object} opts
   * @param {string} opts.id            唯一 id（同 id 复用，不重复建 DOM）
   * @param {string} opts.title
   * @param {string} [opts.subtitle]
   * @param {Node[]} [opts.body]
   * @param {Array<{label:string,value:any,variant?:string}>} [opts.actions]
   * @param {any} [opts.cancelValue]
   * @param {number} [opts.layer]
   * @returns {Promise<any>} 用户选择的值
   */
  openModal({
    id = `modal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title = '', subtitle = '', body = [], actions = [{ label: '关闭', value: true, variant: 'primary' }],
    cancelValue = null, layer = UI_LAYERS.MODAL, blocking = true, owner = null,
  } = {}) {
    if (!this.mounted || !this.dom.modal) {
      // 没有 DOM（Node/极端环境）：直接按取消值解析，绝不让调用方永久 await
      return Promise.resolve(cancelValue);
    }
    if (this._modals.has(id)) return this._modals.get(id).promise;

    const doc = document;
    const token = this.stack.push(id, { layer, blocking, owner });
    const wrap = doc.createElement('div');
    wrap.className = 'p6-modal';
    wrap.dataset.p6UiBlock = '1';
    wrap.style.zIndex = String(layer);

    const card = doc.createElement('div');
    card.className = 'p6-modal-card';
    const h = doc.createElement('h2');
    h.textContent = title;
    card.append(h);
    if (subtitle) {
      const sub = doc.createElement('p');
      sub.className = 'p6-modal-sub';
      sub.textContent = subtitle;
      card.append(sub);
    }
    for (const node of body) if (node) card.append(node);

    let resolveFn = null;
    const promise = new Promise((r) => { resolveFn = r; });
    const entry = { node: wrap, resolve: resolveFn, token, promise, id, closed: false };
    this._modals.set(id, entry);

    const finish = (value) => {
      if (entry.closed) return;
      entry.closed = true;
      this._modals.delete(id);
      this.stack.close(token);
      wrap.remove();
      entry.resolve(value);
    };
    entry.finish = finish;

    const row = doc.createElement('div');
    row.className = 'p6-modal-actions';
    for (const a of actions) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = `p1-btn ${a.variant === 'primary' ? 'p1-btn-primary' : ''}`.trim();
      b.textContent = a.label;
      b.addEventListener('click', () => finish(a.value));
      row.append(b);
    }
    card.append(row);
    wrap.append(card);
    wrap.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.dom.modal.append(wrap);
    this.dom.modal.hidden = false;
    this.stats.modals++;
    return promise;
  }

  async confirm(title, text, { okLabel = '确定', cancelLabel = '取消' } = {}) {
    const doc = document;
    const p = doc.createElement('p');
    p.textContent = text;
    const v = await this.openModal({
      id: `confirm-${title}`,
      title,
      body: [p],
      actions: [
        { label: okLabel, value: true, variant: 'primary' },
        { label: cancelLabel, value: false },
      ],
      cancelValue: false,
    });
    return v === true;
  }

  async alert(title, text) {
    const doc = document;
    const p = doc.createElement('p');
    p.textContent = text;
    await this.openModal({
      id: `alert-${title}`,
      title,
      body: [p],
      actions: [{ label: '知道了', value: true, variant: 'primary' }],
      cancelValue: true,
    });
  }

  /** 关闭所有 P6 弹窗（读档/场景重置/错误恢复）。 */
  dismissAll(reason = 'dismiss') {
    this.stats.dismissAll++;
    for (const entry of [...this._modals.values()]) entry.finish(null);
    this._modals.clear();
    if (this.dom.modal) this.dom.modal.hidden = true;
    this.stack.clear(reason);
  }

  get openCount() { return this._modals.size; }
  get isBlocking() { return this.stack.blocking; }

  // -------------------------------------------------------------- 致命错误
  /**
   * 不可恢复错误：必须明确提示，不允许留一个黑屏让用户猜。
   * 提供「回到战略地图」与「重新加载页面」两条恢复路径。
   */
  showFatal({ title = '运行错误', message = '', actions = [] } = {}) {
    if (!this.mounted || !this.dom.fatal) return null;
    const doc = document;
    const box = this.dom.fatal;
    box.replaceChildren();
    const card = doc.createElement('div');
    card.className = 'p6-fatal-card';
    card.dataset.p6UiBlock = '1';
    const h = doc.createElement('h2');
    h.textContent = title;
    const p = doc.createElement('pre');
    p.className = 'p6-fatal-msg';
    p.textContent = message;
    const row = doc.createElement('div');
    row.className = 'p6-modal-actions';
    for (const a of actions) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'p1-btn';
      b.textContent = a.label;
      b.addEventListener('click', () => { this.hideFatal(); if (typeof a.onClick === 'function') a.onClick(); });
      row.append(b);
    }
    card.append(h, p, row);
    box.append(card);
    box.hidden = false;
    this._fatal = { title, message };
    this.stats.fatals++;
    // 致命错误本身也是阻断层
    this.stack.push('fatal', { layer: UI_LAYERS.ERROR, blocking: true });
    return box;
  }

  hideFatal() {
    if (this.dom.fatal) { this.dom.fatal.hidden = true; this.dom.fatal.replaceChildren(); }
    this.stack.closeId('fatal');
    this._fatal = null;
  }

  get fatalVisible() { return !!(this.dom.fatal && !this.dom.fatal.hidden); }

  getStatus() {
    return {
      mounted: this.mounted,
      modals: this.stats.modals,
      open: this.openCount,
      stack: this.stack.getStats(),
      blocking: this.isBlocking,
      fatal: this.fatalVisible,
      toasts: this._toasts.length,
    };
  }

  dispose() {
    this.dismissAll('dispose');
    this.hideFatal();
    if (this.dom.layer) this.dom.layer.remove();
    this.dom = {};
    this.mounted = false;
  }
}
