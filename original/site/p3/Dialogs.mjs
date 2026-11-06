/**
 * P3 对话框层 —— 原版 4 个「同步阻塞式」控件的 HTML 等价物。
 *
 * 之所以要「等价物」而不是自己实现功能：原版 mi()/ei() 是协程，
 *   `const n = await Ls(e,e.length,4,2,235,317); if (255===n) return 1;`
 * 业务顺序、可用条件、参数、结算全在协程里；这里只负责把「选择结果」
 * 按原始取值域返回（下标 / 255 / 数值 / 65535 / 1|0），因此规则零复制。
 *
 * 对应关系：
 *   Ms(idx)        -> showMessage      文本 = lib.getConst(idx)
 *   vs(pid, text)  -> showPersonMessage 文本 = 原版已拼好，附武将名
 *   $r(rect,i,str) -> showList         返回条目下标 或 255
 *   Hs(min,max,k)  -> askValue         返回数值 或 65535，按钮语义与原版一致（确定/最大/取消）
 *   Gs(cityId)     -> showReport       返回 1 确定 / 0 取消
 */
import { UI_IDS } from './config.mjs';

export function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/**
 * 对话框宿主：所有弹窗共用一层遮罩，保证「同时最多一个阻塞式对话框」
 * （原版协程本身也是串行的），并统一处理 Esc / 遮罩点击 / 关闭时清理。
 */
export class DialogHost {
  constructor(layer) {
    if (!layer) throw new TypeError('DialogHost 需要遮罩层元素');
    this.layer = layer;
    this.layer.hidden = true;
    this.openCount = 0;
    this._stack = [];
    this.stats = { opened: 0, cancelled: 0 };
  }

  get busy() { return this.openCount > 0; }

  /**
   * @param {object} spec
   * @param {string} spec.title
   * @param {string} [spec.subtitle]
   * @param {Node[]} [spec.body]
   * @param {Array<{label:string,value:any,variant?:string,disabled?:boolean}>} spec.actions
   * @param {any} spec.cancelValue    Esc / 遮罩点击的返回值
   * @param {boolean} [spec.closable]
   * @param {boolean} [spec.wide]
   * @returns {Promise<any>}
   */
  open(spec) {
    const {
      title, subtitle = '', body = [], actions = [], cancelValue = null,
      closable = true, wide = false, onMount = null,
    } = spec;
    return new Promise((resolve) => {
      const overlay = el('div', 'p3-overlay');
      const card = el('div', `p3-modal${wide ? ' p3-modal-wide' : ''}`);
      card.setAttribute('data-p1-ui-block', '');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');

      const head = el('div', 'p3-modal-head');
      head.append(el('h3', 'p3-modal-title', title));
      if (subtitle) head.append(el('p', 'p3-modal-sub', subtitle));
      card.append(head);

      const content = el('div', 'p3-modal-body');
      for (const node of body) content.append(node);
      card.append(content);

      const foot = el('div', 'p3-modal-foot');
      const buttons = [];
      for (const a of actions) {
        const b = el('button', `p3-btn${a.variant ? ' p3-btn-' + a.variant : ''}`, a.label);
        b.type = 'button';
        b.disabled = !!a.disabled;
        b.addEventListener('click', () => finish(a.value, 'action'));
        foot.append(b);
        buttons.push(b);
      }
      card.append(foot);
      overlay.append(card);

      /** 统一收尾：出栈、解绑、清理 DOM（避免监听器泄漏）。 */
      const finish = (value, why) => {
        const at = this._stack.findIndex((s) => s.overlay === overlay);
        if (at < 0) return;                      // 已关闭，防止重复 resolve
        this._stack.splice(at, 1);
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        this.openCount = Math.max(0, this.openCount - 1);
        if (!this.openCount) this.layer.hidden = true;
        if (why === 'cancel') this.stats.cancelled++;
        resolve(value);
      };

      function onKey(ev) {
        if (!closable) return;
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          finish(cancelValue, 'cancel');
        }
      }

      this._stack.push({ overlay, finish });
      this.layer.append(overlay);
      this.layer.hidden = false;
      this.openCount++;
      this.stats.opened++;
      document.addEventListener('keydown', onKey, true);

      if (closable) {
        overlay.addEventListener('click', (ev) => {
          if (ev.target === overlay) finish(cancelValue, 'cancel');
        });
      }

      if (typeof onMount === 'function') {
        try { onMount({ card, content, buttons, finish }); } catch (_) { /* 视觉细节不影响结果 */ }
      }
      const focusTarget = buttons.find((b) => !b.disabled) || card;
      try { focusTarget.focus({ preventScroll: true }); } catch (_) { /* 忽略 */ }
    });
  }

  /** 关闭所有挂起对话框（会话结束时调用，避免 Promise 永久挂起）。 */
  cancelAll(reason = '会话结束') {
    for (const s of [...this._stack].reverse()) s.finish(null, 'cancel');
    this._stack.length = 0;
    this.layer.hidden = true;
    this.openCount = 0;
    return reason;
  }

  dispose() { this.cancelAll('dispose'); this.layer.replaceChildren(); }
}

/** 段落文本（保留换行）。 */
export function paragraph(text) {
  const p = el('p', 'p3-text');
  p.textContent = String(text ?? '');
  return p;
}

/** 让一个按钮列表成为可点列表（原版 $r 的条目语义）。 */
export function clickList(items, { onPick, columns = 2 } = {}) {
  const wrap = el('div', 'p3-pick-list');
  wrap.style.setProperty('--p3-pick-cols', String(columns));
  items.forEach((item, index) => {
    const b = el('button', 'p3-pick-item');
    b.type = 'button';
    if (item.disabled) b.disabled = true;
    if (item.title) b.title = item.title;
    b.append(el('span', 'p3-pick-label', item.label));
    if (item.note) b.append(el('span', 'p3-pick-note', item.note));
    b.addEventListener('click', () => onPick(index));
    wrap.append(b);
  });
  return wrap;
}

export { UI_IDS };
