/**
 * P4 BattleRangeRenderer —— 移动范围 / 攻击范围的 3D 覆盖层。
 *
 * 数据只来自 GameAdapter.getMovementRange() / getAttackRange()，
 * 也就是原版 qi() / Vo() 的计算结果；本模块**不做任何范围推导**，
 * 只把给定的格子列表画成半透明色块。
 *
 * 两个 InstancedMesh（移动=蓝、攻击=红）+ 一个格子高亮框，
 * 每帧不变，切换单位时只改 count 与矩阵，不重建几何体。
 */
import { RANGE_STYLE } from './config.mjs';

export class BattleRangeRenderer {
  constructor({ THREE, assets, coordinate }) {
    if (!THREE || !assets || !coordinate) throw new TypeError('BattleRangeRenderer 依赖不完整');
    this.THREE = THREE;
    this.assets = assets;
    this.coordinate = coordinate;
    this.group = null;
    this._move = null;
    this._attack = null;
    this._cursor = null;
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this.stats = { moveCells: 0, attackCells: 0, updates: 0, pathPoints: 0 };
  }

  build() {
    const THREE = this.THREE;
    const group = new THREE.Group();
    group.name = 'p4-battle-ranges';
    this.group = group;

    const geo = this.assets.geometry('p4:range-cell', (T) => new T.PlaneGeometry(
      RANGE_STYLE.cellScale, RANGE_STYLE.cellScale));

    const mk = (key, color, opacity) => {
      const mat = this.assets.material(key, (T) => new T.MeshBasicMaterial({
        color, transparent: true, opacity, depthWrite: false, side: T.DoubleSide,
      }));
      const inst = new THREE.InstancedMesh(geo, mat, RANGE_STYLE.maxInstances);
      inst.count = 0;
      inst.frustumCulled = false;
      inst.renderOrder = 3;
      return inst;
    };
    this._move = mk('p4:range-move-mat', RANGE_STYLE.moveColor, RANGE_STYLE.moveOpacity);
    this._move.name = 'p4-range-move';
    this._attack = mk('p4:range-attack-mat', RANGE_STYLE.attackColor, RANGE_STYLE.attackOpacity);
    this._attack.name = 'p4-range-attack';

    const cursorGeo = this.assets.geometry('p4:cursor-box', (T) => new T.BoxGeometry(1, 0.02, 1));
    const cursorMat = this.assets.material('p4:cursor-mat', (T) => new T.MeshBasicMaterial({
      color: 0xffe08a, transparent: true, opacity: 0.55, depthWrite: false,
    }));
    this._cursor = new THREE.Mesh(cursorGeo, cursorMat);
    this._cursor.name = 'p4-battle-cursor';
    this._cursor.visible = false;
    this._cursor.renderOrder = 4;

    // P5：移动路径折线（数据来自原版 qi() 距离场下降，见 p5/VisualPath.mjs）
    const pathGeo = new THREE.BufferGeometry();
    pathGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RANGE_STYLE.maxPathPoints * 3), 3));
    pathGeo.setDrawRange(0, 0);
    const pathMat = new THREE.LineBasicMaterial({
      color: 0xffd76a, transparent: true, opacity: 0.85, depthTest: false,
    });
    this._path = new THREE.Line(pathGeo, pathMat);
    this._path.name = 'p5-battle-path';
    this._path.visible = false;
    this._path.renderOrder = 6;
    this._path.frustumCulled = false;

    // P5：目标锁定环（攻击/计谋目标）
    const targetGeo = this.assets.geometry('p5:target-ring', (T) => new T.RingGeometry(0.5, 0.63, 28));
    const targetMat = this.assets.material('p5:target-ring-mat', (T) => new T.MeshBasicMaterial({
      color: 0xff4b3a, transparent: true, opacity: 0.92, depthWrite: false, side: T.DoubleSide,
    }));
    this._target = new THREE.Mesh(targetGeo, targetMat);
    this._target.rotation.x = -Math.PI / 2;
    this._target.name = 'p5-battle-target';
    this._target.visible = false;
    this._target.renderOrder = 5;

    group.add(this._move, this._attack, this._cursor, this._path, this._target);
    return group;
  }

  /** P5：显示「从当前格到目标格」的视觉路径（只画，不判断合法性）。 */
  showPath(cells) {
    if (!this._path) return 0;
    const pts = Array.isArray(cells) ? cells : [];
    if (pts.length < 2) { this.clearPath(); return 0; }
    const attr = this._path.geometry.getAttribute('position');
    const n = Math.min(pts.length, RANGE_STYLE.maxPathPoints);
    for (let i = 0; i < n; i++) {
      const w = this.coordinate.gridToWorld(pts[i].x, pts[i].y);
      attr.setXYZ(i, w.x, RANGE_STYLE.pathY, w.z);
    }
    attr.needsUpdate = true;
    this._path.geometry.setDrawRange(0, n);
    this._path.visible = true;
    this.stats.pathPoints = n;
    return n;
  }

  clearPath() {
    if (!this._path) return;
    this._path.visible = false;
    this._path.geometry.setDrawRange(0, 0);
    this.stats.pathPoints = 0;
  }

  /** P5：目标锁定环（传 null 隐藏）。 */
  setTarget(cell) {
    if (!this._target) return false;
    if (!cell || !Number.isInteger(cell.x) || !Number.isInteger(cell.y)) {
      this._target.visible = false;
      return false;
    }
    const w = this.coordinate.gridToWorld(cell.x, cell.y);
    this._target.position.set(w.x, RANGE_STYLE.pathY + 0.01, w.z);
    this._target.visible = true;
    return true;
  }

  _fill(inst, cells, y) {
    const n = Math.min(cells.length, RANGE_STYLE.maxInstances);
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      const w = this.coordinate.gridToWorld(c.x, c.y);
      this._p.set(w.x, y, w.z);
      this._m4.compose(this._p, this._q, this._s);
      inst.setMatrixAt(i, this._m4);
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    inst.visible = n > 0;
    return n;
  }

  showMove(cells) {
    this.stats.moveCells = this._fill(this._move, cells || [], RANGE_STYLE.y);
    this.stats.updates++;
    return this.stats.moveCells;
  }

  showAttack(cells) {
    // 抬高 0.02：攻击范围常与移动范围重叠，同高度会 z-fighting（视觉上闪/丢失）
    this.stats.attackCells = this._fill(this._attack, cells || [], RANGE_STYLE.y + 0.02);
    return this.stats.attackCells;
  }

  setCursor(cell) {
    if (!cell || !Number.isInteger(cell.x) || !Number.isInteger(cell.y)) {
      this._cursor.visible = false;
      return false;
    }
    const w = this.coordinate.gridToWorld(cell.x, cell.y);
    this._cursor.position.set(w.x, 0.02, w.z);
    this._cursor.visible = true;
    return true;
  }

  clear() {
    this._move.count = 0;
    this._attack.count = 0;
    this._move.visible = false;
    this._attack.visible = false;
    this._cursor.visible = false;
    this.clearPath();
    this.setTarget(null);
    this.stats.moveCells = 0;
    this.stats.attackCells = 0;
  }

  dispose() {
    if (this.group && this.group.parent) this.group.parent.remove(this.group);
    this.group = null;
    this._move = null;
    this._attack = null;
    this._cursor = null;
    this._path = null;
    this._target = null;
  }
}
