/**
 * P2 CityRenderer —— 38 座真实城市的 3D 表现。
 *
 * 数据全部来自 GameAdapter.getCities()/getCity()（Dn.g_Cities + lib 数据表）：
 *   id / name / position / ownerId / state 均为原版字段的只读投影。
 * 本类不写任何原版对象，也不重新生成城市业务数据。
 *
 * 性能：
 *   - 城廓（基座+4 面城墙+4 角楼+内建筑+屋顶+城门）合并为 1 个 Geometry，
 *     38 座城市用 1 个 InstancedMesh（1 draw call）；
 *   - 拾取区也是 1 个 InstancedMesh，Raycaster 用 instanceId 反查 cityId，
 *     避免建筑细节影响点击（P2 §9.1）；
 *   - 选中高亮用 instanceColor，不重建对象、不改势力归属颜色；
 *   - 名称牌用 Sprite + CanvasTexture，文字来自原版城市名。
 */
import { CITY_MODEL_CONFIG as C, LABEL_CONFIG, factionRingColor } from './config.mjs';
import { createCityLabelTexture } from './TextureFactory.mjs';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * 城市状态（原版 c.Id：0 正常 / 1 饥荒 / 2 旱灾 / 3 水灾 / 4 暴动）。
 * instanceColor 与城廓部件的 vertexColors 相乘，因此正常态用白色保持本色，
 * 灾害态只做轻微色偏，选中态用金色。
 */
const STATE_COLORS = Object.freeze([
  0xffffff, 0xd8a080, 0xd9bf86, 0x9dbbd0, 0xc490a4,
]);

export class CityRenderer {
  constructor({ THREE, assets, adapter, coordinate }) {
    if (!THREE || !assets || !adapter || !coordinate) throw new TypeError('CityRenderer 依赖不完整');
    this.THREE = THREE;
    this.assets = assets;
    this.adapter = adapter;
    this.coordinate = coordinate;
    this.group = new THREE.Group();
    this.group.name = 'p2-cities';
    this.cities = [];
    this._byId = new Map();
    this._labels = new Map();
    this._selected = null;
    this._hover = null;          // P7：悬停城市（纯表现，不参与任何判断）
    this._flagRenderer = null;
    this._factionRing = null;    // P6 §8.1：阵营地面环（38 城 1 draw call）
    this._elapsed = 0;
    this._avoidAccum = 0;
    this._avoidDirty = true;
    this._ownTextures = [];
    this._built = false;
  }

  setFlagRenderer(flags) { this._flagRenderer = flags; }

  /** 我方势力 ownerId = 原版 g_PlayerKing + 1（与原版 Belong 同一口径）。 */
  _playerOwnerId() {
    try { return this.adapter.getGameState().playerKing + 1; } catch (_) { return null; }
  }

  /** 合并出一份可复用的城廓几何体（所有城市共享）。 */
  _buildBodyGeometry() {
    return this.assets.geometry('p2:city-body', (THREE) => {
      const parts = [];
      // 每个部件写入顶点色，合并后仍保留色块差异（增强立体感）
      const paint = (g, hex) => {
        const col = new THREE.Color(hex);
        const n = g.attributes.position.count;
        const arr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b;
        }
        g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
        parts.push(g);
      };
      const r = C.baseRadius;
      const base = new THREE.CylinderGeometry(r * 1.12, r * 1.18, 0.045, 8);
      base.translate(0, 0.0225, 0); paint(base, 0x8a7350);

      const wallLen = r * 1.75;
      for (let i = 0; i < 4; i++) {
        const w = new THREE.BoxGeometry(wallLen, C.wallHeight, C.wallThickness);
        const a = i * Math.PI / 2;
        w.rotateY(a);
        w.translate(Math.sin(a) * r * 0.86, 0.045 + C.wallHeight / 2, Math.cos(a) * r * 0.86);
        paint(w, 0xe2d5b4);
      }
      for (let i = 0; i < 4; i++) {
        const tw = new THREE.CylinderGeometry(C.towerRadius, C.towerRadius * 1.2, C.towerHeight, 6);
        const a = Math.PI / 4 + i * Math.PI / 2;
        tw.translate(Math.sin(a) * r * 0.95, 0.045 + C.towerHeight / 2, Math.cos(a) * r * 0.95);
        paint(tw, 0xb98a52);
      }
      const inner = new THREE.BoxGeometry(r * 0.62, C.innerBuildingHeight, r * 0.62);
      inner.translate(0, 0.045 + C.innerBuildingHeight / 2, 0); paint(inner, 0xeee1c2);
      const roof = new THREE.ConeGeometry(r * 0.58, 0.1, 4);
      roof.rotateY(Math.PI / 4);
      roof.translate(0, 0.045 + C.innerBuildingHeight + 0.05, 0); paint(roof, 0x9c4a3a);
      const gate = new THREE.BoxGeometry(r * 0.42, C.wallHeight * 0.72, C.wallThickness * 1.4);
      gate.translate(0, 0.045 + C.wallHeight * 0.36, r * 0.86); paint(gate, 0x4a3526);

      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      if (!merged) throw new Error('城廓几何体合并失败');
      merged.computeVertexNormals();
      return merged;
    });
  }

  build() {
    if (this._built) return this.group;
    const THREE = this.THREE;
    this.cities = this.adapter.getCities();
    if (!this.cities.length) throw new Error('原版城市列表为空，无法构建 3D 战略地图');
    const n = this.cities.length;

    const bodyMat = this.assets.material('p2:city-body-mat', (T) => new T.MeshLambertMaterial({
      color: 0xffffff, vertexColors: true, side: T.DoubleSide,
    }));
    this._body = new THREE.InstancedMesh(this._buildBodyGeometry(), bodyMat, n);
    this._body.name = 'p2-city-models';
    this._body.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const pickGeo = this.assets.geometry('p2:city-pick', (T) => {
      const g = new T.CircleGeometry(C.pickRadius, 16);
      g.rotateX(-Math.PI / 2);
      return g;
    });
    const pickMat = this.assets.material('p2:city-pick-mat', (T) => new T.MeshBasicMaterial({
      side: T.DoubleSide,
    }));
    this._pick = new THREE.InstancedMesh(pickGeo, pickMat, n);
    this._pick.name = 'p2-city-pick-areas';
    // 拾取区不参与渲染，但 Three.js Raycaster 的 intersectObjects() 不检查
    // object.visible，因此仍能命中并返回 instanceId（P2 §9.1 独立拾取区）。
    this._pick.visible = false;

    const ringGeo = this.assets.geometry('p2:city-select-ring', (T) => {
      const g = new T.RingGeometry(C.selectedRingRadius * 0.88, C.selectedRingRadius, 32);
      g.rotateX(-Math.PI / 2);
      return g;
    });
    this._ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: C.selectedRingColor, transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthWrite: false,
    }));
    this._ring.name = 'p2-city-selection-ring';
    this._ring.visible = false;

    // P6 §8.1：阵营地面环 —— 一个 InstancedMesh 承载 38 城，只加 1 个 draw call。
    // 颜色走 instanceColor（阵营三态：我方蓝 / 敌方红 / 空城灰），与城市本体颜色
    // 完全分开：本体 instanceColor 会乘上城廓 vertexColors，直接乘阵营色会发暗。
    const factionGeo = this.assets.geometry('p2:city-faction-ring', (T) => {
      const g = new T.RingGeometry(C.factionRingInner, C.factionRingOuter, 28);
      g.rotateX(-Math.PI / 2);
      g.translate(0, C.factionRingY, 0);   // 平躺在地面层，不参与拾取
      return g;
    });
    const factionMat = this.assets.material('p2:city-faction-ring-mat', (T) => new T.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: C.factionRingOpacity,
      side: T.DoubleSide, depthWrite: false,
    }));
    this._factionRing = new THREE.InstancedMesh(factionGeo, factionMat, n);
    this._factionRing.name = 'p2-city-faction-rings';
    this._factionRing.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this._factionRing.renderOrder = 1;

    const dummy = new THREE.Object3D();
    for (let i = 0; i < n; i++) {
      const city = this.cities[i];
      const p = this.coordinate.mapToWorld(city.position.x, city.position.y, { height: 0.02 });
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      this._body.setMatrixAt(i, dummy.matrix);
      this._pick.setMatrixAt(i, dummy.matrix);
      this._factionRing.setMatrixAt(i, dummy.matrix);

      const label = this._makeLabel(city, false);
      label.position.set(p.x, LABEL_CONFIG.yOffset, p.z);
      this.group.add(label);
      this._labels.set(city.id, { sprite: label, text: city.name, selected: false });
      this._byId.set(city.id, {
        id: city.id, name: city.name, ownerId: city.ownerId, state: city.state,
        logical: { ...city.position }, world: p, index: i,
      });
    }
    this._body.instanceMatrix.needsUpdate = true;
    this._pick.instanceMatrix.needsUpdate = true;
    this._factionRing.instanceMatrix.needsUpdate = true;
    this.group.add(this._body, this._pick, this._factionRing, this._ring);
    for (const city of this.cities) {
      this._applyBodyColor(city.id);
      this._applyFactionColor(city.id);
    }
    this._built = true;
    return this.group;
  }

  /** 阵营地面环颜色（只读 ownerId，不改任何游戏数据）。 */
  _applyFactionColor(cityId) {
    const rec = this._byId.get(cityId);
    if (!rec || !this._factionRing) return;
    const color = factionRingColor(rec.ownerId, this._playerOwnerId());
    this._factionRing.setColorAt(rec.index, new this.THREE.Color(color));
    if (this._factionRing.instanceColor) this._factionRing.instanceColor.needsUpdate = true;
  }

  _makeLabel(city, selected) {
    const tex = createCityLabelTexture(this.THREE, city.name, { selected });
    this._ownTextures.push(tex);
    const mat = new this.THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false,
    });
    const s = new this.THREE.Sprite(mat);
    s.scale.set(LABEL_CONFIG.worldWidth, LABEL_CONFIG.worldHeight, 1);
    s.renderOrder = 20;
    s.userData = { cityId: city.id, kind: 'city-label' };
    return s;
  }

  _applyBodyColor(cityId) {
    const rec = this._byId.get(cityId);
    if (!rec || !this._body) return;
    const color = cityId === this._selected
      ? C.selectedRingColor
      : (cityId === this._hover ? C.hoverColor : (STATE_COLORS[rec.state] ?? STATE_COLORS[0]));
    this._body.setColorAt(rec.index, new this.THREE.Color(color));
    if (this._body.instanceColor) this._body.instanceColor.needsUpdate = true;
  }

  /**
   * P7：悬停反馈（纯表现）。
   * 只改 instanceColor 与画布光标，不改变选中态、不发任何游戏事件。
   */
  setHover(cityId) {
    const next = (cityId === null || cityId === undefined || cityId === this._selected) ? null : cityId;
    if (next === this._hover) return this._hover;
    const prev = this._hover;
    this._hover = next;
    if (prev !== null) this._applyBodyColor(prev);
    if (next !== null) this._applyBodyColor(next);
    return this._hover;
  }

  get hover() { return this._hover; }

  /** 增量刷新单城（状态/归属/名称变化时不重建整张地图）。 */
  refreshCity(cityId) {
    const rec = this._byId.get(cityId);
    if (!rec) return false;
    let city;
    try { city = this.adapter.getCity(cityId); }
    catch (_) { return false; }
    rec.ownerId = city.ownerId;
    rec.state = city.state;
    this._applyBodyColor(cityId);
    this._applyFactionColor(cityId);
    const labelState = this._labels.get(cityId);
    if (city.name !== rec.text || (cityId === this._selected) !== labelState?.selected) {
      const old = labelState;
      if (old) {
        this.group.remove(old.sprite);
        old.sprite.material.dispose();
        const tex = old.sprite.material.map;
        tex?.dispose?.();
      }
      const label = this._makeLabel(city, cityId === this._selected);
      label.position.set(rec.world.x, LABEL_CONFIG.yOffset, rec.world.z);
      this.group.add(label);
      this._labels.set(cityId, { sprite: label, text: city.name, selected: cityId === this._selected });
      rec.text = city.name;
    }
    if (this._flagRenderer) this._flagRenderer.updateOwner(cityId, city.ownerId);
    this._avoidDirty = true;
    return true;
  }

  /** 选中：模型高亮 + 名称突出 + 地面标记；不改变真实势力。 */
  setSelected(cityId) {
    const prev = this._selected;
    if (prev !== null) {
      const rec = this._byId.get(prev);
      if (rec) rec.selected = false;
      this._applyBodyColor(prev);
      this.refreshCity(prev);
    }
    this._selected = cityId;
    if (cityId === null || !this._byId.has(cityId)) {
      this._ring.visible = false;
      // 选中被清空后，旧悬停色要按新状态重刷一次
      if (this._hover !== null) this._applyBodyColor(this._hover);
      return false;
    }
    if (this._hover === cityId) this._hover = null;   // 悬停城市被选中：交给选中色
    const rec = this._byId.get(cityId);
    this._ring.position.set(rec.world.x, 0.03, rec.world.z);
    this._ring.visible = true;
    this._applyBodyColor(cityId);
    this.refreshCity(cityId);
    rec.selected = true;
    this._avoidDirty = true;
    return true;
  }

  get selected() { return this._selected; }

  /** 相邻的未连接城市不会被返回：严格来自 getCityConnections()。 */
  getNeighborIds(cityId) {
    const out = new Set();
    for (const link of this.adapter.getCityConnections(cityId)) {
      if (link.cityId !== null) out.add(link.cityId);
    }
    return [...out].sort((a, b) => a - b);
  }

  /** 从 Raycaster 命中对象解析 cityId（支持 InstancedMesh 与普通 mesh）。 */
  resolveHit(hit) {
    if (!hit) return null;
    const obj = hit.object;
    if (obj === this._pick && Number.isInteger(hit.instanceId)) {
      const city = this.cities[hit.instanceId];
      return city ? city.id : null;
    }
    if (obj === this._body && Number.isInteger(hit.instanceId)) {
      const city = this.cities[hit.instanceId];
      return city ? city.id : null;
    }
    if (Number.isInteger(obj.userData?.cityId)) return obj.userData.cityId;
    return null;
  }

  getPickables() { return this._body && this._pick ? [this._body, this._pick] : []; }

  getCityWorldPosition(cityId) {
    const r = this._byId.get(cityId);
    return r ? { ...r.world } : null;
  }

  /**
   * 按相机缩放控制名称可读性（缩放很小则隐藏），并做轻量重叠避让：
   * 把名称牌位置投影到 NDC，按「选中城优先」保留不重叠的标签。
   * 节流 0.3s 重算，不在每帧做 O(n²) 全量计算，也不改变任何逻辑坐标。
   */
  update(dt, cameraZoom = 1, { projector = null, ndc = null } = {}) {
    this._elapsed += dt;
    const show = cameraZoom >= LABEL_CONFIG.hideBelowZoom;
    if (!show) {
      for (const { sprite } of this._labels.values()) sprite.visible = false;
    } else if (LABEL_CONFIG.avoidOverlap && projector && ndc) {
      this._avoidAccum += dt;
      if (this._avoidAccum >= LABEL_CONFIG.avoidIntervalSec || this._avoidDirty) {
        this._avoidAccum = 0;
        this._avoidDirty = false;
        this._avoidLabels(projector, ndc);
      }
    } else {
      for (const { sprite } of this._labels.values()) sprite.visible = true;
    }
    if (this._ring.visible) {
      const pulse = 1 + Math.sin(this._elapsed * 3.2) * 0.06;
      this._ring.scale.set(pulse, 1, pulse);
    }
  }

  _avoidLabels(projector, ndc) {
    const items = [];
    for (const [id, { sprite }] of this._labels) {
      const p = projector(sprite.position);
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      items.push({ id, sprite, x: p.x, y: p.y });
    }
    items.sort((a, b) => (a.id === this._selected ? -1 : b.id === this._selected ? 1 : a.id - b.id));
    const kept = [];
    for (const it of items) {
      const overlap = kept.some((k) =>
        Math.abs(k.x - it.x) < ndc.w * 0.92 && Math.abs(k.y - it.y) < ndc.h * 1.05);
      it.sprite.visible = !overlap;
      if (!overlap) kept.push(it);
    }
    this._labelStats = { shown: kept.length, hidden: items.length - kept.length };
    return this._labelStats;
  }

  getDiagnostics() {
    const player = this._playerOwnerId();
    const factions = { player: 0, enemy: 0, empty: 0 };
    // 用 _byId（refreshCity 会就地更新 ownerId），不要用 build() 时的 cities 快照
    for (const rec of this._byId.values()) {
      if (!rec.ownerId) factions.empty++;
      else if (rec.ownerId === player) factions.player++;
      else factions.enemy++;
    }
    return {
      cityCount: this.cities.length,
      uniqueIds: new Set(this.cities.map((c) => c.id)).size,
      labels: this._labels.size,
      labelVisibility: this._labelStats || null,
      pickables: this.getPickables().length,
      selected: this._selected,
      hover: this._hover,
      /** P6 §8.1：阵营三态计数 + 地面环是否已建（1 个 InstancedMesh / 1 draw call）。 */
      factions,
      factionRing: this._factionRing ? this._factionRing.count : 0,
      stateHistogram: this.cities.reduce((m, c) => {
        m[c.state] = (m[c.state] || 0) + 1; return m;
      }, {}),
    };
  }

  dispose() {
    this._ring?.material?.dispose?.();
    for (const { sprite } of this._labels.values()) {
      sprite.material.map?.dispose?.();
      sprite.material.dispose();
    }
    this._labels.clear();
    this._ownTextures.length = 0;
    this._byId.clear();
    this.group.clear();
    this._built = false;
  }
}
