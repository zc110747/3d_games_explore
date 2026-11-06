/**
 * P4 战斗表现层配置 —— 只有渲染/交互参数，不含任何游戏规则数据。
 *
 * 依据真实源码（还原副本 sgby.pretty.js 行号）：
 *  - L2351-2353: _e=10（每方 10 支部队）、we=20、pe=15/be=17（2D 视口）、
 *                Pe=16（图块 16px）、ke=15（路径窗口宽）、Me=128（可到达阈值）
 *  - L5755:      yo() 读地图头部 [0]=宽、[2]=高，并把 g_TileId 置为 4
 *  - L5632:      eo() 从 getItem(MapId,1) 的 16 字节头之后按 width 步长取图块号
 *  - L5411:      Ui() 把图块号归类为 0..7 地形（短名在界面字符串 [7]）
 *  - L5755-5769: 地形消耗表 getItem(2,3) 每兵种 46 项，值 = 128 + 消耗
 *
 * 地形高度、装饰体、颜色全部是**表现层装饰**：原版没有地形高度概念，
 * 3D 高度不参与任何移动/攻击判定（判定一律由原版 qi()/Vo() 给出）。
 */
import { ORIGINAL_INPUT } from '../p1/core/config.mjs';

export const P4_VERSION = '4.0.0-p4';

/** 原版战斗网格协议（只读，数值与 sgby.min.js 常量一致）。 */
export const BATTLE_PROTOCOL = Object.freeze({
  unitsPerSide: 10,
  unitsTotal: 20,
  windowCols: 15,       // pe：2D 视口宽（格）
  windowRows: 17,       // be：2D 视口高（格）
  tilePx: 16,           // Pe：2D 每格像素
  pathWidth: 15,        // ke：g_FightPath 行宽
  blockCost: 128,       // Me：g_FightPath 中 >= 该值即不可到达
  tilePicId: 4,         // 战斗地图图块，46 帧 16x16
  headerBytes: 16,      // 地图数据头：byte0=宽、byte2=高
  source: 'sgby.pretty.js L2351-2353 / L5755 / L5632 / L5411',
});

/**
 * 8 种地形（原版 Ui() 的分类值）的表现参数。
 * 底板一律贴地（保证相邻格无缝隙、格子边界清楚），
 * propHeight / prop 只是叠加在底板上的**装饰体**，不改变格子逻辑坐标，
 * 也不参与移动/攻击判定（判定全部由原版 qi()/Vo() 给出）。
 * tint 以顶点色叠加在原版图块上，同一个 draw call 完成。
 */
export const TERRAIN_STYLE = Object.freeze([
  { id: 0, name: '草地', propHeight: 0.00, tint: 0xffffff, prop: null },
  { id: 1, name: '平原', propHeight: 0.00, tint: 0xffffff, prop: null },
  { id: 2, name: '山地', propHeight: 0.30, tint: 0xf3e2c4, prop: 'rock' },
  { id: 3, name: '森林', propHeight: 0.16, tint: 0xdfeadb, prop: 'tree' },
  { id: 4, name: '村庄', propHeight: 0.20, tint: 0xfff0d0, prop: 'house' },
  { id: 5, name: '城池', propHeight: 0.40, tint: 0xffe8b8, prop: 'keep' },
  { id: 6, name: '营寨', propHeight: 0.26, tint: 0xffe0b0, prop: 'camp' },
  { id: 7, name: '河流', propHeight: 0.00, tint: 0xa9cfe8, prop: null },
]);

/** 战斗地图底板 / 格子。 */
export const BATTLE_TILE_CONFIG = Object.freeze({
  tileSize: 1,                 // 一格 = 1 世界单位（整体缩放只改这一个数）
  groundY: 0,
  gridLineColor: 0x25303a,
  gridLineOpacity: 0.55,
  borderColor: 0x8f7440,
  borderWidth: 0.18,
  waterOverlay: 0x2c6f9e,
  waterOverlayOpacity: 0.18,
  source: 'P4 §5.2：格子与逻辑坐标一一对应，尺寸统一',
});

/** 单位模型（全部复用几何体/材质，20 支部队规模不需要 InstancedMesh）。 */
export const UNIT_STYLE = Object.freeze({
  // 尺寸按「32x32 地图整图可见」时的实际像素反推：1 格 ≈ 15px，
  // 因此单位底座要略大于 1 格，才能在整图视角下看清（相邻格仍不会互相遮挡）。
  baseRadius: 0.44,
  baseHeight: 0.10,
  bodySize: 0.62,
  bodyHeight: 0.74,
  poleHeight: 1.15,
  poleRadius: 0.03,
  bannerWidth: 0.56,
  bannerHeight: 0.66,
  pickRadius: 0.58,
  pickHeight: 1.7,
  /** 势力地环：整图视角下比模型本体更容易辨认敌我（不依赖红绿也能区分明暗） */
  factionRingInner: 0.46,
  factionRingOuter: 0.56,
  factionRingOpacity: 0.9,
  ringInner: 0.6,
  ringOuter: 0.76,
  ringColor: 0xffd76a,
  mineColor: 0x4f7fd0,
  enemyColor: 0xc0504d,
  /** 兵种（原版 ArmsType 0..5，名称见界面字符串 [12]）。 */
  armsColors: Object.freeze([0xd9b26a, 0x8fb36a, 0x6f9ec4, 0x5f9b9b, 0xb07fc0, 0xd08a4a]),
  /** 行动状态（原版 state 0..8，名称见界面字符串 [28+state]）。 */
  stateColors: Object.freeze([
    0x000000, 0xd0a020, 0x9b59b6, 0x2f8f83, 0x5b7f3a, 0x3f6fb5, 0x8d6e63, 0xa33f3f, 0x333333,
  ]),
  activeTint: 0x6b7280,
  /** 兵种徽章（billboard）：整图视角下用来快速分辨敌我与兵种 */
  badgeSize: 1.8,
  badgeY: 2.3,
  labelWidth: 3.2,
  labelHeight: 0.8,
  labelY: 3.25,
  source: 'P4 §7：兵种/势力/状态视觉区分，模型为程序化低面数几何体',
});

/** 移动 / 攻击范围覆盖层。 */
export const RANGE_STYLE = Object.freeze({
  moveColor: 0x4aa3ff,
  moveOpacity: 0.5,
  attackColor: 0xff2b1e,
  attackOpacity: 0.58,
  y: 0.06,
  cellScale: 0.94,
  maxInstances: 300,
  source: 'P4 §9/§10：只显示原版 qi()/Vo() 给出的合法格子',
});

/** 战斗相机：固定斜 45°，正交，禁止旋转；与战略地图参数独立。 */
export const BATTLE_CAMERA_CONFIG = Object.freeze({
  projection: 'orthographic',
  azimuthDeg: 45,
  elevationDeg: 45,
  distance: 46,
  near: 0.1,
  far: 300,
  zoom: 1,
  minZoom: 0.6,
  maxZoom: 3.2,
  panLimit: 18,          // 32x32 地图半幅 16，留 2 格余量
  fitMargin: 1.04,       // 整图刚好落在视口内，尽量少留黑边
  source: 'P4 §4：OrthographicCamera + 固定 45/45，不自由旋转',
});

export const BATTLE_INTERACTION_CONFIG = Object.freeze({
  dragThresholdPx: 4,      // 与 P1 InputManager 一致
  wheelZoomScale: 0.0015,
  panPixelsToWorld: 0.02,
  source: 'P4 §11.3 / P1 INPUT_CONFIG',
});

/** 键码复用 P1 的唯一权威定义（P4 不新增硬编码）。 */
export const KEY_CODES = ORIGINAL_INPUT.keys;
