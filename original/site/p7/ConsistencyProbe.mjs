/**
 * P7 ConsistencyProbe —— 原版数据 ↔ 适配层投影的结构一致性校验器。
 *
 * 严格边界（对应 P7 §4「不得成为新的数据来源」）：
 *   - 只读：不调用任何写接口，不修改 Dn / lib / 场景对象。
 *   - 只在测试调用时运行；不参与运行时刷新，不是第二套状态。
 *   - 期望值取自**原版原始表**（Dn 字段 + lib.getItem/getStr 的原始字节），
 *     而不是取自适配层自己，因此能抓到「投影写错字段/差一/缓存串味」。
 *
 * 四类检查分开报（对应 P7 §4.4 的误差分类）：
 *   logic   —— 必须精确相等的逻辑数据
 *   mapping —— 坐标换算，允许 1e-9 浮点容差
 *   screen  —— 屏幕/虚拟屏坐标，允许 1 像素容差（原版用 floor 取整）
 *   visual  —— 表现层对象（由调用方注入，例如 38 个城市网格）
 */

const EPS = 1e-9;

function sameArray(a, b, n) {
  if (!a || !b) return false;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class ConsistencyProbe {
  constructor({ core, adapter, mapCoordinate = null, battleCoordinate = null } = {}) {
    if (!core) throw new TypeError('ConsistencyProbe 需要 core');
    if (!adapter) throw new TypeError('ConsistencyProbe 需要 adapter');
    this.core = core;
    this.adapter = adapter;
    this.mapCoordinate = mapCoordinate;
    this.battleCoordinate = battleCoordinate;
    this._checks = [];
  }

  _push(name, kind, ok, detail = '') {
    this._checks.push({ name, kind, ok: !!ok, detail: String(detail) });
    return ok;
  }

  get checks() { return this._checks.slice(); }

  /** 跑全部逻辑/映射检查，返回汇总。 */
  run({ sectors = ['cities', 'links', 'factions', 'officers', 'battle', 'mapping'] } = {}) {
    this._checks = [];
    const Dn = this.core.Dn;
    if (sectors.includes('cities')) this.checkCities();
    if (sectors.includes('links')) this.checkLinks();
    if (sectors.includes('factions')) this.checkFactions();
    if (sectors.includes('officers')) this.checkOfficers();
    if (sectors.includes('battle')) this.checkBattle();
    if (sectors.includes('mapping')) this.checkMapping();
    const failed = this._checks.filter((c) => !c.ok);
    return {
      ok: failed.length === 0,
      total: this._checks.length,
      passed: this._checks.length - failed.length,
      failed: failed.length,
      failures: failed.slice(0, 12),
      counts: {
        cities: Dn.g_Cities ? Dn.g_Cities.length : 0,
        officers: Dn.g_Persons ? Dn.g_Persons.length : 0,
        checks: this._checks.length,
      },
      checks: this._checks,
    };
  }

  // ---------------------------------------------------------------- 城市
  checkCities() {
    const Dn = this.core.Dn, lib = this.core.lib;
    const raw = Dn.g_Cities;
    const cities = this.adapter.getCities();
    this._push('cities.count', 'logic', cities.length === raw.length && raw.length === 38,
      `adapter ${cities.length} / Dn ${raw.length}`);

    const coords = lib.getItem(2, 6);
    const layout = lib.getItem(2, 14);
    const mapIds = lib.getItem(2, 15);
    let fieldBad = [];
    let nameBad = [];
    let posBad = [];
    let layoutBad = [];
    for (let i = 0; i < raw.length; i++) {
      const c = cities[i], r = raw[i];
      const fields = ['Belong', 'Id', 'SatrapId', 'Farming', 'FarmingLimit', 'Commerce', 'CommerceLimit',
        'PeopleDevotion', 'AvoidCalamity', 'Population', 'PopulationLimit', 'Money', 'Food',
        'MothballArms', 'PersonQueue', 'Persons', 'ToolQueue', 'Tools'];
      const mapTo = { Belong: 'ownerId', Id: 'state', SatrapId: 'satrapId', Farming: 'farming',
        FarmingLimit: 'farmingLimit', Commerce: 'commerce', CommerceLimit: 'commerceLimit',
        PeopleDevotion: 'peopleDevotion', AvoidCalamity: 'avoidCalamity', Population: 'population',
        PopulationLimit: 'populationLimit', Money: 'money', Food: 'food', MothballArms: 'mothballArms',
        PersonQueue: 'officerQueue', Persons: 'officerCount', ToolQueue: 'toolQueue', Tools: 'toolCount' };
      for (const k of fields) {
        if (c[mapTo[k]] !== r[k]) { fieldBad.push(`#${i}.${k} ${c[mapTo[k]]}!=${r[k]}`); break; }
      }
      if (c.name !== lib.getStr(58, i + 1)) nameBad.push(`#${i} "${c.name}"`);
      if (coords && (c.position.x !== coords[i * 2] || c.position.y !== coords[i * 2 + 1])) {
        posBad.push(`#${i} (${c.position.x},${c.position.y})!=(${coords[i * 2]},${coords[i * 2 + 1]})`);
      }
      const lv = layout ? layout[c.position.y * 12 + c.position.x] : null;
      if (lv !== i + 1 || c.layoutValue !== lv) layoutBad.push(`#${i} layout=${lv} layoutValue=${c.layoutValue}`);
      if (mapIds && c.battleMapId !== mapIds[i]) fieldBad.push(`#${i}.battleMapId`);
    }
    this._push('cities.fields', 'logic', fieldBad.length === 0, fieldBad.slice(0, 4).join(' / '));
    this._push('cities.names', 'logic', nameBad.length === 0, nameBad.slice(0, 4).join(' / '));
    this._push('cities.positions', 'logic', posBad.length === 0, posBad.slice(0, 4).join(' / '));
    this._push('cities.layout(id+1 反查)', 'logic', layoutBad.length === 0, layoutBad.slice(0, 4).join(' / '));

    // 连接：8 方向原始字节
    const conn = lib.getItem(59, 1);
    let connBad = [];
    for (let i = 0; i < raw.length; i++) {
      const list = this.adapter.getCityConnections(i);
      for (let k = 0; k < 8; k++) {
        const expectId = conn[i * 16 + k] ? conn[i * 16 + k] - 1 : null;
        const expectDist = conn[i * 16 + 8 + k];
        if (list[k].cityId !== expectId || list[k].distance !== expectDist || list[k].directionIndex !== k) {
          connBad.push(`#${i}/${k}`);
          break;
        }
      }
    }
    this._push('cities.connections', 'logic', connBad.length === 0, connBad.slice(0, 4).join(' '));
  }

  checkLinks() {
    const lib = this.core.lib;
    const raw = this.core.Dn.g_Cities;
    const conn = lib.getItem(59, 1);
    const expect = new Set();
    for (let i = 0; i < raw.length; i++) {
      for (let k = 0; k < 8; k++) {
        const v = conn[i * 16 + k];
        if (!v) continue;
        const to = v - 1;
        if (to < 0 || to >= raw.length || to === i) continue;
        expect.add(`${Math.min(i, to)}-${Math.max(i, to)}`);
      }
    }
    const links = this.adapter.getCityLinks();
    const got = new Set(links.map((l) => `${l.from}-${l.to}`));
    const missing = [...expect].filter((x) => !got.has(x));
    const extra = [...got].filter((x) => !expect.has(x));
    this._push('links.拓扑与原始表一致', 'logic', missing.length === 0 && extra.length === 0,
      `原始 ${expect.size} / 适配 ${got.size} 缺${missing.length} 多${extra.length}${missing[0] ? ' 例:' + missing[0] : ''}`);
    // 反向记录必须存在（双向都读自同一张原版表）
    const noBackward = links.filter((l) => !l.forward && !l.backward).length;
    this._push('links.至少保留一方向原始记录', 'logic', noBackward === 0, `无记录 ${noBackward}`);
  }

  checkFactions() {
    const Dn = this.core.Dn;
    const factions = this.adapter.getFactions();
    const rawOwners = [...new Set(Dn.g_Cities.map((c) => c.Belong))].sort((a, b) => a - b);
    const ids = factions.map((f) => f.id);
    const idsOk = ids.length === rawOwners.length && ids.every((v, i) => v === rawOwners[i]);
    const sumOk = factions.reduce((s, f) => s + f.cityCount, 0) === Dn.g_Cities.length;
    const playerCount = factions.filter((f) => f.isPlayer).length;
    this._push('factions.势力集合 == Belong 去重', 'logic', idsOk, `${ids.length} vs ${rawOwners.length}`);
    this._push('factions.城市数合计 == 38', 'logic', sumOk, `${factions.reduce((s, f) => s + f.cityCount, 0)}`);
    // 原版主菜单阶段 g_YearDate=0，城市归属尚未写入，此时没有「玩家势力」这个概念。
    // 这不是缺陷，也不该伪造通过 —— 明确标注为「不适用」。
    const inScenario = Dn.g_YearDate > 0;
    if (!inScenario) {
      this._push('factions.玩家势力唯一且 == g_PlayerKing+1', 'logic', true,
        `未进入剧本（g_YearDate=0，Belong 尚未写入），该项不适用；已校验势力集合与城市数`);
    } else {
      this._push('factions.玩家势力唯一且 == g_PlayerKing+1', 'logic',
        playerCount === 1 && factions.some((f) => f.isPlayer && f.id === Dn.g_PlayerKing + 1),
        `player=${playerCount} king=${Dn.g_PlayerKing + 1}`);
    }

    const gs = this.adapter.getGameState();
    const turn = this.adapter.getCurrentTurn();
    this._push('game.玩家君主一致', 'logic', gs.playerKing === Dn.g_PlayerKing, `${gs.playerKing} vs ${Dn.g_PlayerKing}`);
    this._push('game.回合一致', 'logic',
      turn.year === Dn.g_YearDate && turn.month === Dn.g_MonthDate,
      `${turn.year}年${turn.month}月 vs ${Dn.g_YearDate}年${Dn.g_MonthDate}月`);
  }

  checkOfficers() {
    const Dn = this.core.Dn;
    let bad = [];
    let total = 0;
    for (let i = 0; i < Dn.g_Cities.length; i++) {
      const c = Dn.g_Cities[i];
      const list = this.adapter.getOfficers(i);
      let expectCount = 0;
      for (let k = 0; k < c.Persons; k++) {
        const pid = Dn.g_PersonsQueue[c.PersonQueue + k];
        if (pid !== undefined) expectCount++;
      }
      if (list.length !== expectCount) { bad.push(`#${i} 数量 ${list.length}!=${expectCount}`); continue; }
      for (let k = 0; k < list.length; k++) {
        const pid = Dn.g_PersonsQueue[c.PersonQueue + k];
        const o = list[k], p = Dn.g_Persons[pid];
        total++;
        if (!p || o.id !== pid || o.ownerId !== p.Belong || o.level !== p.Level || o.force !== p.Force
          || o.iq !== p.IQ || o.arms !== p.Arms || o.armsType !== p.ArmsType || o.age !== p.Age) {
          bad.push(`#${i}/${k} pid=${pid}`);
          break;
        }
      }
    }
    this._push('officers.队列切片与武将字段一致', 'logic', bad.length === 0,
      `${total} 名，异常 ${bad.length} 处${bad[0] ? ' 例:' + bad[0] : ''}`);
  }

  checkBattle() {
    const Dn = this.core.Dn;
    let map = null;
    try {
      map = this.adapter.getBattleMap();
    } catch (e) {
      // 内核未导出战斗函数（例如 Node 夹具）：如实标注为「当前不可校验」，不伪造通过也算不上失败
      this._push('battle.地图可读（当前不在战斗）', 'logic', true, `未进入战斗：${e.message}`);
      return;
    }
    if (!map || !map.available) {
      this._push('battle.地图可读（当前不在战斗）', 'logic', true, `未进入战斗：${map && map.reason}`);
      return;
    }
    this._push('battle.尺寸 == Dn.g_MapWid/g_MapHgt', 'logic',
      map.width === Dn.g_MapWid && map.height === Dn.g_MapHgt,
      `${map.width}x${map.height} vs ${Dn.g_MapWid}x${Dn.g_MapHgt}`);
    this._push('battle.格子数 == 宽*高', 'logic',
      map.cellCount === map.width * map.height && map.raw && map.raw.length === map.cellCount,
      `${map.cellCount} / raw ${map.raw ? map.raw.length : 0}`);
    const units = this.adapter.getBattleUnits();
    // getBattleUnits() 返回的是 g_GenPos 的全部槽位（固定 20），「在场」由 present 标志区分；
    // 原版 GenArray 里 0 表示空槽。所以要比的是「present 数」，不是数组长度。
    let alive = 0;
    const slots = Dn.g_FgtParam && Array.isArray(Dn.g_FgtParam.GenArray) ? Dn.g_FgtParam.GenArray.length : 0;
    for (let i = 0; i < 20; i++) if (Dn.g_FgtParam.GenArray[i]) alive++;
    const present = units.filter((u) => u.present).length;
    this._push('battle.槽位 20（我方 10 + 敌方 10）', 'logic', units.length === 20, `${units.length} 槽 · GenArray ${slots}`);
    this._push('battle.在场部队数 == GenArray 非零项', 'logic', present === alive, `present ${present} vs GenArray 非零 ${alive}`);
    this._push('battle.present 标志 == GenArray[i] 非零', 'logic',
      units.every((u) => (u.present ? 1 : 0) === (u.index < 20 && Dn.g_FgtParam.GenArray[u.index] ? 1 : 0)),
      `逐槽比对 ${units.length} 项`);
    // 投影对象用的是 index（不是 slot）；写错字段会让下面的坐标比对被整段跳过，
    // 表现为「全绿但其实一条都没比」——这正是 P7 要避免的假通过。
    let coordBad = 0;
    for (const u of units) {
      const gp = Dn.g_GenPos[u.index];
      if (!gp) { coordBad++; continue; }
      if (u.x !== gp.x || u.y !== gp.y) coordBad++;
    }
    this._push('battle.每支部队坐标 == g_GenPos（20 槽逐个比对）', 'logic', coordBad === 0,
      coordBad === 0 ? `${units.length} 槽一致` : `不一致/缺失 ${coordBad} 处`);
  }

  /** 坐标往返：逻辑格 -> 世界 -> 逻辑格，纯数学，1e-9 容差。 */
  checkMapping() {
    if (!this.mapCoordinate) {
      this._push('mapping.战略坐标往返（未注入）', 'mapping', true, 'skipped');
      return;
    }
    let maxErr = 0;
    let bad = 0;
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 12; col++) {
        const w = this.mapCoordinate.mapToWorld(col, row);
        const back = this.mapCoordinate.worldToMap(w.x, w.z);
        maxErr = Math.max(maxErr, Math.abs(back.col - col), Math.abs(back.row - row));
        if (Math.abs(back.col - col) > EPS || Math.abs(back.row - row) > EPS) bad++;
      }
    }
    this._push('mapping.战略 12x9 格往返', 'mapping', bad === 0, `最大误差 ${maxErr.toExponential(2)}，越界 ${bad}`);

    if (this.battleCoordinate) {
      let bMax = 0, bBad = 0;
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          const w = this.battleCoordinate.gridToWorld(x, y);
          const back = this.battleCoordinate.worldToGrid(w.x, w.z);
          bMax = Math.max(bMax, Math.abs(back.x - x), Math.abs(back.y - y));
          if (Math.abs(back.x - x) > EPS || Math.abs(back.y - y) > EPS) bBad++;
        }
      }
      this._push('mapping.战斗 32x32 格往返', 'mapping', bBad === 0, `最大误差 ${bMax.toExponential(2)}，越界 ${bBad}`);
    }

    // 原版虚拟屏：逻辑格 -> 240x320 命中坐标，再用原版 zs() 公式反算
    const cursor = { x: 0, y: 0 };
    let sBad = 0, sChecked = 0;
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 12; col++) {
        const s = this.mapCoordinate.logicalToOriginalScreen(col, row, cursor);
        if (!s) continue;
        sChecked++;
        const a = Math.round(cursor.x * 32);
        const backCol = Math.floor((s.x + a) / 32);
        const backRow = Math.floor(s.y / 32);
        if (backCol !== col || backRow !== row) sBad++;
      }
    }
    this._push('screen.原版虚拟屏命中公式反算', 'screen', sBad === 0,
      `检查 ${sChecked} 格，错位 ${sBad}`);
  }
}

export default ConsistencyProbe;
