/**
 * P3 CitySession —— 原版 UI 控件与 HTML 界面之间的会话驱动。
 *
 * 它是 window.__SGBY_P3_HOST__ 的实现，也是 sgby.core.js 里 7 个 shim 的唯一调用方：
 *   list(rect,start,items)   <- $r     返回条目下标 / 255
 *   person(persons,count,..) <- Ls     返回选中下标 / 255
 *   message(constIdx)        <- Ms     返回 void
 *   personMessage(pid,text)  <- vs     返回 void
 *   value(min,max,kind)      <- Hs     返回数值 / 65535
 *   report(cityId)           <- Gs     返回 1 确定 / 0 取消
 *   beginCityLoop/endCityLoop<- ka()   划定接管窗口（只在玩家城市操作阶段接管）
 *
 * 关键约定：每个方法都返回 { handled, value }。
 *   handled=false 时 shim 会原样调用 *Orig，即完全回到原版 2D 控件；
 *   handled=true  时 value 必须落在原版取值域内，否则会改变游戏行为。
 *
 * 本类不判断任何业务条件（体力够不够、上限到没到、能不能打），
 * 这些都在原版 mi() 内部，UI 只负责把「用户选了第几个」交回去。
 */
import { MENU_CONST, ORIGINAL } from './config.mjs';
import { el, paragraph } from './Dialogs.mjs';

const ACTIVE = Object.freeze({ handled: true });
const pass = () => Object.freeze({ handled: false });
const ok = (value) => Object.freeze({ handled: true, value });

export class CitySession {
  /**
   * @param {object} deps
   * @param {object} deps.core      window.__SGBY_CORE__
   * @param {object} deps.adapter   GameAdapter（只读 + 同步）
   * @param {object} deps.cityUI    CityUIAdapter
   * @param {object} deps.ui        CityManagementUI
   * @param {object} deps.dialogs   DialogHost
   * @param {object} deps.officerDialog OfficerSelectDialog
   * @param {object} [deps.input]   InputManager（弹窗期间阻断 3D 键鼠）
   * @param {object} [deps.interaction] MapInteraction（城市循环内改 intent=select）
   * @param {Function} [deps.log]
   */
  constructor({ core, adapter, cityUI, ui, dialogs, officerDialog, input = null, interaction = null, log = () => {} }) {
    this.core = core;
    this.adapter = adapter;
    this.cityUI = cityUI;
    this.ui = ui;
    this.dialogs = dialogs;
    this.officerDialog = officerDialog;
    this.input = input;
    this.interaction = interaction;
    this.log = log;

    this._cityLoop = false;
    this._pending = null;         // {cat, item} 待交给二级菜单
    this._actionName = '';
    this._actionId = null;
    this._pendingAction = null;   // 记录「这条指令执行前」的数据行，用于展示真实变化
    this._lastCityId = null;
    this._menuText = null;
    this._timer = null;
    this.stats = {
      sessions: 0, lists: 0, persons: 0, messages: 0, values: 0, reports: 0,
      actions: 0, declines: 0, failures: 0, lastWidget: null,
    };
  }

  get cityLoop() { return this._cityLoop; }
  get cityId() { return this._lastCityId; }

  /** 由 main 在 3D 城市点击后调用，作为「当前城市」的可靠来源之一。 */
  noteClickedCity(cityId) {
    if (Number.isInteger(cityId)) this._lastCityId = cityId;
  }

  /** 注册到内核（shim 通过 window.__SGBY_P3_HOST__ 找到本对象）。 */
  attach() {
    window.__SGBY_P3_HOST__ = this;
    return this;
  }

  detach() {
    if (window.__SGBY_P3_HOST__ === this) window.__SGBY_P3_HOST__ = null;
    this.endCityLoop();
  }

  // ==================================================== 会话生命周期
  beginCityLoop() {
    this._cityLoop = true;
    this.stats.sessions++;
    this._menuText = null;
    this._pending = null;
    this._pendingAction = null;
    // 城市操作阶段：点击城市应当「确认选城」，否则 zs() 只会移动光标不返回。
    if (this.interaction) this.interaction.setIntent('select');
    this._startPolling();
    this.log('原版 ka() 进入城市操作阶段：城市 UI 接管已启用');
  }

  endCityLoop() {
    if (!this._cityLoop) return;
    this._cityLoop = false;
    this._pending = null;
    this._pendingAction = null;
    this._stopPolling();
    this.dialogs.cancelAll('离开城市操作阶段');
    this.ui.setCollapsed(false);
    this.ui.close();
    if (this.interaction) this.interaction.setIntent('cursor');
    this._setInputBlock(false);
    this.log('原版 ka() 结束：恢复 3D 地图交互');
  }

  /** 原版此刻在等地图选目标（zs()）时把城市界面收成提示条，让 3D 地图可点。 */
  _startPolling() {
    this._stopPolling();
    this._timer = setInterval(() => {
      if (!this._cityLoop) return;
      let phase;
      try { phase = this.adapter.getInputPhase(); } catch (_) { return; }
      const needMap = phase.kind === 'zs' && phase.waiting;
      if (needMap && this.ui.isOpen) {
        // 原版 ka() 每条指令结束后必然回到 zs()（源码 L7426-7447）：
        // 这里结算「上一轮指令」并把面板收成提示条，让出地图供下一次选城。
        if (this._pendingAction) this._finishAction();
        this.ui.setBusy(false);
        this.ui.setCollapsed(true, '指令已结束 · 点击地图上的城市继续');
        this.ui.setHint('地图选城中 · 点击城市=原版确认');
      } else if (!needMap) {
        this.ui.setCollapsed(false);
        this.ui.setHint(this.ui.isOpen ? '指令由原版 mi() 执行 · 结果实时回写' : '点击己方城市进入管理');
      }
    }, 260);
  }

  _stopPolling() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _setInputBlock(blocked) {
    if (this.input) this.input.setUIOpen(!!blocked);
  }

  /** 弹窗期间阻断 3D 键盘/滚轮，避免「R / 滚轮」在弹窗背后平移镜头。 */
  async _withBlockedInput(fn) {
    this._setInputBlock(true);
    try { return await fn(); } finally { this._setInputBlock(false); }
  }

  // ==================================================== 上下文
  _currentCityId() {
    const cursor = this.cityUI.currentCityId();
    if (Number.isInteger(cursor)) return cursor;
    return Number.isInteger(this._lastCityId) ? this._lastCityId : null;
  }

  _menuStrings() {
    if (this._menuText) return this._menuText;
    const lib = this.cityUI.lib;
    this._menuText = {
      main: String(lib.getConst(MENU_CONST.main) || ''),
      subs: MENU_CONST.sub.map((i) => String(lib.getConst(i) || '')),
    };
    return this._menuText;
  }

  _groupMeta(cat, itemIndex) {
    const groups = this.cityUI.getActionGroups();
    const g = groups.groups[cat];
    if (!g) return { name: '', id: null };
    if (itemIndex === null || itemIndex === undefined) return { name: g.name, id: MENU_CONST.infoActionId };
    const it = g.items[itemIndex];
    return { name: it ? `${g.name}·${it.name}` : g.name, id: it ? it.id : null };
  }

  /** 指令执行前的原版城市数据行快照（用于展示真实变化，不参与任何计算）。 */
  _snapshotLines(cityId) {
    if (!Number.isInteger(cityId)) return null;
    try {
      return this.cityUI.getCityReport(cityId).lines.map((l) => ({
        label: l.label, value: l.value,
      }));
    } catch (_) { return null; }
  }

  _finishAction() {
    const pending = this._pendingAction;
    if (!pending) return;
    this._pendingAction = null;
    const after = this._snapshotLines(pending.cityId);
    const changed = [];
    if (pending.before && after) {
      for (let i = 0; i < Math.min(pending.before.length, after.length); i++) {
        const a = pending.before[i], b = after[i];
        if (a.value !== b.value) changed.push(`${b.label} ${a.value} → ${b.value}`);
      }
    }
    const text = changed.length
      ? `${pending.name} 完成：${changed.join('；')}`
      : `${pending.name} 结束：城市数值无变化（原版未产生改动，或该指令只作用于武将/队列）`;
    this.ui.pushLog(text, changed.length ? 'ok' : 'info');
    this.ui.setStatus(changed.length ? '指令已执行（数值已变化）' : '指令已执行');
  }

  refreshAfterWidget() {
    try { this.adapter.sync({ source: 'p3' }); } catch (_) { /* 同步失败不影响流程 */ }
    if (this.ui.isOpen) {
      try { this.ui.refresh(); } catch (e) { this.log(`界面刷新失败：${e.message}`); }
    }
  }

  // ==================================================== 控件：列表菜单 $r
  async list(rect, startIdx, items) {
    this.stats.lists++;
    this.stats.lastWidget = '$r';
    const text = String(items ?? '');
    if (!text) return pass();
    const menus = this._menuStrings();

    if (text === menus.main) return this._listMain();
    const subIndex = menus.subs.indexOf(text);
    if (subIndex >= 0) return this._listSub(subIndex);
    return this._listGeneric(text, Number(startIdx) || 0);
  }

  async _listMain() {
    // 上一轮指令到这里就已经跑完了（ei() 的 for 循环回到 ni()）。
    this._finishAction();

    const cityId = this._currentCityId();
    if (!Number.isInteger(cityId)) {
      // 拿不到城市上下文时不接管，交给原版 2D 菜单，避免凭空造一个城市界面。
      this.stats.declines++;
      this.log('城市菜单：原版光标不在任何城市上，交回原版 2D 菜单');
      return pass();
    }
    this._lastCityId = cityId;

    const groups = this.cityUI.getActionGroups();
    this.ui.mount();
    this.ui.groups = groups;
    this.ui.openCity(cityId);
    this.ui.setHint('指令由原版 mi() 执行 · 数值来自 Dn');
    this.ui.setStatus('选择指令');

    const choice = await this.ui.chooseEntry();
    if (choice.exit || choice.cat === undefined) {
      this._pending = null;
      this._setInputBlock(false);
      this.ui.pushLog('退出城市管理（原版 ei() 返回 255）', 'info');
      return ok(ORIGINAL.cancelCode);
    }

    const meta = this._groupMeta(choice.cat, choice.item);
    if (choice.item === null || choice.item === undefined) {
      // 状况：ei() case 3 -> 254 -> Gs()，没有二级菜单。
      this._pending = null;
      this._actionName = meta.name;
      this._actionId = MENU_CONST.infoActionId;
      this.ui.pushLog(`打开「${meta.name}」（原版 Gs()）`, 'info');
      return ok(choice.cat);
    }

    this._pending = { cat: choice.cat, item: choice.item };
    this._actionName = meta.name;
    this._actionId = meta.id;
    this._pendingAction = {
      cityId, name: meta.name, actionId: meta.id,
      before: this._snapshotLines(cityId),
    };
    this.stats.actions++;
    this.ui.pushLog(`执行「${meta.name}」…`, 'action');
    return ok(choice.cat);
  }

  async _listSub(cat) {
    const pending = this._pending;
    this._pending = null;
    if (pending && pending.cat === cat) {
      return ok(pending.item);
    }
    // 没有待执行条目：说明用户还没选（正常路径不会到这里）。
    // 就地渲染一个等价的条目列表，保证游戏仍可继续，而不是卡在隐藏画布上。
    this.stats.declines++;
    const groups = this.cityUI.getActionGroups();
    const g = groups.groups[cat];
    if (!g) return pass();
    const items = g.items.map((it) => ({
      label: it.name,
      note: [it.costThew ? `体 ${it.costThew}` : '', it.costMoney ? `金 ${it.costMoney}` : ''].filter(Boolean).join(' / '),
    }));
    const value = await this._pickFromList(`${g.name}（原版 getConst(${MENU_CONST.sub[cat]})）`, items);
    if (value === ORIGINAL.cancelCode) return ok(ORIGINAL.cancelCode);
    const meta = this._groupMeta(cat, value);
    this._actionName = meta.name;
    this._actionId = meta.id;
    this._pendingAction = {
      cityId: this._currentCityId(), name: meta.name, actionId: meta.id,
      before: this._snapshotLines(this._currentCityId()),
    };
    return ok(value);
  }

  async _listGeneric(text, startIdx) {
    // 其余 $r() 都是指令内部的二级选择（例如交易 getConst(46) 的「买入/卖出」）。
    const items = splitFixedWidth(text);
    if (!items.length) return pass();
    const title = this._actionName ? `${this._actionName} · 选择` : '选择';
    const value = await this._pickFromList(title, items.map((label) => ({ label })), startIdx);
    if (value !== ORIGINAL.cancelCode) this.ui.pushLog(`选择「${items[value]}」`, 'action');
    return ok(value);
  }

  async _pickFromList(title, items, startIdx = 0) {
    let picked = -1;
    let finish = null;
    const wrap = el('div', 'p3-pick-list');
    wrap.style.setProperty('--p3-pick-cols', '2');
    items.forEach((item, index) => {
      const b = el('button', 'p3-pick-item');
      b.type = 'button';
      if (item.disabled) b.disabled = true;
      if (item.title) b.title = item.title;
      b.append(el('span', 'p3-pick-label', item.label));
      if (item.note) b.append(el('span', 'p3-pick-note', item.note));
      if (index === startIdx) b.classList.add('is-current');
      b.addEventListener('click', () => { picked = index; if (finish) finish(index, 'action'); });
      wrap.append(b);
    });
    const value = await this._withBlockedInput(() => this.dialogs.open({
      title,
      subtitle: '选项来自原版 $r() 的实参字符串，未做增删',
      body: [wrap],
      actions: [{ label: '取消', value: ORIGINAL.cancelCode }],
      cancelValue: ORIGINAL.cancelCode,
      onMount: ({ finish: done }) => { finish = done; },
    }));
    if (picked >= 0) return picked;
    return typeof value === 'number' ? value : ORIGINAL.cancelCode;
  }

  // ==================================================== 控件：武将选择 Ls
  async person(persons, count, x1, y1, x2, y2, start) {
    this.stats.persons++;
    this.stats.lastWidget = 'Ls';
    const ids = Array.from(persons || []).slice(0, Number(count) || 0);
    const index = await this._withBlockedInput(() => this.officerDialog.ask({
      persons: ids,
      startIndex: Number(start) || 0,
      actionName: this._actionName,
      cityName: this._lastCityId === null ? '' : this.cityUI.cityName(this._lastCityId),
    }));
    if (index === ORIGINAL.cancelCode) {
      this.ui.pushLog('取消武将选择（原版 Ls() 返回 255）', 'info');
      return ok(ORIGINAL.cancelCode);
    }
    const name = this.cityUI.officerName(ids[index]);
    this.ui.pushLog(`选择武将：${name}`, 'action');
    this.refreshAfterWidget();
    return ok(index);
  }

  // ==================================================== 控件：提示 Ms / vs
  async message(constIdx) {
    this.stats.messages++;
    this.stats.lastWidget = 'Ms';
    const text = this.cityUI.messageText(constIdx);
    await this._withBlockedInput(() => this.dialogs.open({
      title: '原版提示',
      subtitle: `getConst(${constIdx})`,
      body: [paragraph(text)],
      actions: [{ label: '确定', value: true, variant: 'primary' }],
      cancelValue: true,
    }));
    this.ui.pushLog(`提示：${text}`, 'msg');
    this.refreshAfterWidget();
    return ACTIVE;
  }

  async personMessage(personId, text) {
    this.stats.messages++;
    this.stats.lastWidget = 'vs';
    const name = this.cityUI.officerName(personId);
    await this._withBlockedInput(() => this.dialogs.open({
      title: name || '提示',
      subtitle: '原版 vs() 提示（文本由原版指令拼接）',
      body: [paragraph(text)],
      actions: [{ label: '确定', value: true, variant: 'primary' }],
      cancelValue: true,
    }));
    this.ui.pushLog(`${name || '提示'}：${text}`, 'msg');
    this.refreshAfterWidget();
    return ACTIVE;
  }

  // ==================================================== 控件：数值 Hs
  async value(min, max, kind) {
    this.stats.values++;
    this.stats.lastWidget = 'Hs';
    const lo = Number(min) || 0;
    const hi = Number(max) || 0;
    const label = this.cityUI.valueLabel(kind);
    const body = el('div', 'p3-value-box');
    const input = el('input', 'p3-input');
    input.type = 'number';
    input.min = String(lo);
    input.max = String(hi);
    input.step = '1';
    input.value = String(lo);
    const range = el('input', 'p3-range');
    range.type = 'range';
    range.min = String(lo);
    range.max = String(Math.max(lo, hi));
    range.value = String(lo);
    range.addEventListener('input', () => { input.value = range.value; });
    input.addEventListener('input', () => { range.value = input.value; });
    const hint = el('p', 'p3-hint', `${label}：原版范围 ${lo} ~ ${hi}（Hs() 实参，UI 未改动）`);
    body.append(el('label', 'p3-value-label', label), input, range, hint);

    const result = await this._withBlockedInput(() => this.dialogs.open({
      title: label || '数值',
      subtitle: '原版 Hs()：确定 / 最大 / 取消',
      body: [body],
      actions: [
        { label: '确定', value: 'ok', variant: 'primary' },
        { label: '最大', value: 'max' },
        { label: '取消', value: 'cancel' },
      ],
      cancelValue: 'cancel',
    }));

    if (result === 'cancel' || result === null) {
      this.ui.pushLog(`${label || '数值'}：取消（Hs 返回 65535）`, 'info');
      return ok(ORIGINAL.valueCancel);
    }
    if (result === 'max') {
      this.ui.pushLog(`${label || '数值'}：取最大值 ${hi}`, 'action');
      return ok(hi);
    }
    const raw = Number(input.value);
    const v = Number.isFinite(raw) ? Math.max(lo, Math.min(Math.max(lo, hi), Math.round(raw))) : lo;
    this.ui.pushLog(`${label || '数值'}：${v}`, 'action');
    return ok(v);
  }

  // ==================================================== 控件：状况 Gs
  async report(cityId) {
    this.stats.reports++;
    this.stats.lastWidget = 'Gs';
    const id = Number.isInteger(cityId) ? cityId : this._currentCityId();
    if (!Number.isInteger(id)) return pass();
    const report = this.cityUI.getCityReport(id);
    const table = el('table', 'p3-report p3-report-modal');
    for (const line of report.lines) {
      const tr = el('tr');
      tr.append(el('th', null, line.label));
      tr.append(el('td', null, line.value));
      table.append(tr);
    }
    const result = await this._withBlockedInput(() => this.dialogs.open({
      title: `${this.cityUI.cityName(id) || '城市'} · 状况`,
      subtitle: '原版 Gs()：Is() 标题 + Ys() 11 行',
      body: [table],
      actions: [
        { label: '关闭', value: 1, variant: 'primary' },
        { label: '取消', value: 0 },
      ],
      cancelValue: 0,
    }));
    this.ui.pushLog(`查看「${this.cityUI.cityName(id)}」状况`, 'info');
    this.refreshAfterWidget();
    return ok(result === 1 ? 1 : 0);
  }

  // ==================================================== 兜底
  /** 内核 shim 在接管抛错时回调：记录 + 报告，绝不静默。 */
  fail(widget, err) {
    this.stats.failures++;
    const message = err && err.message ? err.message : String(err);
    this.log(`[接管失败] ${widget}: ${message}`);
    if (this.ui.isOpen) {
      this.ui.pushLog(`接管失败：${widget} — ${message}`, 'error');
      this.ui.setStatus('接管失败，已按取消语义回卷');
    }
  }
}

/** 原版 $r() 的实参是「定宽 2 字符」拼成的一串，这里只做切分（不改内容）。 */
export function splitFixedWidth(text) {
  const s = String(text || '');
  const out = [];
  for (let i = 0; i + 1 < s.length; i += 2) out.push(s.slice(i, i + 2));
  return out;
}
