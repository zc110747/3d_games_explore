/**
 * P6 SaveManager —— 原版存档系统的封装（**不复制、不改写**原版格式）。
 *
 * 权威入口只有原版自己的两个函数（tools/make_core.mjs 已导出）：
 *   保存 core.fns.ac(slot)  -> 写 `${prefix}${2*slot}.sav`（base）与 `+1`（dyn），返回 boolean
 *   读取 core.fns.oc(slot)  -> 逐字段写回 Dn，返回 boolean
 *   key  core.fns.jn(slot)  -> 真实 key（前缀可能被 URL ?save= 改过，不能自己拼）
 *
 * 本模块只做四件事：
 *   1) 读之前给出**可解释的准入判断**（战斗/指令上下文中读档会让原版协程拿到错状态）；
 *   2) 读之后驱动表现层全量重同步（3D 城市/旗帜/选中/相机，全部按 Dn 重新取）；
 *   3) 把槽位信息（是否存在/君主/年份/字节数/格式校验）如实列出来给界面和报告；
 *   4) 失败一律如实上报 —— 原版 oc() 是逐字段写入、**非原子**，半途失败会留下部分字段，
 *      这时必须明确告诉用户「建议重启页面」，绝不能假装读档成功。
 *
 * 硬约束：不写 Dn、不改存档结构、不往存档里加 3D 字段。
 */

import { SAVE, savePartBytes } from './config.mjs';

const B64 = (text) => {
  try { return atob(String(text)); } catch (_) { return null; }
};

/** base64 -> 字节长度（atob 结果每个字符就是一个字节）。 */
function b64Bytes(text) {
  const bin = B64(text);
  return bin === null ? null : bin.length;
}

/** 从 base 片解出头部信息（与原版 Hn() 完全同一口径：t[6..9]）。 */
function readHeader(baseText) {
  const bin = B64(baseText);
  if (!bin) return null;
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  const headerOk = b.length >= 5 && b[0] === SAVE.header[0] && b[1] === SAVE.header[1]
    && b[2] === SAVE.header[2] && b[3] === SAVE.header[3];
  return {
    headerOk,
    version: b[4],
    king: b.length >= 8 ? (b[6] | (b[7] << 8)) : null,
    year: b.length >= 10 ? (b[8] | (b[9] << 8)) : null,
    difficulty: b.length >= 19 ? b[18] : null,
    bytes: b.length,
  };
}

export class SaveManager {
  /**
   * @param {object} deps
   * @param {object} deps.core      window.__SGBY_CORE__
   * @param {object} deps.adapter   GameAdapter
   * @param {object} deps.events    EventManager
   * @param {object} [deps.ui]      UIManager（提示，可空）
   * @param {Function} [deps.onAfterLoad] 读档成功后的表现层重建（由 SceneDirector 提供）
   * @param {Function} [deps.isBattleActive] 是否处于战斗（战斗不存档/不读档）
   * @param {object} [deps.storage] 默认 localStorage
   * @param {Function} [deps.log]
   */
  constructor({
    core, adapter, events, ui = null, onAfterLoad = null, isBattleActive = () => false,
    storage = null, log = () => {},
  }) {
    if (!core || !adapter || !events) throw new TypeError('SaveManager 依赖不完整');
    this.core = core;
    this.adapter = adapter;
    this.events = events;
    this.ui = ui;
    this.onAfterLoad = onAfterLoad;
    this.isBattleActive = isBattleActive;
    this.log = log;
    this._storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    this.stats = {
      inspects: 0, saves: 0, saveFails: 0, loads: 0, loadFails: 0,
      rejects: 0, afterLoadHooks: 0, partialWrites: 0,
    };
    this.history = [];
  }

  // ------------------------------------------------------------- 只读信息
  get capacity() {
    const cap = this.core.p6 && this.core.p6.capacity ? this.core.p6.capacity : null;
    if (cap) return cap;
    // 内核未导出容量时如实返回 null（不猜）
    return null;
  }

  get expectedBytes() {
    const cap = this.capacity;
    return cap ? savePartBytes(cap) : null;
  }

  slots() { return Array.from({ length: SAVE.slots }, (_, i) => i); }

  keysFor(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= SAVE.slots) {
      throw new RangeError(`存档槽越界: ${slot}（原版只有 0..${SAVE.slots - 1}）`);
    }
    const jn = this.core.fns && this.core.fns.jn;
    if (typeof jn !== 'function') throw new Error('内核未导出 fns.jn（sgby.core.js 版本过旧）');
    return jn(slot);
  }

  /** 槽位详情：是否存在 / 头部 / 字节数 / 与当前资源包容量是否匹配。 */
  inspect(slot) {
    this.stats.inspects++;
    const keys = this.keysFor(slot);
    const raw = keys.map((k) => (this._storage ? this._storage.getItem(k) : null));
    const exists = !!(raw[0] && raw[1]);
    const readable = !!this._storage;
    const base = raw[0] ? readHeader(raw[0]) : null;
    const bytes = { base: raw[0] ? b64Bytes(raw[0]) : null, dyn: raw[1] ? b64Bytes(raw[1]) : null };
    const expect = this.expectedBytes;
    const sizeMatch = !!(expect && exists && bytes.base === expect.base && bytes.dyn === expect.dyn);
    const cap = this.capacity;
    return Object.freeze({
      slot,
      exists,
      readable,
      keys,
      header: base,
      bytes,
      expect,
      sizeMatch,
      capacity: cap,
      /** 原版 oc() 的容量校验（Nn()）口径：武将/城市/道具/技能数必须与当前包一致。 */
      compatible: !!(base && base.headerOk && base.version === SAVE.version && sizeMatch),
      label: exists && base && base.headerOk
        ? `${base.year ?? '?'} 年 · 君主 #${base.king ?? '?'}`
        : '空槽',
      source: 'core.fns.jn + localStorage 原文（只读，不解析业务字段）',
    });
  }

  inspectAll() { return this.slots().map((s) => this.inspect(s)); }

  // ------------------------------------------------------------- 准入判断
  /**
   * 能否保存。理由必须具体：
   *   - 战斗中不允许（原版存档字段里没有战斗态，写下去等于丢战斗）；
   *   - 未进剧本不允许（ac() 会把 period=0/year=0 的空壳写进槽位）。
   */
  canSave() {
    const reasons = [];
    if (!this._storage) reasons.push('localStorage 不可用（无痕模式或被禁用）');
    if (!this.adapter.connected) reasons.push('原版内核未连接');
    const gs = this.adapter.connected ? this.adapter.getGameState() : null;
    if (!gs || !(gs.year > 0)) reasons.push('尚未进入剧本（原版主菜单），存档没有意义');
    if (this.isBattleActive()) reasons.push('战斗中不存档：原版存档格式不含战斗态（g_FgtOver/g_GenPos 等都不在字段表里）');
    let phase = null;
    try { phase = this.adapter.getInputPhase(); } catch (_) { phase = null; }
    if (phase && phase.inOrderContext) reasons.push('原版正处于指令上下文（window.__SGBY_CTX），此时 Dn 可能只更新了一半');
    return { ok: reasons.length === 0, reasons, phase, gameState: gs };
  }

  /**
   * 能否读档。oc() 只覆盖 Dn，**不会**重置正在 await 的协程，
   * 因此只有「原版确实停在战略阶段等选城」时读档才安全。
   */
  canLoad() {
    const reasons = [];
    if (!this._storage) reasons.push('localStorage 不可用（无痕模式或被禁用）');
    if (!this.adapter.connected) reasons.push('原版内核未连接');
    if (this.isBattleActive()) reasons.push('战斗中不读档：原版战斗协程 Uo() 正在跑，覆盖 Dn 会撕裂战况');
    let phase = null;
    try { phase = this.adapter.getInputPhase(); } catch (_) { phase = null; }
    if (phase) {
      if (!phase.inScenario) reasons.push('原版仍在主菜单（读档入口在原版主菜单，3D 层不越权）');
      else if (phase.inOrderContext) reasons.push('原版正处于城市指令上下文，读档会打断 mi() 协程');
      else if (!(phase.kind === 'zs' && phase.waiting)) {
        reasons.push(`原版当前等待的协程是 ${phase.kind}（不是战略选城 zs），读档会让该协程拿到错状态`);
      }
    }
    return { ok: reasons.length === 0, reasons, phase };
  }

  // ------------------------------------------------------------- 保存
  save(slot, { reason = 'manual' } = {}) {
    const gate = this.canSave();
    if (!gate.ok) {
      this.stats.rejects++;
      const r = { ok: false, slot, reason: gate.reasons.join('；'), gate, source: 'P6 准入判断' };
      this._record('save', r);
      this.log(`存档 #${slot + 1} 被拒绝：${r.reason}`);
      return r;
    }
    const before = this.inspect(slot);
    let ok = false;
    let error = null;
    try {
      ok = !!this.core.fns.ac(slot);
    } catch (e) {
      error = e.message;
    }
    const after = this.inspect(slot);
    if (ok) this.stats.saves++; else this.stats.saveFails++;
    const r = {
      ok,
      slot,
      error,
      bytes: after.bytes,
      header: after.header,
      sizeMatch: after.sizeMatch,
      replaced: before.exists,
      signature: this.adapter.sync({ source: 'p6-save' }),
      phase: gate.phase,
      reason,
      source: '原版 ac()（P6 只调用，不复制格式）',
    };
    this._record('save', r);
    this.log(ok
      ? `存档 #${slot + 1} 已写入：${after.header ? after.header.year + ' 年' : '?'}，`
        + `base ${after.bytes.base}B / dyn ${after.bytes.dyn}B${after.sizeMatch ? '（与容量公式一致）' : '（长度异常）'}`
      : `存档 #${slot + 1} 失败：${error || '原版 ac() 返回 false'}`);
    return r;
  }

  // ------------------------------------------------------------- 读取
  /**
   * 读档。成功后会依次执行：
   *   1) core.fns.qs(Dn.g_CityPos) —— 原版战略地图 2D 重绘（同时重建 citymap），纯显示
   *   2) adapter.sync({ force:true }) —— 强制全量派发状态变化（签名未变也要通知）
   *   3) onAfterLoad() —— 由 SceneDirector 重建 3D 表现（城市/旗帜/选中/相机）
   */
  load(slot, { reason = 'manual' } = {}) {
    const gate = this.canLoad();
    if (!gate.ok) {
      this.stats.rejects++;
      const r = { ok: false, slot, reason: gate.reasons.join('；'), gate, source: 'P6 准入判断' };
      this._record('load', r);
      this.log(`读档 #${slot + 1} 被拒绝：${r.reason}`);
      return r;
    }
    const info = this.inspect(slot);
    if (!info.exists) {
      this.stats.rejects++;
      const r = { ok: false, slot, reason: '该槽位没有存档（原版要求 base/dyn 两片都存在）', info };
      this._record('load', r);
      return r;
    }
    const before = {
      year: this.adapter.getGameState().year,
      signature: this.adapter.snapshotSignature ? this.adapter.snapshotSignature() : null,
    };
    let ok = false;
    let error = null;
    try {
      ok = !!this.core.fns.oc(slot);
    } catch (e) {
      error = e.message;
    }
    if (!ok) {
      this.stats.loadFails++;
      // 原版 oc() 非原子：可能已经写入了一部分字段，必须如实说明
      this.stats.partialWrites++;
      const r = {
        ok: false, slot, error, info, before,
        reason: `原版 oc() 返回 false（${error || '存档损坏/格式或容量不匹配'}）；`
          + '原版读档是逐字段写入、非原子，Dn 可能已被部分覆盖，建议重启页面后重试',
        partial: true,
        source: '原版 oc()',
      };
      this._record('load', r);
      this.log(`读档 #${slot + 1} 失败：${r.reason}`);
      return r;
    }

    this.stats.loads++;
    let redrawn = false;
    try {
      const qs = this.core.fns.qs;
      const Dn = this.core.Dn;
      if (typeof qs === 'function' && Dn && Dn.g_CityPos) { qs(Dn.g_CityPos); redrawn = true; }
    } catch (e) {
      this.log(`读档后原版战略图重绘失败（不影响 3D 数据）：${e.message}`);
    }
    let sync = null;
    try { sync = this.adapter.sync({ source: 'p6-load', force: true }); } catch (e) {
      this.log(`读档后状态同步失败：${e.message}`);
    }
    let after = null;
    if (typeof this.onAfterLoad === 'function') {
      try {
        after = this.onAfterLoad({ slot, reason, info });
        this.stats.afterLoadHooks++;
      } catch (e) {
        this.log(`读档后表现层重建失败：${e.message}`);
        after = { ok: false, error: e.message };
      }
    }
    const gs = this.adapter.getGameState();
    const r = {
      ok: true, slot, info, before, redrawn, sync, after,
      afterState: { year: gs.year, month: gs.month, playerKing: gs.playerKing, period: gs.period },
      reason,
      source: '原版 oc() + qs() 重绘 + 表现层全量重建',
    };
    this._record('load', r);
    this.log(`读档 #${slot + 1} 成功：${gs.year} 年 ${gs.month} 月 · 君主 #${gs.playerKing}`);
    return r;
  }

  /** 与原版导出格式同构的只读描述（用于报告；导入仍由原版 2D 界面负责）。 */
  describe(slot) {
    const info = this.inspect(slot);
    if (!info.exists) return { ...info, exportable: false };
    const h = info.header || {};
    return {
      ...info,
      exportable: true,
      exportFormat: {
        format: SAVE.format, version: SAVE.version, slot: slot + 1,
        king: h.king, year: h.year,
        base: `${info.bytes.base} B`, dyn: `${info.bytes.dyn} B`,
      },
      note: '导出/导入 JSON 由原版界面负责（dr()/导入按钮）；P6 只读展示，不改格式',
    };
  }

  _record(op, result) {
    this.history.push({
      op, at: Date.now(), slot: result.slot, ok: !!result.ok,
      reason: result.reason || null, bytes: result.bytes || null,
    });
    if (this.history.length > 12) this.history.shift();
  }

  getStatus() {
    return {
      ...this.stats,
      slots: this.inspectAll().map((s) => ({
        slot: s.slot, exists: s.exists, compatible: s.compatible,
        label: s.label, bytes: s.bytes, expect: s.expect, sizeMatch: s.sizeMatch,
      })),
      expected: this.expectedBytes,
      capacity: this.capacity,
      canSave: this.canSave(),
      canLoad: this.canLoad(),
      history: this.history.slice(-6),
      format: { header: SAVE.header, version: SAVE.version, slots: SAVE.slots, atomic: SAVE.atomic },
    };
  }
}
