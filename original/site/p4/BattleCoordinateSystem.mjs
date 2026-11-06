/**
 * P4 BattleCoordinateSystem —— 战斗格坐标的唯一出口（薄封装 P1 CoordinateSystem）。
 *
 * 三套坐标严格分开（P4 §11.2）：
 *   1) 原版格子坐标 (x,y)     —— 与 Ci() 地图数据下标一一对应，整数，绝不缩放
 *   2) 世界坐标 (x,y,z)       —— 由 CoordinateSystem.gridToWorld 统一换算
 *   3) 屏幕坐标 (px,py)       —— 只由 projector 回调得到，用于拾取/标注
 *
 * 另外提供「原版 15x15 局部窗口」的换算：qi() 只算窗口内的格子，
 * 窗口原点由原版自己的 g_PathSX-g_PUseSX 给出（见 GameAdapter.getMovementRange）。
 *
 * 本模块不含任何战斗规则，也不读 THREE。
 */
export class BattleCoordinateSystem {
  constructor(coordinate) {
    if (!coordinate) throw new TypeError('BattleCoordinateSystem 需要 P1 CoordinateSystem');
    this.coordinate = coordinate;
    this.size = { cols: coordinate.battle.cols, rows: coordinate.battle.rows };
  }

  /** 按原版地图头部真实宽高配置（不写死 32）。 */
  configure(cols, rows) {
    this.coordinate.setBattleGridSize(cols, rows);
    this.size = { cols, rows };
    return this.size;
  }

  /** 格子 -> 世界（默认贴地，可给高度用于挂点）。 */
  gridToWorld(x, y, { height } = {}) {
    return this.coordinate.gridToWorld(x, y, height === undefined ? {} : { height });
  }

  /** 世界 -> 格子（返回四舍五入后的整数格、原始浮点与边界信息）。 */
  worldToGrid(worldX, worldZ) {
    return this.coordinate.worldToGrid(worldX, worldZ);
  }

  /** 世界 -> 屏幕；projector 由渲染层注入，本模块不持有相机。 */
  worldToScreen(world, projector, viewport) {
    return this.coordinate.worldToScreen(world, projector, viewport);
  }

  /** 屏幕 -> 世界：只做「射线交点」这一步，交点由调用方用 Raycaster 求得。 */
  screenToWorld(intersection) {
    if (!intersection || !intersection.point) return null;
    const p = intersection.point;
    return { x: p.x, y: p.y, z: p.z };
  }

  /** 原版 15x15 路径窗口内下标 -> 全图格坐标（origin 来自原版 g_Path*）。 */
  pathWindowToGrid(index, origin, windowSize = 15) {
    return { x: origin.x + (index % windowSize), y: origin.y + Math.floor(index / windowSize) };
  }

  /** 攻击范围位图下标 -> 全图格坐标（origin 来自原版 g_FgtAtkRng[1..2]）。 */
  attackBitmapToGrid(index, origin, size) {
    return { x: origin.x + (index % size), y: origin.y + Math.floor(index / size) };
  }

  /** 世界坐标是否落在该地图内（只用于调试图层，不参与判定）。 */
  containsWorld(x, z) {
    const g = this.worldToGrid(x, z);
    return g.inBounds;
  }

  getConfig() {
    return { battle: { ...this.coordinate.battle }, size: { ...this.size } };
  }
}
