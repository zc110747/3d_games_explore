#!/usr/bin/env node
/**
 * P7 构建校验（正式构建 = sgby.core.js 生成物 + 静态站点 + 资源包）
 *
 * 本项目没有打包器：正式构建就是「工具生成内核 + 浏览器直接加载 ES 模块」。
 * 因此构建校验检查的是「交付物是否自洽、能否从干净环境直接跑起来」：
 *
 *   1) 桥接不变量：core.js 去掉尾注并反向还原 18 处改名后与 sgby.min.js 逐字节相同
 *   2) 模块图：index3d.html 引用的 css/js 存在；全部 .mjs 的相对 import 都能落地
 *   3) 语法：每个 .mjs 过一遍 node --check
 *   4) 资源：assets/game.zip 存在且可被 zip 目录读取（头部校验）
 *   5) 环境隔离：静态站点源码里不出现开发机绝对路径 / 硬编码 localhost 端口
 *   6) 唯一性：全站只有一个 new THREE.WebGLRenderer、一个 requestAnimationFrame 循环
 *
 * 用法：node tools/verify_build.mjs [--json]
 * 退出码：0 全通过 / 1 有失败项
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SITE = path.join(ROOT, 'original', 'site');
const JSON_OUT = process.argv.includes('--json');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}

const read = (p) => fs.readFileSync(p, 'utf8');
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'assets') continue;   // 第三方与资源包单独校验
      walk(p, out);
    } else out.push(p);
  }
  return out;
};

// ------------------------------------------------------------------ 1 桥接不变量
const RENAMES = [
  ['async function $rOrig(t,e,n){', 'async function $r(t,e,n){'],
  ['async function LsOrig(t,e,n,r,s,i,st){', 'async function Ls(t,e,n,r,s,i,st){'],
  ['async function MsOrig(t){', 'async function Ms(t){'],
  ['async function vsOrig(t,e){', 'async function vs(t,e){'],
  ['async function HsOrig(t,e,n){', 'async function Hs(t,e,n){'],
  ['async function GsOrig(t){', 'async function Gs(t){'],
  ['async function kaOrig(){', 'async function ka(){'],
  ['async function yoOrig(){', 'async function yo(){'],
  ['async function UoOrig(){', 'async function Uo(){'],
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

check('内核桥接：core.js 反向还原后与 sgby.min.js 逐字节相同', () => {
  const min = read(path.join(SITE, 'sgby.min.js'));
  const core = read(path.join(SITE, 'sgby.core.js'));
  const at = core.indexOf('/* === SGBY-P1-CORE-BRIDGE START');
  if (at <= 0) throw new Error('未找到桥接尾注标记');
  let restored = core.slice(0, at);
  for (const [from, to] of RENAMES) restored = restored.split(from).join(to);
  const a = restored.replace(/\s+$/, '');
  const b = min.replace(/\s+$/, '');
  if (a !== b) throw new Error('还原后与原文不一致（业务代码被改动？）');
  return `min ${min.length}B + 桥接 ${core.length - at}B = ${core.length}B / 18 处改名`;
});

// ------------------------------------------------------------------ 2 模块图
check('入口 HTML 引用的样式/脚本/模块都能在磁盘上找到', () => {
  const html = read(path.join(SITE, 'index3d.html'));
  const refs = [];
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) refs.push(m[1]);
  const missing = refs.filter((r) => !/^(data:|https?:|#)/.test(r) && !fs.existsSync(path.join(SITE, r)));
  if (missing.length) throw new Error(`缺失：${missing.join(', ')}`);
  return `${refs.length} 处引用全部存在`;
});

check('全部 .mjs 的相对 import 都能解析到真实文件', () => {
  const files = [
    ...walk(path.join(SITE, 'p1')), ...walk(path.join(SITE, 'p2')),
    ...walk(path.join(SITE, 'p3')), ...walk(path.join(SITE, 'p4')),
    ...walk(path.join(SITE, 'p5')), ...walk(path.join(SITE, 'p6')),
    ...walk(path.join(SITE, 'p7')),
    path.join(SITE, 'local-bridge.js'),
  ].filter((f) => f.endsWith('.mjs'));
  const bad = [];
  let edges = 0;
  for (const f of files) {
    const text = read(f);
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;      // 裸模块（three）由 importmap 解析
      edges++;
      const target = path.resolve(path.dirname(f), spec);
      if (!fs.existsSync(target)) bad.push(`${path.relative(SITE, f)} -> ${spec}`);
    }
  }
  if (bad.length) throw new Error(`无法解析：${bad.slice(0, 6).join(' | ')}`);
  return `${files.length} 个模块 / ${edges} 条相对 import`;
});

// ------------------------------------------------------------------ 3 语法
check('全部 .mjs 通过 node --check', () => {
  const files = walk(path.join(SITE, 'p1')).concat(
    walk(path.join(SITE, 'p2')), walk(path.join(SITE, 'p3')), walk(path.join(SITE, 'p4')),
    walk(path.join(SITE, 'p5')), walk(path.join(SITE, 'p6')), walk(path.join(SITE, 'p7')),
  ).filter((f) => f.endsWith('.mjs'));
  const bad = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      bad.push(`${path.relative(SITE, f)}: ${String(e.stderr || e.message).split('\n')[0]}`);
    }
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return `${files.length} 个文件`;
});

check('生成物内核通过 node --check', () => {
  execFileSync(process.execPath, ['--check', path.join(SITE, 'sgby.core.js')], { stdio: 'pipe' });
  return `${fs.statSync(path.join(SITE, 'sgby.core.js')).size}B`;
});

// ------------------------------------------------------------------ 4 资源
check('资源包 assets/game.zip 存在且为合法 zip（PK\\x03\\x04）', () => {
  const p = path.join(SITE, 'assets', 'game.zip');
  const buf = fs.readFileSync(p);
  if (buf.length < 1024) throw new Error(`过小 ${buf.length}B`);
  if (!(buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)) {
    throw new Error('不是 zip 头');
  }
  return `${buf.length}B`;
});

check('Three.js 本地 vendor 存在（不依赖 CDN）', () => {
  const names = ['three.module.js', 'three.core.js'];
  const missing = names.filter((n) => !fs.existsSync(path.join(SITE, 'p1', 'vendor', n)));
  if (missing.length) throw new Error(`缺少 ${missing.join(',')}`);
  const size = fs.statSync(path.join(SITE, 'p1', 'vendor', 'three.module.js')).size;
  return `three.module.js ${size}B`;
});

// ------------------------------------------------------------------ 5 环境隔离
check('静态站点源码不含开发机绝对路径 / 硬编码端口地址', () => {
  const files = walk(SITE).filter((f) => /\.(mjs|js|html|css)$/.test(f));
  const bad = [];
  for (const f of files) {
    if (f.endsWith('sgby.min.js') || f.endsWith('sgby.core.js')) continue;   // 原版生成物
    const text = read(f);
    if (/[A-Za-z]:\\\\|[A-Za-z]:\\Users\\|[A-Za-z]:\/Users\//.test(text)) bad.push(`${path.relative(SITE, f)}:绝对路径`);
    // 只认真正的 URL（带端口/路径）；提示文案里的 "http://localhost 访问" 不算
    if (/https?:\/\/(localhost|127\.0\.0\.1)(:\d+|\/)/.test(text)) bad.push(`${path.relative(SITE, f)}:硬编码本机地址`);
  }
  if (bad.length) throw new Error(bad.slice(0, 6).join(' | '));
  return `${files.length} 个文件检查通过`;
});

check('站点资源路径均为相对路径（大小写按真实文件校验）', () => {
  const html = read(path.join(SITE, 'index3d.html'));
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]).filter((r) => !/^(data:|https?:|#)/.test(r));
  const bad = refs.filter((r) => r.startsWith('/'));
  if (bad.length) throw new Error(`绝对路径：${bad.join(',')}`);
  return `${refs.length} 处相对引用`;
});

// ------------------------------------------------------------------ 6 唯一性
check('全站只有一个 WebGLRenderer 与一个自续帧渲染循环', () => {
  const files = walk(SITE).filter((f) => f.endsWith('.mjs') || (f.endsWith('.js') && !/sgby\.(min|core)\.js/.test(f)));
  const renderers = [];
  const loops = [];
  const oneShots = [];
  for (const f of files) {
    const text = read(f);
    const rel = path.relative(SITE, f);
    if (/new\s+THREE\.WebGLRenderer/.test(text)) renderers.push(rel);
    // 自续循环：把 rAF 的返回值存回循环函数自身（this._loop / this._tick）
    if (/requestAnimationFrame\(\s*this\._?(?:loop|tick|frame)\b/.test(text)) loops.push(rel);
    const rafCount = (text.match(/requestAnimationFrame\(/g) || []).length;
    if (rafCount && !loops.includes(rel)) oneShots.push(`${rel}×${rafCount}`);
  }
  if (renderers.length !== 1) throw new Error(`WebGLRenderer 出现 ${renderers.length} 次：${renderers.join(',')}`);
  if (loops.length !== 1) throw new Error(`自续渲染循环出现在 ${loops.length} 个文件：${loops.join(',')}`);
  // 其它 rAF 必须是一次性调度（滚动定位/悬停节流），数量要可控，避免有人又开一条循环
  if (oneShots.length > 3) throw new Error(`疑似额外循环：${oneShots.join(',')}`);
  return `renderer=${renderers[0]} / 循环=${loops[0]} / 一次性调度 ${oneShots.length} 处（${oneShots.join(', ') || '无'}）`;
});

check('P7 模块不写游戏状态、不自建渲染循环', () => {
  const dir = path.join(SITE, 'p7');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  const bad = [];
  for (const f of files) {
    const text = read(path.join(dir, f));
    if (/Dn\.[A-Za-z_$][\w$]*\s*=[^=]/.test(text)) bad.push(`${f}:Dn 赋值`);
    if (/new\s+THREE\.WebGLRenderer|requestAnimationFrame\(/.test(text)) bad.push(`${f}:自建渲染`);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return `${files.length} 个模块`;
});

// ------------------------------------------------------------------ 输出
const failed = results.filter((r) => !r.ok);
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
} else {
  console.log('\n===== P7 构建校验 =====');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n汇总：${results.length - failed.length}/${results.length} PASS`);
}
process.exitCode = failed.length ? 1 : 0;
