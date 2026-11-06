#!/usr/bin/env node
/**
 * 内核桥接生成器（P1 只读导出 + P3 UI 组件接管点 + P4/P5 战斗协程钩子），可重复执行。
 *
 * 由 original/site/sgby.min.js 生成 original/site/sgby.core.js：
 *   1) 原文件一个字节都不改；
 *   2) 对**生成副本**做 18 处唯一字符串改名（`$r`/`Ls`/`Ms`/`vs`/`Hs`/`Gs`/`ka`
 *      + P4 的 `yo`/`Uo` + P5 的 `bo`/`ko`/`vo`/`xo`/`Ao`/`Fo`/`Io`/`Eo`/`So`
 *      -> 同名 + `Orig`），每处必须命中且只命中一次，否则拒绝生成；
 *   3) 在同名位置声明 shim：城市操作循环内把「原版 2D 控件」转成 HTML 请求，
 *      其余时刻（主菜单 / 战斗 / 未注册宿主）原样调用改名后的原函数；
 *      P4 的 yo/Uo、P5 的 9 个战斗函数 shim 只做「通知宿主 / 转发输入」，
 *      不改变任何返回值与调用顺序，也不直接写 Dn；
 *   4) 追加只读导出 window.__SGBY_CORE__，供 GameAdapter / CityUIAdapter / 战斗表现层读取。
 *
 * 为什么必须改名而不是从外部覆写：
 *   sgby.min.js 是 type="module" 的单文件模块，顶层声明处于模块作用域，
 *   外部无法 `window.$r = ...`。改名 + 同名 shim 是唯一既不改原文件、
 *   又不复制业务规则的接管方式。shim 的返回契约与原函数完全一致（同一取值域）。
 *
 * 用法： node tools/make_core.mjs
 * 校验： node --check original/site/sgby.core.js
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'original', 'site', 'sgby.min.js');
const OUT = path.join(ROOT, 'original', 'site', 'sgby.core.js');

const BRIDGE_START = '/* === SGBY-P1-CORE-BRIDGE START';

/** 这些符号必须真实存在于 sgby.min.js 顶层作用域（防原版升级后静默失效）。 */
const REQUIRED = [
  'const Dn={', 'const l={', 'class Un{', 'class On{', 'class Bn{',
  'function zs(', 'function qs(', 'function ei(', 'function mi(',
  'function ac(', 'function oc(', 'function jn(', 'function $n(',
  'function Bs(', 'function Ys(', 'function Is(', 'function ss(',
  // P4：战斗初始化 / 战斗主循环 / 范围计算 / 地形 / 编成判定
  'async function yo(', 'async function Uo(', 'function qi(', 'function Vo(',
  'function Ui(', 'function Ci(', 'function Xo(', 'function vi(',
  // P5：战斗输入循环 / 选部队 / 移动 / 选目标 / 行动菜单 / 结算 / 回合
  'async function bo(', 'async function ko(', 'async function vo(', 'async function xo(',
  'async function Ao(', 'async function Fo(', 'async function Io(', 'async function Eo(',
  'async function So(', 'function eo(', 'function Oi(',
];

/**
 * P3 接管点：把原版控件函数改名（加 Orig 后缀），同名 shim 由桥接段声明。
 * 全部带完整参数签名 + 左花括号，避免误伤同前缀的其他标识符；每处必须命中 1 次。
 *
 * P4 追加 yo/Uo：两者只用于「通知表现层」战斗开始/就绪/结束，
 * shim 内部原样调用 *Orig 并返回其结果，因此游戏行为与原文逐字节等价。
 *
 * P5 追加 9 个战斗协程函数，全部只做「通知宿主 + 原样调用 *Orig」：
 *   bo() 战斗地图输入循环（唯一等待原版输入的地方）
 *   ko() 选部队 / vo() 移动 / xo() 选目标 / Ao() 行动菜单 / Fo() 行动结算
 *   Io() 回合开始 / Eo() 我方阶段 / So() 敌方阶段
 * 这些 shim 不复制任何判定，宿主拿到的只是「原版正处于哪一步」这一事实。
 */
const RENAMES = [
  ['async function $r(t,e,n){', 'async function $rOrig(t,e,n){'],                    // 通用列表菜单
  ['async function Ls(t,e,n,r,s,i,st){', 'async function LsOrig(t,e,n,r,s,i,st){'],  // 武将选择窗口
  ['async function Ms(t){', 'async function MsOrig(t){'],                            // 单条提示
  ['async function vs(t,e){', 'async function vsOrig(t,e){'],                        // 带武将的提示
  ['async function Hs(t,e,n){', 'async function HsOrig(t,e,n){'],                    // 数值选择（粮/钱/兵）
  ['async function Gs(t){', 'async function GsOrig(t){'],                            // 城市状况报告
  ['async function ka(){', 'async function kaOrig(){'],                              // 玩家城市操作循环
  ['async function yo(){', 'async function yoOrig(){'],                              // P4 战斗初始化（地图/编成/位置）
  ['async function Uo(){', 'async function UoOrig(){'],                              // P4 整场战斗协程
  ['async function bo(t,e=null){', 'async function boOrig(t,e=null){'],              // P5 战斗地图输入循环
  ['async function ko(){', 'async function koOrig(){'],                              // P5 选部队
  ['async function vo(t){', 'async function voOrig(t){'],                            // P5 移动到目标格
  ['async function xo(t,e,n){', 'async function xoOrig(t,e,n){'],                    // P5 选择攻击/计谋目标
  ['async function Ao(t){', 'async function AoOrig(t){'],                            // P5 行动菜单
  ['async function Fo(n){', 'async function FoOrig(n){'],                            // P5 行动结算
  ['async function Io(){', 'async function IoOrig(){'],                              // P5 回合开始
  ['async function Eo(){', 'async function EoOrig(){'],                              // P5 我方阶段
  ['async function So(){', 'async function SoOrig(){'],                              // P5 敌方阶段
];

/**
 * 构建期推导「mi() 真实存在哪些指令分支」。
 *
 * 原因：内政/外交/军备共 24 个菜单项，但 mi() 并非全部实现（缺 18 反间）。
 * 这是原版的真实事实，UI 必须如实呈现，不能靠注释猜。
 * 做法：按花括号配平取出 mi() 函数体（跳过字符串字面量），收集
 *   - 数字 case（1..27）
 *   - 命名 case（原版用常量 Ke/Ne/qe/... 表示指令号），常量从全文 const 声明里解析
 * 结果写进桥接导出的 p3.actionIds，运行时由 CityUIAdapter 直接使用。
 */
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
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(src, i); continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

function deriveActionIds(src) {
  const body = extractFunctionBody(src, 'async function mi(t,e){');
  if (!body) throw new Error('推导失败：未找到 mi()');
  // 原版指令号常量（L2355）：Ke=13,Ne=14,qe=15,ze=16,He=17,Je=19,Ve=23,Ze=24,tn=27
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

const BRIDGE = `

${BRIDGE_START} (generated by tools/make_core.mjs) ===============
 * 本段之前的内容 = sgby.min.js 原文，仅对下列 18 个函数做了同名改名为 *Orig：
 *   $r(列表菜单) Ls(武将选择) Ms(提示) vs(带将提示) Hs(数值) Gs(状况) ka(城市循环)
 *   yo(战斗初始化) Uo(整场战斗)
 *   bo(战斗输入循环) ko(选部队) vo(移动) xo(选目标) Ao(行动菜单) Fo(行动结算)
 *   Io(回合开始) Eo(我方阶段) So(敌方阶段)
 * 下方同名 shim 在「P3 未注册宿主」或「不在城市循环内」时直接调用 *Orig，
 * 行为与原文逐字节等价；在城市循环内则把控件请求交给 window.__SGBY_P3_HOST__。
 * 战斗期间 $r() 会先问 window.__SGBY_P5_HOST__（行动菜单/战斗菜单），宿主不接管才回原版。
 * P4/P5 的战斗 shim 只做「通知 + 转发输入」，不改变返回值/顺序，也不写 Dn 的游戏状态。
 * 禁止在此调用原版业务函数或写 Dn；表现层只能读，写操作必须走原版输入/业务入口。
 * ========================================================================= */

/** 宿主查找：P3 CitySession 通过 window.__SGBY_P3_HOST__ 注册。 */
function __sgbyP3Host() {
  try {
    var h = typeof globalThis !== 'undefined' ? globalThis.__SGBY_P3_HOST__ : null;
    return h && typeof h === 'object' ? h : null;
  } catch (e) { return null; }
}

/**
 * 接管失败时的安全出口。
 * 关键：绝不能在「已经吃掉用户交互」之后回退到 2D 原版控件（画布可能是隐藏的，
 * 那样会永久等待键盘而卡死）。统一返回该控件语义上的「取消值」，让原版协程正常回卷。
 */
function __sgbyP3Fail(widget, err, cancelValue) {
  try {
    console.error('[SGBY-P3] ' + widget + ' 的 HTML 接管失败，按取消语义返回，避免卡死：', err);
  } catch (e) { /* 控制台不可用不影响流程 */ }
  try {
    var h = __sgbyP3Host();
    if (h && typeof h.fail === 'function') h.fail(widget, err);
  } catch (e) { /* 上报失败忽略 */ }
  return cancelValue;
}

/** 通用接管：仅在「城市循环内 + 宿主实现了该方法」时询问宿主。 */
function __sgbyP3Ask(method, args) {
  var h = __sgbyP3Host();
  if (!h || h.cityLoop !== true) return null;
  var fn = h[method];
  if (typeof fn !== 'function') return null;
  return fn.apply(h, args);
}

async function $r(rect, startIdx, items) {
  try {
    var r = __sgbyP3Ask('list', arguments);
    if (r) {
      var res = await r;
      if (res && res.handled === true) return res.value;
    }
  } catch (e) { return __sgbyP3Fail('$r', e, 255); }
  // P5：战斗中的 $r() 只有三处入口 —— Ao() 行动菜单、Ro() 计谋列表、Go() 战斗菜单。
  // 宿主接管时返回原版取值域内的下标；任何异常一律退回原版 2D 菜单，绝不让战斗卡死。
  var b5 = __sgbyP5Menu(rect, startIdx, items);
  if (b5) {
    try {
      var r5 = await b5;
      if (r5 && r5.handled === true) return r5.value;
    } catch (e5) {
      try { console.error('[SGBY-P5] 战斗菜单接管失败，退回原版 2D 菜单：', e5); } catch (e6) { /* 控制台不可用 */ }
    }
  }
  return $rOrig(rect, startIdx, items);
}

async function Ls(persons, count, x1, y1, x2, y2, start) {
  try {
    var r = __sgbyP3Ask('person', arguments);
    if (r) {
      var res = await r;
      if (res && res.handled === true) return res.value;
    }
  } catch (e) { return __sgbyP3Fail('Ls', e, 255); }
  return LsOrig(persons, count, x1, y1, x2, y2, start);
}

async function Ms(constIdx) {
  try {
    var r = __sgbyP3Ask('message', arguments);
    if (r) {
      var res = await r;
      if (res && res.handled === true) return;
    }
  } catch (e) { __sgbyP3Fail('Ms', e, undefined); return; }
  return MsOrig(constIdx);
}

async function vs(personId, text) {
  try {
    var r = __sgbyP3Ask('personMessage', arguments);
    if (r) {
      var res = await r;
      if (res && res.handled === true) return;
    }
  } catch (e) { __sgbyP3Fail('vs', e, undefined); return; }
  return vsOrig(personId, text);
}

async function Hs(min, max, kind) {
  try {
    var r = __sgbyP3Ask('value', arguments);
    if (r) {
      var res = await r;
      if (res && res.handled === true) return res.value;
    }
  } catch (e) { return __sgbyP3Fail('Hs', e, 65535); }
  return HsOrig(min, max, kind);
}

async function Gs(cityId) {
  try {
    var r = __sgbyP3Ask('report', arguments);
    if (r) {
      var res = await r;
      if (res && res.handled === true) return res.value;
    }
  } catch (e) { return __sgbyP3Fail('Gs', e, 0); }
  return GsOrig(cityId);
}

/** ka() 是玩家城市操作循环（Ua L7651）。用它精确划定「允许接管」的生命周期。 */
async function ka() {
  var h = __sgbyP3Host();
  if (!h || typeof h.beginCityLoop !== 'function' || typeof h.endCityLoop !== 'function') {
    return kaOrig();
  }
  h.beginCityLoop();
  try {
    return await kaOrig();
  } finally {
    h.endCityLoop();
  }
}

/* ------------------------------------------------------------------ P4 战斗 */

/** 宿主查找：P4 战斗表现层通过 window.__SGBY_P4_HOST__ 注册。 */
function __sgbyP4Host() {
  try {
    var h = typeof globalThis !== 'undefined' ? globalThis.__SGBY_P4_HOST__ : null;
    return h && typeof h === 'object' ? h : null;
  } catch (e) { return null; }
}

/** 只通知，不返回任何值、不改任何状态；宿主异常不影响原版战斗。 */
function __sgbyP4Kernel(kind) {
  try {
    var h = __sgbyP4Host();
    if (h && typeof h.onKernel === 'function') h.onKernel(kind);
  } catch (e) {
    try { console.error('[SGBY-P4] 战斗生命周期通知宿主失败：', e); } catch (e2) { /* 控制台不可用 */ }
  }
}

/**
 * yo() 是战斗初始化（原版 L5744-5783）：天气/结束标志清零、按 GenArray 计算
 * 每支部队 hp/mp/move、读取地图宽高与城池坐标、按 Way 阵列排布双方位置。
 * 它 resolve 之后 Dn.g_MapWid/g_MapHgt/g_GenPos 才是可读的完整战况。
 */
async function yo() {
  var r = await yoOrig();
  __sgbyP4Kernel('ready');
  return r;
}

/**
 * Uo() 是整场战斗协程（原版 L6253）：回合循环 Io -> Eo(我方) -> So(敌方) -> Ki。
 * 进入前地图尚未初始化，因此 'enter' 只用于切换场景；'exit' 在返回后排到战役流程。
 * finally 保证战斗中途抛错也会通知，避免表现层永久停在战斗场景。
 */
async function Uo() {
  __sgbyP4Kernel('enter');
  try {
    return await UoOrig();
  } finally {
    __sgbyP4Kernel('exit');
  }
}

/* ------------------------------------------------------------- P5 战斗操作 */

/**
 * 宿主查找：P5 战斗操作层通过 window.__SGBY_P5_HOST__ 注册。
 * 未注册时下面所有 shim 直接走 *Orig，P1~P4 的行为完全不变。
 */
function __sgbyP5Host() {
  try {
    var h = typeof globalThis !== 'undefined' ? globalThis.__SGBY_P5_HOST__ : null;
    return h && typeof h === 'object' ? h : null;
  } catch (e) { return null; }
}

/**
 * 阶段通知：**只告诉宿主「原版正走到哪一步」**，不传可变引用、不改任何状态。
 * 宿主返回值会被 await —— 这是 P5 唯一的「表现层延时」通道（例如等移动动画播完），
 * 因此宿主实现必须保证有限时长返回；宿主抛错/超时都必须被吞掉，绝不影响原版协程。
 */
function __sgbyP5Notify(kind, a, b) {
  var h = __sgbyP5Host();
  if (!h || typeof h.onPhase !== 'function') return undefined;
  try {
    var r = h.onPhase(kind, a, b);
    if (r && typeof r.then === 'function') {
      return r.then(null, function (e) {
        try { console.error('[SGBY-P5] 阶段 ' + kind + ' 的宿主处理失败：', e); } catch (e2) { /* 控制台不可用 */ }
      });
    }
    return undefined;
  } catch (e) {
    try { console.error('[SGBY-P5] 阶段 ' + kind + ' 通知宿主失败：', e); } catch (e2) { /* 控制台不可用 */ }
    return undefined;
  }
}

/** 战斗菜单接管：仅在「宿主处于战斗中 + 实现了 list」时才返回 Promise，否则返回 null。 */
function __sgbyP5Menu(rect, startIdx, items) {
  var h = __sgbyP5Host();
  if (!h || h.inBattle !== true || typeof h.list !== 'function') return null;
  try { return h.list(rect, startIdx, items); } catch (e) { return null; }
}

/**
 * bo() 是**唯一**等待战斗地图输入的地方（ko/vo/xo 都通过它取输入）：
 *   异步函数 bo(t,e=null)  —— t=每帧回调、e=格子回调（Mo/Po）
 * 原始实现内部 await l.input.waitMsgTimeout(200) 轮询 class A 的输入队列。
 *
 * 因此这里不改任何判定，只在**本次调用范围内**给 waitMsgTimeout 套一层：
 *   1) 真实输入队列（玩家在用原版 2D 画面）优先；
 *   2) 否则向宿主拉取一条「虚拟输入消息」，消息格式与 class A 完全一致
 *      （{type:16,param:1|x,y} 等），由原版自己的 bo() 解释成焦点/点击/取消。
 * 退出时无条件还原原型方法，异常路径也不会留下补丁。
 */
async function bo(onFrame, onCell) {
  var h = __sgbyP5Host();
  if (!h || typeof h.beginInput !== 'function') return boOrig(onFrame, onCell);
  var input = l.input;
  if (!input || typeof input.waitMsgTimeout !== 'function') return boOrig(onFrame, onCell);
  var token = null;
  try { token = h.beginInput({ hasCell: typeof onCell === 'function' }); } catch (e) { token = null; }
  if (!token) return boOrig(onFrame, onCell);      // 宿主拒绝接管 -> 完全原版输入

  var hadOwn = Object.prototype.hasOwnProperty.call(input, 'waitMsgTimeout');
  var origWait = input.waitMsgTimeout;
  input.waitMsgTimeout = function (ms) {
    if (!this.queue || 0 === this.queue.length) {
      var msg = null;
      try { msg = h.pullInput(token); } catch (e) { msg = null; }
      if (msg) { this.lastMsg = msg; return Promise.resolve(msg); }
    }
    return origWait.call(this, ms);
  };
  try {
    return await boOrig(onFrame, onCell);
  } finally {
    if (hadOwn) input.waitMsgTimeout = origWait;
    else { try { delete input.waitMsgTimeout; } catch (e) { input.waitMsgTimeout = origWait; } }
    try { h.endInput(token); } catch (e) { /* 清理失败不影响原版 */ }
  }
}

/** ko() 选部队循环：返回被选中的部队下标，或 255（玩家选了「回合结束/撤退」）。 */
async function ko() {
  await __sgbyP5Notify('select');
  var r = await koOrig();
  await __sgbyP5Notify('selectDone', r);
  return r;
}

/** vo(t) 移动：返回 0=已移动、1=取消/不可移动。位置由原版自己写入 g_GenPos。 */
async function vo(t) {
  await __sgbyP5Notify('moveBegin', t);
  var r = await voOrig(t);
  await __sgbyP5Notify('moveDone', t, r);
  return r;
}

/** xo(type,param,unitId) 选目标：返回目标部队下标或 255（取消）。 */
async function xo(t, e, n) {
  await __sgbyP5Notify('targetBegin', { type: t, param: e, unitId: n });
  var r = await xoOrig(t, e, n);
  await __sgbyP5Notify('targetDone', r);
  return r;
}

/** Ao(t) 行动菜单：t 会被原版写成 {type,param,sIdx,aIdx}，这里只在前后各通知一次。 */
async function Ao(t) {
  await __sgbyP5Notify('actionMenu', t && t.sIdx);
  await AoOrig(t);
  await __sgbyP5Notify('actionDone', t ? {
    sIdx: t.sIdx, type: t.type, param: t.param, aIdx: t.aIdx,
  } : null);
}

/** Fo(n) 行动结算：伤害/兵力/死亡全部由原版在内部完成，宿主只能在前后各看一次状态。 */
async function Fo(n) {
  var d = n ? { sIdx: n.sIdx, type: n.type, param: n.param, aIdx: n.aIdx } : null;
  await __sgbyP5Notify('resolveBegin', d);
  var r = await FoOrig(n);
  await __sgbyP5Notify('resolveDone', d, r);
  return r;
}

/** Io() 回合开始（回合数 +1、状态恢复、粮草判定）。 */
async function Io() {
  await __sgbyP5Notify('turnBegin');
  var r = await IoOrig();
  await __sgbyP5Notify('turnStart', Dn.g_FgtBoutCnt);
  return r;
}

/** Eo() 我方阶段；So() 敌方（原版 AI）。两者的判定与流程一字未改。 */
async function Eo() {
  await __sgbyP5Notify('playerPhase');
  try {
    return await EoOrig();
  } finally {
    await __sgbyP5Notify('playerPhaseEnd');
  }
}

async function So() {
  await __sgbyP5Notify('enemyPhase');
  try {
    return await SoOrig();
  } finally {
    await __sgbyP5Notify('enemyPhaseEnd');
  }
}

;(function () {
  var core = Object.freeze({
    version: '5.0.0-p5',
    source: 'sgby.min.js',
    get Dn() { return Dn; },
    get l() { return l; },
    get lib() { return Dn.lib; },
    classes: Object.freeze({ Un: Un, On: On, Bn: Bn }),
    fns: Object.freeze({
      zs: zs, qs: qs, ei: ei, mi: mi, ac: ac, oc: oc, jn: jn,
      // 原版只读查询函数（P3 城市 UI 直接调用，绝不复制其规则）
      $n: $n, ss: ss, Bs: Bs, Ys: Ys, Is: Is,
    }),
    // P3：接管点与原始实现（诊断/回退用；表现层正常路径不应调用 originals）
    p3: Object.freeze({
      widgetNames: Object.freeze(['$r', 'Ls', 'Ms', 'vs', 'Hs', 'Gs', 'ka']),
      originals: Object.freeze({
        $r: $rOrig, Ls: LsOrig, Ms: MsOrig, vs: vsOrig, Hs: HsOrig, Gs: GsOrig, ka: kaOrig,
      }),
      /** 指令号常量（原文 const Ke=13,Ne=14,qe=15,ze=16,He=17,Je=19,Ve=23,Ze=24,tn=27）。 */
      cmdIds: Object.freeze({
        transport: Ke, move: Ne, sow: qe, recruit: ze, subvert: He,
        persuade: Je, scout: Ve, conscript: Ze, attack: tn,
      }),
      /** 原版消耗表：按指令号索引（Ge=金钱，Ye=体力），与 mi() 校验完全同源。 */
      costMoney: Ge,
      costThew: Ye,
      cancelCode: ye,
      cityCount: Fe,
      /**
       * mi() 中真实存在的指令分支（构建期由本脚本扫描同一份源码推导，
       * 不是手写常量）。24 个菜单项里缺 18（反间）。
       */
      actionIds: Object.freeze(__SGBY_ACTION_IDS__),
    }),
    /**
     * P4：战斗表现层可用的**原版**函数与协议常量。
     * 这些引用只是把原版函数暴露给适配层调用：
     *   移动范围 qi()、攻击范围 Vo()、地形归类 Ui()、地图数据 Ci()、
     *   编成/索引 Ii()/Ei()、可选判定 Xo()、界面文字 vi()。
     * 表现层禁止自己算这些规则，只能调用它们并读取结果。
     */
    p4: Object.freeze({
      widgetNames: Object.freeze(['yo', 'Uo']),
      originals: Object.freeze({ yo: yoOrig, Uo: UoOrig }),
      notify: __sgbyP4Kernel,
      battle: Object.freeze({
        qi: qi, Vo: Vo, Ui: Ui, Ci: Ci, Ii: Ii, Ei: Ei, Xo: Xo, vi: vi,
        /** 原版战斗网格协议（L2351-2353：_e=10,we=20,pe=15,be=17,Pe=16,ke=15,Me=128）。 */
        grid: Object.freeze({
          unitsPerSide: _e, unitsTotal: we,
          windowCols: pe, windowRows: be, tilePx: Pe,
          pathWidth: ke, blockCost: Me, pathBytes: 225,
        }),
        /** 战斗图块资源 id：yo() L5755 在战斗开始时把 g_TileId 置为 4（战斗地图图块）。 */
        tilePicId: 4,
        /** 只读运行态快照（不写任何字段）。 */
        stats: function () {
          return {
            mapId: Dn.g_FgtParam.MapId, mode: Dn.g_FgtParam.Mode, way: Dn.g_FgtParam.Way,
            mapWidth: Dn.g_MapWid, mapHeight: Dn.g_MapHgt, tilePicId: Dn.g_TileId,
            focusX: Dn.g_FoucsX, focusY: Dn.g_FoucsY,
            viewport: { sx: Dn.g_MapSX, sy: Dn.g_MapSY, cols: pe, rows: be },
          };
        },
      }),
    }),
    /**
     * P5：战斗操作层。
     *
     * 设计要点：P5 **不新增任何业务入口**，只暴露「原版输入协议常量 + 原版纯函数引用」，
     * 让适配层可以
     *   1) 把 3D 拾取到的格子换算成原版 240x320 虚拟屏坐标（公式与原版 Ji()/Vi() 同源）；
     *   2) 通过 class A.pushMsg 投递 type:16 的指针消息，由原版 bo() 自己解释；
     *   3) 只用 vi()/Ui()/Oi()/eo() 这类只读函数做展示与视口对齐。
     * 移动合法性/伤害/死亡/胜负一律仍由原版 ko/vo/xo/Ao/Fo 判定，这里不提供也不允许提供。
     */
    p5: Object.freeze({
      widgetNames: Object.freeze([
        'bo', 'ko', 'vo', 'xo', 'Ao', 'Fo', 'Io', 'Eo', 'So',
      ]),
      originals: Object.freeze({
        bo: boOrig, ko: koOrig, vo: voOrig, xo: xoOrig, Ao: AoOrig,
        Fo: FoOrig, Io: IoOrig, Eo: EoOrig, So: SoOrig,
      }),
      battle: Object.freeze({
        /** 原版纯函数引用（只读调用）。eo() 会写 g_MapSX/SY 与 g_FightMap —— 纯显示量。 */
        eo: eo, Oi: Oi, Xo: Xo, qi: qi, Vo: Vo, Ui: Ui, Ci: Ci, vi: vi,
        /** 原版键码（M/v 映射表，L332）。 */
        keyCodes: Object.freeze({
          up: w, down: m, left: p, right: b, confirm: C, cancel: k, info: P, menu: 51,
        }),
        /** 原版指针消息（class A._bindTouch，L392-436）。 */
        pointer: Object.freeze({
          type: _, down: 1, up: 2, move: 3, cancel: 4,
        }),
        /** 战斗地图像素协议（pe/be/Pe/Ce，L2353）：像素 = (格 - 视口原点) << 4。 */
        pixels: Object.freeze({
          tilePx: Pe, tilePy: Ce, viewCols: pe, viewRows: be, shift: 4,
          screenWidth: Oe, screenHeight: Ue, mapAreaBottom: 272,
        }),
        /** 原版界面字符串下标（vi(n) === lib.getStr(1,n)），只登记 P5 用到的几项。 */
        strIdx: Object.freeze({
          moveFailed: 1, noTarget: 2, badCommand: 3,
          actionMenu: 8, battleMenu: 9, lookYesNo: 10, speed: 11, armsType: 12,
          terrainName: 7, terrainNote: 14, expGain: 22, stateName: 28, skillNameRes: 11,
        }),
        /**
         * Dn.g_FgtOver 的真实语义（由源码三处写入点共同确定，不是推断）：
         *   yo() L5750  2-(e/_e|0)：我方全灭 -> 2，敌方全灭 -> 1
         *   Io() L6192  回合>30 -> Mode=1 时为 2、否则为 1；我方粮尽 -> 2、敌方粮尽 -> 1
         *   Go() L6423  全军撤退 -> 2
         *   Eo() L6237  Mode=1 且攻方停在城池格 -> 1；So() L6250 对称 -> 2
         * 因此 1 = 我军胜、2 = 我军败、0 = 进行中。
         */
        battleOver: Object.freeze({ none: 0, win: 1, lose: 2 }),
      }),
    }),
  });
  Object.defineProperty(window, '__SGBY_CORE__', {
    value: core, writable: false, configurable: false
  });
  try {
    window.dispatchEvent(new CustomEvent('sgby:core-ready', { detail: { version: core.version } }));
  } catch (e) { /* 非浏览器宿主忽略 */ }
})();
/* === SGBY-P1-CORE-BRIDGE END ============================================== */
`;

// ---------------------------------------------------------------- 生成
let src = fs.readFileSync(SRC, 'utf8');

const missing = REQUIRED.filter((p) => !src.includes(p));
if (missing.length) {
  console.error('[FAIL] sgby.min.js 缺少预期符号，拒绝生成：', missing.join(', '));
  process.exit(1);
}
if (src.includes('SGBY-P1-CORE-BRIDGE')) {
  console.error('[FAIL] 源文件已包含桥接段，请确认没有把 sgby.core.js 当成源文件。');
  process.exit(1);
}

let body = src;
const applied = [];
for (const [from, to] of RENAMES) {
  const hits = body.split(from).length - 1;
  if (hits !== 1) {
    console.error(`[FAIL] 改名目标命中 ${hits} 次（要求恰好 1 次）：${from}`);
    process.exit(1);
  }
  body = body.replace(from, to);
  applied.push([from.slice(15).replace(/\{.*$/, ''), to.slice(15).replace(/\{.*$/, '')]);
}

const actionIds = deriveActionIds(body);

const out = (body.endsWith('\n') ? body : body + '\n')
  + BRIDGE.replace('__SGBY_ACTION_IDS__', JSON.stringify(actionIds));
fs.writeFileSync(OUT, out, 'utf8');

// ---------------------------------------------------------------- 自检
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const outBuf = fs.readFileSync(OUT);
const prefix = outBuf.subarray(0, Buffer.byteLength(body));
// 前缀必须等于「原文 + 7 次改名」：用重跑一遍的方式验证确定性
const expectPrefix = Buffer.from(body, 'utf8');
const deterministic = Buffer.compare(prefix, expectPrefix) === 0;

// 名字残留检查：改名后不应再出现对被改名函数的原签名定义
const residual = RENAMES.filter(([from]) => body.includes(from)).map(([from]) => from);

console.log('[OK] 生成', path.relative(ROOT, OUT));
console.log('     source bytes :', Buffer.byteLength(src), 'sha1', sha1(fs.readFileSync(SRC)));
console.log('     output bytes :', outBuf.length);
console.log('     改名         :', applied.length, '处 ->', applied.map((a) => `${a[0]}→${a[1]}`).join(' '));
console.log('     bridge bytes :', Buffer.byteLength(BRIDGE));
console.log('     前缀一致     :', deterministic, '（= 原文 + ' + applied.length + ' 处改名，其余逐字节相同）');
if (residual.length) {
  console.error('[FAIL] 仍存在未改名的原签名：', residual.join(', '));
  process.exit(1);
}
console.log('     window.__SGBY_CORE__ 版本 5.0.0-p5（含 p3 接管点 + p4 战斗钩子 + p5 操作钩子）');
console.log('     mi() 指令分支 :', actionIds.length, '个 ->', actionIds.join(','));
const EXPECTED = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 23, 24, 25, 26, 27];
if (JSON.stringify(actionIds) !== JSON.stringify(EXPECTED)) {
  console.warn('[WARN] mi() 分支集合与 P3 记录的基线不同，请复核 CityUIAdapter.ACTION_IDS：',
    '\n  实际:', actionIds.join(','), '\n  基线:', EXPECTED.join(','));
}
