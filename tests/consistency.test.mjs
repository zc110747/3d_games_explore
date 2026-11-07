/**
 * P7 Node 一致性测试 —— 原版真实数据 ↔ GameAdapter 投影
 *
 * 数据来源：original/site/assets/game.zip（fixtures.makeRealCore，与 window.__SGBY_CORE__ 同构）。
 * 期望值一律取自**原始表**（Dn 字段、lib.getItem(2,6/14/15)、lib.getItem(59,1)、lib.getStr(58)），
 * 不取自适配层自身，因此能抓到投影差一/写错字段/缓存串味。
 *
 * 同时验证「测试工具不写游戏状态」：跑完一致性检查后 Dn 的关键字段必须一字未变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRealCore } from './fixtures.mjs';
import { GameAdapter } from '../original/site/p1/core/GameAdapter.mjs';
import { EventManager } from '../original/site/p1/core/EventManager.mjs';
import { CoordinateSystem } from '../original/site/p1/core/CoordinateSystem.mjs';
import { MapCoordinateSystem } from '../original/site/p2/MapCoordinateSystem.mjs';
import { BattleCoordinateSystem } from '../original/site/p4/BattleCoordinateSystem.mjs';
import { ConsistencyProbe } from '../original/site/p7/ConsistencyProbe.mjs';

async function makeRig() {
  const core = makeRealCore();
  const events = new EventManager();
  const adapter = new GameAdapter({ core, events });
  await adapter.connect({ requireInput: false, installHooks: false, watchdog: false });
  const coordinate = new CoordinateSystem();
  const mapCoordinate = new MapCoordinateSystem(coordinate);
  const battleCoordinate = new BattleCoordinateSystem(coordinate);
  battleCoordinate.configure(core.Dn.g_MapWid || 32, core.Dn.g_MapHgt || 32);
  const probe = new ConsistencyProbe({ core, adapter, mapCoordinate, battleCoordinate });
  return { core, events, adapter, coordinate, mapCoordinate, battleCoordinate, probe };
}

test('一致性探针：38 城逻辑数据与原始表逐字段相同', async () => {
  const { probe } = await makeRig();
  const r = probe.run({ sectors: ['cities'] });
  assert.equal(r.failed, 0, JSON.stringify(r.failures));
  assert.equal(r.counts.cities, 38);
});

test('一致性探针：城市名/坐标/布局/id+1 反查全部命中', async () => {
  const { probe } = await makeRig();
  const r = probe.run({ sectors: ['cities'] });
  const names = r.checks.filter((c) => ['cities.names', 'cities.positions', 'cities.layout(id+1 反查)'].includes(c.name));
  assert.equal(names.length, 3);
  for (const c of names) assert.ok(c.ok, `${c.name}: ${c.detail}`);
});

test('一致性探针：连接拓扑（54 路）与原始 8 方向表一致', async () => {
  const { probe, adapter } = await makeRig();
  const r = probe.run({ sectors: ['links', 'cities'] });
  const link = r.checks.find((c) => c.name === 'links.拓扑与原始表一致');
  assert.ok(link.ok, link.detail);
  assert.equal(adapter.getCityLinks().length, 54);
});

test('一致性探针：势力集合/玩家/回合与 Dn 相同', async () => {
  const { probe } = await makeRig();
  const r = probe.run({ sectors: ['factions'] });
  assert.equal(r.failed, 0, JSON.stringify(r.failures));
});

test('一致性探针：城市武将队列切片与武将字段一致', async () => {
  const { probe } = await makeRig();
  const r = probe.run({ sectors: ['officers'] });
  const c = r.checks[0];
  assert.ok(c.ok, c.detail);
});

test('一致性探针：坐标往返误差 <= 1e-9（战略 12x9 / 战斗 32x32）', async () => {
  const { probe } = await makeRig();
  const r = probe.run({ sectors: ['mapping'] });
  const m = r.checks.filter((c) => c.kind === 'mapping');
  assert.ok(m.length >= 2);
  for (const c of m) assert.ok(c.ok, `${c.name}: ${c.detail}`);
});

test('一致性探针：原版虚拟屏命中公式反算无错位', async () => {
  const { probe } = await makeRig();
  const r = probe.run({ sectors: ['mapping'] });
  const s = r.checks.find((c) => c.kind === 'screen');
  assert.ok(s, '缺少 screen 检查');
  assert.ok(s.ok, s.detail);
});

test('一致性探针：只读——跑完整套检查后 Dn 关键字段不变', async () => {
  const { core, probe } = await makeRig();
  const Dn = core.Dn;
  const before = JSON.stringify({
    year: Dn.g_YearDate, month: Dn.g_MonthDate, king: Dn.g_PlayerKing,
    cities: Dn.g_Cities.map((c) => [c.Belong, c.Money, c.Food, c.Farming, c.Persons]),
    persons: Dn.g_Persons.slice(0, 20).map((p) => [p.Belong, p.Arms, p.Level]),
    genPos: Dn.g_GenPos.map((g) => [g.x, g.y, g.hp]),
    fgt: [Dn.g_FgtOver, Dn.g_FgtBoutCnt, Dn.g_MapWid, Dn.g_MapHgt],
  });
  probe.run();
  const after = JSON.stringify({
    year: Dn.g_YearDate, month: Dn.g_MonthDate, king: Dn.g_PlayerKing,
    cities: Dn.g_Cities.map((c) => [c.Belong, c.Money, c.Food, c.Farming, c.Persons]),
    persons: Dn.g_Persons.slice(0, 20).map((p) => [p.Belong, p.Arms, p.Level]),
    genPos: Dn.g_GenPos.map((g) => [g.x, g.y, g.hp]),
    fgt: [Dn.g_FgtOver, Dn.g_FgtBoutCnt, Dn.g_MapWid, Dn.g_MapHgt],
  });
  assert.equal(after, before, '一致性检查不得修改任何游戏状态');
});

test('一致性探针：源码不含任何对 Dn 的写操作（静态守卫）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'original', 'site', 'p7');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  const offenders = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/Dn\.[A-Za-z_$][\w$]*\s*=[^=]/.test(text)) offenders.push(`${f}:Dn 赋值`);
    if (/new\s+THREE\.WebGLRenderer/.test(text)) offenders.push(`${f}:自建 WebGLRenderer`);
    if (/requestAnimationFrame\(/.test(text)) offenders.push(`${f}:自建渲染循环`);
  }
  assert.deepEqual(offenders, [], 'P7 模块不得写游戏状态 / 不得自建渲染循环');
});
