/**
 * P2 TerrainRenderer —— 战略地图地形。
 *
 * 底板贴图 = 原版 `lib.loadPic(54,1)` 的 108 帧（12x9）地形图块，按 qs() 的
 * (row*12+col) 索引拼合（TextureFactory.createTerrainAtlas）。
 * 顶点起伏与低面数山体是**装饰性几何**，依据「城市布局(2,14)」避开所有城格，
 * 不改变城市坐标/连接/规则，也不作为任何游戏判断依据（P2 §5.1）。
 *
 * Geometry / Material 通过 P1 AssetManager 缓存复用；底板与山体各 1 个 draw call。
 */
import { TERRAIN_CONFIG, ORIGINAL_MAP, stableHash } from './config.mjs';
import { createTerrainAtlas } from './TextureFactory.mjs';

export class TerrainRenderer {
  constructor({ THREE, assets, lib, coordinate }) {
    if (!THREE || !assets || !lib || !coordinate) throw new TypeError('TerrainRenderer 依赖不完整');
    this.THREE = THREE;
    this.assets = assets;
    this.lib = lib;
    this.coordinate = coordinate;
    this.group = new THREE.Group();
    this.group.name = 'p2-terrain';
    this.stats = { frames: 0, degraded: false, props: 0, vertices: 0, source: '' };
    this._ownTextures = [];
    this._built = false;
  }

  /** 城市布局表：值 = 城市编号 + 1，0 = 空格（P0 §3.3）。 */
  _cityMask() {
    const layout = this.lib.getItem(2, 14);
    const o = ORIGINAL_MAP;
    const mask = new Uint8Array(o.cols * o.rows);
    if (layout) {
      for (let i = 0; i < mask.length; i++) mask[i] = layout[i] ? 1 : 0;
    }
    return mask;
  }

  build() {
    if (this._built) return this.group;
    const THREE = this.THREE;
    const cfg = this.coordinate.getConfig().world;
    const o = ORIGINAL_MAP;
    const t = cfg.tileSize;
    const w = o.cols * t, h = o.rows * t;
    const mask = this._cityMask();

    const atlas = createTerrainAtlas(THREE, this.lib);
    this.stats.frames = atlas.frames;
    this.stats.degraded = atlas.degraded;
    this.stats.source = atlas.source;
    this._ownTextures.push(atlas.texture);

    const seg = TERRAIN_CONFIG.segmentsPerTile;
    const geo = new THREE.PlaneGeometry(w, h, o.cols * seg, o.rows * seg);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const col = Math.min(o.cols - 1, Math.max(0, Math.floor((x + w / 2) / t)));
      const row = Math.min(o.rows - 1, Math.max(0, Math.floor((y + h / 2) / t)));
      const isCity = mask[row * o.cols + col];
      const n = stableHash(`relief:${col}:${row}:${i}`) / 0xffffffff;
      const relief = isCity ? 0 : TERRAIN_CONFIG.reliefHeight * (0.35 + 0.65 * n);
      // PlaneGeometry 局部 +z 在 rotation.x=-PI/2 后成为世界 +y
      pos.setZ(i, relief);
      const shade = 0.86 + (relief / Math.max(1e-6, TERRAIN_CONFIG.reliefHeight)) * 0.14;
      colors[i * 3] = shade; colors[i * 3 + 1] = shade; colors[i * 3 + 2] = shade;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    this.stats.vertices = pos.count;

    const ground = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: atlas.texture, vertexColors: true, side: THREE.DoubleSide,
    }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.002;
    ground.name = 'p2-terrain-ground';
    this.group.add(ground);

    // 古风地图边框：四条细长条，比例统一，不针对单城特例
    const bw = TERRAIN_CONFIG.borderWidth;
    const borderMat = new THREE.MeshBasicMaterial({ color: 0x6b5736 });
    const long = new THREE.BoxGeometry(w + bw * 2, bw * 0.55, bw);
    const short = new THREE.BoxGeometry(bw, bw * 0.55, h + bw * 2);
    for (const [g, x, z] of [[long, 0, -h / 2 - bw / 2], [long, 0, h / 2 + bw / 2],
      [short, -w / 2 - bw / 2, 0], [short, w / 2 + bw / 2, 0]]) {
      const bar = new THREE.Mesh(g, borderMat);
      bar.position.set(x, 0.015, z);
      this.group.add(bar);
    }

    if (TERRAIN_CONFIG.decorativeProps) this._buildProps(mask, t);
    this._built = true;
    return this.group;
  }

  /** 装饰性低面数山体：InstancedMesh，一格最多一个，避开所有城格。 */
  _buildProps(mask, t) {
    const THREE = this.THREE;
    const o = ORIGINAL_MAP;
    const spots = [];
    for (let row = 0; row < o.rows; row++) {
      for (let col = 0; col < o.cols; col++) {
        if (mask[row * o.cols + col]) continue;
        const n = stableHash(`prop:${col}:${row}`);
        if (n % 100 > 14) continue;      // 确定性稀疏采样（装饰不喧宾夺主）
        const p = this.coordinate.mapToWorld(col, row, { height: 0.01 });
        const jitter = (k) => (((stableHash(`j:${col}:${row}:${k}`) % 1000) / 1000) - 0.5) * t * 0.45;
        spots.push({ x: p.x + jitter(1), z: p.z + jitter(2), scale: 0.55 + (n % 50) / 100 });
      }
    }
    if (!spots.length) return;
    const geometry = new THREE.ConeGeometry(0.09 * t, 0.17 * t, 5, 1);
    const material = new THREE.MeshLambertMaterial({ color: 0x6f7d56, flatShading: true });
    const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
    mesh.name = 'p2-terrain-decorative-props';
    const dummy = new THREE.Object3D();
    spots.forEach((s, i) => {
      dummy.position.set(s.x, 0.05 * s.scale, s.z);
      dummy.scale.setScalar(s.scale);
      dummy.rotation.y = (stableHash(`rot:${i}`) % 628) / 100;
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    this.stats.props = spots.length;
    this._props = mesh;
  }

  dispose() {
    for (const tex of this._ownTextures.splice(0)) tex.dispose();
    for (const child of [...this.group.children]) {
      if (child.geometry && child.geometry !== this._props?.geometry) child.geometry.dispose?.();
      const mats = Array.isArray(child.material) ? child.material : (child.material ? [child.material] : []);
      for (const m of mats) m.dispose?.();
    }
    this._props?.geometry?.dispose?.();
    this.group.clear();
    this._built = false;
  }
}
