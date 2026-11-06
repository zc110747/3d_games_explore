/**
 * P2 MapCoordinateSystem —— 四个坐标系严格分离，不重复实现 P1 的数学。
 *
 *  1) 原版地图逻辑格   (col,row)  12x9，来自 lib.getItem(2,6) 城市坐标
 *  2) Three.js 世界坐标 (x,y,z)   由 P1 CoordinateSystem 转换（唯一权威）
 *  3) 屏幕像素         (px,py)    由摄像机投影（P1 worldToScreen 注入 projector）
 *  4) 原版 240x320 虚拟屏 (sx,sy) 仅用于「把 3D 点击喂给原版 zs() 输入协议」
 *
 * 第 4 套坐标不是渲染坐标，而是原版输入协议坐标：
 *   zs() L4328: i=Math.floor((x+a)/gn), c=Math.floor(y/dn), l=t.y+c
 *   其中 gn=dn=32，a=t.x*gn（横向视口偏移，读 Dn.g_CityPos.x），t.y=hn-9=0。
 *   qs() L4178 的绘制用 KW=20px/OY=57，与 32px 命中网格不一致 —— 这是网页版
 *   自带偏差（P0 §3.3、P1 遗留问题 #3）。本模块按 zs() 的【命中公式】反推，
 *   不按绘制位置反推，也不修改原版任何代码。
 */
import { ORIGINAL_MAP } from './config.mjs';

export class MapCoordinateSystem {
  /** @param {CoordinateSystem} base P1 实例（不在本类里重建转换规则） */
  constructor(base) {
    if (!base || typeof base.mapToWorld !== 'function') {
      throw new TypeError('MapCoordinateSystem 需要 P1 CoordinateSystem 实例');
    }
    this.base = base;
    this.original = { ...ORIGINAL_MAP };
  }

  // ------------------------------------------------ 战略地图（委托 P1）
  mapToWorld(col, row, opts) { return this.base.mapToWorld(col, row, opts); }
  worldToMap(x, z) { return this.base.worldToMap(x, z); }
  worldToScreen(world, projector, viewport) {
    return this.base.worldToScreen(world, projector, viewport);
  }

  // ------------------------------------------------ 战斗格子（委托 P1）
  gridToWorld(col, row, opts) { return this.base.gridToWorld(col, row, opts); }
  worldToGrid(x, z) { return this.base.worldToGrid(x, z); }

  getConfig() { return { ...this.base.getConfig(), original: { ...this.original } }; }

  // ------------------------------------------------ 原版虚拟屏坐标
  /**
   * 逻辑格 -> 原版 240x320 虚拟屏像素（供 sendInput 的 pointer 消息使用）。
   * @param {number} col 逻辑列 0..11
   * @param {number} row 逻辑行 0..8
   * @param {{x:number,y:number}} cursor 原版 Dn.g_CityPos（只读）
   * @returns {{x:number,y:number}|null} 落在当前视口/可点区域之外时返回 null
   */
  logicalToOriginalScreen(col, row, cursor = { x: 0, y: 0 }) {
    const o = this.original;
    if (!Number.isInteger(col) || !Number.isInteger(row)
      || col < 0 || col >= o.cols || row < 0 || row >= o.rows) return null;
    const a = Math.round((cursor.x || 0) * o.gridW);
    // 取格内 1/4 处而非中心：col=7 的中心 x=240 已越出 240 宽虚拟屏，
    // row=8 的中心 y=272 落入 Ks=269 起的按钮条。1/4 点仍满足 floor((x+a)/gn)=col。
    const sy = (row - (cursor.y || 0)) * o.gridH + o.gridH / 4;
    const sx = col * o.gridW - a + o.gridW / 4;
    // zs() L4326-4329：y>=Ks(269) 属于按钮条；x 超出 240 宽的屏幕不会被派发到该格
    if (sx < 0 || sx >= o.screenWidth || sy < 0 || sy >= o.clickableBottom) return null;
    return { x: Math.round(sx), y: Math.round(sy) };
  }

  /** 逆运算：原版虚拟屏像素 -> 逻辑格（用于测试与协议核对）。 */
  originalScreenToLogical(sx, sy, cursor = { x: 0, y: 0 }) {
    const o = this.original;
    const a = Math.round((cursor.x || 0) * o.gridW);
    return {
      col: Math.floor((sx + a) / o.gridW),
      row: (cursor.y || 0) + Math.floor(sy / o.gridH),
      source: 'zs() L4328',
    };
  }

  /**
   * 当前横向视口能显示的逻辑列范围（用于判断是否需要先用方向键滚动）。
   * zs() L4251-4258：a=t.x*gn，i=Math.floor((x+a)/gn)，屏幕宽 240 => 7.5 列。
   */
  visibleColumnRange(cursor = { x: 0, y: 0 }) {
    const o = this.original;
    const first = Math.round((cursor.x || 0) * o.gridW / o.gridW);
    return { first, last: first + Math.floor(o.screenWidth / o.gridW) - 1 };
  }
}
