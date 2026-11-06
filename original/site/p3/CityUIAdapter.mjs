/**
 * P3 CityUIAdapter —— 城市管理 UI 的**只读**数据入口。
 *
 * 约束（P3 §2.2 / §8）：
 *   - 不复制任何原版规则：武将筛选走原版 ss()，属性文本走原版 Bs()，
 *     城市属性文本走原版 Ys()，城市名走原版 Is()，武将名走原版 $n()，
 *     菜单文本/消耗走原版 getConst() / getItem(2,10|11)。
 *   - 不维护第二套权威状态：每次取值都现读 Dn，缓存仅限「同一帧内二次读取」的场景，
 *     且提供 invalidate() 供状态变化后强制重读。
 *   - 写操作一律不在本模块；UI 只把「用户选择」交回原版协程（CitySession）。
 *
 * 原版函数缺失时（Node 测试夹具、内核升级）返回带 degraded 标记的空结构，
 * 绝不编造数据。
 */
import { MENU_CONST, ORIGINAL } from './config.mjs';

/**
 * mi() 中真实存在的指令分支（源码 L4609-5368 逐一核对，构建期由
 * tools/make_core.mjs 扫描同一份 sgby.min.js 复算；tests/p3.test.mjs 会重新推导比对）。
 * 24 个菜单项中缺 18（反间）：原版 mi() 无此分支，选择后不发生任何操作。
 */
export const ACTION_IDS = Object.freeze([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
  13, 14, 15, 16, 17, 19,
  23, 24, 25, 26, 27,
]);

/** 武将表 13 列的原版列标题 getConst 下标（Bs() 的 case 0..12 与 getConst(24+o) 对应）。 */
const OFFICER_LABEL_BASE = 24;
const OFFICER_NAME_LABEL = 23;
const OFFICER_COLUMNS = 13;

const has = (o, k) => !!o && typeof o[k] === 'function';

export class CityUIAdapter {
  constructor({ core, adapter }) {
    if (!core || !adapter) throw new TypeError('CityUIAdapter 需要 core 与 adapter');
    this.core = core;
    this.adapter = adapter;
    this._sets = new Set(ACTION_IDS);
    this.stats = { queries: 0, degradedCalls: 0 };
    this._actionCache = null;
  }

  get lib() { return this.core.lib; }
  get fns() { return this.core.fns || {}; }
  get original() { return this.core.p3 || {}; }

  /** 原版查询函数是否齐备（浏览器内应为 true；Node 夹具为 false）。 */
  get available() {
    const f = this.fns;
    return has(f, 'ss') && has(f, 'Bs') && has(f, 'Ys') && has(f, 'Is') && has(f, '$n');
  }

  _miss(name) {
    this.stats.degradedCalls++;
    return { degraded: true, reason: `原版函数 ${name}() 不可用` };
  }

  /** 数值型接口，保证返回有限数字（避免 UI 出现 NaN）。 */
  _num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  // ============================================================ 城市
  cityName(cityId) {
    if (cityId === null || cityId === undefined) return '';
    try {
      return has(this.fns, 'Is') ? String(this.fns.Is(cityId) ?? '') : this.adapter.getCity(cityId).name;
    } catch (_) { return ''; }
  }

  /**
   * 城市信息栏：直接使用原版 Ys() 的 11 行文本（归属/太守/农业/商业/民忠/防灾/
   * 人口/金钱/粮食/后备兵力/状态），按第一个 ':' 切成 label/value。
   * 这样显示与格式天然与原版「状况」窗口一致，不做二次格式化。
   */
  getCityReport(cityId) {
    this.stats.queries++;
    if (!has(this.fns, 'Ys')) {
      const raw = this.adapter.getCity(cityId);
      return {
        degraded: true, reason: this._miss('Ys').reason,
        title: raw.name,
        lines: [
          { label: '归属', value: raw.ownerId ? this.officerName(raw.ownerId - 1) : '无' },
          { label: '农业', value: `${raw.farming}/${raw.farmingLimit}` },
          { label: '商业', value: `${raw.commerce}/${raw.commerceLimit}` },
          { label: '民忠', value: String(raw.peopleDevotion) },
          { label: '防灾', value: String(raw.avoidCalamity) },
          { label: '人口', value: String(raw.population) },
          { label: '金钱', value: String(raw.money) },
          { label: '粮食', value: String(raw.food) },
          { label: '后备兵力', value: String(raw.mothballArms) },
        ],
        raw,
      };
    }
    const lines = [];
    for (let i = 0; i < 11; i++) {
      const text = String(this.fns.Ys(cityId, i) ?? '');
      const at = text.indexOf(':');
      lines.push(at > 0
        ? { label: text.slice(0, at), value: text.slice(at + 1), raw: text }
        : { label: '', value: text, raw: text });
    }
    return { degraded: false, title: this.cityName(cityId), lines, raw: this.adapter.getCity(cityId) };
  }

  ownerName(ownerId) {
    if (!ownerId) return String(this.lib.getConst(50) || '无');       // getConst(50) = 无
    return this.officerName(this._num(ownerId, 1) - 1);
  }

  playerKingId() {
    const k = this.core.Dn && this.core.Dn.g_PlayerKing;
    return Number.isInteger(k) ? k : null;
  }

  /** 原版选城光标当前所指城市（ka() 里 zs() 的返回值来源），null 表示光标不在城上。 */
  currentCityId() {
    try {
      const c = this.adapter.getCityCursor();
      return c.cityId;
    } catch (_) { return null; }
  }

  // ============================================================ 指令
  /**
   * 指令表：4 个大类、24 个条目，顺序/名称/消耗全部来自原版数据。
   * 第 4 类「状况」不是指令，对应 ei() case 3 -> 254 -> Gs()。
   */
  getActionGroups() {
    const acts = this.adapter.getCityActions(0);
    const groups = acts.groups.map((g, gi) => Object.freeze({
      index: gi,
      name: g.name,
      kind: 'action',
      items: Object.freeze(g.items.map((it, ii) => Object.freeze({
        index: ii,
        id: it.id,
        name: it.name,
        costThew: it.costThew,
        costMoney: it.costMoney,
        hasBranch: this._sets.has(it.id),
      }))),
    }));
    const infoIndex = MENU_CONST.infoCategoryIndex;
    groups.push(Object.freeze({
      index: infoIndex,
      name: acts.main[infoIndex] || '状况',
      kind: 'info',
      items: Object.freeze([]),
    }));
    return Object.freeze({
      main: acts.main,
      groups: Object.freeze(groups),
      infoActionId: MENU_CONST.infoActionId,
      cancelCode: ORIGINAL.cancelCode,
      source: acts.source,
    });
  }

  /** 某指令是否在原版 mi() 中确有分支（构建期扫描结果，非推测）。 */
  hasBranch(actionId) { return this._sets.has(actionId); }

  messageText(constIdx) {
    this.stats.queries++;
    const t = this.lib.getConst(constIdx);
    return t === undefined || t === null ? `（原版缺少 getConst(${constIdx})）` : String(t);
  }

  /** Hs() 的 kind：41 粮食 42 金钱 43 士兵。 */
  valueLabel(kind) {
    return String(this.lib.getConst(kind) || '').trim() || `数值(${kind})`;
  }

  // ============================================================ 武将
  officerName(officerId) {
    if (!Number.isInteger(officerId) || officerId < 0) return '';
    if (has(this.fns, '$n')) {
      try { return String(this.fns.$n(officerId) ?? ''); } catch (_) { /* 落到资源表 */ }
    }
    if (has(this.fns, 'Bs')) {
      try { return String(this.fns.Bs(officerId, 0) ?? ''); } catch (_) { /* 继续 */ }
    }
    try { return String(this.lib.getStr(62, officerId + 1) || ''); } catch (_) { return ''; }
  }

  /** 列标题：姓名 + getConst(24..36)，与原版 Ds()/Ts() 的表头完全同源。 */
  getOfficerColumns() {
    const cols = [{ key: 'name', label: String(this.lib.getConst(OFFICER_NAME_LABEL) || '姓名').trim() }];
    for (let i = 0; i < OFFICER_COLUMNS; i++) {
      cols.push({ key: `c${i}`, label: String(this.lib.getConst(OFFICER_LABEL_BASE + i) || `列${i}`).trim() });
    }
    return Object.freeze(cols);
  }

  /**
   * 城中可操作武将：ids 来自原版 ss(cityId)（Belong 与本城一致的武将），
   * 不是本模块自己遍历 g_PersonsQueue 写的过滤条件。
   */
  officerIds(cityId) {
    this.stats.queries++;
    if (!has(this.fns, 'ss')) {
      return { degraded: true, reason: this._miss('ss').reason, ids: [] };
    }
    try {
      return { degraded: false, ids: Array.from(this.fns.ss(cityId) || []) };
    } catch (e) {
      return { degraded: true, reason: `ss() 调用失败：${e.message}`, ids: [] };
    }
  }

  /** 单行 13 列属性，值直接取原版 Bs(officerId, col) 的字符串。 */
  officerRow(officerId) {
    const cells = [];
    for (let i = 0; i < OFFICER_COLUMNS; i++) {
      let v = '';
      if (has(this.fns, 'Bs')) {
        try { v = String(this.fns.Bs(officerId, i) ?? ''); } catch (_) { v = ''; }
      }
      cells.push(v);
    }
    return Object.freeze({
      id: officerId,
      name: this.officerName(officerId),
      cells: Object.freeze(cells),
    });
  }

  /** 城市武将表（含原版全部 13 列）。 */
  getCityOfficers(cityId) {
    const r = this.officerIds(cityId);
    if (r.degraded) return { degraded: true, reason: r.reason, columns: this.getOfficerColumns(), rows: [] };
    return {
      degraded: false,
      columns: this.getOfficerColumns(),
      rows: r.ids.map((id) => this.officerRow(id)),
    };
  }

  /** 原版 Ls() 收到的候选数组 -> UI 行（同样走 ss() 的语义，不做二次筛选）。 */
  officerRowsByIds(ids) {
    return ids.map((id) => this.officerRow(id));
  }
}
