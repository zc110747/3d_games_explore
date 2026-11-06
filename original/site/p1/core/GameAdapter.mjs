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
    return freeze({
      over: Dn.g_FgtOver,
      round: Dn.g_FgtBoutCnt,
      weather: Dn.g_FgtWeather,
      mapId: f.MapId, mode: f.Mode, way: f.Way,
      width: Dn.g_MapWid, height: Dn.g_MapHgt,
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
    return freeze((Dn.g_GenPos || []).map((u, i) => freeze({
      index: i,
      side: i < 10 ? 'mine' : 'enemy',
      x: u.x, y: u.y, hp: u.hp, mp: u.mp,
      move: u.move, active: u.active, state: u.state,
      officerId: gen ? gen[i] - 1 : null,   // GenArray 值 = 武将编号+1
      source: 'Dn.g_GenPos + g_FgtParam.GenArray',
    })));
  }

  /**
   * 原版 qi() 计算的 15×15 局部窗口位图（Dn.g_FightPath 前 225 字节）。
   * P1 只透传原始位图，不解释「剩余移动力」语义、不重算规则。
   */
  getMovementRange(unitId) {
    const Dn = this.core.Dn;
    if (!Number.isInteger(unitId) || unitId < 0 || unitId >= (Dn.g_GenPos || []).length) {
      throw new RangeError(`部队 ID 越界: ${unitId}`);
    }
    const path = Dn.g_FightPath;
    return freeze({
      unitId,
      windowSize: 15,
      origin: freeze({ x: Dn.g_PathSX - Dn.g_PUseSX, y: Dn.g_PathSY - Dn.g_PUseSY }),
      raw: path ? Uint8Array.from(path.subarray(0, 225)) : new Uint8Array(0),
      freshness: 'unknown',
      note: '原版 qi() 的瞬时缓存；仅当原版流程正在计算该部队移动范围时有效。P1 不解释规则。',
      source: 'Dn.g_FightPath / g_PathSX / g_PathSY / g_PUseSX / g_PUseSY',
    });
  }

  /** 原版 Vo() 计算的攻击范围位图（5×5 普通 / 9×9 技能）。同样只透传。 */
  getAttackRange(unitId) {
    const Dn = this.core.Dn;
    if (!Number.isInteger(unitId) || unitId < 0 || unitId >= (Dn.g_GenPos || []).length) {
      throw new RangeError(`部队 ID 越界: ${unitId}`);
    }
    const r = Dn.g_FgtAtkRng, size = r ? r[0] : 0;
    return freeze({
      unitId,
      size,
      origin: freeze({ x: r ? r[1] : 0, y: r ? r[2] : 0 }),
      bitmap: r && size ? Uint8Array.from(r.subarray(3, 3 + size * size)) : new Uint8Array(0),
      freshness: 'unknown',
      note: '原版 Vo() 的瞬时缓存；仅当原版流程正在计算攻击范围时有效。P1 不解释规则。',
      source: 'Dn.g_FgtAtkRng[0..2] + 位图',
    });
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
      getBattleUnits: read('Dn.g_GenPos + GenArray'),
      getMovementRange: read('Dn.g_FightPath（瞬时缓存，只透传）'),
      getAttackRange: read('Dn.g_FgtAtkRng（瞬时缓存，只透传）'),
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
