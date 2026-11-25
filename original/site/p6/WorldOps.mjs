/**
 * P6 WorldOps —— 3D 战略主界面的操作层（与原版 zs() 完全同一套语义）。
 *
 * 原版 zs() 的操作事实（sgby.core.js 实测，不是推测）：
 *   键盘 34/35/36/37 移动光标（setx/sety），39 确认（光标所在格有城则返回该城），
 *        40 返回 255，38 帮助页，51 形势图；
 *   指针 点击地图格 → 移动光标；再次点击同一格 → 确认；拖动画布 → 滚动视口；
 *        点击底部按钮条 → 帮助/形势图；点击状态栏 → 返回 255。
 *
 * 3D 里逐条对齐：
 *   - 点击格 → requestCursorTo(col,row)（逐格方向键，唯一能驱动原版的方式）；
 *   - 再次点击同格 → pressKey(39)；
 *   - 方向键/WASD/E/Q/Tab/M **不重复注入**——原版自己监听 window keydown，
 *     让它原样消费，才是真正的"操作逻辑一致"；
 *   - 拖动 → 相机平移；滚轮缩放属于 3D 增强，不影响原版状态；
 *   - 底部按钮条 → pressKey(38/51/39/40/方向)，键码全部来自原版协议。
 *
 * 本模块只做「把用户动作翻成原版输入」+「把原版状态显示出来」，不含任何规则。
 */
import { CURSOR_STYLE, OPS_LAYOUT } from './config.mjs';

function safe(fn, fallback = null) {
  try { return fn(); } catch (_) { return fallback; }
}

export class WorldOps {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {object} deps.adapter     GameAdapter
   * @param {object} deps.input       P1 InputManager（仅用于状态显示/阻断判定）
   * @param {object} deps.scene       StrategicMapScene
   * @param {object} deps.coordinate  CoordinateSystem（mapToWorld）
   * @param {object} [deps.cityManager] P3（判断城市界面是否打开）
   * @param {HTMLElement} [deps.opsHost] #p6-ops
   * @param {Function} [deps.log]
   */
  constructor({ THREE, adapter, input, scene, coordinate, worldCamera = null, cityManager = null,
    opsHost = null, log = () => {} }) {
    if (!THREE || !adapter || !scene || !coordinate) throw new TypeError('WorldOps 依赖不完整');
    this.THREE = THREE;
    this.adapter = adapter;
    this.input = input;
    this.scene = scene;
    this.coordinate = coordinate;
    this.worldCamera = worldCamera;
    this.cityManager = cityManager;
    this.opsHost = opsHost || (typeof document !== 'undefined' ? document.getElementById('p6-ops') : null);
    this.log = log;

    this.active = false;
    this.cursor = null;          // 最近一次观测到的原版光标
    this.lastClick = null;
    this.stats = { clicks: 0, moved: 0, confirms: 0, keys: 0, rejected: 0, lastReason: null };
    this._timer = null;
    this._marker = null;
    this._buttons = new Map();
    this._dom = {};
  }

  // ------------------------------------------------------------ 生命周期
  start() {
    this._buildMarker();
    this._buildOps();
    if (!this._timer) this._timer = setInterval(() => this.refresh(), 200);
    this.refresh();
    return this;
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._disposeMarker();
    if (this.opsHost) this.opsHost.replaceChildren();
    this._buttons.clear();
  }

  /** 仅在世界地图场景且没有全屏城市界面时显示操作条。 */
  setActive(active) {
    this.active = !!active;
    if (this.opsHost) this.opsHost.hidden = !this.active;
    if (this._marker) this._marker.visible = this.active && !!this.cursor;
  }

  // ------------------------------------------------------------ 光标标记
  _buildMarker() {
    if (this._marker || !this.scene.scene) return;
    const THREE = this.THREE;
    const C = CURSOR_STYLE;
    const group = new THREE.Group();
    group.name = 'p6-cursor-cell';

    // 半透明填充 + 细边线：俯视下是清楚的"格子框"，不会盖住城市模型细节
    const plane = new THREE.PlaneGeometry(C.size, C.size);
    const fill = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({
      color: C.color, transparent: true, opacity: C.fillOpacity,
      side: THREE.DoubleSide, depthWrite: false,
    }));
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(plane), new THREE.LineBasicMaterial({
      color: C.color, transparent: true, opacity: C.opacity, depthWrite: false,
    }));
    fill.rotation.x = -Math.PI / 2;
    edge.rotation.x = -Math.PI / 2;
    fill.renderOrder = 3;
    edge.renderOrder = 4;
    group.add(fill, edge);
    group.position.y = C.y;
    group.visible = false;
    this.scene.scene.add(group);
    this._marker = group;
  }

  _disposeMarker() {
    if (!this._marker) return;
    const m = this._marker;
    if (m.parent) m.parent.remove(m);
    m.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this._marker = null;
  }

  // ------------------------------------------------------------ 操作条
  _buildOps() {
    const host = this.opsHost;
    if (!host || this._buttons.size) return;
    host.replaceChildren();
    for (const group of OPS_LAYOUT) {
      const wrap = document.createElement('div');
      wrap.className = group.id === 'dpad' ? 'p6-dpad' : 'p6-ops-group';
      for (const btn of group.buttons) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'p6-key' + (btn.variant ? ` p6-${btn.variant}` : '');
        b.dataset.p6Key = String(btn.key);
        b.textContent = btn.label;
        if (btn.hint) b.title = btn.hint;
        b.addEventListener('click', () => this.sendKey(btn.key));
        wrap.append(b);
        this._buttons.set(btn.key, b);
      }
      host.append(wrap);
    }
  }

  // ------------------------------------------------------------ 操作
  /** 投递一次原版按键（0 表示未投递，reason 说明原因）。 */
  sendKey(param) {
    const r = safe(() => this.adapter.pressKey(param), null);
    if (r && r.sent) {
      this.stats.keys++;
      this.log(`原版按键 ${param} 已投递`);
      return r;
    }
    this.stats.rejected++;
    this.stats.lastReason = r ? r.reason : '适配层不可用';
    this.log(`按键 ${param} 未投递：${this.stats.lastReason}`);
    return r;
  }

  /**
   * 地图点击（由 MapInteraction.pickCell 解析后的逻辑格）。
   * 与原版一致：点别处=移动光标；点光标所在格=确认。
   */
  handleMapClick({ cell, cityId = null } = {}) {
    if (!this.active || !cell) return null;
    this.stats.clicks++;
    const cur = this.cursor || safe(() => this.adapter.getCityCursor(), null);
    const same = cur && cur.setx === cell.col && cur.sety === cell.row;
    this.lastClick = { cell, cityId, sameCell: same };
    if (same) {
      this.stats.confirms++;
      return this.sendKey(39);
    }
    const r = safe(() => this.adapter.requestCursorTo(cell.col, cell.row), null);
    if (r && r.moved) this.stats.moved++;
    else { this.stats.rejected++; this.stats.lastReason = r ? r.reason : '适配层不可用'; }
    return r;
  }

  // ------------------------------------------------------------ 状态刷新
  refresh() {
    if (typeof document === 'undefined') return;
    const gs = safe(() => this.adapter.getGameState(), null);
    const cur = safe(() => this.adapter.getCityCursor(), null);
    this.cursor = cur;

    this._setText('p6-king', this._kingLabel(gs));
    this._setText('p6-turn', gs && gs.year ? `${gs.year} 年 ${gs.month} 月` : '未进入剧本');
    this._setText('p6-cursor', this._cursorLabel(cur));

    // 光标方框
    if (this._marker) {
      const on = this.active && cur && cur.populated;
      this._marker.visible = !!on;
      if (on) {
        const p = this.coordinate.mapToWorld(cur.setx, cur.sety, { height: CURSOR_STYLE.y });
        this._marker.position.set(p.x, p.y, p.z);
      }
    }

    // 城市高亮跟随原版光标（只在变化时重建，避免每帧重建道路几何）
    const cityId = cur && cur.cityId !== undefined ? cur.cityId : null;
    if (this.scene.cityRenderer && this.scene.selection !== cityId) {
      this.scene.setSelection(cityId);
    }

    // 城市管理界面打开时让出底部（P3 面板自己有一套按钮）
    if (this.cityManager && this.opsHost && this.active) {
      const open = !!(this.cityManager.ui && this.cityManager.ui.isOpen);
      this.opsHost.hidden = open;
    }
  }

  _kingLabel(gs) {
    if (!gs) return '君主 —';
    const factions = safe(() => this.adapter.getFactions(), []) || [];
    const mine = factions.find((f) => f.isPlayer);
    if (mine && mine.name) return `${mine.name} · ${mine.cityCount} 城`;
    return `君主 #${gs.playerKing + 1}`;
  }

  _cursorLabel(cur) {
    if (!cur) return '光标 —';
    const city = cur.cityId !== null && cur.cityId !== undefined
      ? safe(() => this.adapter.getCity(cur.cityId).name, null) : null;
    return city
      ? `光标 (${cur.setx},${cur.sety}) ${city}`
      : `光标 (${cur.setx},${cur.sety}) 空地`;
  }

  _setText(id, text) {
    const el = document.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
  }

  getSnapshot() {
    return {
      active: this.active,
      cursor: this.cursor,
      stats: { ...this.stats },
      buttons: [...this._buttons.keys()],
      markerVisible: !!(this._marker && this._marker.visible),
    };
  }
}
