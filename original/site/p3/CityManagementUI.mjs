/**
 * P3 城市管理主界面（HTML/CSS 覆盖在 3D 战略地图之上）。
 *
 * 职责边界：
 *   - 只做展示 + 收集「用户选了哪一项」；
 *   - 不判断能不能执行、不算资源、不改武将 —— 这些全部在原版 mi()/ei() 里；
 *   - 不维护第二份权威数据：每次渲染都通过 CityUIAdapter 现读 Dn。
 *
 * 菜单层级与原版一致（ei() 的真实两级结构）：
 *   第一级 getConst(37) -> 内政 / 外交 / 军备 / 状况   （左侧纵向按钮）
 *   第二级 getConst(38|39|40) -> 14 / 5 / 5 项          （条目列表）
 * 用户点条目时，先把第一级结果交给原版协程，等它请求第二级时立即交出条目下标，
 * 因此原版仍然完成两次 $r() 调用，顺序与取值域完全不变。
 */
import { CITY_UI_CONFIG, UI_IDS } from './config.mjs';
import { el } from './Dialogs.mjs';

const TAB_DEFS = Object.freeze([
  { key: 'overview', label: '概览' },
  { key: 'officers', label: '武将' },
  { key: 'log', label: '执行记录' },
]);

export class CityManagementUI {
  constructor({ host, dialogHost, cityUI, cityAdapter }) {
    if (!host || !dialogHost || !cityUI) throw new TypeError('CityManagementUI 依赖不完整');
    this.host = host;
    this.dialogHost = dialogHost;
    this.cityUI = cityUI;
    this.adapter = cityAdapter;      // GameAdapter（只读用途：状态、玩家君主）
    this.cityId = null;
    this.tab = 'overview';
    this.groups = null;
    this.logs = [];
    this._resolveEntry = null;
    this._built = false;
    this.stats = { opens: 0, closes: 0, actions: 0 };
    this.dom = {};
  }

  get isOpen() { return this._built && !this.dom.root.hidden; }

  // ============================================================ DOM
  mount() {
    if (this._built) return this;
    const root = el('div', 'p3-root');
    root.id = UI_IDS.root;
    root.hidden = true;
    // 注意：根容器**不带** data-p1-ui-block。P1 的
    // `#p1-ui [data-p1-ui-block]{pointer-events:auto}` 会让它吞掉整屏点击，
    // 收起态就没法再点 3D 地图。阻断只放在真的可见部件上（frame / dim / 弹窗）。

    // 遮罩：只挡视觉与点击，不让 3D 事件穿透
    const dim = el('div', 'p3-dim');
    dim.setAttribute('data-p1-ui-block', '');
    root.append(dim);

    const frame = el('section', 'p3-frame');
    frame.setAttribute('data-p1-ui-block', '');
    root.append(frame);

    // ---------------- 顶部城市信息栏
    const head = el('header', 'p3-head');
    const nameBox = el('div', 'p3-name-box');
    const cityName = el('h2', 'p3-city-name', '—');
    cityName.id = 'p3-city-name';
    const citySub = el('p', 'p3-city-sub', '');
    nameBox.append(cityName, citySub);
    head.append(nameBox);

    const stats = el('dl', 'p3-stats');
    stats.id = UI_IDS.infoBar;
    head.append(stats);

    const headBtns = el('div', 'p3-head-btns');
    const exitBtn = el('button', 'p3-btn p3-btn-ghost', '返回战略地图');
    exitBtn.type = 'button';
    exitBtn.addEventListener('click', () => this.requestExit());
    headBtns.append(exitBtn);
    head.append(headBtns);
    frame.append(head);

    // ---------------- 主体：大类 / 条目 / 明细
    const body = el('div', 'p3-body');
    const rail = el('nav', 'p3-rail');
    rail.id = UI_IDS.rail;
    const items = el('div', 'p3-items');
    items.id = UI_IDS.list;
    const detail = el('div', 'p3-detail');
    detail.id = UI_IDS.panel;
    body.append(rail, items, detail);
    frame.append(body);

    // 底部
    const foot = el('footer', 'p3-foot');
    const status = el('span', 'p3-status', '就绪');
    const hint = el('span', 'p3-foot-hint', '');
    hint.id = UI_IDS.hint;
    foot.append(status, hint);
    frame.append(foot);

    this.host.append(root);
    this.dom = { root, dim, frame, cityName, citySub, stats, rail, items, detail, status, hint, exitBtn };
    this._built = true;
    return this;
  }

  // ============================================================ 打开 / 关闭
  openCity(cityId) {
    this.mount();
    const changed = this.cityId !== cityId;
    this.cityId = cityId;
    if (changed) this.logs = [];
    this.dom.root.hidden = false;
    this.stats.opens++;
    this.setBusy(false);
    this.refresh();
    return this;
  }

  close() {
    if (!this._built) return;
    this.dom.root.hidden = true;
    this.stats.closes++;
    const r = this._resolveEntry;
    this._resolveEntry = null;
    if (r) r({ exit: true });
  }

  /** 用户点「返回战略地图」：交给会话转发成原版 255（ei() 返回 255 -> 回到 zs()）。 */
  requestExit() {
    this.setStatus('退出城市（原版 ei() 返回 255）');
    this.close();
  }

  /** 原版正在等待地图选目标（zs()）：把界面收成提示条，让 3D 地图可点。 */
  setCollapsed(collapsed, text = '') {
    if (!this._built) return;
    this.dom.frame.classList.toggle('p3-collapsed', !!collapsed);
    this.dom.dim.classList.toggle('p3-dim-off', !!collapsed);
    if (collapsed) this.setStatus(text || '请在地图上选择目标城市');
  }

  setBusy(busy) {
    if (!this._built) return;
    this.dom.frame.classList.toggle('p3-busy', !!busy);
    if (busy) this.setStatus('原版正在执行指令…');
  }

  setStatus(text) {
    if (this._built) this.dom.status.textContent = text;
  }

  setHint(text) {
    if (this._built) this.dom.hint.textContent = text;
  }

  // ============================================================ 渲染
  refresh() {
    if (!this._built || this.cityId === null) return;
    const id = this.cityId;
    const report = this.cityUI.getCityReport(id);
    const groups = this.groups || this.cityUI.getActionGroups();
    this.groups = groups;

    // 标题
    this.dom.cityName.textContent = this.cityUI.cityName(id) || `城市 #${id}`;
    const raw = report.raw;
    const ownerText = raw.ownerId ? this.cityUI.officerName(raw.ownerId - 1) : (this.cityUI.lib.getConst(50) || '无');
    const isMine = raw.ownerId && raw.ownerId === this.cityUI.playerKingId() + 1;
    this.dom.cityName.classList.toggle('p3-mine', !!isMine);
    this.dom.citySub.textContent = `#${id} · ${ownerText} · 逻辑坐标 (${raw.position.x},${raw.position.y})`
      + (report.degraded ? ` · ${report.reason}` : '');

    // 信息栏：直接用原版 Ys() 的 11 行文本
    this.dom.stats.replaceChildren();
    for (const line of report.lines) {
      const dt = el('dt', null, line.label || '—');
      const dd = el('dd', null, line.value);
      this.dom.stats.append(dt, dd);
    }

    this.renderRail(groups.groups || []);
    this.renderDetail(groups);
  }

  renderRail(list) {
    const rail = this.dom.rail;
    rail.replaceChildren();
    if (!list.length) {
      rail.append(el('p', 'p3-hint', '原版菜单不可用'));
      return;
    }
    for (const g of list) {
      const b = el('button', 'p3-rail-btn');
      b.type = 'button';
      b.dataset.group = String(g.index);
      b.append(el('span', 'p3-rail-name', g.name));
      b.append(el('span', 'p3-rail-count', g.kind === 'info' ? '报告' : `${g.items.length} 项`));
      if (g.index === this.activeGroup) b.classList.add('is-active');
      b.addEventListener('click', () => this.selectGroup(g.index));
      rail.append(b);
    }
    if (this.activeGroup === undefined) this.selectGroup(list[0].index, { silent: true });
  }

  selectGroup(index, { silent = false } = {}) {
    this.activeGroup = index;
    for (const b of this.dom.rail.querySelectorAll('.p3-rail-btn')) {
      b.classList.toggle('is-active', Number(b.dataset.group) === index);
    }
    this.renderItems();
    if (!silent) this.setStatus(`已选择「${this.groups.groups[index].name}」`);
  }

  renderItems() {
    const wrap = this.dom.items;
    wrap.replaceChildren();
    const g = this.groups.groups[this.activeGroup];
    if (!g) return;
    wrap.append(el('h3', 'p3-items-title', g.name));

    if (g.kind === 'info') {
      const b = el('button', 'p3-item p3-item-info');
      b.type = 'button';
      b.append(el('span', 'p3-item-name', '城市状况'));
      b.append(el('span', 'p3-item-note', '原版 Gs() 报告'));
      b.addEventListener('click', () => this.pickEntry(g.index, null));
      wrap.append(b);
      return;
    }

    for (const it of g.items) {
      const b = el('button', 'p3-item');
      b.type = 'button';
      b.dataset.actionId = String(it.id);
      b.append(el('span', 'p3-item-name', it.name));
      const cost = [];
      if (it.costThew) cost.push(`体 ${it.costThew}`);
      if (it.costMoney) cost.push(`金 ${it.costMoney}`);
      b.append(el('span', 'p3-item-cost', cost.join(' / ')));
      if (!it.hasBranch) {
        b.classList.add('p3-item-nobranch');
        b.title = '原版 mi() 无该指令分支：选择后不会发生任何操作（原版行为）';
      }
      b.addEventListener('click', () => this.pickEntry(g.index, it.index));
      wrap.append(b);
    }
    const note = el('p', 'p3-hint p3-items-note');
    note.textContent = '顺序、名称、消耗均取自原版数据；灰显条目在原版 mi() 中无分支，点击后不产生任何效果。';
    wrap.append(note);
  }

  renderDetail(groups) {
    const d = this.dom.detail;
    d.replaceChildren();

    const tabs = el('div', 'p3-tabs');
    for (const t of TAB_DEFS) {
      const b = el('button', 'p3-tab', t.label);
      b.type = 'button';
      b.classList.toggle('is-active', this.tab === t.key);
      b.addEventListener('click', () => { this.tab = t.key; this.renderDetail(this.groups); });
      tabs.append(b);
    }
    d.append(tabs);

    if (this.tab === 'overview') {
      const report = this.cityUI.getCityReport(this.cityId);
      // 11 行拆成两栏，避免右侧大面积留白
      const cols = el('div', 'p3-report-cols');
      const half = Math.ceil(report.lines.length / 2);
      for (let c = 0; c < 2; c++) {
        const table = el('table', 'p3-report');
        for (const line of report.lines.slice(c * half, (c + 1) * half)) {
          const tr = el('tr');
          tr.append(el('th', null, line.label));
          tr.append(el('td', null, line.value));
          table.append(tr);
        }
        if (table.children.length) cols.append(table);
      }
      d.append(cols);
      const actions = groups.groups.reduce((n, g) => n + g.items.length, 0);
      d.append(el('p', 'p3-hint', `原版菜单：${groups.main.join(' / ')}，共 ${actions} 条指令。`
        + '城市数值与文字全部来自原版 Ys()，未经二次加工。'));
    } else if (this.tab === 'officers') {
      d.append(this.buildOfficerTable());
    } else {
      d.append(this.buildLog());
    }
  }

  buildOfficerTable() {
    const info = this.cityUI.getCityOfficers(this.cityId);
    const wrap = el('div', 'p3-officer-wrap p3-officer-inline');
    if (info.degraded) {
      wrap.append(el('p', 'p3-hint', `武将数据不可用：${info.reason}`));
      return wrap;
    }
    const table = el('table', 'p3-officer-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const c of info.columns) hr.append(el('th', null, c.label));
    thead.append(hr);
    table.append(thead);
    const tbody = el('tbody');
    for (const row of info.rows) {
      const tr = el('tr');
      tr.append(el('td', 'p3-officer-name', row.name));
      for (const cell of row.cells) tr.append(el('td', null, cell));
      tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);
    wrap.append(el('p', 'p3-hint', `共 ${info.rows.length} 人（原版 ss() 过滤后的可操作武将）`));
    return wrap;
  }

  buildLog() {
    const wrap = el('div', 'p3-log-wrap');
    if (!this.logs.length) {
      wrap.append(el('p', 'p3-hint', '本次进入城市管理后尚无指令记录。'));
      return wrap;
    }
    const list = el('ol', 'p3-log-list');
    for (const entry of this.logs) {
      const li = el('li', `p3-log-item p3-log-${entry.kind || 'info'}`);
      li.append(el('span', 'p3-log-time', entry.time));
      li.append(el('span', 'p3-log-text', entry.text));
      list.append(li);
    }
    wrap.append(list);
    return wrap;
  }

  pushLog(text, kind = 'info') {
    const d = new Date();
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:`
      + String(d.getSeconds()).padStart(2, '0');
    this.logs.push({ time, text: String(text), kind });
    if (this.logs.length > CITY_UI_CONFIG.logLimit) this.logs.shift();
    if (this.tab === 'log' && this.isOpen) this.renderDetail(this.groups);
  }

  // ============================================================ 选择入口
  /**
   * 等待用户在左侧/条目区做出选择。
   * @returns {Promise<{cat:number,item:number|null}|{exit:true}>}
   */
  chooseEntry() {
    this.mount();
    this.dom.root.hidden = false;
    return new Promise((resolve) => {
      this._resolveEntry = resolve;
    });
  }

  pickEntry(cat, item) {
    const resolve = this._resolveEntry;
    this._resolveEntry = null;
    this.setBusy(true);
    this.stats.actions++;
    if (resolve) resolve({ cat, item });
  }
}
