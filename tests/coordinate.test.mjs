/**
 * P1 坐标转换测试 —— 全部使用 game.zip 的真实数据：
 *   城市坐标(38)、城市布局(9x12)、战斗地图1 头部 32x32 与 32x32 图块。
 * 运行： node --test tests/coordinate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CoordinateSystem } from '../original/site/p1/core/CoordinateSystem.mjs';
import { loadRealData } from './fixtures.mjs';

const data = loadRealData();
const cityCoords = data.constants['城市坐标'];
const layout = data.constants['城市布局'];
const mapHead = data.battleMap1['头部'];
const tiles = data.battleMap1['图块'];

test('真实数据形态：38 城 / 12x9 布局 / 32x32 战斗地图', () => {
  assert.equal(cityCoords.length, 38);
  assert.equal(layout.length, 9);
  assert.equal(layout[0].length, 12);
  assert.equal(mapHead[0], 32);
  assert.equal(mapHead[2], 32);
  assert.equal(tiles.length, 32);
  assert.equal(tiles[0].length, 32);
});

test('38 城逻辑坐标 -> 世界 -> 逻辑，往返误差为 0', () => {
  const cs = new CoordinateSystem();
  for (let id = 0; id < cityCoords.length; id++) {
    const [col, row] = cityCoords[id];
    const w = cs.mapToWorld(col, row);
    const back = cs.worldToMap(w.x, w.z);
    assert.equal(back.col, col, `城市 ${id} 列`);
    assert.equal(back.row, row, `城市 ${id} 行`);
    assert.ok(back.error < 1e-12, `城市 ${id} 误差 ${back.error}`);
    assert.equal(back.inBounds, true);
  }
});

test('城市布局值与城市坐标表 38/38 一致（真实数据自洽）', () => {
  const pos = new Map();
  layout.forEach((rowArr, y) => rowArr.forEach((v, x) => { if (v) pos.set(v - 1, [x, y]); }));
  assert.equal(pos.size, 38);
  for (let id = 0; id < 38; id++) {
    assert.deepEqual(pos.get(id), cityCoords[id], `城市 ${id} 布局与坐标不一致`);
  }
});

test('整体调整 tileSize 后转换仍可逆（不针对单城特例）', () => {
  const cs = new CoordinateSystem();
  for (const t of [0.5, 1, 2.5, 10]) {
    cs.setWorldTileSize(t);
    for (const [col, row] of [[0, 0], [11, 0], [0, 8], [11, 8], [5, 4]]) {
      const w = cs.mapToWorld(col, row);
      const back = cs.worldToMap(w.x, w.z);
      assert.equal(back.col, col);
      assert.equal(back.row, row);
      assert.ok(back.error < 1e-9);
    }
  }
});

test('战斗 32x32 格子全部可逆', () => {
  const cs = new CoordinateSystem();
  for (let row = 0; row < 32; row++) {
    for (let col = 0; col < 32; col++) {
      const w = cs.gridToWorld(col, row);
      const g = cs.worldToGrid(w.x, w.z);
      assert.equal(g.col, col);
      assert.equal(g.row, row);
      assert.equal(g.inBounds, true);
    }
  }
});

test('战斗局部路径窗口偏移还原到全图格坐标', () => {
  const cs = new CoordinateSystem();
  // 以 qi() 的 15x15 窗口为例：origin=(10,5)
  assert.deepEqual(cs.localPathToGrid(0, 12, 7, 2, 2), { col: 10, row: 5 });
  assert.deepEqual(cs.localPathToGrid(7 * 15 + 14, 12, 7, 2, 2), { col: 24, row: 12 });
});

test('攻击范围位图 -> 全图格坐标（5x5 / 9x9）', () => {
  const cs = new CoordinateSystem();
  assert.deepEqual(cs.attackRangeToGrid(12, 3, 4, 5), { col: 5, row: 6 });  // 5x5 中心
  assert.deepEqual(cs.attackRangeToGrid(40, 10, 20, 9), { col: 14, row: 24 }); // 9x9 中心
});

test('worldToScreen 是独立投影：视口缩放不改变逻辑坐标', () => {
  const cs = new CoordinateSystem();
  const w = cs.mapToWorld(5, 4);
  const projector = (world) => ({ x: world.x / 10, y: world.z / 10, z: 0 });
  const small = cs.worldToScreen(w, projector, { left: 0, top: 0, width: 800, height: 600 });
  const large = cs.worldToScreen(w, projector, { left: 0, top: 0, width: 1600, height: 1200 });
  assert.notEqual(small.x, large.x);
  assert.notEqual(small.y, large.y);
  assert.deepEqual(cs.worldToMap(w.x, w.z).col, 5);
  assert.deepEqual(cs.worldToMap(w.x, w.z).row, 4);
  assert.equal(small.visible, true);
});

test('out-of-bounds 世界坐标会被标记', () => {
  const cs = new CoordinateSystem();
  const bad = cs.worldToMap(999, 999);
  assert.equal(bad.inBounds, false);
});
