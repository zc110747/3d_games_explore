/**
 * P4 BattleMapRenderer —— 3D 战斗格子地图。
 *
 * 数据来源：GameAdapter.getBattleMap()（原版 Ci() + Ui()）。
 *   - 底板：每格一个四边形，UV 精确取原版图集里 tile 号对应的那一帧；
 *     1024 格合并进一个 BufferGeometry —— 1 个 draw call。
 *   - 顶点色：按地形类别做轻微 tint（河流偏蓝、城池偏暖），不影响图块内容。
 *   - 网格线：33x33 条独立线段（LineSegments，1 个 draw call）。
 *   - 装饰体：山地/森林/村庄/城池/营寨各 1 个 InstancedMesh，低面数几何体，
 *     明确是**装饰**（原版无地形高度），不参与任何判定，也不遮挡单位。
 *
 * 全部几何体/材质走 P1 AssetManager 缓存，重复进入战斗不重复创建。
 */
import { BATTLE_TILE_CONFIG, TERRAIN_STYLE, BATTLE_PROTOCOL } from './config.mjs';
import { createBattleTileAtlas } from './BattleTexture.mjs';

export class BattleMapRenderer {
  constructor({ THREE, assets, coordinate, adapter }) {
    if (!THREE || !assets || !coordinate || !adapter) {
      throw new TypeError('BattleMapRenderer 依赖不完整');
    }
    this.THREE = THREE;
    this.assets = assets;
    this.coordinate = coordinate;
    this.adapter = adapter;
    this.group = null;
    this.map = null;
    this.stats = {
      cells: 0, tiles: 0, frames: 0, degraded: false,
      gridLines: 0, props: 0, propMeshes: 0, source: '',
    };
  }

  /** 构建（或重建）整张战斗地图。返回一个 Group，由场景挂到 scene。 */
  build() {
    const THREE = this.THREE;
    const map = this.adapter.getBattleMap();
    if (!map.available) throw new Error(`战斗地图不可用：${map.reason}`);
    this.map = map;
    this.coordinate.configure(map.width, map.height);

    const group = new THREE.Group();
    group.name = 'p4-battle-map';
    this.group = group;

    // 图集先就绪：底板 UV 依赖它的帧数与排版
    if (!this.atlas) {
      this.atlas = createBattleTileAtlas(THREE, this.adapter.lib, BATTLE_PROTOCOL.tilePicId);
      this.stats.frames = this.atlas.frames;
      this.stats.degraded = this.atlas.degraded;
      this.stats.source = this.atlas.source;
    }

    group.add(this._buildTiles(map));
    group.add(this._buildGrid(map));
    if (BATTLE_TILE_CONFIG.borderWidth > 0) group.add(this._buildBorder(map));
    for (const mesh of this._buildProps(map)) group.add(mesh);

    this.stats.cells = map.cellCount;
    this.stats.tiles = this.stats.tiles || 0;
    return group;
  }

  // ------------------------------------------------------------------ 底板
  _buildTiles(map) {
    const THREE = this.THREE;
    const cfg = BATTLE_TILE_CONFIG;
    const { width: w, height: h, raw, terrain } = map;
    const t = this.coordinate.getConfig().battle.tileSize;

    const quads = w * h;
    const pos = new Float32Array(quads * 4 * 3);
    const uv = new Float32Array(quads * 4 * 2);
    const col = new Float32Array(quads * 4 * 3);
    const idx = new Uint32Array(quads * 6);

    const atlasCols = this.atlas ? this.atlas.cols : 8;
    const atlasRows = this.atlas ? this.atlas.rows : 6;
    const halfU = 1 / (2 * atlasCols);
    const halfV = 1 / (2 * atlasRows);
    const c = new THREE.Color();
    const color = new THREE.Color();

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        const cx = (x - (w - 1) / 2) * t;
        const cz = (y - (h - 1) / 2) * t;
        const o = k * 4;
        // 四角：左上、右上、右下、左下（俯视 -Y）
        const corners = [
          [cx - t / 2, cz - t / 2], [cx + t / 2, cz - t / 2],
          [cx + t / 2, cz + t / 2], [cx - t / 2, cz + t / 2],
        ];
        for (let i = 0; i < 4; i++) {
          pos[(o + i) * 3] = corners[i][0];
          pos[(o + i) * 3 + 1] = cfg.groundY;
          pos[(o + i) * 3 + 2] = corners[i][1];
        }
        // UV：图集里第 tile 帧的格子（内缩半像素，避免最近邻取到邻帧）
        const tile = raw[k];
        const frame = tile < (this.atlas ? this.atlas.frames : 46) ? tile : 0;
        const fx = frame % atlasCols;
        const fy = Math.floor(frame / atlasCols);
        const u0 = fx / atlasCols + halfU * 0.02;
        const v0 = 1 - (fy + 1) / atlasRows + halfV * 0.02;
        const u1 = (fx + 1) / atlasCols - halfU * 0.02;
        const v1 = 1 - fy / atlasRows - halfV * 0.02;
        // 纹理 flipY=true：v1 是帧的上边，对应世界北侧（-Z）的两角
        uv[(o + 0) * 2] = u0; uv[(o + 0) * 2 + 1] = v1;
        uv[(o + 1) * 2] = u1; uv[(o + 1) * 2 + 1] = v1;
        uv[(o + 2) * 2] = u1; uv[(o + 2) * 2 + 1] = v0;
        uv[(o + 3) * 2] = u0; uv[(o + 3) * 2 + 1] = v0;

        const style = TERRAIN_STYLE[terrain[k]] || TERRAIN_STYLE[1];
        color.setHex(style.tint);
        for (let i = 0; i < 4; i++) {
          col[(o + i) * 3] = color.r;
          col[(o + i) * 3 + 1] = color.g;
          col[(o + i) * 3 + 2] = color.b;
        }

        const b = k * 4;
        idx[k * 6 + 0] = b; idx[k * 6 + 1] = b + 2; idx[k * 6 + 2] = b + 1;
        idx[k * 6 + 3] = b; idx[k * 6 + 4] = b + 3; idx[k * 6 + 5] = b + 2;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    const mat = this.assets.material('p4:battle-tile-mat', (T) => new T.MeshLambertMaterial({
      map: this.atlas ? this.atlas.texture : null,
      vertexColors: true,
      side: T.DoubleSide,
    }));
    if (this.atlas && this.atlas.texture && mat.map !== this.atlas.texture) {
      mat.map = this.atlas.texture;
      mat.needsUpdate = true;
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'p4-battle-tiles';
    mesh.receiveShadow = false;
    this.stats.tiles = 1;
    return mesh;
  }

  // ------------------------------------------------------------------ 网格
  _buildGrid(map) {
    const THREE = this.THREE;
    const t = this.coordinate.getConfig().battle.tileSize;
    const halfW = (map.width * t) / 2;
    const halfH = (map.height * t) / 2;
    const y = BATTLE_TILE_CONFIG.groundY + 0.012;
    const pts = [];
    for (let i = 0; i <= map.width; i++) {
      const x = -halfW + i * t;
      pts.push(x, y, -halfH, x, y, halfH);
    }
    for (let i = 0; i <= map.height; i++) {
      const z = -halfH + i * t;
      pts.push(-halfW, y, z, halfW, y, z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = this.assets.material('p4:battle-grid-mat', (T) => new T.LineBasicMaterial({
      color: BATTLE_TILE_CONFIG.gridLineColor,
      transparent: true,
      opacity: BATTLE_TILE_CONFIG.gridLineOpacity,
    }));
    const lines = new THREE.LineSegments(geo, mat);
    lines.name = 'p4-battle-grid';
    this.stats.gridLines = pts.length / 6;
    return lines;
  }

  _buildBorder(map) {
    const THREE = this.THREE;
    const t = this.coordinate.getConfig().battle.tileSize;
    const bw = BATTLE_TILE_CONFIG.borderWidth;
    const halfW = (map.width * t) / 2 + bw / 2;
    const halfH = (map.height * t) / 2 + bw / 2;
    const geoW = this.assets.geometry('p4:border-w', (T) => new T.BoxGeometry(1, 1, 1));
    const mat = this.assets.material('p4:border-mat', (T) => new T.MeshBasicMaterial({
      color: BATTLE_TILE_CONFIG.borderColor,
    }));
    const group = new THREE.Group();
    group.name = 'p4-battle-border';
    const specs = [
      [0, -halfH, map.width * t + bw * 2, bw],
      [0, halfH, map.width * t + bw * 2, bw],
      [-halfW, 0, bw, map.height * t],
      [halfW, 0, bw, map.height * t],
    ];
    for (const [x, z, sx, sz] of specs) {
      const m = new THREE.Mesh(geoW, mat);
      m.scale.set(sx, 0.06, sz);
      m.position.set(x, 0.02, z);
      group.add(m);
    }
    return group;
  }

  // ---------------------------------------------------------------- 装饰体
  _buildProps(map) {
    const THREE = this.THREE;
    const t = this.coordinate.getConfig().battle.tileSize;
    const byProp = new Map();
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const cls = map.terrain[y * map.width + x];
        const style = TERRAIN_STYLE[cls];
        if (!style || !style.prop) continue;
        if (!byProp.has(style.prop)) byProp.set(style.prop, { style, cells: [] });
        byProp.get(style.prop).cells.push([x, y]);
      }
    }

    const geoByProp = {
      rock: (T) => new T.ConeGeometry(0.28, 0.34, 5, 1),
      tree: (T) => new T.ConeGeometry(0.2, 0.34, 5, 1),
      house: (T) => new T.BoxGeometry(0.34, 0.22, 0.3),
      keep: (T) => new T.BoxGeometry(0.5, 0.42, 0.5),
      camp: (T) => new T.ConeGeometry(0.34, 0.26, 6, 1),
    };
    const colorByProp = {
      rock: 0x8a8574, tree: 0x4f7042, house: 0xc8a878, keep: 0xd8c49a, camp: 0xb07a52,
    };
    const meshes = [];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    let total = 0;

    for (const [prop, { style, cells }] of byProp) {
      const geo = this.assets.geometry(`p4:prop-${prop}`, (T) => geoByProp[prop](T));
      const mat = this.assets.material(`p4:prop-mat-${prop}`, (T) => new T.MeshLambertMaterial({
        color: colorByProp[prop], flatShading: true,
      }));
      const inst = new THREE.InstancedMesh(geo, mat, cells.length);
      inst.name = `p4-battle-props-${prop}`;
      inst.userData = { decorative: true, terrain: style.id };
      cells.forEach(([x, y], i) => {
        const w = this.coordinate.gridToWorld(x, y);
        // 用格子坐标做稳定抖动，避免所有装饰体一模一样（纯视觉，确定性）
        const jx = ((x * 7 + y * 13) % 5 - 2) * 0.03;
        const jz = ((x * 11 + y * 5) % 5 - 2) * 0.03;
        const hs = 0.85 + ((x * 3 + y * 7) % 4) * 0.08;
        p.set(w.x + jx, style.propHeight * 0.5, w.z + jz);
        scale.set(1, hs, 1);
        m4.compose(p, q, scale);
        inst.setMatrixAt(i, m4);
      });
      inst.instanceMatrix.needsUpdate = true;
      meshes.push(inst);
      total += cells.length;
    }
    this.stats.props = total;
    this.stats.propMeshes = meshes.length;
    void t;
    return meshes;
  }

  /** 地形类别计数（诊断用，全部来自原版 Ui()）。 */
  getTerrainHistogram() {
    const map = this.map;
    if (!map) return null;
    const counts = new Array(8).fill(0);
    for (let i = 0; i < map.terrain.length; i++) counts[map.terrain[i]]++;
    return counts;
  }

  dispose() {
    if (this.group && this.group.parent) this.group.parent.remove(this.group);
    this.group = null;
    this.map = null;
  }
}
