/**
 * P1 适配层测试 —— core 由 game.zip 真实数据构造（tests/fixtures.mjs）。
 * 断言全部针对真实字段：城市/武将/连接/菜单/消耗/战斗地图尺寸；
 * 结构性字段不参与业务数值断言。
 * 运行： node --test tests/adapter.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GameAdapter, UnsupportedError } from '../original/site/p1/core/GameAdapter.mjs';
import { EventManager, EVENTS } from '../original/site/p1/core/EventManager.mjs';
import { loadRealData, makeRealCore } from './fixtures.mjs';

const data = loadRealData();
const DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

function setup() {
  const core = makeRealCore(data);
  const events = new EventManager();
  const adapter = new GameAdapter({ core, events });
  return { core, events, adapter };
}

test('connect 后能读取真实游戏状态（38 城 / 200 将 / 190 年）', async () => {
  const { adapter } = setup();
  await adapter.connect({ requireInput: false, installHooks: false, watchdog: false });
  const s = adapter.getGameState();
  assert.equal(s.cityCount, 38);
  assert.equal(s.officerCount, 200);
  assert.equal(s.year, 190);
  assert.equal(s.month, 1);
  assert.equal(s.source, 'Dn (sgby.core.js)');
  adapter.dispose();
});

test('getCities/getCity 返回真实名称、坐标与布局值，且为只读投影', async () => {
  const { adapter } = setup();
  await adapter.connect({ requireInput: false, installHooks: false, watchdog: false });
  const cities = adapter.getCities();
  assert.equal(cities.length, 38);
  assert.equal(cities[0].name, '西凉');
  assert.equal(cities[37].name, '建宁');
  assert.deepEqual({ x: cities[0].position.x, y: cities[0].position.y },
    { x: data.constants['城市坐标'][0][0], y: data.constants['城市坐标'][0][1] });
  for (const c of cities) assert.equal(c.layoutValue, c.id + 1, `城市 ${c.id} 布局值`);
  assert.equal(cities[0].battleMapId, data.constants['城市地图id'][0]);
  assert.equal(Object.isFrozen(cities[0]), true);
  assert.equal(Object.isFrozen(cities[0].position), true);
  assert.throws(() => { cities[0].money = 999; }, TypeError);
  adapter.dispose();
});

test('getCityConnections 与 struct/城市连接右.json 逐项一致', async () => {
  const { adapter } = setup();
  await adapter.connect({ requireInput: false, installHooks: false, watchdog: false });
  for (let id = 0; id < 38; id++) {
    const got = adapter.getCityConnections(id);
    const raw = data.connRight['城市'][id];
    assert.equal(got.length, 8);
    DIRS.forEach((d, k) => {
      assert.equal(got[k].dir, d);
      assert.equal(got[k].cityId, raw['连接'][d] ? raw['连接'][d] - 1 : null, `城 ${id} ${d} 连接`);
      assert.equal(got[k].distance, raw['距离'][d], `城 ${id} ${d} 距离`);
    });
  }
  adapter.dispose();
});

test('getCityActions 复现真实菜单顺序 4 / 14+5+5 与消耗表', async () => {
  const { adapter } = setup();
  await adapter.connect({ requireInput: false, installHooks: false, watchdog: false });
  const a = adapter.getCityActions(0);
  assert.deepEqual(a.main, ['内政', '外交', '军备', '状况']);
  assert.equal(a.groups[0].items.length, 14);
  assert.equal(a.groups[1].items.length, 5);
  assert.equal(a.groups[2].items.length, 5);
  assert.equal(a.groups[0].items[0].name, '开垦');
  assert.equal(a.groups[0].items[0].id, 1);
  assert.equal(a.groups[0].items[0].costThew, 8);
  assert.equal(a.groups[0].items[0].costMoney, 50);
  assert.equal(a.groups[1].items[0].name, '离间');
  assert.equal(a.groups[1].items[0].id, 15);
  assert.equal(a.groups[2].items[0].name, '侦察');
  assert.equal(a.groups[2].items[0].id, 23);
  assert.equal(a.groups[2].items[4].id, 27);
  assert.equal(a.groups[2].items[4].name, '出征');
  adapter.dispose();
});

test('getOfficers/getOfficer 来自真实武将队列与武将数据', async () => {
  const { adapter } = setup();
  await adapter.connect({ requireInput: false, installHooks: false, watchdog: false });
  const withOfficers = adapter.getCities().find((c) => c.officerCount > 0);
  assert.ok(withOfficers);
  const list = adapter.getOfficers(withOfficers.id);
  assert.equal(list.length, withOfficers.officerCount);
  assert.equal(adapter.getOfficer(0).name, '董卓');
  assert.equal(adapter.getOfficer(0).force, data.personData['时期'][0][0]['武力']);
  assert.equal(Object.isFrozen(adapter.getOfficer(0)), true);
  adapter.dispose();
});

test('战斗只读接口：无 p4 内核时如实拒绝，不伪造范围', async () => {
  const { adapter } = setup();
  await adapter.connect({ requireInput: false, installHooks: false, watchdog: false });
  const b = adapter.getBattleState();
  assert.equal(b.width, 32);
  assert.equal(b.height, 32);
  assert.equal(b.mapId, 110);
  assert.equal(b.viewport.cols, 15);
  assert.equal(b.viewport.rows, 17);
  assert.equal(b.mapReady, false, '未进战斗时地图未初始化');

  const units = adapter.getBattleUnits();
  assert.equal(units.length, 20);
  assert.equal(units.filter((u) => u.present).length, 0, '未开局时 GenArray 为空');
  assert.equal(units[0].side, 'mine');
  assert.equal(units[10].side, 'enemy');

  // Node 夹具没有 p4 内核导出：必须抛 UnsupportedError（绝不返回一份假范围）
  assert.throws(() => adapter.getMovementRange(0),
    (e) => e instanceof UnsupportedError && /p4\.battle/.test(e.reason));
  assert.throws(() => adapter.getAttackRange(0),
    (e) => e instanceof UnsupportedError && /p4\.battle/.test(e.reason));
  assert.throws(() => adapter.getBattleMap(),
    (e) => e instanceof UnsupportedError && /p4\.battle/.test(e.reason));
  assert.equal(adapter.canSelectUnit(0), false, '无 p4 时不可选，不假装可选');
  assert.throws(() => adapter.getBattleUnit(99), RangeError);
  adapter.dispose();
});

test('capabilities 如实标注；不可用接口抛 UnsupportedError 且不伪造成功', async () => {
  const { adapter } = setup();
  await adapter.connect({ requireInput: false, installHooks: false, watchdog: false });
  const c = adapter.getCapabilities();
  assert.equal(c.getCities.status, 'read');
  assert.equal(c.sendInput.status, 'write');
  for (const name of ['selectCity', 'executeCityAction', 'selectOfficer', 'moveUnit', 'attackUnit', 'endTurn']) {
    assert.equal(c[name].status, 'unavailable');
    assert.throws(() => adapter[name](), (e) => e instanceof UnsupportedError && !!e.reason && !!e.originalEntry,
      `${name} 应抛 UnsupportedError`);
  }
  adapter.dispose();
});

test('状态同步：真实 diff 派发 CITY_UPDATED / CITY_OWNER_CHANGED / TURN_CHANGED', async () => {
  const { core, events, adapter } = setup();
  await adapter.connect({ requireInput: false, installHooks: false, watchdog: false });
  const seen = [];
  events.on(EVENTS.CITY_UPDATED, (e) => seen.push(['city', e.cityId]));
  events.on(EVENTS.CITY_OWNER_CHANGED, (e) => seen.push(['owner', e.cityId, e.oldOwnerId, e.newOwnerId]));
  events.on(EVENTS.TURN_CHANGED, (e) => seen.push(['turn', e.year, e.month]));

  core.Dn.g_Cities[0].Money += 10;
  adapter.sync({ source: 'test' });
  core.Dn.g_Cities[1].Belong = 3;
  core.Dn.g_YearDate = 191;
  adapter.sync({ source: 'test' });

  assert.ok(seen.some((s) => s[0] === 'city' && s[1] === 0));
  assert.ok(seen.some((s) => s[0] === 'owner' && s[1] === 1 && s[3] === 3));
  assert.ok(seen.some((s) => s[0] === 'turn' && s[1] === 191));
  const before = events.getStats().emitted;
  const unchanged = adapter.sync({ source: 'test' });
  assert.equal(unchanged.changed, false);
  assert.equal(events.getStats().emitted, before, '无变化不应重复派发');
  adapter.dispose();
});

test('EventManager：订阅/取消、去重、releaseOwner', () => {
  const events = new EventManager();
  let n = 0;
  const off = events.on(EVENTS.CITY_SELECTED, () => { n++; });
  events.emit(EVENTS.CITY_SELECTED, { cityId: 0 });
  off();
  events.emit(EVENTS.CITY_SELECTED, { cityId: 0 });
  assert.equal(n, 1);

  let m = 0;
  events.on(EVENTS.GAME_STATE_UPDATED, () => { m++; });
  events.emit(EVENTS.GAME_STATE_UPDATED, {}, { dedupeKey: 'same' });
  events.emit(EVENTS.GAME_STATE_UPDATED, {}, { dedupeKey: 'same' });
  assert.equal(m, 1);

  const owner = {};
  let k = 0;
  events.on(EVENTS.CITY_UPDATED, () => { k++; }, { owner });
  events.emit(EVENTS.CITY_UPDATED, { cityId: 0 });
  assert.equal(events.releaseOwner(owner), 1);
  events.emit(EVENTS.CITY_UPDATED, { cityId: 0 });
  assert.equal(k, 1);
  events.dispose();
});
