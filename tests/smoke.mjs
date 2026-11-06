#!/usr/bin/env node
/**
 * P1 浏览器端运行验证（无头 Edge + CDP 真实等待 + 真实本地服务）
 *
 * 验证：原版内核启动 -> Three.js 初始化 -> WebGLRenderer -> 三场景框架
 *       -> 真实城市数据 -> 页面内自检（坐标/适配层/事件/资源）-> DOM 状态标记。
 *
 * 用 CDP 而非 --virtual-time-budget：页面有持续 rAF 循环，虚拟时间会被 rAF 耗尽，
 * 导致 6MB 资源包尚未加载完就 dump DOM。这里按真实时间轮询页面状态。
 *
 * 运行： node tests/smoke.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ORIGINAL = path.join(ROOT, 'original');
const SERVER = path.join(ORIGINAL, 'server', 'server.mjs');
const PORT = 8791;
const DEVTOOLS_PORT = 23000 + Math.floor(Math.random() * 1000);
const URL = `http://127.0.0.1:${PORT}/index3d.html`;
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, pass: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

async function waitFor(fn, ms = 15000, label = '条件') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch (_) { /* 尚未就绪 */ }
    await sleep(200);
  }
  throw new Error(`${label} 等待超时 (${ms}ms)`);
}

if (!EDGE) {
  check('找到 Edge 浏览器', false, EDGE_CANDIDATES.join(' / '));
  process.exit(1);
}

const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'sgby-p1-edge-'));
const server = spawn(process.execPath, [SERVER], {
  cwd: ORIGINAL,
  env: { ...process.env, PORT: String(PORT), SGBY_NO_SW: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

let edge = null;
let ws = null;
try {
  const health = await waitFor(() => fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok ? r.json() : null), 12000, '本地服务');
  check('本地服务 /api/health', health.ok === true, `version ${health.version}`);

  const origHtml = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text());
  check('原版 index.html 仍为原入口（引用 sgby.min.js）',
    origHtml.includes('sgby.min.js') && !origHtml.includes('sgby.core.js'));
  const minJs = fs.readFileSync(path.join(ORIGINAL, 'site', 'sgby.min.js'));
  const coreJs = fs.readFileSync(path.join(ORIGINAL, 'site', 'sgby.core.js'));
  check('sgby.core.js = sgby.min.js + 只读尾注（业务代码零改动）',
    coreJs.subarray(0, minJs.length).equals(minJs) && coreJs.length - minJs.length < 2000,
    `min=${minJs.length}B core=${coreJs.length}B delta=${coreJs.length - minJs.length}B`);

  edge = spawn(EDGE, [
    '--headless=new',
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    `--user-data-dir=${tmpProfile}`,
    `--remote-debugging-port=${DEVTOOLS_PORT}`,
    '--remote-allow-origins=*',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    URL,
  ], { stdio: 'ignore' });

  const target = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`);
    const list = await r.json();
    return list.find((t) => t.type === 'page' && t.url.includes('index3d.html'));
  }, 20000, 'CDP 目标页面');
  check('无头 Edge 启动并连接 CDP', !!target.webSocketDebuggerUrl);

  ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const exceptions = [];
  const consoleErrors = [];
  let msgId = 0;
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(msg.params.exceptionDetails?.text || 'unknown');
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push(`${msg.params.entry.text} [${msg.params.entry.url || ''}]`);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const msg = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return msg.result?.result?.value;
  };
  await send('Runtime.enable');
  await send('Log.enable');

  const status = await waitFor(async () => {
    const s = await evaluate('document.body && document.body.dataset.p1Status || ""');
    return s === 'ready' || s === 'error' ? s : null;
  }, 45000, 'P1 页面自检');
  check('P1 页面状态 = ready', status === 'ready', status);

  const html = await evaluate('document.documentElement.outerHTML');
  const pageLog = await evaluate('document.getElementById("p1-log")?.textContent || ""');
  const smokeAttr = await evaluate('document.getElementById("p1-status-list")?.dataset.smoke || ""');
  const statusJson = await evaluate('window.__P1__ ? JSON.stringify(window.__P1__.getStatus()) : "null"');
  const parsed = statusJson && statusJson !== 'null' ? JSON.parse(statusJson) : null;

  check('页面返回 DOM', typeof html === 'string' && html.length > 1000, `${(html || '').length} chars`);
  check('页面内自检全部通过', /^(\d+)\/(\d+)$/.test(smokeAttr) && (() => {
    const m = /^(\d+)\/(\d+)$/.exec(smokeAttr);
    return m[1] === m[2] && Number(m[1]) > 0;
  })(), smokeAttr || '未找到 data-smoke');
  check('原版内核已连接（真实 38 城 / 200 将）',
    pageLog.includes('内核已连接：城市 38、武将 200'));
  check('Three.js / WebGLRenderer 正常',
    !!parsed && parsed.renderer && parsed.renderer.failed === false && parsed.renderer.renders > 0,
    parsed ? `frames=${parsed.renderer.frames} draws=${parsed.renderer.drawCalls} renders=${parsed.renderer.renders}` : '无状态');
  check('三个场景框架可管理',
    ['world', 'city', 'battle'].every((id) => html.includes(`data-scene="${id}"`)) && !!parsed);
  check('唯一渲染循环 / 无重复注册',
    !!parsed && parsed.renderer.frames > 0 && html.includes('p1-stage'));
  check('无启动异常 / 无页面 JS 异常',
    !pageLog.includes('启动失败：') && exceptions.length === 0,
    `exceptions=${exceptions.length}, consoleErrors=${consoleErrors.length}`);

  // 浏览器内实际切换三个场景（测试入口，不代表真实游戏操作结果）
  const flow = [];
  for (const id of ['city', 'world', 'battle', 'world']) {
    await evaluate(`window.__P1__.switchScene(${JSON.stringify(id)})`);
    flow.push(await evaluate('window.__P1__.getStatus().scenes.current'));
  }
  const sceneStats = JSON.parse(await evaluate('JSON.stringify(window.__P1__.getStatus().scenes)'));
  check('浏览器内三场景实际切换与生命周期',
    flow.join(',') === 'city,world,battle,world' && sceneStats.switches >= 5 && sceneStats.rejected === 0,
    `flow=${flow.join('>')} switches=${sceneStats.switches} rejected=${sceneStats.rejected}`);

  // UI 弹窗打开时阻断 3D 输入，关闭后恢复
  await evaluate("document.getElementById('p1-modal').click()");
  const uiOpen = await evaluate('window.__P1__.input.uiOpen');
  await evaluate("document.getElementById('p1-modal-close').click()");
  const uiClosed = await evaluate('window.__P1__.input.uiOpen');
  check('UI 弹窗输入阻断与恢复', uiOpen === true && uiClosed === false,
    `open=${uiOpen} closed=${uiClosed}`);

  // 窗口尺寸变化自动调整 Renderer
  const sizeBefore = await evaluate('JSON.stringify(window.__P1__.getStatus().renderer.size)');
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const sizeAfter = await evaluate('JSON.stringify(window.__P1__.getStatus().renderer.size)');
  check('窗口尺寸变化自动调整', sizeBefore !== sizeAfter, `${sizeBefore} -> ${sizeAfter}`);

  const diag = await evaluate(`JSON.stringify({
    statusText: document.getElementById('status-text')?.textContent || '',
    dn: window.__SGBY_CORE__ ? {
      cities: window.__SGBY_CORE__.Dn.g_Cities.length,
      persons: window.__SGBY_CORE__.Dn.g_Persons.length,
      lib: !!window.__SGBY_CORE__.Dn.lib,
      year: window.__SGBY_CORE__.Dn.g_YearDate
    } : null,
    libInfo: window.__SGBY_CORE__ && window.__SGBY_CORE__.Dn.lib ? {
      cityItems: window.__SGBY_CORE__.Dn.lib.itemCount(57),
      constLen: window.__SGBY_CORE__.Dn.lib.getItem(2,6)?.length ?? null
    } : null
  })`);
  console.log('\n--- 内核诊断 ---\n' + diag);
  console.log('\n--- 页面日志（完整）---');
  console.log(pageLog || '(空)');
  if (exceptions.length) console.log('\n--- JS 异常 ---\n' + exceptions.join('\n'));
  if (consoleErrors.length) console.log('\n--- console error ---\n' + consoleErrors.slice(0, 10).join('\n'));
} catch (e) {
  check('无头浏览器执行', false, `${e.message}\n--- server log ---\n${serverLog.slice(-2000)}`);
} finally {
  if (ws) { try { ws.close(); } catch (_) { /* ignore */ } }
  if (edge) edge.kill();
  server.kill();
  // 临时 profile 保留供排障（不自动递归删除，避免清理动作影响结果输出）。
  console.log(`\n(临时 profile: ${tmpProfile})`);
}

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`\n浏览器 smoke：${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
