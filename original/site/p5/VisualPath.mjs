/**
 * P5 VisualPath —— 移动动画用的「视觉折线」，只读原版距离场，不做寻路。
 *
 * 数据来源：GameAdapter.getMovementRange(unitId).raw
 *   = 原版 qi()（L5524）算完后的 g_FightPath 15x15 窗口快照（单位：累计移动消耗）。
 *   qi() 末尾把起点格置 0（L5574），被占用格置 254（L5585），不可通行格 255。
 *
 * 算法：从目标格开始，每步走向「数值更小的四邻」直到回到起点。
 * 这是**沿原版已经算好的距离场下降**，不是新的寻路：
 *   - 不产生任何新的可达性判断（可达性只看 qi() 写下的值）；
 *   - 不写回 Dn，也不改变最终格子（最终位置由原版 vo() 写成 g_GenPos）；
 *   - 万一距离场异常（例如起点不在窗口内），退化为直线折线，仍不改变结果。
 *
 * 纯表现用途：只决定 3D 模型在路上怎么走，不参与任何判定。
 */

const DIRS4 = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]]);

/**
 * @param {object} opts
 * @param {Uint8Array} opts.field   原版 g_FightPath 快照（至少 width*width）
 * @param {{x:number,y:number}} opts.origin  窗口左上角在地图上的坐标（g_PathSX-g_PUseSX）
 * @param {{x:number,y:number}} opts.from
 * @param {{x:number,y:number}} opts.to
 * @param {number} [opts.width=15]
 * @param {number} [opts.blockCost=128]
 * @returns {{cells:Array<{x:number,y:number}>, source:string, degraded:boolean, steps:number}}
 */
export function buildVisualPath({
  field, origin, from, to, width = 15, blockCost = 128,
}) {
  if (!field || !origin || !from || !to) {
    return { cells: [from, to].filter(Boolean), source: 'fallback:缺少距离场', degraded: true, steps: 0 };
  }
  if (from.x === to.x && from.y === to.y) {
    return { cells: [{ x: from.x, y: from.y }], source: 'qi() 距离场（零距离）', degraded: false, steps: 0 };
  }
  const val = (x, y) => {
    const col = x - origin.x, row = y - origin.y;
    if (col < 0 || row < 0 || col >= width || row >= width) return -1;
    return field[row * width + col];
  };
  const start = val(from.x, from.y);
  const goal = val(to.x, to.y);
  if (start < 0 || goal < 0 || goal >= blockCost) {
    return { cells: straightFallback(from, to), source: 'fallback:起点/目标不在 qi() 窗口内', degraded: true, steps: 0 };
  }

  const cells = [{ x: to.x, y: to.y }];
  let cx = to.x, cy = to.y, cur = goal;
  let guard = width * width + 4;         // 防止异常字段导致死循环
  let degraded = false;
  while (guard-- > 0) {
    if (cx === from.x && cy === from.y) break;
    let best = null, bestV = cur;
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx, ny = cy + dy;
      const v = val(nx, ny);
      if (v < 0 || v >= blockCost) continue;
      if (v < bestV) { bestV = v; best = { x: nx, y: ny }; }
    }
    if (!best) { degraded = true; break; }
    cx = best.x; cy = best.y; cur = bestV;
    cells.push({ x: cx, y: cy });
  }
  if (cells[cells.length - 1].x !== from.x || cells[cells.length - 1].y !== from.y) {
    // 距离场不连通（理论上不该出现）：保留已走的段并接回起点，纯视觉
    cells.push({ x: from.x, y: from.y });
    degraded = true;
  }
  cells.reverse();
  return {
    cells,
    source: '原版 qi() 距离场下降（只读，非寻路）',
    degraded,
    steps: cells.length - 1,
  };
}

/** 退化折线：先横后竖，仅用于没有距离场的场合（纯视觉）。 */
function straightFallback(from, to) {
  const out = [{ x: from.x, y: from.y }];
  let { x, y } = from;
  while (x !== to.x) { x += Math.sign(to.x - x); out.push({ x, y }); }
  while (y !== to.y) { y += Math.sign(to.y - y); out.push({ x, y }); }
  return out;
}

/** 折线格子数与「主方向」朝向（供动画转身用，弧度）。 */
export function pathHeading(cells) {
  if (!cells || cells.length < 2) return 0;
  const a = cells[cells.length - 2], b = cells[cells.length - 1];
  return Math.atan2(b.x - a.x, b.y - a.y);
}
