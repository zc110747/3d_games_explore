#!/usr/bin/env node
/**
 * P2 战略地图一致性测试（Node，数据全部来自 original/site/assets/game.zip）。
 *
 * 覆盖 P2 §13 的测试 1/2/3 与 §6.4 坐标测试：
 *   城市完整性 / 路径一致性 / 势力一致性 / 坐标转换 / 原版输入协议。
 * 交互与摄像机（测试 4/5）由 tests/smoke.mjs 在真实浏览器中验证。
 *
 * 运行： node --test tests/worldmap.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRealCore, loadRealData } from './fixtures.mjs';
import { EventManager } from '../original/site/p1/core/EventManager.mjs';
import { GameAdapter } from '../original/site/p1/core/GameAdapter.mjs';
import { CoordinateSystem } from '../original/site/p1/core/CoordinateSystem.mjs';
import { MapCoordinateSystem } from '../original/site/p2/MapCoordinateSystem.mjs';
import { ORIGINAL_MAP, KEY_CODES, INPUT_TYPE, classifyFaction, factionColor, FLAG_CONFIG } from '../original/site/p2/config.mjs';
import { ORIGINAL_INPUT } from '../original/site/p1/core/config.mjs';

const core = makeRealCore();
const adapter = new GameAdapter({ core, events: new EventManager() });
const mapCoord = new MapCoordinateSystem(new CoordinateSystem());
const real = loadRealData();
const DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

// ============================================================ 测试 1：城市完整性
test('测试1 城市总数 38、ID 0..37、名称非空且唯一', () => {
  const cities = adapter.getCities();
  assert.equal(cities.length, 38);
  assert.deepEqual(cities.map((c) => c.id), Array.from({ length: 38 }, (_, i) => i));
  const names = cities.map((c) => c.name);
  assert.ok(names.every((n) => typeof n === 'string' && n.length > 0));
  assert.equal(new Set(names).size, 38, '城市名不应重复');
});

test('测试1 城市坐标来自资源 2[6]，唯一且落在 12x9 逻辑格内', () => {
  const cities = adapter.getCities();
  const seen = new Set();
  for (const c of cities) {
    assert.ok(Number.isInteger(c.position.x) && Number.isInteger(c.position.y));
    assert.ok(c.position.x >= 0 && c.position.x < ORIGINAL_MAP.cols, `城 #${c.id} x 越界`);
    assert.ok(c.position.y >= 0 && c.position.y < ORIGINAL_MAP.rows, `城 #${c.id} y 越界`);
    const key = `${c.position.x},${c.position.y}`;
    assert.ok(!seen.has(key), `城 #${c.id} 与其它城共格 ${key}`);
    seen.add(key);
  }
  assert.equal(seen.size, 38);
});

test('测试1 城市布局表(2,14) 位置 == 城市坐标，值 == cityId+1', () => {
  const layout = core.lib.getItem(2, 14);
  assert.equal(layout.length, ORIGINAL_MAP.cols * ORIGINAL_MAP.rows);
  for (const c of adapter.getCities()) {
    assert.equal(layout[c.position.y * ORIGINAL_MAP.cols + c.position.x], c.id + 1,
      `城 #${c.id} 布局值不符`);
    assert.equal(c.layoutValue, c.id + 1);
  }
});

test('测试1 城市状态 / 归属 / 战斗地图 id 均为原版字段', () => {
  for (const c of adapter.getCities()) {
    assert.ok(c.state >= 0 && c.state <= 4, `城 #${c.id} 状态异常`);
    assert.ok(c.ownerId >= 0 && c.ownerId <= 200, `城 #${c.id} 归属异常`);
    assert.ok(c.battleMapId >= 0 && c.battleMapId <= 6, `城 #${c.id} 战斗图 id 异常`);
    assert.ok(c.money >= 0 && c.food >= 0);
  }
});

// ============================================================ 测试 2：路径一致性
test('测试2 连接表 = 原版右表(59)，每城 8 方向 + 8 距离', () => {
  const table = real.connRight['城市'];
  assert.equal(table.length, 38);
  for (const c of adapter.getCities()) {
    const links = adapter.getCityConnections(c.id);
    assert.equal(links.length, 8);
    links.forEach((link, k) => {
      assert.equal(link.dir, DIRS[k]);
      assert.equal(link.directionIndex, k);
      const expectConnect = table[c.id]['连接'][DIRS[k]];
      const expectDistance = table[c.id]['距离'][DIRS[k]];
      assert.equal(link.cityId, expectConnect ? expectConnect - 1 : null,
        `城 #${c.id} ${DIRS[k]} 连接端点不符`);
      assert.equal(link.distance, expectDistance, `城 #${c.id} ${DIRS[k]} 距离不符`);
    });
  }
});

test('测试2 54 条无向边 / 108 条有向记录，无额外连接与遗漏', () => {
  const links = adapter.getCityLinks();
  assert.equal(links.length, 54);
  const expected = new Set();
  let directed = 0;
  for (const c of adapter.getCities()) {
    for (const link of adapter.getCityConnections(c.id)) {
      if (link.cityId === null) continue;
      directed++;
      expected.add(`${Math.min(c.id, link.cityId)}-${Math.max(c.id, link.cityId)}`);
    }
  }
  assert.equal(directed, 108);
  assert.equal(expected.size, 54);
  const actual = new Set(links.map((e) => `${e.from}-${e.to}`));
  assert.deepEqual([...actual].sort(), [...expected].sort());
  for (const e of links) {
    assert.ok(e.forward && e.backward, `边 ${e.from}-${e.to} 缺双向原始记录`);
    assert.ok(e.from < e.to);
    assert.ok(e.forward.distance > 0 && e.backward.distance > 0);
  }
});

test('测试2 只读取右表(59)，左表(60) 未被用于绘制', () => {
  const right = adapter.getCityLinks();
  const leftTable = real.connLeft['城市'];
  const leftEdges = new Set();
  leftTable.forEach((row, i) => DIRS.forEach((d) => {
    const v = row['连接'][d];
    if (v) leftEdges.add(`${Math.min(i, v - 1)}-${Math.max(i, v - 1)}`);
  }));
  // 左右表确实不同，且适配层返回的是右表（54 条而非左表 99 条）
  assert.ok(leftEdges.size > right.length, '左表应包含更多连接，用于确认未混用');
  assert.equal(right.length, 54);
});

// ============================================================ 测试 3：势力一致性
test('测试3 势力 = 原版君主武将（Belong），名称来自真实武将表', () => {
  const factions = adapter.getFactions();
  assert.equal(factions.length, 19, '含空城共 19 个势力值');
  const empty = factions.find((f) => f.id === 0);
  assert.equal(empty.name, '');
  assert.equal(empty.isPlayer, false);
  assert.equal(empty.cityCount, 13);
  const dong = factions.find((f) => f.id === 1);
  assert.equal(dong.name, '董卓');
  assert.equal(dong.isPlayer, true);
  assert.equal(dong.cityCount, 3);
  assert.equal(factions.reduce((n, f) => n + f.cityCount, 0), 38);
});

test('测试3 空城 / 玩家 / 其它势力分类只由 ownerId 决定', () => {
  const player = core.Dn.g_PlayerKing + 1;
  assert.equal(classifyFaction(0, player), 'empty');
  assert.equal(classifyFaction(player, player), 'player');
  assert.equal(classifyFaction(player + 1, player), 'other');
  assert.equal(factionColor(0, player), FLAG_CONFIG.emptyFlagColor);
  assert.equal(factionColor(player, player), FLAG_CONFIG.playerColor);
  // 同一 ID 颜色恒定（不随调用次数变化），不同 ID 应有区分
  assert.equal(factionColor(2, player), factionColor(2, player));
  assert.notEqual(factionColor(2, player), factionColor(3, player));
});

// ============================================================ 测试 4：坐标体系
test('测试4 38 城逻辑格 -> 世界坐标往返误差 0', () => {
  for (const c of adapter.getCities()) {
    const w = mapCoord.mapToWorld(c.position.x, c.position.y);
    const back = mapCoord.worldToMap(w.x, w.z);
    assert.equal(back.col, c.position.x);
    assert.equal(back.row, c.position.y);
    assert.ok(back.error < 1e-9);
    assert.equal(back.inBounds, true);
  }
});

test('测试4 世界 -> 屏幕只是投影，改变 viewport 不改逻辑坐标', () => {
  const projector = (p) => ({ x: p.x / 10, y: p.z / 10, z: 0 });
  const w = mapCoord.mapToWorld(5, 4);
  const a = mapCoord.worldToScreen(w, projector, { left: 0, top: 0, width: 800, height: 600 });
  const b = mapCoord.worldToScreen(w, projector, { left: 0, top: 0, width: 1600, height: 1200 });
  assert.notEqual(a.x, b.x);
  assert.equal(mapCoord.worldToMap(w.x, w.z).col, 5);
  assert.equal(mapCoord.worldToMap(w.x, w.z).row, 4);
});

test('测试4 战斗格 32x32 与战略格 12x9 互相独立', () => {
  for (const [col, row] of [[0, 0], [31, 31], [15, 8], [7, 23]]) {
    const w = mapCoord.gridToWorld(col, row);
    const g = mapCoord.worldToGrid(w.x, w.z);
    assert.equal(g.col, col);
    assert.equal(g.row, row);
  }
  const cfg = mapCoord.getConfig();
  assert.equal(cfg.world.cols, 12);
  assert.equal(cfg.battle.cols, 32);
});

test('测试4 整体缩放 tileSize 后仍可逆，逻辑坐标不变', () => {
  const base = new CoordinateSystem();
  const mc = new MapCoordinateSystem(base);
  base.setWorldTileSize(2.5);
  for (const c of adapter.getCities().slice(0, 6)) {
    const w = mc.mapToWorld(c.position.x, c.position.y);
    const back = mc.worldToMap(w.x, w.z);
    assert.equal(back.col, c.position.x);
    assert.equal(back.row, c.position.y);
  }
  assert.equal(adapter.getCity(0).position.x, 1, '逻辑坐标不受渲染缩放影响');
});

test('测试4 逻辑格 -> 原版 240x320 虚拟屏坐标可逆（按 zs() L4328）', () => {
  let tested = 0;
  let skipped = 0;
  for (const c of adapter.getCities()) {
    const s = mapCoord.logicalToOriginalScreen(c.position.x, c.position.y, { x: 0, y: 0 });
    if (!s) {
      // 原版真实限制：col>=8 时 x>=264 超出 240 宽横向视口，
      // 必须先由方向键滚动视口（requestCitySelection 走的正是这条路径）。
      assert.ok(c.position.x >= 8,
        `城 #${c.id} (${c.position.x},${c.position.y}) 不应被判为视口外`);
      skipped++;
      continue;
    }
    assert.ok(s.x >= 0 && s.x < 240 && s.y >= 0 && s.y < 269);
    const back = mapCoord.originalScreenToLogical(s.x, s.y, { x: 0, y: 0 });
    assert.deepEqual({ col: back.col, row: back.row }, { col: c.position.x, row: c.position.y });
    tested++;
  }
  assert.ok(tested >= 15, `可往返城市过少: ${tested}`);
  assert.ok(skipped >= 1, '原版视口/按钮条限制应被如实排除');
  assert.equal(tested + skipped, 38);
});

test('测试4 横向视口偏移会改变原版屏幕坐标，但不改变逻辑坐标', () => {
  const c = adapter.getCity(0);
  const a = mapCoord.logicalToOriginalScreen(c.position.x, c.position.y, { x: 0, y: 0 });
  const b = mapCoord.logicalToOriginalScreen(c.position.x + 4, c.position.y, { x: 4, y: 0 });
  assert.deepEqual(a, b, '视口滚动 4 格后同一屏幕位置对应不同逻辑列，公式应一致');
  assert.equal(adapter.getCity(0).position.x, c.position.x);
});

// ============================================================ 测试 5：输入协议
test('测试5 输入协议常量与 P1 唯一权威定义一致', () => {
  assert.deepEqual({ ...KEY_CODES }, { ...ORIGINAL_INPUT.keys });
  assert.equal(INPUT_TYPE.key, ORIGINAL_INPUT.keyType);
  assert.equal(INPUT_TYPE.pointer, ORIGINAL_INPUT.pointerType);
  assert.equal(KEY_CODES.confirm, 39);
  assert.equal(ORIGINAL_MAP.gridW, 32);
  assert.equal(ORIGINAL_MAP.clickableBottom, 269);
});

test('测试5 原版不在 zs() 阶段时拒绝注入，不伪造成功', () => {
  const a = new GameAdapter({ core, events: new EventManager() });
  const phase = a.getInputPhase();
  assert.equal(phase.canSelectCity, false);
  const r = a.requestCitySelection(1, { intent: 'cursor' });
  assert.equal(r.injected, false);
  assert.match(r.reason, /未注入原版输入/);
});

test('测试5 原版 zs() 等待时按方向键导航到目标城（走 pushMsg，不写 Dn）', () => {
  // 测试夹具：只模拟输入队列对象与包装器记录的协程名，所有城市数据仍来自 game.zip
  const input = {
    waiters: [() => {}], queue: [], lastMsg: null,
    pushMsg(m) { this.queue.push(m); },
    waitMsg() { return Promise.resolve(this.queue.shift() || null); },
  };
  const testCore = { ...core, l: { input } };
  const a = new GameAdapter({ core: testCore, events: new EventManager() });
  a._waiterKind = 'zs';
  assert.equal(a.getInputPhase().canSelectCity, true, a.getInputPhase().reason);

  const target = adapter.getCity(1);
  const before = { ...core.Dn.g_CityPos };
  const r = a.requestCitySelection(1, { intent: 'cursor' });
  assert.equal(r.injected, true);
  assert.equal(r.messageCount, target.position.x + target.position.y);
  assert.ok(r.messages.every((m) => m.type === 5));
  assert.ok(r.messages.every((m) => [34, 35, 36, 37].includes(m.param)));
  assert.deepEqual({ ...core.Dn.g_CityPos }, before, '适配层不得直接写 Dn.g_CityPos');
  assert.equal(input.queue.length, r.messageCount, '消息必须经 class A.pushMsg 投递');

  input.waiters.length = 0;
  a._waiterKind = 'unknown';
  assert.equal(a.requestCitySelection(2).injected, false);
});

test('测试5 原版光标 cityId 来自真实 citymap（不是表现层推断）', () => {
  const layout = core.lib.getItem(2, 14);
  const d = makeRealCore();
  d.Dn.citymap = Array.from({ length: 9 }, (_, r) =>
    Uint8Array.from(layout.slice(r * 12, r * 12 + 12)));
  const a = new GameAdapter({ core: d, events: new EventManager() });
  const cursor = a.getCityCursor();
  assert.equal(cursor.populated, true);
  const id = layout[0] - 1;
  assert.equal(cursor.cityId, id >= 0 ? id : null);
  for (const c of a.getCities()) {
    d.Dn.g_CityPos.setx = c.position.x;
    d.Dn.g_CityPos.sety = c.position.y;
    assert.equal(a.getCityCursor().cityId, c.id, `城 #${c.id} 光标映射不符`);
  }
});
