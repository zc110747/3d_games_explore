/**
 * P4 Node 测试 —— 全部断言基于 original/site/assets/game.zip 的真实数据
 * 与真实生成物 sgby.core.js，不使用任何模拟战斗数据。
 *
 * 覆盖：
 *   1) 7 张战斗地图的结构（32x32 / 1024 格 / 城池格唯一 / 图块号在图集范围内）
 *   2) 原版战斗图块资源（资源 4，46 帧 16x16）
 *   3) 战斗网格协议常量与源码一致
 *   4) 32x32 坐标往返（含按真实地图宽高重配）
 *   5) 地形短名与界面字符串 [7] 一致
 *   6) 内核生成物：9 处改名可逆还原 == 原文（业务代码零改写）、9 个 shim、p4 导出
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openZip } from './zip-lite.mjs';
import { CoordinateSystem } from '../original/site/p1/core/CoordinateSystem.mjs';
import { BattleCoordinateSystem } from '../original/site/p4/BattleCoordinateSystem.mjs';
import {
  BATTLE_PROTOCOL, TERRAIN_STYLE, UNIT_STYLE, BATTLE_CAMERA_CONFIG, RANGE_STYLE,
} from '../original/site/p4/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SITE = path.join(ROOT, 'original', 'site');
const ZIP = path.join(SITE, 'assets', 'game.zip');

const zip = openZip(ZIP);
const strings = zip.readJson('strings.json');
const manifest = zip.readJson('manifest.json');
const maps = [1, 2, 3, 4, 5, 6, 7].map((i) => ({
  id: 110 + i - 1,
  name: `战斗地图${i}`,
  json: zip.readJson(`struct/战斗地图${i}.json`),
}));

test('战斗地图 1..7 均为 32x32、1024 格（与 yo() 读取的头部一致）', () => {
  for (const m of maps) {
    const head = m.json['头部'];
    assert.equal(head[0], 32, `${m.name} 宽`);
    assert.equal(head[2], 32, `${m.name} 高`);
    assert.equal(head.length, 16, `${m.name} 头部应为 16 字节`);
    const grid = m.json['图块'];
    assert.equal(grid.length, head[2], `${m.name} 行数`);
    for (const row of grid) assert.equal(row.length, head[0], `${m.name} 列数`);
    const flat = grid.flat();
    assert.equal(flat.length, head[0] * head[2], `${m.name} 格子数`);
  }
});

test('每张地图恰好 1 个城池格（raw=3）：yo() 靠它定位 g_CityX/Y', () => {
  for (const m of maps) {
    const flat = m.json['图块'].flat();
    const city = flat.filter((v) => v === 3);
    assert.equal(city.length, 1, `${m.name} 城池格数量`);
  }
});

test('地图图块号全部落在原版图集帧范围内（0..45）', () => {
  const frames = manifest.resources['4'].pics;
  assert.equal(frames, 46, '资源 4 帧数');
  for (const m of maps) {
    const flat = m.json['图块'].flat();
    const bad = flat.filter((v) => !Number.isInteger(v) || v < 0 || v >= frames);
    assert.equal(bad.length, 0, `${m.name} 越界图块号 ${bad.slice(0, 5).join(',')}`);
  }
});

test('资源 4 = 战斗地图图块：46 帧 16x16（yo() 把 g_TileId 置为 4）', () => {
  const r = manifest.resources['4'];
  assert.equal(r.name, '战斗地图图块');
  assert.equal(r.type, 'pic');
  assert.equal(r.wid, 16);
  assert.equal(r.hig, 16);
  assert.equal(r.pics, 46);
});

test('战斗网格协议与源码常量一致（_e/we/pe/be/Pe/ke/Me）', () => {
  assert.equal(BATTLE_PROTOCOL.unitsPerSide, 10);
  assert.equal(BATTLE_PROTOCOL.unitsTotal, 20);
  assert.equal(BATTLE_PROTOCOL.windowCols, 15);
  assert.equal(BATTLE_PROTOCOL.windowRows, 17);
  assert.equal(BATTLE_PROTOCOL.tilePx, 16);
  assert.equal(BATTLE_PROTOCOL.pathWidth, 15);
  assert.equal(BATTLE_PROTOCOL.blockCost, 128);
  assert.equal(BATTLE_PROTOCOL.tilePicId, 4);
  assert.equal(BATTLE_PROTOCOL.headerBytes, 16);
});

test('地形短名与界面字符串 [7] 逐项一致（8 类）', () => {
  const raw = String(strings['界面字符串'][6]);   // '草地平原山地森林村庄城池营寨河流'
  const names = [];
  for (let i = 0; i + 1 < raw.length; i += 2) names.push(raw.slice(i, i + 2));
  assert.deepEqual(names, TERRAIN_STYLE.map((t) => t.name));
  assert.equal(TERRAIN_STYLE.length, 8);
});

test('兵种颜色表覆盖原版 6 个兵种（界面字符串 [12]）', () => {
  const raw = String(strings['界面字符串'][11]);  // 骑兵步兵弓兵水军极兵玄兵
  const arms = [];
  for (let i = 0; i + 1 < raw.length; i += 2) arms.push(raw.slice(i, i + 2));
  assert.equal(arms.length, 6);
  assert.ok(UNIT_STYLE.armsColors.length >= arms.length, '兵种颜色不足');
});

test('战斗相机固定斜 45° 且不允许旋转', () => {
  assert.equal(BATTLE_CAMERA_CONFIG.azimuthDeg, 45);
  assert.equal(BATTLE_CAMERA_CONFIG.elevationDeg, 45);
  assert.equal(BATTLE_CAMERA_CONFIG.projection, 'orthographic');
  assert.ok(BATTLE_CAMERA_CONFIG.maxZoom > BATTLE_CAMERA_CONFIG.minZoom);
  assert.ok(BATTLE_CAMERA_CONFIG.panLimit >= 16, '32x32 地图半幅 16，panLimit 需覆盖');
});

test('范围覆盖层容量覆盖 15x15 窗口与 5x5 攻击范围', () => {
  assert.ok(RANGE_STYLE.maxInstances >= 225);
  assert.ok(RANGE_STYLE.moveColor !== RANGE_STYLE.attackColor, '移动/攻击颜色必须可区分');
});

test('32x32 坐标往返：默认配置与按真实地图重配都成立', () => {
  const cs = new CoordinateSystem();
  const bc = new BattleCoordinateSystem(cs);

  for (const [x, y] of [[0, 0], [31, 31], [15, 8], [7, 23], [16, 16]]) {
    const w = bc.gridToWorld(x, y);
    const g = bc.worldToGrid(w.x, w.z);
    assert.equal(g.col, x);
    assert.equal(g.row, y);
    assert.ok(g.error <= 1e-9);
  }

  // 按每张真实地图的头部尺寸重配后仍可逆（P4 不写死 32）
  for (const m of maps) {
    const head = m.json['头部'];
    bc.configure(head[0], head[2]);
    const w = bc.gridToWorld(head[0] - 1, head[2] - 1);
    const g = bc.worldToGrid(w.x, w.z);
    assert.equal(g.col, head[0] - 1);
    assert.equal(g.row, head[2] - 1);
    assert.equal(g.inBounds, true);
  }
});

test('地图边缘外坐标不落在战斗格内', () => {
  const bc = new BattleCoordinateSystem(new CoordinateSystem());
  bc.configure(32, 32);
  const corner = bc.gridToWorld(31, 31);
  const outside = bc.worldToGrid(corner.x + 1.2, corner.z + 1.2);
  assert.equal(outside.inBounds, false);
});

// ---------------------------------------------------------------- 内核生成物
const minJs = fs.readFileSync(path.join(SITE, 'sgby.min.js'), 'utf8');
const coreJs = fs.readFileSync(path.join(SITE, 'sgby.core.js'), 'utf8');
const BRIDGE_MARK = '/* === SGBY-P1-CORE-BRIDGE START';

test('sgby.core.js 业务代码零改写：18 处改名可逆还原后与 sgby.min.js 逐字节一致', () => {
  const at = coreJs.indexOf(BRIDGE_MARK);
  assert.ok(at > 0, '缺少桥接段标记');
  let body = coreJs.slice(0, at);
  const names = ['$r', 'Ls', 'Ms', 'vs', 'Hs', 'Gs', 'ka', 'yo', 'Uo',
    'bo', 'ko', 'vo', 'xo', 'Ao', 'Fo', 'Io', 'Eo', 'So'];   // 后 9 个为 P5 追加
  for (const n of names) body = body.split(`${n}Orig(`).join(`${n}(`);
  assert.equal(body.trimEnd(), minJs.trimEnd(), '还原后应与原文完全一致');
});

test('桥接段声明 18 个同名 shim（含 P4 的 yo/Uo 与 P5 的 9 个操作协程）', () => {
  const bridge = coreJs.slice(coreJs.indexOf(BRIDGE_MARK));
  for (const sig of [
    'async function $r(', 'async function Ls(', 'async function Ms(', 'async function vs(',
    'async function Hs(', 'async function Gs(', 'async function ka(',
    'async function yo()', 'async function Uo()',
    'async function bo(', 'async function ko()', 'async function vo(', 'async function xo(',
    'async function Ao(', 'async function Fo(', 'async function Io()', 'async function Eo()',
    'async function So()',
  ]) {
    assert.ok(bridge.includes(sig), `桥接段缺少 ${sig}`);
  }
  assert.ok(bridge.includes('__SGBY_P4_HOST__'), '缺少 P4 宿主查找');
  assert.ok(bridge.includes("__sgbyP4Kernel('ready')"), 'yo 结束应通知 ready');
  assert.ok(bridge.includes("__sgbyP4Kernel('enter')"), 'Uo 进入应通知 enter');
  assert.ok(bridge.includes("__sgbyP4Kernel('exit')"), 'Uo 结束应通知 exit');
});

test('桥接段导出 p4.battle 原版函数（qi/Vo/Ui/Ci/Xo）与网格常量', () => {
  const bridge = coreJs.slice(coreJs.indexOf(BRIDGE_MARK));
  assert.ok(bridge.includes('p4: Object.freeze({'));
  for (const k of ['qi: qi', 'Vo: Vo', 'Ui: Ui', 'Ci: Ci', 'Ii: Ii', 'Ei: Ei', 'Xo: Xo', 'vi: vi']) {
    assert.ok(bridge.includes(k), `p4.battle 缺少 ${k}`);
  }
  assert.ok(bridge.includes('unitsPerSide: _e'));
  assert.ok(bridge.includes('blockCost: Me'));
});

test('Uo shim 用 finally 保证战斗异常也会通知 exit', () => {
  const bridge = coreJs.slice(coreJs.indexOf(BRIDGE_MARK));
  const at = bridge.indexOf('async function Uo()');
  const body = bridge.slice(at, at + 400);
  assert.ok(/finally\s*\{/.test(body), 'Uo shim 缺少 finally');
  assert.ok(body.includes('UoOrig()'), 'Uo shim 必须调用原实现');
});

test('内核版本与导出点数量（18 处改名：P3 7 + P4 2 + P5 9）标注一致', () => {
  assert.ok(coreJs.includes("version: '5.0.0-p5'"), '版本未升级到 5.0.0-p5');
  assert.ok(coreJs.includes("widgetNames: Object.freeze(['$r', 'Ls', 'Ms', 'vs', 'Hs', 'Gs', 'ka'])"));
  assert.ok(coreJs.includes("widgetNames: Object.freeze(['yo', 'Uo'])"));
  assert.ok(coreJs.includes("widgetNames: Object.freeze([\n        'bo', 'ko', 'vo', 'xo', 'Ao', 'Fo', 'Io', 'Eo', 'So',\n      ])"));
});
