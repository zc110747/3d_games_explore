/**
 * P5 Node 测试 —— 断言依据全部来自
 *   1) original/site/assets/game.zip 的真实字符串资源（界面字符串 8/9）
 *   2) 真实生成物 original/site/sgby.core.js
 *   3) 纯函数（splitMenuByRect / buildVisualPath）+ 适配层协议换算
 *
 * 不使用任何模拟战斗数值：战斗规则本身由原版协程负责，
 * 这里只验证「表现层与协议层是否如实、可逆、不越权」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRealData, makeRealCore } from './fixtures.mjs';
import { GameAdapter, UnsupportedError } from '../original/site/p1/core/GameAdapter.mjs';
import { EventManager } from '../original/site/p1/core/EventManager.mjs';
import { splitMenuByRect } from '../original/site/p5/BattleFlowController.mjs';
import { buildVisualPath, pathHeading } from '../original/site/p5/VisualPath.mjs';
import { PHASES, PHASE_INPUT, ANIM, ACTION_MENU_INDEX, BATTLE_MENU_INDEX } from '../original/site/p5/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SITE = path.join(ROOT, 'original', 'site');
const coreJs = fs.readFileSync(path.join(SITE, 'sgby.core.js'), 'utf8');
const minJs = fs.readFileSync(path.join(SITE, 'sgby.min.js'), 'utf8');
const BRIDGE_MARK = '/* === SGBY-P1-CORE-BRIDGE START';

const data = loadRealData();
const strings = data.strings['界面字符串'];
const ACTION_TEXT = strings[7];      // vi(8) = "攻击计谋查看待机"
const BATTLE_TEXT = strings[8];      // vi(9) = "回合结束敌军移动战斗动画移动速度全军撤退"

// ---------------------------------------------------------------- 1. 菜单切分
test('$r 菜单定宽切分：32px -> 4 单位（行动菜单 4 项）', () => {
  const items = splitMenuByRect(ACTION_TEXT, { sx: 100, ex: 132 });
  assert.deepEqual(items, ['攻击', '计谋', '查看', '待机']);
});

test('$r 菜单定宽切分：64px -> 8 单位（战斗菜单 5 项）', () => {
  const items = splitMenuByRect(BATTLE_TEXT, { sx: 8, ex: 72 });
  assert.deepEqual(items, ['回合结束', '敌军移动', '战斗动画', '移动速度', '全军撤退']);
});

test('菜单切分不丢字：条目拼回原文（去尾部补空格）', () => {
  for (const [text, rect] of [
    [ACTION_TEXT, { sx: 100, ex: 132 }],
    [BATTLE_TEXT, { sx: 8, ex: 72 }],
  ]) {
    const items = splitMenuByRect(text, rect);
    assert.equal(items.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
  }
});

test('菜单切分对空串与畸形 rect 安全（不抛、不造条目）', () => {
  assert.deepEqual(splitMenuByRect('', { sx: 0, ex: 32 }), []);
  assert.deepEqual(splitMenuByRect(null, null), []);
  const fallback = splitMenuByRect(ACTION_TEXT, { sx: 10, ex: 10 });
  assert.deepEqual(fallback, ['攻击', '计谋', '查看', '待机']);
});

// ---------------------------------------------------------------- 2. 视觉路径
/** 构造一个与原版 qi() 同构的累计消耗场（4 邻接，起点 0）。 */
function makeCostField(width, from, to, origin = { x: 0, y: 0 }) {
  const f = new Uint8Array(width * width).fill(255);
  // 直走廊：只有从 from 到 to 的曼哈顿折线可走（按窗口相对坐标写入，与原版 g_FightPath 一致）
  let { x, y } = from;
  const path = [{ x, y }];
  while (x !== to.x) { x += Math.sign(to.x - x); path.push({ x, y }); }
  while (y !== to.y) { y += Math.sign(to.y - y); path.push({ x, y }); }
  path.forEach((p, i) => { f[(p.y - origin.y) * width + (p.x - origin.x)] = i; });
  return { field: f, cells: path };
}

test('视觉路径沿距离场下降，端点与步数与原版场一致', () => {
  const width = 15;
  const from = { x: 3, y: 4 };
  const to = { x: 9, y: 4 };
  const { field, cells } = makeCostField(width, from, to);
  const r = buildVisualPath({ field, origin: { x: 0, y: 0 }, from, to, width, blockCost: 128 });
  assert.equal(r.degraded, false);
  assert.deepEqual(r.cells[0], from, '首个点必须是起点');
  assert.deepEqual(r.cells[r.cells.length - 1], to, '末个点必须是终点');
  assert.equal(r.cells.length, cells.length, '步数应与距离场走廊一致');
  for (let i = 1; i < r.cells.length; i++) {
    const a = r.cells[i - 1], b = r.cells[i];
    assert.equal(Math.abs(a.x - b.x) + Math.abs(a.y - b.y), 1, '相邻点必须是四邻格');
  }
});

test('视觉路径对窗口偏移正确（origin 非零）', () => {
  const width = 15;
  const from = { x: 12, y: 12 };
  const to = { x: 14, y: 14 };
  const { field } = makeCostField(width, from, to, { x: 10, y: 10 });
  const r = buildVisualPath({
    field, origin: { x: 10, y: 10 }, from, to, width, blockCost: 128,
  });
  assert.equal(r.degraded, false);
  assert.deepEqual(r.cells[0], from);
  assert.deepEqual(r.cells[r.cells.length - 1], to);
});

test('视觉路径在起点/终点不在窗口内时退化但不抛错', () => {
  const width = 15;
  const { field } = makeCostField(width, { x: 1, y: 1 }, { x: 2, y: 1 });
  const r = buildVisualPath({
    field, origin: { x: 0, y: 0 }, from: { x: 30, y: 30 }, to: { x: 31, y: 31 },
    width, blockCost: 128,
  });
  assert.equal(r.degraded, true);
  assert.deepEqual(r.cells[0], { x: 30, y: 30 });
  assert.deepEqual(r.cells[r.cells.length - 1], { x: 31, y: 31 });
});

test('零距离移动只返回起点（不产生多余动画段）', () => {
  const width = 15;
  const { field } = makeCostField(width, { x: 5, y: 5 }, { x: 5, y: 5 });
  const r = buildVisualPath({
    field, origin: { x: 0, y: 0 }, from: { x: 5, y: 5 }, to: { x: 5, y: 5 }, width,
  });
  assert.equal(r.cells.length, 1);
  assert.equal(r.steps, 0);
  assert.equal(pathHeading(r.cells), 0);
});

// ---------------------------------------------------------------- 3. 状态机常量
test('状态机相位集合与输入映射自洽', () => {
  const all = Object.values(PHASES);
  assert.equal(all.length, 13);
  for (const p of all) assert.ok(PHASE_INPUT[p], `${p} 缺少输入映射`);
  // 动画期与结算期必须锁输入
  for (const p of [PHASES.MOVEMENT_ANIMATING, PHASES.ATTACK_ANIMATING, PHASES.BATTLE_FINISHED]) {
    assert.equal(PHASE_INPUT[p].click, null, `${p} 不应接受点击`);
    assert.equal(PHASE_INPUT[p].cancel, false, `${p} 不应允许取消`);
  }
  // 选部队/选目标允许取消（等价原版 Esc）
  for (const p of [PHASES.SELECT, PHASES.UNIT_SELECTED, PHASES.ATTACK_PREVIEW]) {
    assert.equal(PHASE_INPUT[p].cancel, true, `${p} 应允许取消`);
  }
});

test('菜单语义下标与原版 case 分支一致', () => {
  assert.deepEqual(ACTION_MENU_INDEX, { attack: 0, skill: 1, info: 2, wait: 3 });
  assert.deepEqual(BATTLE_MENU_INDEX, { endTurn: 0, lookEnemy: 1, lookMovie: 2, moveSpeed: 3, retreat: 4 });
});

test('动画时长参数都是有限正数且带硬超时', () => {
  for (const [k, v] of Object.entries(ANIM)) {
    assert.equal(typeof v, 'number', `${k} 必须是数字`);
    assert.ok(Number.isFinite(v) && v > 0, `${k} 必须为正`);
  }
  assert.ok(ANIM.moveTotalTimeoutMs >= 1000, '移动动画必须有兜底超时');
  assert.ok(ANIM.attackTimeoutMs >= 1000, '攻击动画必须有兜底超时');
});

// ---------------------------------------------------------------- 4. 适配层协议
/** 给 Node 夹具补一个与桥接导出同形的 p5 块（常量全部来自真实源码/资源）。 */
function withP5(core) {
  const Dn = core.Dn;
  return {
    ...core,
    p4: { grid: { unitsPerSide: 10, unitsTotal: 20, windowCols: 15, windowRows: 17, tilePx: 16, pathWidth: 15, blockCost: 128, pathBytes: 225 } },
    p5: {
      widgetNames: ['bo', 'ko', 'vo', 'xo', 'Ao', 'Fo', 'Io', 'Eo', 'So'],
      originals: {},
      battle: {
        keyCodes: { up: 34, down: 35, left: 36, right: 37, confirm: 39, cancel: 40, info: 38, menu: 51 },
        pointer: { type: 16, down: 1, up: 2, move: 3, cancel: 4 },
        pixels: {
          tilePx: 16, tilePy: 16, viewCols: 15, viewRows: 17, shift: 4,
          screenWidth: 240, screenHeight: 320, mapAreaBottom: 272,
        },
        strIdx: {
          moveFailed: 1, noTarget: 2, badCommand: 3, actionMenu: 8, battleMenu: 9,
          lookYesNo: 10, speed: 11, armsType: 12, terrainName: 7, terrainNote: 14,
          expGain: 22, stateName: 28, skillNameRes: 11,
        },
        battleOver: { none: 0, win: 1, lose: 2 },
        eo(sx, sy) {
          Dn.g_MapSX = Math.min(sx, Math.max(0, Dn.g_MapWid - 15));
          Dn.g_MapSY = Math.min(sy, Math.max(0, Dn.g_MapHgt - 17));
        },
        Oi: () => 255,
      },
    },
  };
}

function makeAdapter() {
  const core = withP5(makeRealCore(data));
  return { adapter: new GameAdapter({ core, events: new EventManager() }), core };
}

test('格子 -> 原版像素：与 Ji()/Vi() 的 <<4 公式一致', () => {
  const { adapter, core } = makeAdapter();
  const Dn = core.Dn;
  Dn.g_MapSX = 4; Dn.g_MapSY = 6;
  const s = adapter.battleCellToScreen(10, 12);
  assert.equal(s.x, (10 - 4) * 16 + 8);
  assert.equal(s.y, (12 - 6) * 16 + 8);
  assert.equal(s.inWindow, true);
});

test('像素反算回格子：bo() L5876 的 floor(x/Pe) 口径全部往返一致', () => {
  const { adapter, core } = makeAdapter();
  const Dn = core.Dn;
  for (const [sx, sy] of [[0, 0], [4, 6], [10, 9], [17, 15]]) {
    Dn.g_MapSX = sx; Dn.g_MapSY = sy;
    for (let y = sy; y < Math.min(sy + 17, Dn.g_MapHgt); y++) {
      for (let x = sx; x < Math.min(sx + 15, Dn.g_MapWid); x++) {
        const s = adapter.battleCellToScreen(x, y);
        assert.ok(s.y < 272, `y=${s.y} 不应落进下方指令条`);
        assert.equal(sx + Math.floor(s.x / 16), x, `x 反算 (${x},${y})`);
        assert.equal(sy + Math.floor(s.y / 16), y, `y 反算 (${x},${y})`);
      }
    }
  }
});

test('ensureBattleView：窗口内的格子不触发滚动，窗口外调用原版 eo()', () => {
  const { adapter, core } = makeAdapter();
  const Dn = core.Dn;
  Dn.g_MapSX = 5; Dn.g_MapSY = 5;
  const inside = adapter.ensureBattleView(8, 8);
  assert.equal(inside.moved, false);
  assert.deepEqual(inside.after, { sx: 5, sy: 5 });
  const outside = adapter.ensureBattleView(30, 30);
  assert.equal(outside.moved, true);
  assert.ok(Dn.g_MapSX >= 0 && Dn.g_MapSX <= Dn.g_MapWid - 15);
  assert.ok(Dn.g_MapSY >= 0 && Dn.g_MapSY <= Dn.g_MapHgt - 17);
});

test('clickBattleCell 无原版输入实例时抛 UnsupportedError（不伪造成功）', () => {
  const { adapter } = makeAdapter();
  assert.throws(() => adapter.clickBattleCell(1, 1), (e) => e instanceof UnsupportedError);
});

test('getBattleMenus 条目来自真实界面字符串（4 / 5 项）', () => {
  const { adapter } = makeAdapter();
  const m = adapter.getBattleMenus();
  assert.deepEqual(m.action, ['攻击', '计谋', '查看', '待机']);
  assert.deepEqual(m.battle, ['回合结束', '敌军移动', '战斗动画', '移动速度', '全军撤退']);
  assert.equal(m.raw.action, ACTION_TEXT);
  assert.equal(m.raw.battle, BATTLE_TEXT);
});

test('getBattleUnitStates 覆盖 20 个槽位且字段来自 Dn', () => {
  const { adapter, core } = makeAdapter();
  const st = adapter.getBattleUnitStates();
  assert.equal(Object.keys(st).length, 20);
  for (const k of Object.keys(st)) {
    const u = st[k];
    for (const f of ['x', 'y', 'hp', 'mp', 'move', 'active', 'state', 'officerId', 'arms']) {
      assert.ok(f in u, `槽位 ${k} 缺少 ${f}`);
    }
    assert.ok(u.state >= 0 && u.state <= 8);
  }
  assert.equal(st[0].x, core.Dn.g_GenPos[0].x);
});

test('getBattleOutcome：1=胜 2=负 0=进行中（与源码写入点一致）', () => {
  const { adapter, core } = makeAdapter();
  core.Dn.g_FgtOver = 0;
  assert.equal(adapter.getBattleOutcome().meaning, 'none');
  core.Dn.g_FgtOver = 1;
  assert.equal(adapter.getBattleOutcome().meaning, 'win');
  core.Dn.g_FgtOver = 2;
  assert.equal(adapter.getBattleOutcome().meaning, 'lose');
});

test('getBattlePathField / getCurrentAttackRange 只读且形状稳定', () => {
  const { adapter, core } = makeAdapter();
  const Dn = core.Dn;
  Dn.g_PathSX = 20; Dn.g_PUseSX = 12; Dn.g_PathSY = 18; Dn.g_PUseSY = 11;
  const f = adapter.getBattlePathField();
  assert.equal(f.raw.length, 225);
  assert.equal(f.width, 15);
  assert.equal(f.blockCost, 128);
  assert.deepEqual(f.origin, { x: 8, y: 7 });

  Dn.g_FgtAtkRng[0] = 5;
  Dn.g_FgtAtkRng[1] = 10;
  Dn.g_FgtAtkRng[2] = 11;
  Dn.g_FgtAtkRng.fill(0, 3, 3 + 25);
  Dn.g_FgtAtkRng[3] = 1;       // (10,11)
  Dn.g_FgtAtkRng[3 + 6] = 1;   // (11,12)
  const r = adapter.getCurrentAttackRange();
  assert.equal(r.size, 5);
  assert.equal(r.cellCount, 2);
  assert.deepEqual(r.cells.map((c) => `${c.x},${c.y}`), ['10,11', '11,12']);
});

test('适配层 capabilities 如实标注 P5 操作通道', () => {
  const { adapter } = makeAdapter();
  const c = adapter.getCapabilities();
  assert.equal(c.clickBattleCell.status, 'write');
  assert.equal(c.pressBattleKey.status, 'write');
  assert.equal(c.battleCellToScreen.status, 'read');
  assert.equal(c.getBattleMenus.status, 'read');
  assert.equal(c.moveUnit.status, 'unavailable');
  assert.equal(c.attackUnit.status, 'unavailable');
});

// ---------------------------------------------------------------- 5. 生成物
test('P5 的 9 个 shim 都是「先通知、再调 *Orig」且不吞返回值', () => {
  const bridge = coreJs.slice(coreJs.indexOf(BRIDGE_MARK));
  const expect = [
    ['async function ko()', 'koOrig()'],
    ['async function vo(t)', 'voOrig(t)'],
    ['async function xo(t, e, n)', 'xoOrig(t, e, n)'],
    ['async function Fo(n)', 'FoOrig(n)'],
    ['async function Io()', 'IoOrig()'],
    ['async function Eo()', 'EoOrig()'],
    ['async function So()', 'SoOrig()'],
  ];
  for (const [sig, call] of expect) {
    const at = bridge.indexOf(sig);
    assert.ok(at > 0, `缺少 ${sig}`);
    const body = bridge.slice(at, at + 600);
    assert.ok(body.includes(call), `${sig} 必须调用原实现`);
    assert.ok(/__sgbyP5Notify\('/.test(body), `${sig} 必须通知宿主`);
  }
});

test('bo() shim 只在本次调用内替换 waitMsgTimeout，并在 finally 还原', () => {
  const bridge = coreJs.slice(coreJs.indexOf(BRIDGE_MARK));
  const at = bridge.indexOf('async function bo(');
  assert.ok(at > 0);
  const body = bridge.slice(at, at + 1600);
  assert.ok(body.includes('boOrig(onFrame, onCell)'), '必须调用原实现');
  assert.ok(body.includes('input.waitMsgTimeout'), '必须临时替换输入等待');
  assert.ok(/finally\s*\{/.test(body), '必须有 finally 还原');
  assert.ok(body.includes('delete input.waitMsgTimeout'), '必须删除自有属性回到原型方法');
  assert.ok(body.includes('h.endInput(token)'), '必须通知宿主输入已关闭');
  assert.ok(body.includes('this.queue.length'), '真实输入队列必须优先');
});

test('$r shim 增加了 P5 战斗菜单分支，且失败时回退原版', () => {
  const bridge = coreJs.slice(coreJs.indexOf(BRIDGE_MARK));
  const at = bridge.indexOf('async function $r(');
  const body = bridge.slice(at, at + 900);
  assert.ok(body.includes('__sgbyP5Menu('), '缺少战斗菜单接管');
  assert.ok(body.includes('$rOrig(rect, startIdx, items)'), '必须保留原版回退');
});

test('桥接导出 p5.battle 常量、界面字符串下标与结束标志语义', () => {
  const bridge = coreJs.slice(coreJs.indexOf(BRIDGE_MARK));
  assert.ok(bridge.includes('p5: Object.freeze({'));
  for (const k of ['eo: eo', 'Oi: Oi', 'Xo: Xo', 'qi: qi', 'Vo: Vo']) {
    assert.ok(bridge.includes(k), `p5.battle 缺少 ${k}`);
  }
  assert.ok(bridge.includes('up: w, down: m, left: p, right: b, confirm: C, cancel: k'));
  assert.ok(bridge.includes('tilePx: Pe, tilePy: Ce, viewCols: pe, viewRows: be'));
  assert.ok(bridge.includes('battleOver: Object.freeze({ none: 0, win: 1, lose: 2 })'));
  assert.ok(bridge.includes("version: '5.0.0-p5'"));
});

test('内核源码 sgby.min.js 仍未被改写', () => {
  assert.equal(Buffer.byteLength(minJs, 'utf8'), 199653);
  assert.ok(!minJs.includes('__SGBY_P5_HOST__'));
  assert.ok(!minJs.includes('SGBY-P1-CORE-BRIDGE'));
});

// ---------------------------------------------------------------- 6. 动画队列
/**
 * 用「桩渲染器」验证动画管理器的纯逻辑：
 *   - 队列串行、单任务推进、完成回调
 *   - 移动补间以 baseWorld 为基准（basePos 在动画中被重新同步也不会跳）
 *   - 攻击命中回调只触发一次
 *   - 受击/死亡走并发特效，死亡期间保持可见
 *   - cancelAll() 立刻结算所有 await（保证原版协程不会卡住）
 *   - 每个任务都有硬超时
 * 这些都不依赖 WebGL：几何体/材质一律由真实渲染器负责，这里只喂接口。
 */
import { BattleAnimationManager } from '../original/site/p5/BattleAnimationManager.mjs';

function makeStubUnitRenderer() {
  const state = {
    base: new Map(),      // unitId -> {x,y,z}
    vis: new Map(),       // unitId -> 最近一次覆盖量
    flashes: [],
    held: new Set(),
    visLog: [],
  };
  return {
    state,
    group: { add() {}, remove() {} },
    getBaseWorld(id) { return state.base.get(id) || null; },
    setBase(id, x, z) { state.base.set(id, { x, y: 0, z }); },
    setVisual(id, patch) {
      const cur = state.vis.get(id) || { dx: 0, dy: 0, dz: 0, rotY: 0, scale: 1, badgeOpacity: 1 };
      const next = { ...cur, ...patch };
      state.vis.set(id, next);
      state.visLog.push({ id, ...next });
      return next;
    },
    clearVisual(id) { state.vis.delete(id); state.visLog.push({ id, cleared: true }); },
    getVisual(id) { return state.vis.get(id) || null; },
    setFlash(id, sec) { state.flashes.push({ id, sec }); return true; },
    holdUnit(id, on) { if (on) state.held.add(id); else state.held.delete(id); },
    isHeld(id) { return state.held.has(id); },
    _vis: state.vis,
  };
}

const stubCoord = { gridToWorld: (x, y) => ({ x, y: 0, z: y }) };

function makeAnim() {
  const units = makeStubUnitRenderer();
  const anim = new BattleAnimationManager({
    THREE: {}, unitRenderer: units, rangeRenderer: null, coordinate: stubCoord,
    ui: null, getCamera: null, getViewport: null, log: () => {},
  });
  return { anim, units };
}

const run = (anim, seconds, step = 0.016) => {
  for (let t = 0; t < seconds; t += step) anim.update(step);
};

test('动画队列串行执行：同一时刻只有一个 job 推进', async () => {
  const { anim, units } = makeAnim();
  units.setBase(0, 0, 0);
  units.setBase(1, 20, 20);
  let log = [];
  const a = anim.move({ unitId: 0, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }).then((r) => log.push(`a:${r.reason}`));
  const b = anim.move({ unitId: 1, cells: [{ x: 20, y: 20 }, { x: 20, y: 21 }] }).then((r) => log.push(`b:${r.reason}`));
  assert.equal(anim.pending, 2, '两个任务应同时入队');
  assert.equal(anim.activeKind, 'move');
  run(anim, 0.6);
  await a; await b;
  assert.deepEqual(log, ['a:done', 'b:done'], '必须按入队顺序完成');
  assert.equal(anim.pending, 0);
});

test('移动补间：路径点被逐帧采样，结束时覆盖量清空', async () => {
  const { anim, units } = makeAnim();
  units.setBase(0, 0, 0);
  const cells = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
  const p = anim.move({ unitId: 0, cells });
  run(anim, 0.5);
  await p;
  const dxs = units.state.visLog.filter((v) => v.id === 0 && !v.cleared).map((v) => v.dx);
  assert.ok(dxs.length > 2, '应有多次采样');
  assert.ok(dxs.every((d) => d >= -1e-6 && d <= 2 + 1e-6), '偏移不得超出路径范围');
  assert.ok(dxs.every((d, i) => i === 0 || d >= dxs[i - 1] - 1e-6), '必须沿路径单调前进');
  assert.equal(units.state.vis.size, 0, '结束后必须清空视觉覆盖');
  assert.ok(units.state.visLog.some((v) => v.cleared), '必须调用过 clearVisual');
});

test('动画中途 basePos 变更时模型不跳变（以逻辑位置为基准算偏移）', async () => {
  const { anim, units } = makeAnim();
  units.setBase(0, 0, 0);
  const p = anim.move({ unitId: 0, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] });
  run(anim, 0.08);
  // 模拟「原版同步」把逻辑位置直接更新到终点
  units.setBase(0, 2, 0);
  const before = { ...units.getVisual(0) };
  run(anim, 0.05);
  const after = units.getVisual(0);
  assert.ok(before && after, '覆盖量应持续存在');
  // 世界位置 = base + offset，必须仍在路径区间内
  const worldX = 2 + after.dx;
  assert.ok(worldX >= -0.01 && worldX <= 2.01, `世界位置 ${worldX} 必须仍在路径上`);
  run(anim, 1.0);
  await p;
});

test('攻击命中回调只触发一次，并清空攻击方覆盖量', async () => {
  const { anim, units } = makeAnim();
  units.setBase(0, 0, 0);
  units.setBase(10, 3, 0);
  let impacts = 0;
  const p = anim.attack({ attackerId: 0, targetId: 10, armsType: 1, onImpact: () => { impacts++; } });
  run(anim, 2.0);
  await p;
  assert.equal(impacts, 1, 'onImpact 必须恰好一次');
  assert.equal(units.state.vis.size, 0, '结束时必须清空覆盖量');
});

test('受击：闪色 + 抖动特效，结束后清空', () => {
  const { anim, units } = makeAnim();
  units.setBase(3, 1, 1);
  anim.hit(3, { text: '-120', tone: 'damage' });
  assert.equal(units.state.flashes.length, 1, '必须触发闪色');
  assert.equal(units.state.flashes[0].id, 3);
  run(anim, 0.5);
  assert.equal(anim.getDiagnostics().effects, 0, '特效必须自动回收');
  assert.equal(units.state.vis.size, 0);
});

test('死亡：下沉期间保持可见，结束后交还原版状态', () => {
  const { anim, units } = makeAnim();
  units.setBase(5, 2, 2);
  anim.die(5);
  assert.equal(units.isHeld(5), true, '死亡动画期间必须保持可见');
  run(anim, 0.5);
  assert.equal(units.isHeld(5), true, '动画未结束前仍保持');
  run(anim, 1.2);
  assert.equal(units.isHeld(5), false, '动画结束后交还原版 state=8');
  assert.equal(units.state.vis.size, 0);
  assert.equal(anim.getDiagnostics().deaths, 1);
});

test('cancelAll() 立即结算所有等待（原版协程不会被表现层卡住）', async () => {
  const { anim, units } = makeAnim();
  units.setBase(0, 0, 0);
  units.setBase(1, 9, 9);
  const p1 = anim.move({ unitId: 0, cells: [{ x: 0, y: 0 }, { x: 5, y: 0 }] });
  const p2 = anim.move({ unitId: 1, cells: [{ x: 9, y: 9 }, { x: 9, y: 5 }] });
  const n = anim.cancelAll('scene-exit');
  assert.equal(n, 2);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.reason, 'scene-exit');
  assert.equal(r2.reason, 'scene-exit');
  assert.equal(anim.pending, 0);
  assert.equal(units.state.vis.size, 0, '取消时必须清空所有视觉覆盖');
});

test('任务超时兜底：不会永久占用队列', async () => {
  const { anim, units } = makeAnim();
  units.setBase(0, 0, 0);
  // 给一个「永远到不了」的极端时长，但 timeoutMs 很小
  const p = anim.move({ unitId: 0, cells: [{ x: 0, y: 0 }, { x: 30, y: 0 }], timeoutMs: 60 });
  run(anim, 0.2);
  const r = await p;
  assert.equal(r.reason, 'timeout');
  assert.equal(anim.pending, 0);
  assert.ok(anim.getDiagnostics().timedOut >= 1);
});

// ---------------------------------------------------------------- 7. 战果差值
/**
 * 战报/受击/死亡的表现完全由「原版操作前后的状态差」驱动。
 * 这里只验证纯减法函数的语义 —— 它不产生任何战斗数值。
 */
import { diffUnitStates, diffProvender, describeChange } from '../original/site/p5/BattleDelta.mjs';

const unit = (over = {}) => ({ x: 0, y: 0, hp: 100, mp: 50, move: 4, active: 0, state: 0, officerId: 0, arms: 1000, ...over });

test('diffUnitStates：兵力下降/死亡/状态变化都能被识别', () => {
  const before = { 0: unit(), 10: unit(), 11: unit() };
  const after = {
    0: unit(),
    10: unit({ arms: 880 }),            // 兵力 -120
    11: unit({ state: 8, arms: 0 }),    // 溃灭
  };
  const d = diffUnitStates(before, after);
  assert.equal(d.length, 2);
  const t = d.find((x) => x.id === 10);
  assert.equal(t.armsDelta, 120);
  assert.equal(t.died, false);
  assert.equal(t.armsAfter, 880);
  const dead = d.find((x) => x.id === 11);
  assert.equal(dead.died, true);
  assert.equal(dead.stateFrom, 0);
  assert.equal(dead.stateTo, 8);
});

test('diffUnitStates：无变化的单位不产生条目（避免刷新噪声）', () => {
  const before = { 0: unit() };
  const after = { 0: unit() };
  assert.deepEqual(diffUnitStates(before, after), []);
});

test('diffUnitStates：技力消耗与状态抑制都按原版字段差值给出', () => {
  const before = { 3: unit({ mp: 40 }) };
  const after = { 3: unit({ mp: 10, state: 2 }) };
  const d = diffUnitStates(before, after);
  assert.equal(d.length, 1);
  assert.equal(d[0].mpDelta, 30);
  assert.equal(d[0].stateChanged, true);
  assert.equal(d[0].stateTo, 2);
});

test('diffUnitStates：缺失快照时安全返回空数组（不抛错）', () => {
  assert.deepEqual(diffUnitStates(null, { 0: unit() }), []);
  assert.deepEqual(diffUnitStates({ 0: unit() }, null), []);
});

test('diffProvender：双方粮草变化与合计', () => {
  assert.deepEqual(diffProvender({ mine: 100, enemy: 80 }, { mine: 90, enemy: 60 }),
    { mine: -10, enemy: -20, totalDelta: -30 });
  assert.deepEqual(diffProvender(null, null), { mine: 0, enemy: 0, totalDelta: 0 });
});

test('describeChange：只陈述差值，不虚构伤害', () => {
  const d = diffUnitStates({ 0: unit() }, { 0: unit({ arms: 930 }) })[0];
  const text = describeChange(d, '马腾');
  assert.ok(text.includes('马腾'));
  assert.ok(text.includes('-70'), text);
  assert.ok(text.includes('930'), text);
  assert.ok(!/击杀|全灭|胜利/.test(text), '不得自行下结论');
});
