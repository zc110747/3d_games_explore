/**
 * P2 表现层配置（全部为渲染/交互参数，不含任何游戏规则数据）。
 *
 * 依据真实源码（还原副本 sgby.pretty.js 行号）：
 *  - L2355-2357: Se=239 Ue=319 Oe=240 / gn=32 dn=32 / fn=12 hn=9
 *  - L3833:      Ws()=fn*gn-Oe=144（横向视口最大偏移）, Ks=269（底部按钮条起点）
 *  - L332:       方向键码 上34 下35 左36 右37 确认39 返回40
 *  - L4290-4305: zs() 方向键移动光标 / 确认键返回当前城市
 *  - L4328:      i=Math.floor((x+a)/gn), c=Math.floor(y/dn), l=t.y+c（点击命中）
 *  - L4178-4196: qs() 用 loadPic(54,1) 的 108 帧按 (t.y+row)*fn+col 绘制 12x9 地形
 *  - L4198-4205: 城池图标三态 mine/foe/empty（fr=8/7/0）
 *
 * 势力 ID = 原版 city.Belong（0 空城；>0 为君主武将 index+1，见 P0 §3.4）。
 * 本文件的 factionColor 只做「ID -> 表现层颜色」的确定性映射，
 * 绝不反向推断势力，也不修改原版任何数据。
 */
import { ORIGINAL_INPUT } from '../p1/core/config.mjs';

export const P2_VERSION = '2.0.0-p2';

/** 原版 240x320 虚拟屏 + 战略地图网格常量（只读协议参数）。 */
export const ORIGINAL_MAP = Object.freeze({
  screenWidth: 240,
  screenHeight: 320,
  gridW: 32,
  gridH: 32,
  cols: 12,
  rows: 9,
  viewportMaxX: 144,
  clickableBottom: 269,
  source: 'sgby.pretty.js L2355-2357 / L3833 / L4328',
});

/** 原版输入键码 / 消息类型：直接复用 P1 的唯一权威定义，避免两处硬编码。 */
export const KEY_CODES = ORIGINAL_INPUT.keys;
export const INPUT_TYPE = Object.freeze({
  key: ORIGINAL_INPUT.keyType, pointer: ORIGINAL_INPUT.pointerType,
});

/** 地形：12x9 真实原版图块 + 装饰性高度（非城市格，绝不作为规则依据）。 */
export const TERRAIN_CONFIG = Object.freeze({
  terrainPicId: 54,          // lib.loadPic(54,1) 城市地图图块, 108 帧
  cityIconPicId: 55,         // 城市图标, 10 帧（保留给后续美术升级）
  expectedFrames: 108,       // 12 * 9
  segmentsPerTile: 3,        // 底板细分，用于基本高度层次
  reliefHeight: 0.09,        // 非城市格顶点起伏上限（世界单位）
  borderWidth: 0.14,
  decorativeProps: true,     // 程序化低面数山体，明确是装饰
  propsPerRow: 9,            // 装饰密度（确定性，不依赖游戏规则）
});

/** 城市模型：全部复用 P1 AssetManager 缓存的 Geometry / Material。 */
export const CITY_MODEL_CONFIG = Object.freeze({
  baseRadius: 0.29,
  wallHeight: 0.2,
  wallThickness: 0.04,
  towerHeight: 0.36,
  towerRadius: 0.055,
  innerBuildingHeight: 0.28,
  innerBuildingRadius: 0.09,
  pickRadius: 0.45,          // 独立拾取区（避免建筑细节影响点击）
  pickHeight: 0.02,
  selectedRingRadius: 0.47,
  selectedRingColor: 0xffd76a,
  normalColor: 0xb9a98b,
  source: '统一模型；原版无城市等级/规模字段，故不做差异化（P2 §6.3）',
});

/** 城市名称牌：CanvasTexture + Sprite，中文来自 lib.getStr(58, id+1)。 */
export const LABEL_CONFIG = Object.freeze({
  canvasWidth: 256,
  canvasHeight: 64,
  worldWidth: 0.94,
  worldHeight: 0.26,
  yOffset: 0.98,
  font: 'bold 42px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  avoidOverlap: true,
  avoidIntervalSec: 0.3,
  textColor: '#fff8e6',
  strokeColor: '#241a10',
  background: 'rgba(20,16,12,0.72)',
  border: 'rgba(224,190,116,0.85)',
  selectedBackground: 'rgba(96,58,20,0.92)',
  selectedBorder: '#ffd76a',
  hideBelowZoom: 0.62,       // 缩放过小时隐藏名称，保持可读性
});

/**
 * 势力旗帜配置。factionId 来自原版 city.Belong。
 * 颜色是表现层资源，按 ID 确定性选取；玩家势力单独用金色；空城无旗。
 */
export const FLAG_CONFIG = Object.freeze({
  poleHeight: 0.66,
  poleRadius: 0.014,
  clothWidth: 0.34,
  clothHeight: 0.22,
  canvasWidth: 128,
  canvasHeight: 84,
  waveAmplitude: 0.018,
  waveSpeed: 2.1,
  emptyFlagColor: 0x6b7280,
  playerColor: 0xe8b54a,
  palette: Object.freeze([
    0xc0504d, 0x4f81bd, 0x4f9d69, 0x9b59b6, 0x16a0a0, 0xd17a2c,
    0x7f8c8d, 0xb0528f, 0x5b7f3a, 0x3f6fb5, 0xa33f3f, 0x8a6d3b,
    0x2f8f83, 0x9c6b9e, 0x6b8e23, 0xb8860b, 0x476b9c, 0xc25b5b,
    0x5aa06b, 0x8d6e63,
  ]),
});

/** 道路：仅绘制 getItem(59,1) 实际生效的连接，54 条无向边。 */
export const ROAD_CONFIG = Object.freeze({
  width: 0.075,
  segments: 6,
  curve: 0.06,               // 轻微弯曲，仅视觉；不改变连接端点
  y: 0.115,                  // 高于装饰性地形起伏上限 0.09，避免被底板遮住
  color: 0xd9c393,
  highlightColor: 0xffd76a,
  highlightWidth: 0.11,
  source: 'GameAdapter.getCityConnections() -> lib.getItem(59,1)',
});

/** 相机与交互（复用 P1 CAMERA_CONFIG.world 的投影/边界，不另建管理器）。 */
export const MAP_INTERACTION_CONFIG = Object.freeze({
  dragThresholdPx: 4,       // 与 P1 InputManager 一致
  wheelZoomScale: 0.0015,
  panPixelsToWorld: 0.014,
  maxNavigationKeys: 26,    // 12 列 + 9 行的光标导航上限，防止误注入过量消息
  source: 'P2 §4.2 / P1 INPUT_CONFIG',
});

/** 势力分类：完全由原版 ownerId + 原版 playerKing 决定，不靠颜色反推。 */
export function classifyFaction(ownerId, playerOwnerId) {
  if (!ownerId) return 'empty';
  if (ownerId === playerOwnerId) return 'player';
  return 'other';
}

/** 颜色只由 factionId 决定；同一 ID 在任何时刻恒定。 */
export function factionColor(ownerId, playerOwnerId) {
  if (!ownerId) return FLAG_CONFIG.emptyFlagColor;
  if (ownerId === playerOwnerId) return FLAG_CONFIG.playerColor;
  return FLAG_CONFIG.palette[(ownerId - 1) % FLAG_CONFIG.palette.length];
}

/** 稳定哈希，用于旗帜纹样与装饰物摆放（表现层确定性，不是游戏数据）。 */
export function stableHash(n) {
  let h = 0x811c9dc5;
  const s = String(n);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
