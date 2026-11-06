/**
 * P5 BattleActionUI —— 战斗操作界面（HTML/CSS，不参与 3D 拾取）。
 *
 * 原则（P5 §10）：
 *   - 菜单条目文本**直接来自原版**（$r 的实参，即 Ao()/Go()/Ro() 传进来的字符串），
 *     本模块只负责排版与点击，不增删条目、不改取值；
 *   - 按钮的可用性跟随即时状态（来自 BattleFlowController），
 *     但它不是业务规则的最终判断者：点了也只是把原版输入协议投递出去；
 *   - 所有交互区域带 data-p1-ui-block，点击不会穿透到 3D 场景。
 */
import { el } from '../p3/Dialogs.mjs';
import { PHASES, HINTS } from './config.mjs';

export class BattleActionUI {
  constructor({ host, log = () => {} }) {
    this.host = host;
    this.log = log;
    this.dom = null;
    this.logs = [];
    this.phase = PHASES.IDLE;
    this.inputOpen = false;
    this._menu = null;           // { resolve, node }
    this._bannerTimer = null;
    this._resultNode = null;
    this._floatCount = 0;
    this.stats = { menus: 0, floats: 0, banners: 0, logs: 0, results: 0 };
  }

  mount() {
    if (this.dom) return this;
    const root = el('div', 'p5-ui');
    root.id = 'p5-battle-ui';
    root.hidden = true;

    const top = el('div', 'p5-top');
    const phaseChip = el('span', 'p5-phase', '待命');
    const hint = el('span', 'p5-hint', '');
    top.append(phaseChip, hint);

    const banner = el('div', 'p5-banner');
    banner.hidden = true;

    const actions = el('div', 'p5-actions');
    actions.setAttribute('data-p1-ui-block', '');

    const logBox = el('div', 'p5-log');
    logBox.id = 'p5-battle-log';

    const floats = el('div', 'p5-floats');

    root.append(top, banner, logBox, actions, floats);
    this.host.append(root);
    this.dom = { root, top, phaseChip, hint, banner, actions, logBox, floats };
    return this;
  }

  show() { if (!this.dom) this.mount(); this.dom.root.hidden = false; return this; }
  hide() { if (this.dom) this.dom.root.hidden = true; return this; }
  get isMounted() { return !!this.dom; }
  get menuOpen() { return !!this._menu; }

  // -------------------------------------------------------------- 状态显示
  setPhase(phase, detail = {}) {
    if (!this.dom) this.mount();
    this.phase = phase;
    this.dom.phaseChip.textContent = phaseLabel(phase);
    this.dom.phaseChip.dataset.phase = phase;
    this.dom.hint.textContent = HINTS[phase] || '';
    this.dom.hint.title = HINTS[phase] || '';   // 窄屏会被省略号截断，悬停看全文
    this._renderActions(detail);
  }

  setInputOpen(open) {
    const next = !!open;
    const changed = next !== this.inputOpen;
    this.inputOpen = next;
    if (this.dom) this.dom.root.dataset.input = next ? 'open' : 'closed';
    // 按钮可用性依赖「原版是否正在等待输入」，所以输入开关变化时必须重画操作条
    if (changed) this._renderActions();
  }

  /** 战斗结束后：只保留战果面板，收起提示/日志/按钮。 */
  setPostBattle(on) {
    if (!this.dom) return;
    const v = !!on;
    this.dom.top.hidden = v;
    this.dom.logBox.hidden = v;
    this.dom.actions.hidden = v;
    this.dom.banner.hidden = true;
    this.dom.root.dataset.post = v ? 'battle' : '';
  }

  /** 底部操作条：只放「等同于原版按键」的按钮，不放任何业务动词。 */
  _renderActions(detail = {}) {
    if (!this.dom) return;
    const bar = this.dom.actions;
    const buttons = [];
    const mk = (label, title, onClick, disabled = false) => {
      const b = el('button', 'p5-btn', label);
      b.type = 'button';
      b.title = title || label;
      b.disabled = !!disabled;
      if (!disabled) b.addEventListener('click', onClick);
      return b;
    };
    if (this.phase === PHASES.SELECT) {
      buttons.push(mk('战斗菜单', '等价于原版 Esc：打开 Go() 菜单（回合结束 / 全军撤退…）',
        () => this._emit('menu'), !this.inputOpen));
    } else if (this.phase === PHASES.UNIT_SELECTED) {
      buttons.push(mk('取消移动', '等价于原版 Esc：vo() 放弃本次移动', () => this._emit('cancel'), !this.inputOpen));
    } else if (this.phase === PHASES.ATTACK_PREVIEW) {
      buttons.push(mk('取消', '等价于原版 Esc：xo() 返回行动菜单', () => this._emit('cancel'), !this.inputOpen));
    } else if (this.phase === PHASES.MOVEMENT_ANIMATING || this.phase === PHASES.ATTACK_ANIMATING) {
      const b = mk('动画播放中…', '表现层动画进行中，输入已锁定', () => {}, true);
      buttons.push(b);
    }
    if (!buttons.length) {
      bar.hidden = true;
      bar.replaceChildren();
      return;
    }
    bar.hidden = false;
    bar.replaceChildren(...buttons);
    void detail;
  }

  /** 由 boot 注入的回调（controller），避免 UI 直接依赖 controller 造成循环引用。 */
  bind({ onCancel = null, onMenu = null } = {}) {
    this._onCancel = onCancel;
    this._onMenu = onMenu;
    return this;
  }

  _emit(kind) {
    try {
      if (kind === 'cancel' && this._onCancel) this._onCancel();
      if (kind === 'menu' && this._onMenu) this._onMenu();
    } catch (e) { this.log(`UI 操作失败：${e.message}`); }
  }

  // -------------------------------------------------------------- 菜单
  /**
   * 显示原版 $r() 菜单。resolve 值必须是原版取值域：条目下标或 255。
   * 场景退出/战斗结束时 closeMenu() 会被调用，保证协程不会永久等待。
   */
  chooseMenu({ kind = 'generic', title = '选择', labels = [], hints = null, startIndex = 0, allowCancel = true }) {
    if (!this.dom) this.mount();
    this.closeMenu(255, 'superseded');
    this.stats.menus++;
    return new Promise((resolve) => {
      const overlay = el('div', 'p5-menu-wrap');
      overlay.setAttribute('data-p1-ui-block', '');
      const card = el('div', 'p5-menu');
      card.append(el('h3', 'p5-menu-title', title));
      if (kind === 'battle') card.append(el('p', 'p5-menu-note', '条目与原版 Go() 菜单一致；不影响任何战斗规则'));
      if (kind === 'action') card.append(el('p', 'p5-menu-note', '条目与原版 Ao() 菜单一致（战斗效果由原版 Fo() 结算）'));
      const list = el('div', 'p5-menu-list');
      labels.forEach((label, i) => {
        const b = el('button', 'p5-menu-item', label);
        b.type = 'button';
        if (i === startIndex) b.classList.add('is-current');
        if (hints && hints[i]) b.title = hints[i];
        b.addEventListener('click', () => this.closeMenu(i, 'picked'));
        list.append(b);
      });
      card.append(list);
      if (allowCancel) {
        const c = el('button', 'p5-menu-cancel', '取消 (Esc)');
        c.type = 'button';
        c.title = '等价于原版 Esc：$r() 返回 255';
        c.addEventListener('click', () => this.closeMenu(255, 'cancel'));
        card.append(c);
      }
      overlay.append(card);
      this.dom.root.append(overlay);
      // 打开菜单时把 3D 输入彻底阻断，避免点穿到地图
      this.dom.root.dataset.menu = 'open';
      this._menu = { resolve, node: overlay, kind };
      const first = list.querySelector('.is-current') || list.firstElementChild;
      if (first) first.focus();
    });
  }

  closeMenu(value = 255, reason = 'close') {
    const m = this._menu;
    if (!m) return false;
    this._menu = null;
    if (m.node && m.node.parentNode) m.node.parentNode.removeChild(m.node);
    if (this.dom) delete this.dom.root.dataset.menu;
    m.resolve(Number.isInteger(value) ? value : 255);
    this.log(`菜单关闭（${reason} -> ${value}）`);
    return true;
  }

  // -------------------------------------------------------------- 横幅 / 飘字
  showBanner({ title, subtitle = '', tone = 'info', seconds = 1.1 }) {
    if (!this.dom) this.mount();
    this.stats.banners++;
    const b = this.dom.banner;
    b.className = `p5-banner tone-${tone}`;
    b.replaceChildren(
      el('strong', null, title),
      subtitle ? el('span', null, subtitle) : el('span', null, ''),
    );
    b.hidden = false;
    b.classList.add('is-in');
    if (this._bannerTimer) clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => {
      this._bannerTimer = null;
      b.classList.remove('is-in');
      b.hidden = true;
    }, Math.max(300, seconds * 1000));
  }

  floatText(x, y, text, tone = 'damage') {
    if (!this.dom || !text) return false;
    if (this._floatCount > 24) return false;
    this.stats.floats++;
    this._floatCount++;
    const node = el('div', `p5-float tone-${tone}`, text);
    node.style.left = `${Math.round(x)}px`;
    node.style.top = `${Math.round(y)}px`;
    node.addEventListener('animationend', () => {
      this._floatCount--;
      if (node.parentNode) node.parentNode.removeChild(node);
    });
    this.dom.floats.append(node);
    setTimeout(() => {          // 兜底清理（animationend 可能被节流吞掉）
      if (node.parentNode) {
        node.parentNode.removeChild(node);
        this._floatCount = Math.max(0, this._floatCount - 1);
      }
    }, 2200);
    return true;
  }

  // -------------------------------------------------------------- 战报
  pushLog(text, tone = 'info') {
    this.logs.push({ text, tone, at: Date.now() });
    if (this.logs.length > 60) this.logs.shift();
    this.stats.logs++;
    if (!this.dom) return;
    const box = this.dom.logBox;
    box.replaceChildren();
    for (const item of this.logs.slice(-9)) {
      box.append(el('div', `p5-log-line tone-${item.tone}`, item.text));
    }
  }

  /** 战果面板：只在原版已判定 g_FgtOver 后调用；数值全部来自原版状态。 */
  showResult({ meaning, lines = [], autoCloseMs = 9000, onClose = null }) {
    if (!this.dom) this.mount();
    this.stats.results++;
    this.closeResult();
    const wrap = el('div', 'p5-result-wrap');
    wrap.setAttribute('data-p1-ui-block', '');
    const card = el('div', `p5-result tone-${meaning === 'win' ? 'win' : 'lose'}`);
    card.append(el('h2', null, meaning === 'win' ? '我军胜利' : meaning === 'lose' ? '我军败退' : '战斗结束'));
    card.append(el('p', 'p5-result-note', '胜负来自原版 Dn.g_FgtOver（1=我军胜 / 2=我军败），本面板不参与判定'));
    const list = el('div', 'p5-result-lines');
    for (const line of lines) list.append(el('div', 'p5-result-line', line));
    card.append(list);
    const btn = el('button', 'p5-btn', '关闭');
    btn.type = 'button';
    btn.addEventListener('click', () => { this.closeResult(); if (onClose) onClose(); });
    card.append(btn);
    wrap.append(card);
    this.dom.root.append(wrap);
    this._resultNode = wrap;
    if (autoCloseMs > 0) {
      this._resultTimer = setTimeout(() => {
        this.closeResult();
        if (onClose) onClose();
      }, autoCloseMs);
    }
  }

  closeResult() {
    if (this._resultTimer) { clearTimeout(this._resultTimer); this._resultTimer = null; }
    if (this._resultNode && this._resultNode.parentNode) this._resultNode.parentNode.removeChild(this._resultNode);
    this._resultNode = null;
  }

  dispose() {
    this.closeMenu(255, 'dispose');
    this.closeResult();
    if (this._bannerTimer) { clearTimeout(this._bannerTimer); this._bannerTimer = null; }
    if (this.dom && this.dom.root.parentNode) this.dom.root.parentNode.removeChild(this.dom.root);
    this.dom = null;
  }
}

const PHASE_LABEL = Object.freeze({
  [PHASES.IDLE]: '待命',
  [PHASES.SELECT]: '选择部队',
  [PHASES.UNIT_SELECTED]: '选择移动目标',
  [PHASES.MOVEMENT_PENDING]: '判定移动',
  [PHASES.MOVEMENT_ANIMATING]: '移动中',
  [PHASES.ACTION_MENU]: '选择行动',
  [PHASES.ATTACK_PREVIEW]: '选择攻击目标',
  [PHASES.ATTACK_PENDING]: '判定目标',
  [PHASES.ATTACK_ANIMATING]: '交战中',
  [PHASES.ACTION_COMPLETED]: '行动结束',
  [PHASES.TURN_ENDING]: '回合结束',
  [PHASES.ENEMY_PHASE]: '敌军行动',
  [PHASES.BATTLE_FINISHED]: '战斗结束',
});

export function phaseLabel(phase) { return PHASE_LABEL[phase] || phase; }
