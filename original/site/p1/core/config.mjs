/**
 * P1 统一配置。数值依据 P0 报告的真实数据：
 *  - 战略地图 12x9 逻辑格（界面常量[14] 城市布局、[6] 城市坐标）
 *  - 战斗地图 32x32（struct/战斗地图1..7.json 头部 [32,0,32,0,...]）
 *  - 城市 38、武将 200、道具 33、技能 30（Oa() 由资源包长度反推，代码不写死）
 */
export const THREE_VERSION = '0.187.0';

export const RENDER_CONFIG = Object.freeze({
  background: 0x14181d,
  antialias: true,
  alpha: false,
  colorSpace: 'srgb',            // THREE.SRGBColorSpace
  toneMapping: 'none',           // THREE.NoToneMapping（P1 不追求复杂光照）
  maxPixelRatio: 2,
  shadowEnabled: false,
  powerPreference: 'high-performance',
});

/** 战略地图：逻辑格 -> 世界坐标。tileSize 可整体调整，不允许单城特例。 */
export const WORLD_MAP_CONFIG = Object.freeze({
  cols: 12,
  rows: 9,
  tileSize: 1,
  groundY: 0,
});

/** 战斗地图：32x32 格，行列关系保持原版形式。 */
export const BATTLE_GRID_CONFIG = Object.freeze({
  cols: 32,
  rows: 32,
  tileSize: 1,
  groundY: 0,
});

/** 固定斜 45° 正交相机：俯角 45°、方位角 45°，不允许自由旋转。 */
export const CAMERA_CONFIG = Object.freeze({
  world: Object.freeze({
    projection: 'orthographic',
    azimuthDeg: 45,
    elevationDeg: 45,
    distance: 24,
    frustumHeight: 13,
    zoom: 1,
    minZoom: 0.6,
    maxZoom: 3,
    panLimitX: 9,
    panLimitZ: 7,
    near: 0.1,
    far: 200,
  }),
  battle: Object.freeze({
    projection: 'orthographic',
    azimuthDeg: 45,
    elevationDeg: 45,
    distance: 46,
    frustumHeight: 34,
    zoom: 1,
    minZoom: 0.6,
    maxZoom: 3,
    panLimitX: 18,
    panLimitZ: 18,
    near: 0.1,
    far: 300,
  }),
  // 城市场景 P1 不锁定渲染方案：默认复用战略相机参数，后续可整体覆盖。
  city: Object.freeze({ reuse: 'world', projection: 'orthographic' }),
});

export const INPUT_CONFIG = Object.freeze({
  dragThresholdPx: 4,
  wheelZoomScale: 0.0015,
  panPixelsToWorld: 0.02,
});

export const ASSET_CONFIG = Object.freeze({
  baseUrl: 'p1/assets/',
  maxCacheEntries: 128,
});

export const SCENE_IDS = Object.freeze({
  WORLD: 'world',
  CITY: 'city',
  BATTLE: 'battle',
});

/** P1 允许的场景切换路径（对应 P0 真实流程：战略↔城市、战略↔战斗）。 */
export const SCENE_TRANSITIONS = Object.freeze({
  world: ['city', 'battle'],
  city: ['world'],
  battle: ['world'],
});

export const CORE_CONFIG = Object.freeze({
  readyTimeoutMs: 15000,
  readyPollMs: 50,
  syncWatchdogMs: 500,   // 低频兜底 diff；渲染循环不读游戏数据
});
