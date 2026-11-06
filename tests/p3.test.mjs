/**
 * P3 Node 侧一致性测试（不依赖浏览器）。
 *
 * 覆盖两类事实：
 *   A. 数据事实 —— 全部取自 original/site/assets/game.zip 与 sgby.min.js 原文，
 *      断言菜单结构 / 顺序 / 消耗、指令号常量、mi() 真实分支集合。
 *   B. 生成物事实 —— sgby.core.js 的 7 处改名 + 7 个 shim + actionIds 字面量，
 *      以及 CityUIAdapter 在「原版函数不可用」时的降级契约（绝不编数据）。
 *
 * 运行： node --test tests/p3.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRealData, makeRealCore } from './fixtures.mjs';
import { EventManager } from '../original/site/p1/core/EventManager.mjs';
import { GameAdapter } from '../original/site/p1/core/GameAdapter.mjs';
import { CityUIAdapter, ACTION_IDS } from '../original/site/p3/CityUIAdapter.mjs';
import { splitFixedWidth } from '../original/site/p3/CitySession.mjs';
import { MENU_CONST, ORIGINAL } from '../original/site/p3/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIN_JS = path.join(ROOT, 'original', 'site', 'sgby.min.js');
const CORE_JS = path.join(ROOT, 'original', 'site', 'sgby.core.js');

// ---------------------------------------------------------------- 源码分析工具
function skipString(s, i) {
  const q = s[i];
  for (let k = i + 1; k < s.length; k++) {
    if (s[k] === '\\') { k++; continue; }
    if (s[k] === q) return k;
  }
  return s.length - 1;
}

function extractFunctionBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `源码中找不到 ${signature}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(src, i); continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error('花括号未配平');
}

/** 从源码重新推导 mi() 的指令分支（与 tools/make_core.mjs 同算法，用于交叉校验）。 */
function deriveActionIds(src) {
  const body = extractFunctionBody(src, 'async function mi(t,e){');
  const consts = new Map();
  for (const m of src.matchAll(/[,;{]([A-Za-z_$][\w$]*)=(\d{1,3})(?=[,;])/g)) consts.set(m[1], Number(m[2]));
  const ids = new Set();
  for (const m of body.matchAll(/case\s+(\d+)\s*:/g)) {
    const v = Number(m[1]);
    if (v >= 1 && v <= 27) ids.add(v);
  }
  for (const m of body.matchAll(/case\s+([A-Za-z_$][\w$]*)\s*:/g)) {
    const v = consts.get(m[1]);
    if (v !== undefined && v >= 1 && v <= 27) ids.add(v);
  }
  return [...ids].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- 夹具
const data = loadRealData();
const core = makeRealCore(data);
const events = new EventManager();
const gameAdapter = new GameAdapter({ core, events });
const cityUI = new CityUIAdapter({ core, adapter: gameAdapter });

// ---------------------------------------------------------------- A. 数据事实
test('城市菜单：4 大类 + 14/5/5 项，顺序与原版 getConst 一致', () => {
  const acts = cityUI.getActionGroups();
  assert.equal(acts.main.length, 4);
  assert.deepEqual([...acts.main], ['内政', '外交', '军备', '状况']);
  assert.equal(acts.groups.length, 4);
  assert.deepEqual(acts.groups.slice(0, 3).map((g) => g.items.length), [14, 5, 5]);
  assert.equal(acts.groups[3].kind, 'info');
  assert.equal(acts.groups[3].name, '状况');
  assert.equal(acts.infoActionId, 254);
  assert.equal(acts.cancelCode, 255);
});

test('内政 14 项目名称逐项与原版字符串常量一致', () => {
  const items = cityUI.getActionGroups().groups[0].items;
  assert.deepEqual(items.map((i) => i.name), [
    '开垦', '招商', '搜寻', '治理', '出巡', '招降', '处斩',
    '流放', '赏赐', '没收', '交易', '宴请', '输送', '移动',
  ]);
  assert.deepEqual(items.map((i) => i.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
});

test('外交 / 军备条目名称与原版一致，指令号连续', () => {
  const [dip, mil] = cityUI.getActionGroups().groups.slice(1, 3);
  assert.deepEqual(dip.items.map((i) => i.name), ['离间', '招揽', '策反', '反间', '劝降']);
  assert.deepEqual(dip.items.map((i) => i.id), [15, 16, 17, 18, 19]);
  assert.deepEqual(mil.items.map((i) => i.name), ['侦察', '征兵', '分配', '掠夺', '出征']);
  assert.deepEqual(mil.items.map((i) => i.id), [23, 24, 25, 26, 27]);
});

test('指令消耗来自原版 getItem(2,10)/getItem(2,11)（体力/金钱）', () => {
  const items = cityUI.getActionGroups().groups[0].items;
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal(byName['开垦'].costThew, 8);
  assert.equal(byName['开垦'].costMoney, 50);
  assert.equal(byName['招降'].costThew, 15);
  assert.equal(byName['招降'].costMoney, 100);
  // 交易 体力 12、金钱 0（原版表 Ge[11]=0）
  assert.equal(byName['交易'].costThew, 12);
  assert.equal(byName['交易'].costMoney, 0);
});

test('原版常量：Ke=13 输送 / Ne=14 移动 / qe=15 离间 / Ze=24 征兵 / tn=27 出征', () => {
  const src = fs.readFileSync(MIN_JS, 'utf8');
  for (const [name, value] of [['Ke', 13], ['Ne', 14], ['qe', 15], ['ze', 16],
    ['He', 17], ['Je', 19], ['Ve', 23], ['Ze', 24], ['tn', 27]]) {
    assert.match(src, new RegExp(`[,;{]${name}=${value}(?=[,;])`), `${name} 应等于 ${value}`);
  }
  assert.equal(ORIGINAL.cancelCode, 255);
  assert.equal(ORIGINAL.valueCancel, 65535);
  assert.equal(ORIGINAL.cityCount, 38);
});

test('mi() 真实分支 23 个，缺 18（反间），与 ACTION_IDS 完全一致', () => {
  const derived = deriveActionIds(fs.readFileSync(MIN_JS, 'utf8'));
  assert.deepEqual(derived, [...ACTION_IDS]);
  assert.equal(derived.length, 23);
  assert.ok(!derived.includes(18), '18 反间 在原版 mi() 中无分支');
  for (const id of [1, 6, 12, 13, 17, 25, 27]) assert.ok(derived.includes(id), `缺少指令 ${id}`);
});

test('hasBranch() 如实反映原版：24 个菜单项中 1 项无实现', () => {
  const items = cityUI.getActionGroups().groups.flatMap((g) => g.items);
  assert.equal(items.length, 24);
  const missing = items.filter((i) => !cityUI.hasBranch(i.id));
  assert.deepEqual(missing.map((i) => `${i.id}:${i.name}`), ['18:反间']);
});

test('getConst 下标常量正确（37 大类 / 38-40 子菜单）', () => {
  const lib = core.lib;
  assert.equal(splitFixedWidth(lib.getConst(MENU_CONST.main)).length, 4);
  assert.deepEqual(MENU_CONST.sub.map((k) => splitFixedWidth(lib.getConst(k)).length), [14, 5, 5]);
});

test('splitFixedWidth 只做 2 字定宽切分，不改内容', () => {
  assert.deepEqual(splitFixedWidth('买入卖出'), ['买入', '卖出']);
  assert.deepEqual(splitFixedWidth('内政外交军备状况'), ['内政', '外交', '军备', '状况']);
  assert.deepEqual(splitFixedWidth(''), []);
});

test('真实城市数据仍是 38 城 / 200 将（P0 基线）', () => {
  assert.equal(core.Dn.g_Cities.length, 38);
  assert.equal(core.Dn.g_Persons.length, 200);
  assert.equal(cityUI.cityName(0), '西凉');
  assert.equal(cityUI.playerKingId(), 0);
  // 归属名称 = 该城 Belong 对应的君主武将名（Belong = 武将 index + 1）
  const belong = core.Dn.g_Cities[0].Belong;
  assert.ok(belong > 0);
  assert.equal(cityUI.ownerName(belong), cityUI.officerName(belong - 1));
  assert.equal(cityUI.officerName(0), '董卓');
});

// ---------------------------------------------------------------- B. 生成物事实
test('sgby.core.js = min.js + 18 处改名 + 桥接；18 个 shim 与 18 个 *Orig 都在', () => {
  const min = fs.readFileSync(MIN_JS, 'utf8');
  const out = fs.readFileSync(CORE_JS, 'utf8');
  const at = out.indexOf('/* === SGBY-P1-CORE-BRIDGE START');
  assert.ok(at > 0, '缺少桥接段');

  const names = [
    ['async function $rOrig(t,e,n){', 'async function $r(t,e,n){'],
    ['async function LsOrig(t,e,n,r,s,i,st){', 'async function Ls(t,e,n,r,s,i,st){'],
    ['async function MsOrig(t){', 'async function Ms(t){'],
    ['async function vsOrig(t,e){', 'async function vs(t,e){'],
    ['async function HsOrig(t,e,n){', 'async function Hs(t,e,n){'],
    ['async function GsOrig(t){', 'async function Gs(t){'],
    ['async function kaOrig(){', 'async function ka(){'],
    // P4 追加：战斗初始化 / 整场战斗（只通知表现层，不改返回值）
    ['async function yoOrig(){', 'async function yo(){'],
    ['async function UoOrig(){', 'async function Uo(){'],
    // P5 追加：战斗输入循环与操作协程（只通知 + 转发输入，不改任何判定）
    ['async function boOrig(t,e=null){', 'async function bo(t,e=null){'],
    ['async function koOrig(){', 'async function ko(){'],
    ['async function voOrig(t){', 'async function vo(t){'],
    ['async function xoOrig(t,e,n){', 'async function xo(t,e,n){'],
    ['async function AoOrig(t){', 'async function Ao(t){'],
    ['async function FoOrig(n){', 'async function Fo(n){'],
    ['async function IoOrig(){', 'async function Io(){'],
    ['async function EoOrig(){', 'async function Eo(){'],
    ['async function SoOrig(){', 'async function So(){'],
  ];
  // 前缀还原后必须与原文逐字节一致
  let restored = out.slice(0, at);
  for (const [renamed, original] of names) {
    assert.equal(restored.split(renamed).length - 1, 1, `${renamed} 应恰好出现一次`);
    restored = restored.split(renamed).join(original);
  }
  assert.equal(restored.replace(/\s+$/, ''), min.replace(/\s+$/, ''));

  // 桥接段必须声明 7 个同名 shim（形参名可与原文不同，函数名必须一致）
  const bridge = out.slice(at);
  for (const [, original] of names) {
    const fn = /^async function ([^\s(]+)/.exec(original)[1];
    assert.ok(new RegExp(`async function ${fn.replace('$', '\\$')}\\s*\\(`).test(bridge),
      `桥接段缺少 shim：${fn}`);
  }
  assert.ok(bridge.includes('__SGBY_P3_HOST__'));
  assert.ok(bridge.includes('actionIds: Object.freeze(['));
});

test('桥接的 actionIds 字面量与源码推导一致', () => {
  const out = fs.readFileSync(CORE_JS, 'utf8');
  const m = /actionIds: Object\.freeze\(\[([0-9,]*)\]\)/.exec(out);
  assert.ok(m, '未找到 actionIds 字面量');
  const ids = m[1].split(',').filter(Boolean).map(Number);
  assert.deepEqual(ids, deriveActionIds(fs.readFileSync(MIN_JS, 'utf8')));
});

test('原版 sgby.min.js 从未被改写（sha1 与 P2 记录一致）', () => {
  const buf = fs.readFileSync(MIN_JS);
  assert.equal(buf.length, 199653);
  // sha1 不写死在断言里（避免升级时误报），改为校验「仍是单文件模块 + 保留上游标记」
  const src = buf.toString('utf8');
  assert.ok(src.includes('SGBY-EXIT'));
  assert.ok(!src.includes('SGBY-P1-CORE-BRIDGE'));
  assert.ok(!src.includes('__SGBY_P3_HOST__'));
});

test('CityUIAdapter 在无原版函数时如实降级（不编造数据）', () => {
  assert.equal(cityUI.available, false);       // Node 夹具没有 ss/Bs/Ys/Is
  const report = cityUI.getCityReport(0);
  assert.equal(report.degraded, true);
  assert.ok(report.lines.length > 0);
  assert.equal(cityUI.officerIds(0).degraded, true);
  assert.deepEqual(cityUI.officerIds(0).ids, []);
  assert.equal(cityUI.getCityOfficers(0).degraded, true);
  assert.ok(cityUI.stats.degradedCalls >= 2);
  // 即便降级，也不抛异常、不返回假数据
  assert.equal(cityUI.officerName(0), '董卓');   // 走资源表兜底，仍是真实名字
});
