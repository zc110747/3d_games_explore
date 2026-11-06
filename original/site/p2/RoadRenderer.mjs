/**
 * P2 RoadRenderer —— 城市连接道路。
 *
 * 唯一数据来源：GameAdapter.getCityLinks()，即原版「城市连接右」(资源 59) 的
 * 8 方向记录去重后的无向边（当前 54 条）。左表 60 运行时未被调用，不绘制。
 * 曲线的中点偏移只是视觉弯曲，两端点严格等于原版城市世界坐标，
 * 不改变任何连接关系，也不参与行军规则（P2 §8）。
 *
 * 全部道路合并成 1 个 BufferGeometry（1 draw call）；选中高亮单独一个 Mesh，
 * 只在选中变化时重建（不是每帧）。
 */
import { ROAD_CONFIG as R, stableHash } from './config.mjs';

function makeRibbonGeometry(THREE, edges, positions, { width, color, curveScale = 1 }) {
  const geo = new THREE.BufferGeometry();
  const verts = [];
  const cols = [];
  const idx = [];
  const c = new THREE.Color(color);
  let v = 0;
  for (const edge of edges) {
    const a = positions[edge.from], b = positions[edge.to];
    if (!a || !b) continue;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const px = -dz / len, pz = dx / len;
    const bend = (stableHash(`road:${edge.from}:${edge.to}`) % 2 ? 1 : -1)
      * R.curve * curveScale * (len / 4);
    for (let s = 0; s <= R.segments; s++) {
      const t = s / R.segments;
      const off = Math.sin(Math.PI * t) * bend;
      const cx = a.x + dx * t + px * off;
      const cz = a.z + dz * t + pz * off;
      const y = R.y + (color === R.highlightColor ? 0.012 : 0);
      verts.push(cx - px * width / 2, y, cz - pz * width / 2);
      verts.push(cx + px * width / 2, y, cz + pz * width / 2);
      cols.push(c.r, c.g, c.b, c.r, c.g, c.b);
      if (s > 0) {
        const p = v + (s - 1) * 2;
        idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2);
      }
    }
    v += (R.segments + 1) * 2;
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

export class RoadRenderer {
  constructor({ THREE, adapter, coordinate }) {
    if (!THREE || !adapter || !coordinate) throw new TypeError('RoadRenderer 依赖不完整');
    this.THREE = THREE;
    this.adapter = adapter;
    this.coordinate = coordinate;
    this.group = new THREE.Group();
    this.group.name = 'p2-roads';
    this.links = [];
    this._positions = {};
    this._highlight = null;
    this._selectedCity = null;
    this._built = false;
  }

  build() {
    if (this._built) return this.group;
    const THREE = this.THREE;
    this.links = this.adapter.getCityLinks();
    for (const city of this.adapter.getCities()) {
      this._positions[city.id] = this.coordinate.mapToWorld(city.position.x, city.position.y);
    }
    const geo = makeRibbonGeometry(THREE, this.links, this._positions, {
      width: R.width, color: R.color,
    });
    this._base = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.9,
      depthWrite: false,
    }));
    this._base.name = 'p2-road-base';
    this.group.add(this._base);
    this._built = true;
    return this.group;
  }

  /** 只高亮原版允许显示的相邻路径；未连接城市不会被高亮。 */
  highlightNeighbors(cityId) {
    this._selectedCity = cityId;
    if (this._highlight) {
      this.group.remove(this._highlight);
      this._highlight.geometry.dispose();
      this._highlight.material.dispose();
      this._highlight = null;
    }
    if (cityId === null || cityId === undefined) return 0;
    const edges = this.links.filter((e) => e.from === cityId || e.to === cityId);
    if (!edges.length) return 0;
    const geo = makeRibbonGeometry(this.THREE, edges, this._positions, {
      width: R.highlightWidth, color: R.highlightColor, curveScale: 1,
    });
    this._highlight = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.98,
      depthWrite: false,
    }));
    this._highlight.name = 'p2-road-highlight';
    this._highlight.renderOrder = 2;
    this.group.add(this._highlight);
    return edges.length;
  }

  /** 连接统计：供一致性测试与调试面板核对，不做任何推断。 */
  getDiagnostics() {
    const endpoints = new Set();
    let directed = 0;
    for (const e of this.links) {
      endpoints.add(e.from); endpoints.add(e.to);
      if (e.forward) directed++;
      if (e.backward) directed++;
    }
    return {
      edges: this.links.length,
      directedRecords: directed,
      connectedCities: endpoints.size,
      highlighted: this._selectedCity === null ? 0
        : this.links.filter((e) => e.from === this._selectedCity || e.to === this._selectedCity).length,
      source: 'getItem(59,1) / getCityLinks()',
    };
  }

  dispose() {
    if (this._highlight) {
      this._highlight.geometry.dispose();
      this._highlight.material.dispose();
      this._highlight = null;
    }
    if (this._base) {
      this._base.geometry.dispose();
      this._base.material.dispose();
    }
    this.group.clear();
    this._built = false;
  }
}
