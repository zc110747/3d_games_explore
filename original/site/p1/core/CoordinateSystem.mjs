/**
 * P1 CoordinateSystem —— 四套坐标严格分离：
 *   1) 原版地图逻辑坐标  (col,row)   —— 12x9 战略格 / 32x32 战斗格，整数，来自 game.zip
 *   2) Three.js 世界坐标 (x,y,z)     —— y 为高度，x/z 为平面
 *   3) Three.js 屏幕坐标 (px,py)     —— 由摄像机投影得到，与逻辑坐标无关
 *   4) 战斗格子坐标      (col,row)   —— 与战略格共用数学形式，但配置独立
 *
 * 关键约束（P1 任务书 §6.2）：
 *   「逻辑坐标 -> 世界坐标」与「摄像机投影」是两个过程，绝不混为一个函数。
 *   worldToScreen() 只接受一个 projector 回调，本模块不持有 camera、不 import three。
 *
 * 本模块无 DOM / 无 three 依赖，可在 Node 中直接用真实数据做往返测试。
 */
import { WORLD_MAP_CONFIG, BATTLE_GRID_CONFIG } from './config.mjs';

const EPS = 1e-9;

export class CoordinateSystem {
  constructor({ world = WORLD_MAP_CONFIG, battle = BATTLE_GRID_CONFIG } = {}) {
    this.world = { ...world };
    this.battle = { ...battle };
  }

  // ---------------------------------------------------------------- 通用
  /** 统一比例/偏移：以地图中心为世界原点，col -> +X，row -> +Z。 */
  _toWorld(col, row, cfg, height = cfg.groundY) {
    const t = cfg.tileSize;
    return {
      x: (col - (cfg.cols - 1) / 2) * t,
      y: height,
      z: (row - (cfg.rows - 1) / 2) * t,
    };
  }

  /** 逆变换。返回浮点格坐标、四舍五入整数格、以及精度偏差（单位：格）。 */
  _fromWorld(x, z, cfg) {
    const t = cfg.tileSize;
    const col = x / t + (cfg.cols - 1) / 2;
    const row = z / t + (cfg.rows - 1) / 2;
    const rCol = Math.round(col);
    const rRow = Math.round(row);
    return {
      col: rCol, row: rRow,
      raw: { col, row },
      error: Math.max(Math.abs(col - rCol), Math.abs(row - rRow)),
      inBounds: rCol >= 0 && rCol < cfg.cols && rRow >= 0 && rRow < cfg.rows,
    };
  }

  // ------------------------------------------------------- 战略地图坐标
  /** (col,row) -> 世界坐标。可选 height 用于城市模型/旗帜挂点。 */
  mapToWorld(col, row, { height } = {}) {
    return this._toWorld(col, row, this.world, height ?? this.world.groundY);
  }

  /** 世界坐标 -> 逻辑格（含精度与边界信息）。 */
  worldToMap(x, z) { return this._fromWorld(x, z, this.world); }

  /**
   * 世界坐标 -> 屏幕像素。projector 由渲染层注入：
   *   (world:{x,y,z}) => NDC {x,y,z}（即 THREE.Vector3.project(camera) 的结果）
   * viewport: {left, top, width, height}
   * 注意：这只是摄像机投影，改变 viewport / zoom 不会改变 mapToWorld 的结果。
   */
  worldToScreen(world, projector, viewport) {
    if (typeof projector !== 'function') throw new TypeError('worldToScreen 需要 projector 回调');
    const ndc = projector(world);
    if (!ndc || !Number.isFinite(ndc.x) || !Number.isFinite(ndc.y)) {
      return { x: NaN, y: NaN, visible: false, ndc };
    }
    return {
      x: viewport.left + (ndc.x * 0.5 + 0.5) * viewport.width,
      y: viewport.top + (-ndc.y * 0.5 + 0.5) * viewport.height,
      visible: Math.abs(ndc.x) <= 1 + EPS && Math.abs(ndc.y) <= 1 + EPS &&
               (ndc.z === undefined || (ndc.z >= -1 - EPS && ndc.z <= 1 + EPS)),
      ndc,
    };
  }

  // ------------------------------------------------------- 战斗格子坐标
  gridToWorld(col, row, { height } = {}) {
    return this._toWorld(col, row, this.battle, height ?? this.battle.groundY);
  }

  worldToGrid(x, z) { return this._fromWorld(x, z, this.battle); }

  /** 原版 g_FightPath 是 15x15 局部窗口；用 g_PathSX/g_PUseSX 还原为全图格坐标。 */
  localPathToGrid(localIndex, pathSX, pathSY, useSX, useSY, windowSize = 15) {
    const localCol = localIndex % windowSize;
    const localRow = Math.floor(localIndex / windowSize);
    return {
      col: pathSX - useSX + localCol,
      row: pathSY - useSY + localRow,
    };
  }

  /** 原版 g_FgtAtkRng 位图左上角 + 尺寸，还原为全图格坐标。 */
  attackRangeToGrid(index, originX, originY, size) {
    return { col: originX + (index % size), row: originY + Math.floor(index / size) };
  }

  // ------------------------------------------------------------ 配置调整
  setWorldTileSize(tileSize) {
    if (!(tileSize > 0)) throw new RangeError('tileSize 必须为正数');
    this.world = { ...this.world, tileSize };
    return this.world;
  }

  setBattleTileSize(tileSize) {
    if (!(tileSize > 0)) throw new RangeError('tileSize 必须为正数');
    this.battle = { ...this.battle, tileSize };
    return this.battle;
  }

  getConfig() { return { world: { ...this.world }, battle: { ...this.battle } }; }
}
