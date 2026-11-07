/**
 * P6 Node 侧一致性测试（不依赖浏览器）。
 *
 * 覆盖三类事实：
 *   A. 存档格式事实 —— 头 "SGB3"、版本 4、两片长度公式、key 规则，
 *      全部以原版源码为基线交叉校验（不猜）。
 *   B. 整合层逻辑 —— 生命周期幂等、UI 栈阻断、场景切换锁/循环检测、
 *      状态一致性检查、异常升级与恢复。
 *   C. 边界纪律 —— P6 源码不得写 Dn、不得往原版存档键里塞 3D 字段。
 *
 * 运行： node --test tests/p6.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppLifecycle } from '../original/site/p6/AppLifecycle.mjs';
import { UIStack } from '../original/site/p6/UIStack.mjs';
import { PresentationStore } from '../original/site/p6/PresentationStore.mjs';
import { SaveManager } from '../original/site/p6/SaveManager.mjs';
import { SceneDirector } from '../original/site/p6/SceneDirector.mjs';
import { StateSync } from '../original/site/p6/StateSync.mjs';
import { ErrorHub } from '../original/site/p6/ErrorHub.mjs';
import { SAVE, savePartBytes, PRESENTATION } from '../original/site/p6/config.mjs';
import { EventManager, EVENTS } from '../original/site/p1/core/EventManager.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIN_JS = path.join(ROOT, 'original', 'site', 'sgby.min.js');
const P6_DIR = path.join(ROOT, 'original', 'site', 'p6');

// ------------------------------------------------------------------ 工具
class MemoryStorage {
  constructor() { this.map = new Map(); this.writes = []; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.writes.push(k); this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  key(i) { return [...this.map.keys()][i] ?? null; }
  get length() { return this.map.size; }
}

const bytesToB64 = (bytes) => Buffer.from(Uint8Array.from(bytes)).toString('base64');

/** 造一份「格式合法」的 base 片：头 + 版本 + 可解析的 king/year。 */
function makeBaseBytes({ king = 3, year = 195, version = 4, length = 4301 } = {}) {
  const b = new Uint8Array(length);
  b[0] = SAVE.header[0]; b[1] = SAVE.header[1]; b[2] = SAVE.header[2]; b[3] = SAVE.header[3];
  b[4] = version;
  b[6] = king & 0xff; b[7] = (king >> 8) & 0xff;
  b[8] = year & 0xff; b[9] = (year >> 8) & 0xff;
  b[18] = 0;
  return bytesToB64(b);
}

function makeFakeCore({ withSave = true } = {}) {
  const storeCalls = { ac: [], oc: [] };
  const Dn = {
    g_Cities: Array.from({ length: 38 }, (_, i) => ({ Belong: i % 4, Money: 100 + i, Food: 500, Id: 0, Persons: 0, SatrapId: 0 })),
    g_Persons: Array.from({ length: 200 }, () => ({ Belong: 1, Arms: 800, Level: 1, Thew: 50 })),
    g_OrderQueue: [],
    g_YearDate: 195, g_MonthDate: 3, g_PlayerKing: 0, g_PIdx: 1, g_Diff: 0,
    g_CityPos: { x: 0, y: 0, setx: 0, sety: 0 },
    citymap: Array.from({ length: 9 }, () => new Uint8Array(12)),
    g_FgtOver: 0, g_FgtBoutCnt: 0,
  };
  return {
    version: 'test',
    Dn,
    lib: {},
    fns: {
      jn: (slot) => [`${SAVE.defaultPrefix}${2 * slot}.sav`, `${SAVE.defaultPrefix}${2 * slot + 1}.sav`],
      quote: (t) => `${t}`,
      ac: (slot) => { storeCalls.ac.push(slot); return withSave; },
      oc: (slot) => { storeCalls.oc.push(slot); return withSave; },
      qs: () => 1,
    },
    p6: { capacity: { persons: 200, cities: 38, goods: 33, skills: 30 } },
    _calls: storeCalls,
  };
}

function makeAdapter(core, overrides = {}) {
  const stats = { syncCount: 0, forcedSyncs: 0, lastSource: null };
  return {
    connected: true,
    stats,
    getCities: () => core.Dn.g_Cities.map((_, i) => ({ id: i, ownerId: core.Dn.g_Cities[i].Belong, name: `C${i}`, position: { x: i % 12, y: Math.floor(i / 12) } })),
    getGameState: () => ({
      year: core.Dn.g_YearDate, month: core.Dn.g_MonthDate,
      playerKing: core.Dn.g_PlayerKing, period: core.Dn.g_PIdx,
      cityCount: 38, officerCount: 200,
    }),
    getInputPhase: () => ({
      kind: 'zs', waiting: true, inScenario: true, inOrderContext: false, canSelectCity: true,
    }),
    sync: ({ source, force } = {}) => {
      stats.syncCount++;
      if (force) stats.forcedSyncs++;
      stats.lastSource = source;
      return { changed: true, source, force: !!force };
    },
    snapshotSignature: () => 'sig',
    ...overrides,
  };
}

function makeCameraManager() {
  return {
    _state: new Map(),
    views: [],
    getState: () => ({ target: [1, 0, -2], zoom: 1.4, kind: 'world' }),
    setView: (cam, view) => { this_views.push(view); return true; },
  };
}
// 上面的 this 写法在箭头函数里无效，改用显式对象
const this_views = [];

// ------------------------------------------------------------------ 存档格式
test('存档格式常量与原版源码同源（SGB3 / v4 / 3 槽 / 两片）', () => {
  const src = fs.readFileSync(MIN_JS, 'utf8');
  assert.ok(src.includes('const Rn=[83,71,66,51]'), '原版头部常量应为 [83,71,66,51]');
  assert.deepEqual(SAVE.header, [83, 71, 66, 51]);
  assert.equal(SAVE.version, 4);
  assert.equal(SAVE.slots, 3);
  assert.equal(SAVE.format, 'sgby-save');
  assert.equal(SAVE.atomic, false);
  // 槽位 key 规则：`${prefix}${2*slot}.sav` 与 `+1`
  assert.ok(src.includes('`${Qn}${2*t}.sav`'), '原版 key 规则应保持不变');
});

test('存档两片长度公式 = ac()/oc() 的 Uint8Array 尺寸', () => {
  const src = fs.readFileSync(MIN_JS, 'utf8');
  assert.ok(src.includes('new Uint8Array(35+19*Ae+2*Ae+2*Ie)'), 'base 片长度公式应来自源码');
  assert.ok(src.includes('new Uint8Array(2035+37*Fe)'), 'dyn 片长度公式应来自源码');
  const b = savePartBytes({ persons: 200, cities: 38, goods: 33 });
  assert.equal(b.base, 35 + 19 * 200 + 2 * 200 + 2 * 33);
  assert.equal(b.dyn, 2035 + 37 * 38);
  assert.equal(b.base, 4301);
  assert.equal(b.dyn, 3441);
});

test('SaveManager 只经原版 jn()/ac()/oc()，不自造 key 也不解析业务字段', () => {
  const core = makeFakeCore();
  const storage = new MemoryStorage();
  const adapter = makeAdapter(core);
  const events = new EventManager();
  const sm = new SaveManager({ core, adapter, events, storage, log: () => {} });

  assert.deepEqual(sm.keysFor(0), [`${SAVE.defaultPrefix}0.sav`, `${SAVE.defaultPrefix}1.sav`]);
  assert.throws(() => sm.keysFor(3), /越界/);

  const empty = sm.inspect(1);
  assert.equal(empty.exists, false);
  assert.equal(empty.label, '空槽');
  assert.equal(empty.expect.base, 4301);

  // 造一份合法存档，验证头部解析（Hn() 同口径：t[6..7]=king, t[8..9]=year）
  storage.setItem(sm.keysFor(0)[0], makeBaseBytes({ king: 3, year: 195 }));
  storage.setItem(sm.keysFor(0)[1], bytesToB64(new Uint8Array(3441)));
  const info = sm.inspect(0);
  assert.equal(info.exists, true);
  assert.equal(info.header.version, 4);
  assert.equal(info.header.king, 3);
  assert.equal(info.header.year, 195);
  assert.equal(info.sizeMatch, true);
  assert.equal(info.compatible, true);
  assert.match(info.label, /195 年/);

  // 旧版本（v3）必须被识别为不兼容，而不是静默读取
  storage.setItem(sm.keysFor(2)[0], makeBaseBytes({ version: 3 }));
  storage.setItem(sm.keysFor(2)[1], bytesToB64(new Uint8Array(3441)));
  const old = sm.inspect(2);
  assert.equal(old.header.version, 3);
  assert.equal(old.compatible, false);
});

test('SaveManager 准入判断如实拒绝（未进剧本 / 战斗中 / 非 zs 阶段）', () => {
  const core = makeFakeCore();
  core.Dn.g_YearDate = 0;
  const storage = new MemoryStorage();
  const events = new EventManager();
  const adapter = makeAdapter(core, {
    getInputPhase: () => ({ kind: 'menu', waiting: true, inScenario: false, inOrderContext: false, canSelectCity: false }),
  });
  const sm = new SaveManager({ core, adapter, events, storage, log: () => {} });
  assert.equal(sm.canSave().ok, false);
  assert.equal(sm.canLoad().ok, false);
  const r = sm.save(0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /剧本/);
  assert.equal(core._calls.ac.length, 0, '被拒绝时不得调用原版 ac()');

  // 战斗中：
  core.Dn.g_YearDate = 195;
  const sm2 = new SaveManager({
    core, adapter, events, storage, log: () => {},
    isBattleActive: () => true,
  });
  const r2 = sm2.save(0);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /战斗/);
});

test('SaveManager 读档成功走 qs() 重绘 + force 同步 + 表现层重建；失败必须报「非原子」', () => {
  const core = makeFakeCore();
  const storage = new MemoryStorage();
  const events = new EventManager();
  const adapter = makeAdapter(core);
  let afterLoadCalled = 0;
  const sm = new SaveManager({
    core, adapter, events, storage, log: () => {},
    onAfterLoad: () => { afterLoadCalled++; return { ok: true }; },
  });
  storage.setItem(sm.keysFor(0)[0], makeBaseBytes({ year: 208 }));
  storage.setItem(sm.keysFor(0)[1], bytesToB64(new Uint8Array(3441)));
  const ok = sm.load(0);
  assert.equal(ok.ok, true);
  assert.equal(ok.redrawn, true);
  assert.equal(adapter.stats.forcedSyncs, 1);
  assert.equal(afterLoadCalled, 1);
  assert.equal(ok.afterState.year, 195);

  // oc 返回 false：必须标记 partial 并说明非原子
  const dry = makeFakeCore({ withSave: false });
  const sm2 = new SaveManager({ core: dry, adapter: makeAdapter(dry), events, storage, log: () => {} });
  storage.setItem(sm2.keysFor(1)[0], makeBaseBytes());
  storage.setItem(sm2.keysFor(1)[1], bytesToB64(new Uint8Array(3441)));
  const bad = sm2.load(1);
  assert.equal(bad.ok, false);
  assert.equal(bad.partial, true);
  assert.match(bad.reason, /非原子|部分覆盖/);
});

// ------------------------------------------------------------------ 生命周期
test('AppLifecycle：阶段只跑一次、失败指名阶段、唯一对象守卫', async () => {
  const lc = new AppLifecycle({ log: () => {} });
  const order = [];
  await lc.stage('a', () => { order.push('a'); });
  await lc.stage('b', () => { order.push('b'); });
  assert.deepEqual(order, ['a', 'b']);
  await assert.rejects(() => lc.stage('a', () => {}), /重复执行/);

  await assert.rejects(() => lc.stage('c', () => { throw new Error('boom'); }), /「c」/);

  const obj = {};
  lc.claim('renderer', obj);
  assert.equal(lc.claim('renderer', obj), obj);
  assert.throws(() => lc.claim('renderer', {}), /重复登记/);

  const s = lc.summary();
  assert.equal(s.stages, 3);
  assert.equal(s.failed, 1);
  assert.equal(s.duplicates, 2);   // 1 次 stage 重复 + 1 次 claim 冲突
  assert.ok(s.singletons.includes('renderer'));
});

test('AppLifecycle：计时器统一登记且 dispose 后清空', async () => {
  const lc = new AppLifecycle();
  let n = 0;
  lc.interval(() => { n++; }, 5, 'probe');
  await new Promise((r) => setTimeout(r, 22));
  assert.ok(n >= 1);
  const labels = lc.timerLabels;
  assert.ok(labels.includes('probe'));
  lc.dispose();
  assert.equal(lc.timerCount, 0);
});

// ------------------------------------------------------------------ UI 栈
test('UIStack：同 id 不叠加阻断，出栈后恢复输入；owner 批量关闭', () => {
  const calls = [];
  const input = { setUIOpen: (v) => calls.push(v) };
  const stack = new UIStack({ input });
  const owner = { name: 'scene' };

  const t1 = stack.push('city', { layer: 40, owner });
  const t2 = stack.push('city', { layer: 40, owner });
  assert.equal(stack.stats.duplicates, 1);
  assert.equal(stack.depth, 1);
  assert.deepEqual(calls, [true]);

  stack.close(t2);
  assert.equal(stack.blocking, true, '重复 token 不应提前释放阻断');
  assert.equal(calls.length, 1);

  stack.push('officer', { layer: 70, owner });
  assert.equal(stack.depth, 2);
  assert.equal(stack.closeOwner(owner), 2);
  assert.equal(stack.blocking, false);
  assert.deepEqual(calls, [true, false]);

  // 未知 token 只计数不抛错
  assert.equal(stack.close({ id: 'ghost', seq: 999 }), false);
  assert.equal(stack.stats.orphanCloses, 1);
  assert.equal(stack.isOrdered(), true);
});

test('UIStack.clear 会把残留层全部清掉（读档/错误恢复用）', () => {
  const input = { ui: false, setUIOpen(v) { this.ui = v; } };
  const stack = new UIStack({ input });
  stack.push('a'); stack.push('b', { layer: 70 });
  assert.equal(input.ui, true);
  assert.equal(stack.clear('读档'), 2);
  assert.equal(stack.depth, 0);
  assert.equal(input.ui, false);
  assert.equal(stack.stats.forcedCloses, 2);
});

// ------------------------------------------------------------------ 表现配置
test('PresentationStore：只写白名单字段，坏数据回落默认，不与存档键混用', () => {
  const storage = new MemoryStorage();
  const ps = new PresentationStore({ storage });

  const r = ps.save({ camera: { x: 2, z: -3, zoom: 1.5 }, selection: 7 });
  assert.equal(r.ok, true);
  const audit = PresentationStore.auditPayload(r.payload);
  assert.equal(audit.ok, true, `不应含业务字段：${audit.hits.join(',')}`);
  assert.deepEqual(Object.keys(r.payload).sort(), ['camera', 'selection', 'ui', 'version'].sort());
  assert.deepEqual(storage.writes, [PRESENTATION.key]);
  assert.ok(!storage.writes.some((k) => k.endsWith('.sav')));

  // 越界值被钳位（不会把相机送到地图外）
  const clamped = ps.load();
  ps.save({ camera: { x: 999, z: -999, zoom: 99 } });
  const c = ps.load();
  assert.equal(c.camera.x, 64);
  assert.equal(c.camera.z, -64);
  assert.equal(c.camera.zoom, 4);
  assert.ok(clamped);

  // 坏 JSON / 版本不符 都必须回落默认而不是抛错
  storage.setItem(PRESENTATION.key, '{not json');
  assert.equal(ps.load().camera, null);
  assert.equal(ps.stats.corrupt, 1);
  storage.setItem(PRESENTATION.key, JSON.stringify({ version: 999, camera: { x: 1, z: 1, zoom: 1 } }));
  assert.equal(ps.load().camera, null);
  assert.equal(ps.stats.rejected, 1);
});

// ------------------------------------------------------------------ 场景编排
function makeDirectorEnv({ transitions = { world: ['city', 'battle'], city: ['world'], battle: ['world'] } } = {}) {
  const events = new EventManager();
  const state = { current: 'world', switches: 0, rejected: 0 };
  const scenes = {
    get currentId() { return state.current; },
    get stats() { return { switches: state.switches, rejected: state.rejected }; },
    canSwitch(to) {
      const allowed = transitions[state.current] || [];
      return allowed.includes(to) ? { ok: true } : { ok: false, reason: `不允许 ${state.current} -> ${to}` };
    },
    switchTo(to) {
      if (!scenes.canSwitch(to).ok) { state.rejected++; throw new Error(`不允许 ${state.current} -> ${to}`); }
      const from = state.current;
      state.current = to;
      state.switches++;
      events.emit(EVENTS.SCENE_CHANGED, { from, to });
      return { id: to };
    },
  };
  const adapter = makeAdapter(makeFakeCore());
  const views = [];
  const cameraManager = {
    getState: () => ({ target: [1.5, 0, -2.5], zoom: 1.25, kind: 'world' }),
    setView: (cam, view) => { views.push(view); return true; },
  };
  const worldScene = {
    selection: 5,
    camera: { id: 'world-cam' },
    setSelection(id) { this.selection = id; return 1; },
    cityRenderer: { refreshCity: () => true, cities: [] },
    flagRenderer: { syncAll: () => {}, getDiagnostics: () => ({ flags: 38 }) },
    refreshCity: () => true,
  };
  const uiStack = new UIStack({});
  const director = new SceneDirector({
    scenes, adapter, events, uiStack, cameraManager,
    getWorldScene: () => worldScene, getCamera: () => worldScene.camera,
    log: () => {},
  });
  return { events, scenes, state, adapter, director, worldScene, cameraManager, views, uiStack };
}

test('SceneDirector：切换统计 + 进入战斗前保存视图 + 返回后恢复', () => {
  const env = makeDirectorEnv();
  env.director.switchTo('battle', { reason: 'test' });
  assert.equal(env.state.current, 'battle');
  assert.equal(env.director.stats.transitions, 1);
  assert.equal(env.director.stats.battleEnters, 1);
  assert.deepEqual(env.director._worldState.camera, { target: [1.5, 0, -2.5], zoom: 1.25 });

  env.director.switchTo('world', { reason: 'test' });
  assert.equal(env.state.current, 'world');
  assert.equal(env.director.stats.battleExits, 1);
  assert.equal(env.director.stats.restores, 1);
  assert.equal(env.worldScene.selection, 5);
  assert.deepEqual(env.views[0], { target: [1.5, 0, -2.5], zoom: 1.25 });
});

test('SceneDirector：非法切换被拒绝且当前场景不变', () => {
  const env = makeDirectorEnv();
  assert.throws(() => env.director.switchTo('world'), /不允许/);
  assert.equal(env.state.current, 'world');
  assert.equal(env.director.stats.rejected, 1);
});

test('SceneDirector：1 秒内同目标反复切换会被判定为循环并拦下', () => {
  const env = makeDirectorEnv({ transitions: { world: ['city', 'battle'], city: ['world', 'battle', 'world'], battle: ['world'] } });
  // 直接驱动 _checkLoop：模拟 5 次「切到 battle」
  for (let i = 0; i < 4; i++) env.director._checkLoop('battle');
  assert.throws(() => env.director._checkLoop('battle'), /无限循环/);
  assert.equal(env.director.stats.loops, 1);
});

test('SceneDirector：切换锁拒绝重入（同一时刻只允许一次切换）', () => {
  const env = makeDirectorEnv();
  env.director._switching = true;      // 模拟上一次切换尚未完成
  const r = env.director.switchTo('battle');
  assert.equal(r.ok, false);
  assert.match(r.reason, /尚未完成/);
  assert.equal(env.state.current, 'world');
});

test('SceneDirector：读档后重建 = 清 UI 栈 + 全量刷新 + 回战略地图', () => {
  const env = makeDirectorEnv();
  env.uiStack.push('city');
  env.uiStack.push('officer', { layer: 70 });
  env.director.switchTo('battle');
  const r = env.director.afterLoad({ slot: 0, reason: 'test' });
  assert.equal(r.ok, true);
  assert.equal(r.cleared, 2);
  assert.equal(env.state.current, 'world');
  assert.equal(env.director.stats.resyncs, 1);
  assert.equal(env.director.cityOverlay, null);
});

// ------------------------------------------------------------------ 状态同步
test('StateSync：刷新器唯一登记 + 脏标批处理 + 全量同步', async () => {
  const events = new EventManager();
  const adapter = makeAdapter(makeFakeCore());
  const runs = [];
  const sync = new StateSync({ adapter, events, log: () => {} });
  sync.register('world', () => runs.push('world'));
  sync.register('hud', () => runs.push('hud'));
  assert.throws(() => sync.register('world', () => {}), /重复登记/);

  sync.attach();
  sync.attach();     // 二次 attach 不应重复订阅
  events.emit(EVENTS.CITY_OWNER_CHANGED, { cityId: 1 });
  assert.deepEqual(sync.dirty, ['owner']);
  const r = await sync.flush('test');
  assert.equal(r.runs, 2);
  assert.deepEqual(runs, ['world', 'hud']);

  const full = await sync.fullSync('manual');
  assert.equal(full.adapter.force, true);
  assert.equal(adapter.stats.forcedSyncs, 1);
});

test('StateSync.consistency：能抓到「旗帜没跟着归属刷新」这类不一致', () => {
  const events = new EventManager();
  const core = makeFakeCore();
  const adapter = makeAdapter(core);
  const cities = adapter.getCities();
  const scene = {
    selection: null,
    cityRenderer: { cities: cities.map((c) => ({ id: c.id, name: c.name })) },
    flagRenderer: {
      _owner: new Map(cities.map((c) => [c.id, c.ownerId])),
      getDiagnostics: () => ({ flags: cities.length }),
      syncAll: () => {},
    },
  };
  const rm = { stats: { frames: 10, renders: 10 }, isRunning: true, failed: false };
  const sync = new StateSync({
    adapter, events, log: () => {},
    getWorldScene: () => scene, getRenderManager: () => rm,
    getScenes: () => ({ currentId: 'world' }), getBattleManager: () => null,
  });
  assert.equal(sync.consistency().ok, true);

  // 人为让一面旗子「没刷新」，必须被抓到
  scene.flagRenderer._owner.set(7, 999);
  const bad = sync.consistency();
  assert.equal(bad.ok, false);
  assert.match(bad.mismatches.join('|'), /旗帜归属/);

  // 渲染循环停了也算不一致
  scene.flagRenderer._owner.set(7, cities[7].ownerId);
  rm.isRunning = false;
  assert.match(sync.consistency().mismatches.join('|'), /渲染循环未运行/);
});

// ------------------------------------------------------------------ 异常
test('ErrorHub：可恢复不弹致命面板，连续 3 次升级为致命，恢复后计数清零', () => {
  const shown = [];
  const ui = { showFatal: (o) => shown.push(o), hideFatal: () => {} };
  const hub = new ErrorHub({ ui, log: () => {} });
  hub.registerRecovery('world', () => ({ ok: true }));

  assert.equal(hub.report('battle:init', new Error('x')).level, 'recoverable');
  assert.equal(shown.length, 0);
  hub.report('battle:init', new Error('y'));
  const third = hub.report('battle:init', new Error('z'));
  assert.equal(third.level, 'fatal');
  assert.equal(shown.length, 1);
  assert.equal(hub.stats.escalated, 1);

  const r = hub.recover('world');
  assert.equal(r.ok, true);
  assert.equal(hub.stats.recovered, 1);
  assert.equal(hub.counts.size, 0);

  const missing = hub.recover('nope');
  assert.equal(missing.ok, false);
});

// ------------------------------------------------------------------ 边界纪律
test('P6 源码不写原版游戏状态、不往存档键里塞字段', () => {
  const files = fs.readdirSync(P6_DIR).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length >= 9, `P6 模块数 ${files.length}`);
  for (const f of files) {
    const src = fs.readFileSync(path.join(P6_DIR, f), 'utf8');
    // 禁止直接写 Dn 字段（赋值）；只允许读取
    const writes = [...src.matchAll(/Dn\.[A-Za-z_$][\w$]*\s*=(?!=)/g)].map((m) => m[0]);
    assert.deepEqual(writes, [], `${f} 出现对 Dn 的写入：${writes.join(',')}`);
    // 禁止自造存档 key / 向 .sav 写入
    assert.ok(!/\.sav['"`]\s*,\s*[^)]*setItem/.test(src), `${f} 出现向存档键写入`);
  }
});

test('P6 不新增第二个渲染循环 / 第二个 Renderer（只通过 RenderManager）', () => {
  const files = fs.readdirSync(P6_DIR).filter((f) => f.endsWith('.mjs'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(P6_DIR, f), 'utf8');
    assert.ok(!/new\s+THREE\.WebGLRenderer/.test(src), `${f} 自建了 WebGLRenderer`);
    assert.ok(!/requestAnimationFrame\s*\(/.test(src), `${f} 自建了渲染循环`);
  }
});
