/**
 * P6 PresentationStore —— 3D 表现配置的独立存储（与原版存档严格分离）。
 *
 * 为什么要独立：原版存档 ac()/oc() 是**字节级固定格式**（SGB3 + v4 + 定长字段），
 * 往里塞相机位置会直接破坏旧存档兼容性。因此表现层偏好只能走自己的键：
 *
 *   key = 'sgby3d.presentation.v1'      （白名单字段：camera / ui / selection）
 *   原版存档 key = `${prefix}${2*slot}.sav` / `${prefix}${2*slot+1}.sav`
 *
 * 三个硬约束（测试会逐条断言）：
 *   1) 写入的 JSON 只包含白名单键，**结构上不可能**装游戏业务数据；
 *   2) 不读写任何 `*.sav` 键；
 *   3) 读取时做字段校验与钳位，坏数据直接丢弃并回落到默认，绝不让错误配置影响开局。
 */

import { PRESENTATION } from './config.mjs';

const DEFAULTS = Object.freeze({
  camera: null,          // { x, z, zoom } —— 只存战略地图相机，战斗相机不存
  ui: Object.freeze({ p1Panel: false, p2Panel: true, legacy: false }),
  selection: null,       // 上次选中的 cityId（仅用于恢复高亮，不参与任何规则）
});

const clampNum = (v, lo, hi, fallback = null) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
};

export class PresentationStore {
  /**
   * @param {object} [opts]
   * @param {Storage} [opts.storage] 默认使用 localStorage（Node 测试注入内存实现）
   * @param {string} [opts.key]
   */
  constructor({ storage = null, key = PRESENTATION.key, log = () => {} } = {}) {
    this.key = key;
    this.log = log;
    this._storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    this.stats = { reads: 0, writes: 0, corrupt: 0, rejected: 0, resets: 0 };
    this.data = this._clone(DEFAULTS);
  }

  _clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  /** 内存/无 storage 环境下也要能工作（静默降级，但统计可见）。 */
  _get() {
    if (!this._storage) return null;
    try { return this._storage.getItem(this.key); } catch (e) { this.log(`读取表现配置失败：${e.message}`); return null; }
  }

  _set(text) {
    if (!this._storage) return false;
    try { this._storage.setItem(this.key, text); return true; } catch (e) { this.log(`写入表现配置失败：${e.message}`); return false; }
  }

  /** 只序列化白名单字段 —— 这是「不会污染存档」的结构性保证。 */
  serialize() {
    const out = {};
    for (const field of PRESENTATION.fields) {
      if (this.data[field] !== undefined) out[field] = this.data[field];
    }
    return out;
  }

  load() {
    this.stats.reads++;
    const text = this._get();
    if (!text) return this._clone(DEFAULTS);
    let raw;
    try { raw = JSON.parse(text); } catch (_) {
      this.stats.corrupt++;
      this.data = this._clone(DEFAULTS);
      return this.data;
    }
    // 版本不匹配直接丢弃（表现层偏好不需要迁移，丢掉的只是相机位置）
    if (!raw || raw.version !== PRESENTATION.version) {
      this.stats.rejected++;
      this.data = this._clone(DEFAULTS);
      return this.data;
    }
    const camera = raw.camera && typeof raw.camera === 'object'
      ? {
        x: clampNum(raw.camera.x, -64, 64),
        z: clampNum(raw.camera.z, -64, 64),
        zoom: clampNum(raw.camera.zoom, 0.5, 4),
      }
      : null;
    const ui = raw.ui && typeof raw.ui === 'object'
      ? {
        p1Panel: raw.ui.p1Panel === true,
        p2Panel: raw.ui.p2Panel !== false,
        legacy: raw.ui.legacy === true,
      }
      : { ...DEFAULTS.ui };
    const selection = Number.isInteger(raw.selection) && raw.selection >= 0 && raw.selection < 256
      ? raw.selection : null;
    this.data = { camera, ui, selection };
    return this._clone(this.data);
  }

  save(patch = {}) {
    this.stats.writes++;
    const merged = { ...this.data, ...patch };
    this.data = {
      camera: merged.camera && typeof merged.camera === 'object'
        ? {
          x: clampNum(merged.camera.x, -64, 64),
          z: clampNum(merged.camera.z, -64, 64),
          zoom: clampNum(merged.camera.zoom, 0.5, 4),
        } : null,
      ui: {
        p1Panel: merged.ui?.p1Panel === true,
        p2Panel: merged.ui?.p2Panel !== false,
        legacy: merged.ui?.legacy === true,
      },
      selection: Number.isInteger(merged.selection) ? merged.selection : null,
    };
    const payload = { version: PRESENTATION.version, ...this.serialize() };
    const ok = this._set(JSON.stringify(payload));
    return { ok, payload };
  }

  reset() {
    this.stats.resets++;
    this.data = this._clone(DEFAULTS);
    if (this._storage) { try { this._storage.removeItem(this.key); } catch (_) { /* ignore */ } }
    return this._clone(this.data);
  }

  /** 只读快照（诊断面板/测试用）。 */
  get() { return this._clone(this.data); }

  /** 结构性保证：写入的内容里不允许出现游戏业务字段名。 */
  static auditPayload(payload) {
    const banned = ['city', 'cities', 'officer', 'officers', 'king', 'playerKing',
      'money', 'food', 'arms', 'belong', 'turn', 'year', 'month', 'sav'];
    const keys = [];
    const walk = (v, path) => {
      if (!v || typeof v !== 'object') return;
      for (const [k, val] of Object.entries(v)) { keys.push(`${path}${k}`); walk(val, `${path}${k}.`); }
    };
    walk(payload, '');
    const hits = keys.filter((k) => banned.includes(k.split('.').pop().toLowerCase()));
    return { ok: hits.length === 0, keys, hits };
  }
}
