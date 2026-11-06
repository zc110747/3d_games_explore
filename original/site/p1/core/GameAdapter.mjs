/**
 * P1 GameAdapter —— Three.js 表现层与原版游戏逻辑之间的唯一通道。
 *
 * 依据 P0 报告的真实源码（行号见 P0 §11.E，指 sgby.pretty.js）：
 *   - 全局状态 Dn (L2415)、资源库 Dn.lib = class se (L2028)
 *   - Un/On/Bn (L2370/2385/2400)、getConst/getStr/getItem/resId (L2113-2128)
 *   - 城市坐标 getItem(2,6)、城市布局 getItem(2,14)、城市地图id getItem(2,15)
 *   - 城市连接右 getItem(59,1)（每城 16B = 8 连接 + 8 距离）
 *   - 指令消耗体力/金钱 getItem(2,10)/getItem(2,11)，菜单文本 getConst(37..40)
 *   - 武将名 $n() (L2435)、城市名 getStr(58,id+1)
 *   - 输入入口 class A.pushMsg/pushKey (L461-468)、waitMsg (L470)
 *   - 指令上下文 window.__SGBY_CTX (L7437-7445 / L4937 / L5254)
 *
 * 严格约束：
 *   - 本模块只「读」Dn / lib，并把数据转成只读投影；不写任何原版对象。
 *   - 不在本模块复制或重新实现任何业务规则（如移动/伤害/指令结算）。
 *   - 原版没有命令式操作 API（都是 await waitMsg() 的协程 UI），
 *     因此不支持的方法明确抛 UnsupportedError 并给出理由，绝不返回虚假成功。
 */
import { EVENTS } from './EventManager.mjs';
import { CORE_CONFIG, ORIGINAL_INPUT } from './config.mjs';

export class UnsupportedError extends Error {
  constructor(method, reason, originalEntry) {
    super(`${method} 不可用：${reason}（原版入口 ${originalEntry}）`);
    this.name = 'UnsupportedError';
    this.method = method;
    this.reason = reason;
    this.originalEntry = originalEntry;
  }
}

const DIRS = Object.freeze(['北', '东北', '东', '东南', '南', '西南', '西', '西北']);
const freeze = (o) => Object.freeze(o);

/** 轻量字符串签名（FNV-1a），用于「同一状态变化不重复派发」。 */
function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 菜单文本是连续 2 字一项的中文串（P0 §11.C 已逐项验证）。 */
function splitMenu(text) {
  const out = [];
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 2) out.push(s.slice(i, i + 2));
  return out;
}

export class GameAdapter {
  /**
   * @param {object} core   window.__SGBY_CORE__（浏览器）或同构对象（Node 测试，数据取自 game.zip）
   * @param {EventManager} events
   */
  constructor({ core, events }) {
    if (!core) throw new TypeError('GameAdapter 需要 core');
    if (!events) throw new TypeError('GameAdapter 需要 events');
    this.core = core;
    this.events = events;
    this._connected = false;
    this._last = null;
    this._sceneId = null;
    this._restore = [];
    this._watchdog = null;
    this._cache = new Map();
    this._waiterKind = 'unknown';   // P2：最近一次 waitMsg 的调用协程（只读诊断）
    this._mapCache = { key: null, value: null };   // P4：战斗地图投影缓存（一场战斗内不变）
    this.stats = { syncCount: 0, inputHooks: 0, contextHooks: 0, lastSource: null,
      selectionRequests: 0, injectedMessages: 0 };
    this.capabilities = this._buildCapabilities();
  }

  get connected() { return this._connected; }
  get lib() { return this.core.lib; }

  // =============================================================== 连接
  /**
   * 等待原版资源库就绪并安装状态同步钩子。
   * 浏览器默认全开；Node 测试用 {requireInput:false, installHooks:false, watchdog:false}。
   */
  async connect({ requireInput = true, installHooks = true, watchdog = true } = {}) {
    if (this._connected) return true;
    const ready = await this._waitFor(() => {
      const lib = this.core.lib;
      if (!lib || typeof lib.getItem !== 'function') return false;
      // 关键时序：原版先赋值 Dn.lib（L8563），随后 Oa() 才构造 g_Cities/g_Persons
      // （L7716-7719）。只等 lib 会连到「0 城 0 将」的半成品状态。
      const Dn = this.core.Dn;
      if (!Dn || !Dn.g_Cities || !Dn.g_Cities.length || !Dn.g_Persons || !Dn.g_Persons.length) return false;
      if (!requireInput) return true;
      return !!(this.core.l && this.core.l.input);
    });
    if (!ready) {
      throw new Error(`GameAdapter 等待原版内核超时（${CORE_CONFIG.readyTimeoutMs}ms）；`
        + '请确认通过 index3d.html 加载了 sgby.core.js，且 assets/game.zip 可访问');
    }
    if (installHooks) this._installHooks();
    this._last = this._snapshot();
    this._connected = true;
    this.events.emit(EVENTS.GAME_INITIALIZED, {
      cityCount: this.core.Dn.g_Cities.length,
      officerCount: this.core.Dn.g_Persons.length,
      source: 'sgby.core.js',
    });
    if (watchdog && typeof setInterval === 'function') {
      this._watchdog = setInterval(() => {
        if (this._connected) this.sync({ source: 'watchdog' });
      }, CORE_CONFIG.syncWatchdogMs);
    }
    return true;
  }

  async _waitFor(predicate) {
    const t0 = Date.now();
    while (!predicate()) {
      if (Date.now() - t0 > CORE_CONFIG.readyTimeoutMs) return false;
      await new Promise((r) => setTimeout(r, CORE_CONFIG.readyPollMs));
    }
    return true;
  }

  /** 包装原版输入入口与已有上下文钩子；不改变业务逻辑，仅在其后读取真实状态。 */
  _installHooks() {
    const input = this.core.l && this.core.l.input;
    if (input && typeof input.waitMsg === 'function' && typeof input.pushMsg === 'function') {
      const original = input.waitMsg;
      const self = this;
      input.waitMsg = function (...args) {
        // P2：只读记录「谁在等待输入」。zs()/ei()/Ba() 都是压缩后保留的函数名，
        // 同步调用栈里会出现 `at zs (`。用于避免在主菜单/城市菜单阶段误注入选城输入。
        // 不改动原版返回值、不改动任何游戏状态。
        let kind = 'unknown';
        try {
          const stack = new Error().stack || '';
          if (/\bat\s+(?:async\s+)?zs\s*\(/.test(stack)) kind = 'zs';
          else if (/\bat\s+(?:async\s+)?ei\s*\(/.test(stack)) kind = 'ei';
          else if (/\bat\s+(?:async\s+)?Ba\s*\(/.test(stack)) kind = 'menu';
        } catch (_) { /* 忽略：诊断信息不可用不影响原版逻辑 */ }
        self._waiterKind = kind;
        return Promise.resolve(original.apply(this, args)).then((msg) => {
          self.stats.inputHooks++;
          self.sync({ source: 'input' });
          return msg;
        });
      };
      this._restore.push(() => { input.waitMsg = original; });
    }

    if (typeof window !== 'undefined') {
      const desc = Object.getOwnPropertyDescriptor(window, '__SGBY_CTX');
      let value = window.__SGBY_CTX ?? 0;
      const self = this;
      try {
        Object.defineProperty(window, '__SGBY_CTX', {
          configurable: true,
          get() { return value; },
          set(next) {
            value = next;
            self.stats.contextHooks++;
            self.events.emit(EVENTS.ORDER_CONTEXT_CHANGED, { ctx: next || 0 });
            self.sync({ source: 'ctx' });
          },
        });
        this._restore.push(() => {
          Object.defineProperty(window, '__SGBY_CTX',
            desc || { value, writable: true, configurable: true, enumerable: true });
        });
      } catch (e) {
        console.warn('[P1] __SGBY_CTX 钩子安装失败（不影响状态读取）：', e.message);
      }
    }
  }

  // ========================================================== 只读：游戏
  getGameState() {
    const Dn = this.core.Dn, lib = this.core.lib;
    return freeze({
      year: Dn.g_YearDate,
      month: Dn.g_MonthDate,
      playerKing: Dn.g_PlayerKing,
      period: Dn.g_PIdx,
      difficulty: Dn.g_Diff,
      cityCount: Dn.g_Cities.length,
      officerCount: Dn.g_Persons.length,
      goodsCount: Dn.g_GoodsQueue.length,
      // 与 Oa() L7665 同口径：技能数 = 技能数据(资源10)字节数 / 34
      skillCount: (() => { const t = this._const(lib, 10, 1); return t ? Math.floor(t.length / 34) : null; })(),
      orderQueueLength: Dn.g_OrderQueue.length,
      lookEnemy: Dn.g_LookEnemy,
      lookMovie: Dn.g_LookMovie,
      moveSpeed: Dn.g_MoveSpeed,
      source: 'Dn (sgby.core.js)',
    });
  }

  /** 原版没有场景枚举；此处返回表现层当前场景，来源明确标注。 */
  getCurrentScene() { return freeze({ id: this._sceneId, source: 'presentation(SceneManager)' }); }
  setCurrentScene(id) { this._sceneId = id; }

  getCurrentTurn() {
    const Dn = this.core.Dn;
    return freeze({
      year: Dn.g_YearDate,
      month: Dn.g_MonthDate,
      battleRound: Dn.g_FgtBoutCnt,
      source: 'Dn.g_YearDate/g_MonthDate/g_FgtBoutCnt',
    });
  }

  // ========================================================== 只读：城市
  _const(lib, id, idx) {
    const k = `${id}:${idx}`;
    if (!this._cache.has(k)) this._cache.set(k, lib.getItem(id, idx));
    return this._cache.get(k);
  }

  /** P4：内核导出的原版战斗函数（旧内核没有 p4 时返回 null，由调用方如实报错）。 */
  _battleFns() {
    const p4 = this.core.p4;
    return p4 && p4.battle ? p4.battle : null;
  }

  getCities() { return freeze(this.core.Dn.g_Cities.map((_, i) => this.getCity(i))); }

  getCity(cityId) {
    const Dn = this.core.Dn, lib = this.core.lib;
    const c = Dn.g_Cities[cityId];
    if (!c) throw new RangeError(`城市 ID 越界: ${cityId}（共 ${Dn.g_Cities.length} 城）`);
    const coords = this._const(lib, 2, 6);      // 城市坐标 38×2
    const mapIds = this._const(lib, 2, 15);     // 城市地图 id
    const layout = this._const(lib, 2, 14);     // 城市布局 9×12
    const x = coords ? coords[cityId * 2] : null;
    const y = coords ? coords[cityId * 2 + 1] : null;
    return freeze({
      id: cityId,
      name: lib.getStr(58, cityId + 1),        // 资源 58 = 城市名（1-based）
      ownerId: c.Belong,                        // 0 空城；否则 = 君主武将 index+1
      position: freeze({ x, y }),               // 原版 12×9 逻辑格坐标，未经任何缩放
      layoutValue: layout && y !== null ? layout[y * 12 + x] : null, // 应等于 cityId+1
      battleMapId: mapIds ? mapIds[cityId] : null,
      state: c.Id,                              // 0 正常 / 1 饥荒 / 2 旱灾 / 3 水灾 / 4 暴动
      satrapId: c.SatrapId,
      farming: c.Farming, farmingLimit: c.FarmingLimit,
      commerce: c.Commerce, commerceLimit: c.CommerceLimit,
      peopleDevotion: c.PeopleDevotion, avoidCalamity: c.AvoidCalamity,
      population: c.Population, populationLimit: c.PopulationLimit,
      money: c.Money, food: c.Food, mothballArms: c.MothballArms,
      officerCount: c.Persons, officerQueue: c.PersonQueue,
      toolCount: c.Tools, toolQueue: c.ToolQueue,
      source: 'Dn.g_Cities + lib.getItem(2,6/14/15) + lib.getStr(58)',
    });
  }

  /** 城市连接：资源 59「城市连接右」，每城 16B（8 连接 + 8 距离）。 */
  getCityConnections(cityId) {
    const lib = this.core.lib;
    const t = this._const(lib, 59, 1);
    if (!t) throw new Error('资源包缺少城市连接右（59）');
    const base = 16 * cityId;
    if (base + 16 > t.length) throw new RangeError(`城市 ID 越界: ${cityId}`);
    return freeze(DIRS.map((dir, k) => freeze({
      dir,
      directionIndex: k,
      cityId: t[base + k] ? t[base + k] - 1 : null,   // 原版连接值 = 城市编号+1，0 无
      distance: t[base + 8 + k],
    })));
  }

  /** 城市菜单真实功能与顺序：getConst(37..40) + 消耗表 getItem(2,10)/getItem(2,11)。 */
  getCityActions(cityId) {
    const lib = this.core.lib;
    this.getCity(cityId); // 触发越界校验
    const main = splitMenu(lib.getConst(37));           // 内政 外交 军备 状况
    const thew = this._const(lib, 2, 10);
    const money = this._const(lib, 2, 11);
    const make = (text, baseId) => splitMenu(text).map((name, k) => {
      const id = baseId + k;
      return freeze({
        id, name,
        costThew: thew ? thew[id] : null,
        costMoney: money ? money[id] : null,
      });
    });
    return freeze({
      cityId,
      main: freeze(main),
      groups: freeze([
        freeze({ name: main[0] ?? '内政', items: freeze(make(lib.getConst(38), 1)) }),
        freeze({ name: main[1] ?? '外交', items: freeze(make(lib.getConst(39), 15)) }),
        freeze({ name: main[2] ?? '军备', items: freeze(make(lib.getConst(40), 23)) }),
      ]),
      controls: freeze({ infoActionId: 254, cancelCode: 255 }),
      note: '指令 20-22 不是主菜单项；[40..42] 为输送/交易内部数值操作子项（P0 §11.C）',
      source: 'lib.getConst(37..40) + lib.getItem(2,10/11)',
    });
  }

  /**
   * P2：战略地图道路拓扑。把资源 59 的 8 方向有向连接合并成无向唯一边，
   * 但保留每一侧原始的 directionIndex / distance（不丢任何原版信息）。
   * 运行时只使用右表（getItem(59,1)）；左表 60 全文未被调用，见 P0 §3.3。
   */
  getCityLinks() {
    const cities = this.core.Dn.g_Cities;
    const edges = new Map();
    for (let i = 0; i < cities.length; i++) {
      for (const link of this.getCityConnections(i)) {
        const to = link.cityId;
        if (to === null || to < 0 || to >= cities.length || to === i) continue;
        const from = Math.min(i, to), last = Math.max(i, to);
        const key = `${from}-${last}`;
        if (!edges.has(key)) edges.set(key, { from, to: last, forward: null, backward: null });
        const edge = edges.get(key);
        const rec = freeze({
          from: i, to, dir: link.dir, directionIndex: link.directionIndex,
          distance: link.distance, source: 'getItem(59,1)',
        });
        if (i === from) edge.forward = rec; else edge.backward = rec;
      }
    }
    return freeze([...edges.values()].map((e) => freeze({
      from: e.from, to: e.to, forward: e.forward, backward: e.backward,
      source: 'getItem(59,1) 去重（双向原始记录保留）',
    })));
  }

  /**
   * P2：势力投影。原版没有独立势力表，势力 = 君主武将
   * （Belong = 君主武将 index + 1，玩家 g_PlayerKing 同为武将 index，见 P0 §3.4）。
   * 名称一律走原版 $n() / getStr(62)，不另造势力数据。
   */
  getFactions() {
    const Dn = this.core.Dn, cities = Dn.g_Cities;
    const ids = [...new Set(cities.map((c) => c.Belong))].sort((a, b) => a - b);
    return freeze(ids.map((id) => {
      let name = '';
      if (id > 0) {
        try { name = this.getOfficer(id - 1).name; }
        catch (_) { name = this.core.lib.getStr(62, id) || ''; }
      }
      return freeze({
        id, name,
        isPlayer: id === Dn.g_PlayerKing + 1,
        cityCount: cities.filter((c) => c.Belong === id).length,
        source: 'Dn.g_Cities[].Belong + $n() / lib.getStr(62)',
      });
    }));
  }

  /**
   * P2：原版战略地图光标（只读）。zs(Dn.g_CityPos) 与 qs() 共用该对象；
   * citymap 由 qs() 按 城市布局(2,14) 填充，值为城市编号+1，0 表示空格。
   * 这就是「原版选城结果」的可观测形式——不是表现层伪造的选中状态。
   */
  getCityCursor() {
    const Dn = this.core.Dn, p = Dn.g_CityPos;
    if (!p) throw new Error('Dn.g_CityPos 不存在（内核未初始化）');
    const row = p.sety - p.y, col = p.setx;
    const map = Dn.citymap;
    const value = map && map[row] ? map[row][col] : 0;
    return freeze({
      setx: p.setx, sety: p.sety, x: p.x, y: p.y, row, col,
      cityId: value ? value - 1 : null,
      populated: !!(map && map.length),
      source: 'Dn.g_CityPos + Dn.citymap (qs() L4179-4187 / zs() L4247)',
    });
  }

  // ========================================================== 只读：武将
  getOfficers(cityId) {
    const Dn = this.core.Dn, c = Dn.g_Cities[cityId];
    if (!c) throw new RangeError(`城市 ID 越界: ${cityId}`);
    const q = Dn.g_PersonsQueue, out = [];
    for (let k = 0; k < c.Persons; k++) {
      const pid = q[c.PersonQueue + k];
      if (pid !== undefined) out.push(this.getOfficer(pid));
    }
    return freeze(out);
  }

  getOfficer(officerId) {
    const Dn = this.core.Dn, p = Dn.g_Persons[officerId];
    if (!p) throw new RangeError(`武将 ID 越界: ${officerId}`);
    const fns = this.core.fns || {};
    const name = typeof fns.$n === 'function'
      ? fns.$n(officerId)                                  // 原版真实查表（随时期）
      : this.core.lib.getStr(62, officerId + 1);           // fallback：时期 1 名字表
    return freeze({
      id: officerId,
      name,
      ownerId: p.Belong,        // 0 在野 / 65535 俘虏 / 否则君主武将 index+1
      level: p.Level, force: p.Force, iq: p.IQ,
      devotion: p.Devotion, character: p.Character,
      experience: p.Experience, thew: p.Thew,
      armsType: p.ArmsType, arms: p.Arms,
      equip: freeze([p.Equip[0], p.Equip[1]]),
      age: p.Age, runtimeId: p.Id,
      source: 'Dn.g_Persons(Un) + $n()',
    });
  }

  // ========================================================== 只读：战斗
  getBattleState() {
    const Dn = this.core.Dn, f = Dn.g_FgtParam || {};
    const b = this._battleFns();
    return freeze({
      over: Dn.g_FgtOver,
      round: Dn.g_FgtBoutCnt,
      weather: Dn.g_FgtWeather,
      mapId: f.MapId, mode: f.Mode, way: f.Way,
      width: Dn.g_MapWid, height: Dn.g_MapHgt,
      // 地图与部队位置只有在原版 yo()（L5744）跑完后才有效，这里如实暴露就绪状态
      mapReady: !!(b && Dn.g_MapWid > 0 && Dn.g_MapHgt > 0 && Dn.g_GenPos && Dn.g_GenPos.length >= 20),
      tilePicId: b ? b.tilePicId : null,
      provender: freeze({ mine: f.MProvender, enemy: f.EProvender }),
      viewport: freeze({ sx: Dn.g_MapSX, sy: Dn.g_MapSY, cols: 15, rows: 17 }),
      focus: freeze({ x: Dn.g_FoucsX, y: Dn.g_FoucsY }),
      // 原版没有 active 标志：以下为表现层推断，已显式标注，不当作原版字段
      activeInferred: Dn.g_FgtBoutCnt > 0 && Dn.g_FgtOver === 0,
      inferredNote: 'activeInferred 由回合数/结束标志推断；原版无对应字段',
      source: 'Dn.g_FgtParam/g_FgtOver/g_FgtBoutCnt/g_MapWid/g_MapHgt',
    });
  }

  getBattleUnits() {
    const Dn = this.core.Dn;
    const gen = Dn.g_FgtParam && Dn.g_FgtParam.GenArray;
    return freeze((Dn.g_GenPos || []).map((u, i) => this._projectUnit(i, u, gen)));
  }

  getBattleUnit(unitId) {
    const Dn = this.core.Dn;
    const u = Dn.g_GenPos && Dn.g_GenPos[unitId];
    if (!u) throw new RangeError(`部队 ID 越界: ${unitId}`);
    return this._projectUnit(unitId, u, Dn.g_FgtParam && Dn.g_FgtParam.GenArray);
  }

  /**
   * P4：单支部队的只读投影。
   * 名称走原版 $n()，兵种/状态/势力文字走原版界面字符串表（getStr(1,12/28+)），
   * 不做任何推断；`present=false` 表示该槽位在原版 GenArray 里是空的。
   */
  _projectUnit(index, u, gen) {
    const Dn = this.core.Dn, lib = this.core.lib;
    const genValue = gen ? gen[index] : 0;
    const officerId = genValue ? genValue - 1 : null;
    const present = genValue > 0;
    let person = null;
    if (present && Dn.g_Persons && Dn.g_Persons[officerId]) person = Dn.g_Persons[officerId];
    const armsType = person ? person.ArmsType : null;
    const belong = person ? person.Belong : 0;
    let name = '';
    if (present) {
      const fns = this.core.fns || {};
      name = typeof fns.$n === 'function' ? fns.$n(officerId) : lib.getStr(62, officerId + 1);
    }
    return freeze({
      index,
      side: index < 10 ? 'mine' : 'enemy',
      present,
      x: u.x, y: u.y, hp: u.hp, mp: u.mp,
      move: u.move, active: u.active, state: u.state,
      officerId,
      name,
      belong,
      armsType,
      armsTypeName: armsType === null ? '' : String(lib.getStr(1, 12) || '').substr(armsType * 2, 2),
      arms: person ? person.Arms : null,
      level: person ? person.Level : null,
      stateName: String(lib.getStr(1, 28 + u.state) || ''),   // 原版 vi(28+state)，Oo() L6282
      source: 'Dn.g_GenPos + g_FgtParam.GenArray + $n() + getStr(1,12/28+)',
    });
  }

  /**
   * P4：某支部队此刻是否**允许被玩家操作**。
   *
   * 判定完全复用原版 Xo()（L6433）：它只扫我方 0..9，按
   *   state!==8（在场）、active===0（未行动）、state!==1/6（混乱/石阵）
   * 返回焦点格上的部队下标。这里临时把 g_FoucsX/Y 指向该部队、同步调用后立刻还原，
   * 因此不复制任何规则，也不留下任何状态改动（焦点是纯显示用的临时量）。
   */
  canSelectUnit(unitId) {
    const Dn = this.core.Dn, b = this._battleFns();
    const u = Dn.g_GenPos && Dn.g_GenPos[unitId];
    if (!u) throw new RangeError(`部队 ID 越界: ${unitId}`);
    if (!b || typeof b.Xo !== 'function') return false;
    const fx = Dn.g_FoucsX, fy = Dn.g_FoucsY;
    try {
      Dn.g_FoucsX = u.x;
      Dn.g_FoucsY = u.y;
      return b.Xo() === unitId;
    } finally {
      Dn.g_FoucsX = fx;
      Dn.g_FoucsY = fy;
    }
  }

  /**
   * P4：原版战斗地图（Ci() = lib.getItem(g_FgtParam.MapId, 1)）。
   *   头部 16 字节：byte0=宽、byte2=高（yo() L5755 就是按这两个值取 g_MapWid/Hgt）
   *   之后是 width*height 个图块号，直接对应 lib.loadPic(4,1) 的 46 帧
   *   地形类别由原版 Ui() 给出（0..7：草地/平原/山地/森林/村庄/城池/营寨/河流）
   */
  getBattleMap() {
    const Dn = this.core.Dn, f = Dn.g_FgtParam || {};
    const b = this._battleFns();
    if (!b) {
      throw new UnsupportedError('getBattleMap',
        '内核未导出 p4.battle（sgby.core.js 版本过旧，请重新执行 node tools/make_core.mjs）', 'Ci() L5374');
    }
    if (!Dn.g_MapWid || !Dn.g_MapHgt) {
      return freeze({ available: false, mapId: f.MapId,
        reason: '战斗尚未初始化（原版 yo() 未执行完）', source: 'Dn.g_MapWid/g_MapHgt' });
    }
    const data = b.Ci();
    if (!data) return freeze({ available: false, mapId: f.MapId, reason: '资源包缺少该战斗地图', source: 'Ci()' });
    const w = Dn.g_MapWid, h = Dn.g_MapHgt;
    // 同一场战斗内地图数据不会变：按 mapId 缓存 1024 格投影，避免 HUD 每次刷新重算
    const cacheKey = `${f.MapId}:${w}x${h}:${data.length}`;
    if (this._mapCache.key === cacheKey) return this._mapCache.value;
    const raw = new Uint8Array(w * h);
    const terrain = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        raw[k] = data[16 + k];
        terrain[k] = b.Ui(x, y);        // 原版地形归类，本层不推导
      }
    }
    return freeze({
      available: true,
      mapId: f.MapId,
      width: w,
      height: h,
      cellCount: w * h,
      tilePicId: b.tilePicId,           // 4 = 战斗地图图块（46 帧）
      raw,                              // 图块号（0..45），直接对应图集帧
      terrain,                          // 原版 Ui() 地形类别 0..7
      terrainNames: freeze(this.getBattleTerrainNames()),
      source: 'Ci() = lib.getItem(MapId,1)；宽高 = 头部[0]/[2]；地形 = Ui()',
    });
  }

  /** 战斗地图投影缓存清理（换一场战斗时由适配层自己失效，无需外部调用）。 */
  invalidateBattleMap() { this._mapCache = { key: null, value: null }; }

  /** P4：8 种地形短名，来自原版界面字符串 [7]（每 2 字一项）。 */
  getBattleTerrainNames() {
    const s = String(this.core.lib.getStr(1, 7) || '');
    const out = [];
    for (let i = 0; i + 1 < s.length; i += 2) out.push(s.slice(i, i + 2));
    return out;
  }

  /** P4：单格只读投影（调试面板与 HUD 用）。 */
  getBattleCell(x, y) {
    const map = this.getBattleMap();
    if (!map.available) return freeze({ available: false, reason: map.reason });
    if (!(x >= 0 && x < map.width && y >= 0 && y < map.height)) {
      throw new RangeError(`格子越界: (${x},${y})，地图 ${map.width}x${map.height}`);
    }
    const k = y * map.width + x;
    const cls = map.terrain[k];
    return freeze({
      x, y,
      tile: map.raw[k],
      terrain: cls,
      terrainName: map.terrainNames[cls] || '',
      description: String(this.core.lib.getStr(1, 14 + cls) || ''),   // 原版 Oo() L6285
      source: 'Ui() + getStr(1,7/14+)',
    });
  }

  /**
   * P4：移动范围 —— **调用原版 qi()**（L5524）算出 15x15 局部窗口位图，
   * 再按原版自己的偏移（g_PathSX-g_PUseSX）还原成全图格坐标。
   *
   * 取值语义与原版 ea()（L6659「画移动范围」）完全一致：0 < v < Me(128) 即可到达，
   * 起始格由 qi() 末尾置 0，因此不会把自己算进目标格。
   *
   * qi() 会写 g_FightPath 与 4 个 g_Path* 坐标 —— 它们都是原版每帧重算的临时量。
   * 为了让 2D 原版流程完全不受影响，调用前后做快照/还原（同步执行，无并发）。
   */
  getMovementRange(unitId) {
    const Dn = this.core.Dn, b = this._battleFns();
    const u = Dn.g_GenPos && Dn.g_GenPos[unitId];
    if (!u) throw new RangeError(`部队 ID 越界: ${unitId}`);
    if (!b || typeof b.qi !== 'function') {
      throw new UnsupportedError('getMovementRange', '内核未导出 p4.battle.qi', 'qi() L5524');
    }
    if (!Dn.g_MapWid) {
      return freeze({ available: false, unitId, reason: '战斗尚未初始化（原版 yo() 未执行完）', source: 'Dn.g_MapWid' });
    }
    if (!u.move) {
      return freeze({ available: false, unitId, reason: '该部队移动力为 0（原版本回合不可移动）', source: 'Dn.g_GenPos[].move' });
    }
    const path = Dn.g_FightPath;
    const snap = {
      path: Uint8Array.from(path),
      sx: Dn.g_PathSX, sy: Dn.g_PathSY, usx: Dn.g_PUseSX, usy: Dn.g_PUseSY,
      bakX: Dn.g_BakUpX, bakY: Dn.g_BakUpY,
    };
    try {
      b.qi(unitId);
      const origin = { x: (Dn.g_PathSX - Dn.g_PUseSX) & 0xff, y: (Dn.g_PathSY - Dn.g_PUseSY) & 0xff };
      const width = b.grid.pathWidth;      // 15
      const limit = b.grid.blockCost;      // 128
      const cells = [];
      for (let row = 0; row < width; row++) {
        for (let col = 0; col < width; col++) {
          const v = path[row * width + col];
          if (v > 0 && v < limit) cells.push(freeze({ x: origin.x + col, y: origin.y + row, remaining: v }));
        }
      }
      return freeze({
        available: true,
        unitId,
        self: freeze({ x: u.x, y: u.y }),
        origin: freeze(origin),
        windowSize: width,
        cells: freeze(cells),
        cellCount: cells.length,
        raw: Uint8Array.from(path.subarray(0, b.grid.pathBytes)),
        source: '原版 qi()（移动力/地形消耗/占位全由它算），本层只做坐标还原',
      });
    } finally {
      path.set(snap.path);
      Dn.g_PathSX = snap.sx; Dn.g_PathSY = snap.sy;
      Dn.g_PUseSX = snap.usx; Dn.g_PUseSY = snap.usy;
      Dn.g_BakUpX = snap.bakX; Dn.g_BakUpY = snap.bakY;
    }
  }

  /**
   * P4：攻击范围 —— 调用原版 Vo(0,0,unitId)（L6628，普通攻击 5x5 掩码，
   * 掩码来自资源 2 项 2 的「兵种攻击范围」）。技能范围是 Vo(1,skill,unitId) 的 9x9，
   * P5 才接入技能选择，本阶段只做普通攻击范围。
   *
   * 同样快照/还原 g_FgtAtkRng：原版 zo()（L6600）在敌方自动反击时**直接复用**
   * 这份位图，若被表现层污染会改变战斗结果，因此必须还原。
   */
  getAttackRange(unitId) {
    const Dn = this.core.Dn, b = this._battleFns();
    if (!Dn.g_GenPos || !Dn.g_GenPos[unitId]) throw new RangeError(`部队 ID 越界: ${unitId}`);
    if (!b || typeof b.Vo !== 'function') {
      throw new UnsupportedError('getAttackRange', '内核未导出 p4.battle.Vo', 'Vo() L6628');
    }
    if (!Dn.g_MapWid) {
      return freeze({ available: false, unitId, reason: '战斗未开始', source: 'Dn.g_MapWid' });
    }
    const rng = Dn.g_FgtAtkRng;
    const snap = Uint8Array.from(rng);
    try {
      b.Vo(0, 0, unitId);
      const size = rng[0];
      const origin = { x: rng[1], y: rng[2] };
      const cells = [];
      for (let i = 0; i < size * size; i++) {
        if (rng[3 + i] !== 1) continue;                 // 与原版 Ho() L6620 同一判定
        cells.push(freeze({ x: origin.x + (i % size), y: origin.y + Math.floor(i / size) }));
      }
      return freeze({
        available: true,
        unitId,
        kind: 'normal',
        size,
        origin: freeze(origin),
        cells: freeze(cells),
        cellCount: cells.length,
        bitmap: Uint8Array.from(rng.subarray(3, 3 + size * size)),
        source: '原版 Vo(0,0,unitId)；掩码来自 getItem(2,2) 兵种攻击范围',
      });
    } finally {
      rng.set(snap);
    }
  }

  // ========================================================== 操作通道
  /** 原版规定的输入注入入口：class A.pushMsg()（P0 L467）。消息格式见 P0 §6.4。 */
  sendInput(msg) {
    const input = this.core.l && this.core.l.input;
    if (!input || typeof input.pushMsg !== 'function') {
      throw new UnsupportedError('sendInput', '原版输入实例未就绪', 'class A.pushMsg (L467)');
    }
    if (!msg || typeof msg.type !== 'number') throw new TypeError('输入消息需要数值 type');
    input.pushMsg(msg);
    return true;
  }

  /**
   * P2：只读判断「原版此刻是否处于 zs() 选城输入循环」。
   * 三重判据全部来自真实状态，缺一即拒绝注入，避免在主菜单/城市菜单里误触发输入：
   *   1) l.input.waiters 非空（确实有协程在 await waitMsg）
   *   2) 最近一次 waitMsg 的同步调用栈命中 `at zs (`（_installHooks 记录）
   *   3) 已进剧本（g_YearDate>0）且不在指令上下文（window.__SGBY_CTX === 0）
   */
  getInputPhase() {
    const input = this.core.l && this.core.l.input;
    const Dn = this.core.Dn || {};
    const waiting = !!(input && Array.isArray(input.waiters) && input.waiters.length > 0);
    const inScenario = (Dn.g_YearDate || 0) > 0;
    const inOrderContext = typeof window !== 'undefined' && !!window.__SGBY_CTX;
    const kind = this._waiterKind || 'unknown';
    const canSelectCity = waiting && kind === 'zs' && inScenario && !inOrderContext;
    return freeze({
      kind, waiting, inScenario, inOrderContext, canSelectCity,
      reason: canSelectCity
        ? '原版 zs() 正在等待选城输入'
        : (!waiting ? '原版当前无协程等待输入'
          : kind !== 'zs' ? `当前等待协程为 ${kind}，不是 zs()`
            : !inScenario ? '尚未进入剧本（原版仍在主菜单）'
              : '原版正处于指令上下文'),
      source: 'l.input.waiters + waitMsg 调用栈 + Dn.g_YearDate + window.__SGBY_CTX',
    });
  }

  /**
   * P2：把 3D 城市点击交给**原版选城逻辑**。
   *
   * 原版不存在命令式 selectCity()（P1 已如实标注 UnsupportedError）；zs() 是
   * `await waitMsg()` 的输入循环，只能用原版规定的输入协议驱动：
   *   - 方向键（type:5, param:34/35/36/37）把 Dn.g_CityPos 光标逐格移到目标城
   *   - intent='select' 时追加确认键 39，zs() L4299 `case C: if(o) return o-1`
   *     才真正返回该城给 ka()（此时原版会按自身规则决定后续，表现层不介入）
   *   - intent='cursor'（默认）只定位原版光标，不打开任何菜单，符合 P2 范围
   *
   * 所有消息经 sendInput -> class A.pushMsg，绝不直接写 Dn.g_Cities / g_CityPos。
   * 返回体如实标注 injected 与原因，绝不伪造「原版已选中」。
   */
  requestCitySelection(cityId, { intent = 'cursor', maxSteps = 26 } = {}) {
    const city = this.getCity(cityId);       // 触发 ID 越界校验，取真实逻辑坐标
    const phase = this.getInputPhase();
    if (!phase.canSelectCity) {
      return freeze({ injected: false, cityId, intent, phase,
        reason: `未注入原版输入：${phase.reason}`, source: 'getInputPhase()' });
    }
    if (intent !== 'cursor' && intent !== 'select') {
      throw new RangeError(`未知 intent: ${intent}（可选 cursor / select）`);
    }
    const cur = this.getCityCursor();
    const dx = city.position.x - cur.setx;
    const dy = city.position.y - cur.sety;
    const steps = Math.abs(dx) + Math.abs(dy);
    if (steps > maxSteps) {
      return freeze({ injected: false, cityId, intent, phase, steps,
        reason: `导航步数 ${steps} 超过上限 ${maxSteps}`, source: 'getCityCursor()' });
    }
    const k = ORIGINAL_INPUT.keys;
    const messages = [];
    for (let n = 0; n < Math.abs(dx); n++) {
      messages.push({ type: ORIGINAL_INPUT.keyType, param: dx > 0 ? k.right : k.left });
    }
    for (let n = 0; n < Math.abs(dy); n++) {
      messages.push({ type: ORIGINAL_INPUT.keyType, param: dy > 0 ? k.down : k.up });
    }
    if (intent === 'select') {
      messages.push({ type: ORIGINAL_INPUT.keyType, param: k.confirm });
    }
    for (const msg of messages) this.sendInput(msg);
    this.stats.selectionRequests++;
    this.stats.injectedMessages += messages.length;
    return freeze({
      injected: true, cityId, intent,
      target: freeze({ ...city.position }),
      cursorBefore: cur,
      messageCount: messages.length,
      messages: freeze(messages.map((m) => freeze(m))),
      note: '消息已按原版输入协议投递；原版处理结果须由 getCityCursor() / __SGBY_CTX 事后观测，本返回值不代表原版已选中',
      source: 'class A.pushMsg (L467) + zs() L4290-4305',
    });
  }

  /** 表现层显式通知选中事件（原版无对应事件源，不伪造「原版发出」）。 */
  notifyCitySelected(cityId) { this.events.emit(EVENTS.CITY_SELECTED, { cityId, source: 'presentation' }); }
  notifyUnitSelected(unitId) { this.events.emit(EVENTS.UNIT_SELECTED, { unitId, source: 'presentation' }); }

  // ---------------------------------------------------------- 未接入接口
  selectCity() {
    throw new UnsupportedError('selectCity',
      '原版 zs() 是 await waitMsg() 的输入循环，方向是「返回被点城市 ID」，没有命令式 selectCity；P1 提供 sendInput() 走原版输入协议',
      'zs() L4247');
  }
  executeCityAction() {
    throw new UnsupportedError('executeCityAction',
      '原版 mi(city,orderId) 内部 await Ls()/zs()/Js() 完成选将、选城与数值输入，无参数化命令式入口',
      'mi() L4609');
  }
  selectOfficer() {
    throw new UnsupportedError('selectOfficer',
      '原版 Ls() 是返回选中下标的异步选择窗口，无命令式 selectOfficer',
      'Ls() L3686');
  }
  moveUnit() {
    throw new UnsupportedError('moveUnit',
      '原版移动由 Ao()/Fo()/Qo() 协程驱动，含动画与回合状态，无独立 moveUnit 接口',
      'Ao() L6000 / Fo() L6024');
  }
  attackUnit() {
    throw new UnsupportedError('attackUnit',
      '原版攻击由 Fo()/Bo()/ji() 协程结算，无独立 attackUnit 接口',
      'Fo() L6024 / Bo() L6290');
  }
  endTurn() {
    throw new UnsupportedError('endTurn',
      '原版回合结束是 Ma() 菜单项 + wa()/ma() 协程，无独立 endTurn 接口',
      'Ma() L7449 / wa() L7213 / ma() L7219');
  }

  /** 每个建议接口的真实状态，供 UI/文档展示，避免「看似可用实则伪造」。 */
  _buildCapabilities() {
    const read = (source) => freeze({ status: 'read', source });
    const un = (reason, originalEntry) => freeze({ status: 'unavailable', reason, originalEntry });
    return freeze({
      getGameState: read('Dn'),
      getCurrentScene: read('表现层 SceneManager（原版无场景枚举）'),
      getCurrentTurn: read('Dn.g_YearDate/g_MonthDate/g_FgtBoutCnt'),
      getCities: read('Dn.g_Cities + lib'),
      getCity: read('Dn.g_Cities[cityId]'),
      getCityConnections: read('lib.getItem(59,1)'),
      getCityLinks: read('getItem(59,1) 去重无向边，保留双向原始记录（P2）'),
      getFactions: read('Dn.g_Cities[].Belong + $n()（P2，原版无独立势力表）'),
      getCityCursor: read('Dn.g_CityPos + Dn.citymap（P2，原版选城结果）'),
      getInputPhase: read('l.input.waiters + waitMsg 调用栈 + Dn.g_YearDate（P2）'),
      getCityActions: read('lib.getConst(37..40) + getItem(2,10/11)'),
      getOfficers: read('g_PersonsQueue + Dn.g_Persons'),
      getOfficer: read('Dn.g_Persons + $n()'),
      getBattleState: read('Dn.g_FgtParam 等'),
      getBattleUnits: read('Dn.g_GenPos + GenArray + $n() + getStr(1,12/28+)'),
      getBattleUnit: read('Dn.g_GenPos[unitId]（P4）'),
      getBattleMap: read('Ci() = lib.getItem(MapId,1) + Ui() 地形归类（P4）'),
      getBattleCell: read('地图 + getStr(1,7/14+)（P4）'),
      getBattleTerrainNames: read('getStr(1,7) 每 2 字一项（P4）'),
      canSelectUnit: read('原版 Xo()，临时借用 g_FoucsX/Y 后立刻还原（P4）'),
      getMovementRange: read('调用原版 qi()，快照/还原 g_FightPath 后还原格坐标（P4）'),
      getAttackRange: read('调用原版 Vo(0,0,id)，快照/还原 g_FgtAtkRng（P4）'),
      sendInput: freeze({ status: 'write', source: 'class A.pushMsg（原版规定入口）' }),
      requestCitySelection: freeze({ status: 'write', source: 'P2：方向键/确认键经 pushMsg 驱动 zs()，需 getInputPhase().canSelectCity' }),
      selectCity: un('原版是输入循环，方向相反', 'zs() L4247'),
      executeCityAction: un('原版是协程 UI，无参数化入口', 'mi() L4609'),
      selectOfficer: un('原版是异步选择窗口', 'Ls() L3686'),
      moveUnit: un('原版由协程驱动，含动画与回合状态', 'Ao()/Fo()'),
      attackUnit: un('原版由协程结算', 'Fo()/Bo()'),
      endTurn: un('原版是菜单项 + 结算协程', 'Ma()/wa()/ma()'),
    });
  }

  getCapabilities() { return this.capabilities; }

  // ============================================================ 状态同步
  _snapshot() {
    const Dn = this.core.Dn;
    const cities = (Dn.g_Cities || []).map((c) => [
      c.Belong, c.Money, c.Food, c.Id, c.Persons, c.SatrapId,
    ].join(','));
    const persons = (Dn.g_Persons || []).map((p) => [
      p.Belong, p.Arms, p.Level, p.Thew,
    ].join(','));
    const orders = (Dn.g_OrderQueue || []).map((o) => o.OrderId).join(',');
    return {
      year: Dn.g_YearDate, month: Dn.g_MonthDate,
      playerKing: Dn.g_PlayerKing, period: Dn.g_PIdx, diff: Dn.g_Diff,
      cities, persons, orders,
      battle: {
        over: Dn.g_FgtOver, round: Dn.g_FgtBoutCnt,
        weather: Dn.g_FgtWeather, mapId: Dn.g_FgtParam && Dn.g_FgtParam.MapId,
      },
    };
  }

  _signature(s) {
    return hashString([
      s.year, s.month, s.playerKing, s.period, s.diff,
      s.cities.join('|'), s.persons.join('|'), s.orders,
      Object.values(s.battle).join(','),
    ].join('#'));
  }

  /** 比较真实状态快照，仅在变化时派发事件；不在渲染循环里无条件全量读取。 */
  sync({ source = 'manual' } = {}) {
    if (!this.core.Dn) return { changed: false, reason: 'Dn 未就绪' };
    const now = this._snapshot();
    const prev = this._last;
    this.stats.syncCount++;
    this.stats.lastSource = source;
    if (!prev) { this._last = now; return { changed: false, reason: '首次快照' }; }
    const sig = this._signature(now);
    const oldSig = this._signature(prev);
    if (sig === oldSig) return { changed: false, signature: sig };
    const emitted = [];

    const turnChanged = now.year !== prev.year || now.month !== prev.month;
    if (turnChanged) {
      this.events.emit(EVENTS.TURN_CHANGED, {
        year: now.year, month: now.month, previous: { year: prev.year, month: prev.month },
      }, { dedupeKey: `turn:${now.year}:${now.month}` });
      emitted.push(EVENTS.TURN_CHANGED);
    }

    const n = Math.min(now.cities.length, prev.cities.length);
    for (let i = 0; i < n; i++) {
      if (now.cities[i] === prev.cities[i]) continue;
      const [belong, money, food, state, persons, satrap] = now.cities[i].split(',');
      const prevBelong = prev.cities[i].split(',')[0];
      if (belong !== prevBelong) {
        this.events.emit(EVENTS.CITY_OWNER_CHANGED, {
          cityId: i, oldOwnerId: Number(prevBelong), newOwnerId: Number(belong),
        }, { dedupeKey: `owner:${i}:${prevBelong}:${belong}:${sig}` });
        emitted.push(EVENTS.CITY_OWNER_CHANGED);
      } else {
        this.events.emit(EVENTS.CITY_UPDATED, {
          cityId: i,
          fields: freeze({ money: Number(money), food: Number(food), state: Number(state),
            officerCount: Number(persons), satrapId: Number(satrap) }),
        }, { dedupeKey: `city:${i}:${sig}` });
        emitted.push(EVENTS.CITY_UPDATED);
      }
    }

    if (now.persons.join('|') !== prev.persons.join('|')) {
      const changed = [];
      for (let i = 0; i < Math.min(now.persons.length, prev.persons.length); i++) {
        if (now.persons[i] !== prev.persons[i]) changed.push(i);
      }
      this.events.emit(EVENTS.OFFICER_UPDATED, { officerIds: freeze(changed) },
        { dedupeKey: `officer:${sig}` });
      emitted.push(EVENTS.OFFICER_UPDATED);
    }

    const b = now.battle, pb = prev.battle;
    if (b.round !== pb.round || b.over !== pb.over || b.mapId !== pb.mapId) {
      if (pb.round === 0 && b.round > 0) {
        this.events.emit(EVENTS.BATTLE_STARTED, { mapId: b.mapId }, { dedupeKey: `bstart:${b.mapId}:${sig}` });
        emitted.push(EVENTS.BATTLE_STARTED);
      }
      if (pb.over === 0 && b.over !== 0) {
        this.events.emit(EVENTS.BATTLE_FINISHED, { result: b.over }, { dedupeKey: `bfinish:${sig}` });
        emitted.push(EVENTS.BATTLE_FINISHED);
      }
      this.events.emit(EVENTS.BATTLE_STATE_UPDATED, {
        round: b.round, over: b.over, weather: b.weather, mapId: b.mapId,
      }, { dedupeKey: `battle:${sig}` });
      emitted.push(EVENTS.BATTLE_STATE_UPDATED);
    }

    this.events.emit(EVENTS.GAME_STATE_UPDATED, {
      signature: sig, source, turn: freeze({ year: now.year, month: now.month }),
    }, { dedupeKey: `state:${sig}` });
    emitted.push(EVENTS.GAME_STATE_UPDATED);

    this._last = now;
    return { changed: true, signature: sig, emitted: freeze(emitted) };
  }

  dispose() {
    this._connected = false;
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
    for (const restore of this._restore.splice(0)) {
      try { restore(); } catch (e) { console.warn('[P1] 钩子恢复失败:', e.message); }
    }
    this._cache.clear();
    this._last = null;
  }
}
