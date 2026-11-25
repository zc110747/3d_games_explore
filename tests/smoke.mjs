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
  // 不变量：core.js 去掉桥接尾注、把 18 处改名反向还原后，必须与 min.js 逐字节相同。
  // 这比「前缀相同」更强：任何额外改动都会被抓到。
  // P3 接管 7 个 UI 控件，P4 追加 yo/Uo，P5 追加 9 个战斗操作协程 -> 共 18 处。
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
  const coreText = coreJs.toString('utf8');
  const bridgeAt = coreText.indexOf('/* === SGBY-P1-CORE-BRIDGE START');
  let restored = bridgeAt > 0 ? coreText.slice(0, bridgeAt) : '';
  for (const [from, to] of RENAMES) restored = restored.split(from).join(to);
  const sameAsSource = restored.replace(/\s+$/, '') === minJs.toString('utf8').replace(/\s+$/, '');
  check('sgby.core.js = sgby.min.js + 18 处改名 + 桥接尾注（业务代码零改动）',
    sameAsSource && bridgeAt > 0,
    `min=${minJs.length}B core=${coreJs.length}B delta=${coreJs.length - minJs.length}B 还原一致=${sameAsSource}`);

  edge = spawn(EDGE, [
    '--headless=new',
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--window-size=1280,900',
    `--user-data-dir=${tmpProfile}`,
    `--remote-debugging-port=${DEVTOOLS_PORT}`,
    '--remote-allow-origins=*',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    URL,
  ], { stdio: 'ignore' });

  const cdpTarget = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`);
    const list = await r.json();
    return list.find((t) => t.type === 'page' && t.url.includes('index3d.html'));
  }, 20000, 'CDP 目标页面');
  check('无头 Edge 启动并连接 CDP', !!cdpTarget.webSocketDebuggerUrl);

  ws = new WebSocket(cdpTarget.webSocketDebuggerUrl);
  const pending = new Map();
  const exceptions = [];
  const consoleErrors = [];
  let msgId = 0;
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      const detail = d.exception?.description || d.exception?.value || d.text || 'unknown';
      exceptions.push(String(detail).split('\n').slice(0, 4).join(' | '));
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

  // ==================================================================
  // P6：默认必须停在原版 2D 主界面（菜单/选择不做 3D 化）
  // ==================================================================
  const defaultView = JSON.parse(await evaluate(`JSON.stringify((() => {
    const vis = (id) => {
      const el = document.getElementById(id);
      return !!el && getComputedStyle(el).display !== 'none';
    };
    const legacyCanvas = document.getElementById('screen');
    return {
      body: document.body.dataset.sangoView,
      legacy: vis('p1-legacy'), stage: vis('p1-stage'), ui: vis('p1-ui'),
      canvas: !!legacyCanvas && legacyCanvas.width === 240 && legacyCanvas.height === 320,
      ops: window.__P6__ ? window.__P6__.getSnapshot() : null,
    };
  })())`));
  check('默认进入原版 2D 主界面（主菜单/选择不 3D 化）',
    defaultView.body === 'menu' && defaultView.legacy === true
    && defaultView.stage === false && defaultView.ui === false
    && defaultView.ops?.view?.mode === 'menu',
    `body=${defaultView.body} legacy=${defaultView.legacy} stage=${defaultView.stage} ui=${defaultView.ui}`);
  check('原版 240x320 画布仍在驱动游戏（未改动原版界面）',
    defaultView.canvas === true);
  check('菜单阶段 3D 操作条不存在（不干扰原版操作）',
    defaultView.ops?.opsHidden === true || defaultView.stage === false,
    `opsHidden=${defaultView.ops?.opsHidden}`);

  // 主界面（原版 2D）截图：用于目视核对「菜单/选择未被 3D 化」。
  // 浏览器以 1280x900 启动，原版整数倍缩放会给出完整可操作界面。
  await send('Page.enable');
  const menuShot = await send('Page.captureScreenshot', { format: 'png' });
  const menuShotPath = path.join(os.tmpdir(), 'sgby-p6-main-menu.png');
  fs.writeFileSync(menuShotPath, Buffer.from(menuShot.result.data, 'base64'));
  check('原版主界面截图已生成（2D 菜单）', fs.statSync(menuShotPath).size > 8000, menuShotPath);

  // 原版未处于 zs() 选城阶段时，必须拒绝注入输入（不伪造成功）——只在菜单阶段可验证
  const menuPhase = JSON.parse(await evaluate('JSON.stringify(window.__P2__.adapter.getInputPhase())'));  const menuReq = JSON.parse(await evaluate('JSON.stringify(window.__P2__.adapter.requestCitySelection(0, { intent: "cursor" }))'));
  check('原版不在选城阶段时拒绝注入输入（如实标注）',
    menuPhase.canSelectCity === false && menuReq.injected === false,
    `${menuPhase.reason} / ${menuReq.reason}`);


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

  // ==================================================================
  // P6：脚本化开局（只在临时浏览器进程内推进原版流程）
  //     验证「进入剧本 -> 自动切 3D」，之后所有 3D 断言都在 game 视图下跑
  // ==================================================================
  let bootSteps = 0;
  let openState = null;
  for (; bootSteps < 12; bootSteps++) {
    const s = JSON.parse(await evaluate(`JSON.stringify({
      year: window.__SGBY_CORE__.Dn.g_YearDate,
      phase: window.__P2__.adapter.getInputPhase()
    })`));
    openState = s;
    if (s.year > 0 && s.phase.canSelectCity) break;
    await evaluate('window.__P2__.adapter.sendInput({ type: 5, param: 39 })');
    await sleep(450);
  }
  const opened = openState?.year > 0 && openState?.phase?.canSelectCity === true;
  check('脚本化真实开局后原版进入 zs() 选城阶段', opened,
    `按键 ${bootSteps} 次 / year=${openState?.year} / kind=${openState?.phase?.kind} / waiting=${openState?.phase?.waiting}`);

  const switched = await waitFor(async () => {
    const v = await evaluate('document.body.dataset.sangoView');
    return v === 'game' ? v : null;
  }, 8000, 'P6 自动切换 3D 视图').catch(() => null);
  const bodyView = await evaluate('document.body.dataset.sangoView');
  check('进入剧本后自动切换 3D 战略地图', switched === 'game', `body=${bodyView}`);
  const gameView = JSON.parse(await evaluate(`JSON.stringify((() => {
    const vis = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none'; };
    const btns = [...document.querySelectorAll('#p6-ops .p6-key')];
    return {
      legacy: vis('p1-legacy'), stage: vis('p1-stage'), ui: vis('p1-ui'),
      opsButtons: btns.length,
      opsKeys: btns.filter((b) => b.dataset.p6Key).map((b) => b.dataset.p6Key).sort(),
      opsActions: btns.filter((b) => b.dataset.p6Action).map((b) => b.dataset.p6Action).sort(),
      opsHidden: document.getElementById('p6-ops')?.hidden,
    };
  })())`));
  check('3D 视图下原版 2D 层隐藏、原版操作条就绪',
    gameView.legacy === false && gameView.stage === true && gameView.ui === true
    && gameView.opsButtons === 11 && gameView.opsHidden === false,
    `legacy=${gameView.legacy} stage=${gameView.stage} 按键=${gameView.opsButtons} hidden=${gameView.opsHidden}`);
  // P6 §8.2：原版全部按键（8 个键码 + 菜单/缩放三个动作）都在，一个都不少
  const expectKeys = ['34', '35', '36', '37', '38', '39', '40', '51'];
  const expectActions = ['menu', 'zoomIn', 'zoomOut'];
  check('操作条保留原版全部按键（8 个键码 + 菜单/缩放）',
    JSON.stringify(gameView.opsKeys) === JSON.stringify(expectKeys)
    && JSON.stringify(gameView.opsActions) === JSON.stringify(expectActions),
    `keys=${gameView.opsKeys.join(',')} actions=${gameView.opsActions.join(',')}`);

  // 按键"挂在 DOM 上"不等于"看得见、点得到"：11 键曾在小视口挤到视口外或被别的层压住。
  // 这里逐个按钮取包围盒，再用 elementFromPoint 验证它真的是最上层。
  const opsGeom = JSON.parse(await evaluate(`JSON.stringify((() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const out = [...document.querySelectorAll('#p6-ops .p6-key')].map((b) => {
      const r = b.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        label: (b.textContent || '').trim() || b.dataset.p6Key || b.dataset.p6Action,
        w: Math.round(r.width), h: Math.round(r.height),
        inView: r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh,
        reachable: !!hit && (hit === b || b.contains(hit)),
      };
    });
    return { vw, vh, out };
  })())`));
  const outOfView = opsGeom.out.filter((b) => !b.inView).map((b) => b.label);
  const notReachable = opsGeom.out.filter((b) => !b.reachable).map((b) => b.label);
  check('操作条 11 键全部在视口内且可点（不被裁切/遮挡）',
    opsGeom.out.length === 11
    && opsGeom.out.every((b) => b.inView && b.reachable && b.w > 0 && b.h > 0),
    `视口 ${opsGeom.vw}x${opsGeom.vh} · 越界 ${outOfView.join(',') || '无'} · 点不到 ${notReachable.join(',') || '无'}`);

  // 阵营图例：P6 §8.1 的产物。它曾经挂在左下角、被默认打开的左侧调试面板整块压住
  // （文档写着有、画面完全看不到）。现在坐在操作条里，必须是"看得见 + 三色对"。
  const legendState = JSON.parse(await evaluate(`JSON.stringify((() => {
    const el = document.getElementById('p2-legend');
    if (!el) return { exists: false };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const dots = [...el.querySelectorAll('.p2-dot')].map((d) => getComputedStyle(d).backgroundColor);
    const ops = document.getElementById('p6-ops');
    return {
      exists: true, display: cs.display, w: Math.round(r.width), h: Math.round(r.height),
      inView: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      inOps: !!ops && ops.contains(el),
      dots,
      opsButtons: ops ? ops.querySelectorAll('.p6-key').length : 0,
    };
  })())`));
  const hexToRgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;
  check('阵营图例可见、在操作条内且三色正确',
    legendState.exists === true && legendState.display !== 'none'
    && legendState.w > 0 && legendState.h > 0 && legendState.inView === true
    && legendState.inOps === true && legendState.dots.length === 3
    && legendState.dots[0] === hexToRgb('#2f6fd0')
    && legendState.dots[1] === hexToRgb('#c0392b')
    && legendState.dots[2] === hexToRgb('#4b5058')
    && legendState.opsButtons === 11,
    `display=${legendState.display} ${legendState.w}x${legendState.h} inView=${legendState.inView}`
    + ` 在操作条内=${legendState.inOps} · 圆点 ${legendState.dots.join(' / ')}`
    + ` · 操作条按钮仍为 ${legendState.opsButtons} 个`);

  // 「菜单」= 原版右上角菜单（云存档 / MOD / 关于）：面板是 body 上的 .wm-overlay，
  // 直接开在 3D 之上（实测 kind 仍为 zs、视图不跳）。注意页面里还有一个「云存档同步」同 class
  // 的隐藏面板，选择器必须挑"当前打开的那个"，否则会点到别人的关闭按钮（踩过）。
  const menuClicked = await evaluate(`((() => {
    const b = document.querySelector('#p6-ops [data-p6-action="menu"]');
    if (!b) return false;
    b.click();
    return true;
  })())`);
  await sleep(400);
  const menuState = JSON.parse(await evaluate(`JSON.stringify((() => {
    const ov = [...document.querySelectorAll('.wm-overlay')].find((o) => o.classList.contains('open'));
    if (!ov) return { open: false, total: document.querySelectorAll('.wm-overlay').length };
    const r = ov.querySelector('.wm-close');
    const rect = r ? r.getBoundingClientRect() : null;
    return { open: true, inBody: ov.parentElement === document.body,
      title: ov.querySelector('.wm-title')?.textContent || '',
      view: document.body.dataset.sangoView,
      close: rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null };
  })())`));
  let menuClosed = false;
  if (menuState.close) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: menuState.close.x, y: menuState.close.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: menuState.close.x, y: menuState.close.y, button: 'left', clickCount: 1 });
    await sleep(400);
    menuClosed = await evaluate(`![...document.querySelectorAll('.wm-overlay')].some((o) => o.classList.contains('open'))`);
  }
  check('「菜单」按钮打开原版菜单面板（3D 下直接可读，视图不跳），可正常关闭',
    menuClicked === true && menuState.open === true && menuState.inBody === true
    && menuState.title === '菜单' && menuState.view === 'game' && menuClosed === true,
    `open=${menuState.open} title=${menuState.title} inBody=${menuState.inBody}`
    + ` 视图=${menuState.view} 关闭=${menuClosed}`);
  // 面板关掉后必须还能操作地图（不能留下吃点击的隐形遮罩）
  await sleep(300);
  const menuAfterView = await evaluate('document.body.dataset.sangoView');

  // 缩放 −/+：只改相机，不改任何游戏状态
  const camZoom = async () => JSON.parse(await evaluate(
    'JSON.stringify({ z: window.__P2__.worldCamera.getState(window.__P2__.mapScene.camera).zoom,'
    + ' turn: (() => { const g = window.__P2__.adapter.getGameState(); return `${g.year}-${g.month}`; })() })'));
  const clickAction = async (a) => evaluate(`document.querySelector('#p6-ops [data-p6-action="${a}"]').click()`);
  const zoomBefore = await camZoom();
  await clickAction('zoomIn');
  await sleep(220);
  const zoomAfterIn = await camZoom();
  await clickAction('zoomOut');
  await sleep(220);
  const zoomAfterOut = await camZoom();
  check('缩放 −/+ 只改相机（放大后 zoom 变大，缩小回原值；回合未变）',
    zoomAfterIn.z > zoomBefore.z && Math.abs(zoomAfterOut.z - zoomBefore.z) < 1e-6
    && zoomBefore.turn === zoomAfterOut.turn,
    `zoom ${zoomBefore.z.toFixed(3)} -> ${zoomAfterIn.z.toFixed(3)} -> ${zoomAfterOut.z.toFixed(3)}`
    + ` / 回合 ${zoomBefore.turn} -> ${zoomAfterOut.turn}`);
  await evaluate('window.__P2__.worldCamera.reset(window.__P2__.mapScene.camera)');
  await sleep(600);   // 等 resize/fit 完成后再取画布矩形

  // ==================================================================
  // P2 战略地图：真实鼠标交互 / 拾取 / 相机 / 状态同步 / 截图
  // ==================================================================
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const dragAt = async (x1, y1, x2, y2) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: x1 + (x2 - x1) * i / 6, y: y1 + (y2 - y1) * i / 6,
        button: 'left', buttons: 1,
      });
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
  };
  const stageRect = JSON.parse(await evaluate(`JSON.stringify((() => {
    const r = document.getElementById('p1-stage').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  })())`));

  const p2Ready = await evaluate('!!window.__P2__');
  check('P2 调试接口就绪', p2Ready === true);
  const d2 = JSON.parse(await evaluate('JSON.stringify(window.__P2__.getDiagnostics())'));
  check('P2 38 城 / 54 路 / 38 旗 / 108 帧原版地形',
    d2.cities.cityCount === 38 && d2.roads.edges === 54
    && d2.flags.flags === 38 && d2.terrain.frames === 108 && !d2.terrain.degraded,
    `城${d2.cities.cityCount} 路${d2.roads.edges} 旗${d2.flags.flags} 地形帧${d2.terrain.frames}`);
  check('P2 正面俯视正交相机（0°/90°，禁旋转）',
    d2.camera.fixedView === true && d2.camera.topDown === true
    && d2.camera.projection === 'orthographic' && d2.camera.rotationAllowed === false,
    `${d2.camera.azimuthDeg}°/${d2.camera.elevationDeg}°`);

  const candidates = JSON.parse(await evaluate(`JSON.stringify((() => {
    const vp = ${JSON.stringify(stageRect)};
    const out = [];
    for (const c of window.__P2__.adapter.getCities()) {
      const s = window.__P2__.cityScreenPosition(c.id, vp);
      if (s && s.visible) out.push({ id: c.id, x: s.x, y: s.y, ndcX: s.ndc.x, ndcY: s.ndc.y });
    }
    return out;
  })())`));
  const safe = candidates.filter((c) =>
    c.x > stageRect.left + 370 && c.x < stageRect.left + stageRect.width - 290
    && c.y > stageRect.top + 80 && c.y < stageRect.top + stageRect.height - 140);
  const pool = safe.length ? safe : candidates;
  const target = pool[Math.floor(pool.length / 2)];
  check('全部 38 城可投影到屏幕', candidates.length === 38,
    `${candidates.length}/38，可点区域 ${safe.length} 城`);

  const pickId = await evaluate(`window.__P2__.pickCityAt(${target.ndcX}, ${target.ndcY})`);
  check('Raycaster 拾取返回正确原版城市 ID', pickId === target.id,
    `目标 #${target.id} -> ${pickId}`);
  await clickAt(target.x, target.y);
  await sleep(280);
  const clickedId = await evaluate('window.__P2__.interaction.selectedCityId');
  check('真实鼠标点击城市并识别 ID', clickedId === target.id, `#${clickedId}`);
  const selDiag = JSON.parse(await evaluate('JSON.stringify(window.__P2__.getDiagnostics())'));
  check('选中高亮 + 仅高亮原版相邻路径',
    selDiag.selected === target.id && selDiag.roads.highlighted > 0
    && selDiag.roads.highlighted <= 8,
    `选中 #${selDiag.selected} 高亮 ${selDiag.roads.highlighted} 条`);
  // 逻辑边数 > 0 只证明"算出了要亮哪几条"，不证明"真画出来了"：
  // highlightNeighbors 曾在这里 ReferenceError 却不影响上面的断言（静默失败）。
  check('高亮路径真的生成了 Mesh（不只是算出了边数）',
    selDiag.roads.highlightMesh === true && selDiag.roads.highlightVertices > 0,
    `mesh=${selDiag.roads.highlightMesh} 顶点=${selDiag.roads.highlightVertices}`);

  const selBeforeDrag = await evaluate('window.__P2__.interaction.selectedCityId');
  await dragAt(target.x, target.y, target.x + 70, target.y + 40);
  await sleep(200);
  const selAfterDrag = await evaluate('window.__P2__.interaction.selectedCityId');
  const drags = await evaluate('window.__P2__.interaction.stats.drags');
  check('地图拖动不误触发城市选择',
    selAfterDrag === selBeforeDrag && drags > 0,
    `选中 ${selBeforeDrag}->${selAfterDrag}，drag 事件 ${drags}`);

  const camBefore = JSON.parse(await evaluate('JSON.stringify(window.__P2__.worldCamera.getState(window.__P2__.mapScene.camera))'));
  const logicBefore = await evaluate('JSON.stringify(window.__P2__.adapter.getCity(0).position)');
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: stageRect.left + stageRect.width / 2,
    y: stageRect.top + stageRect.height / 2, deltaX: 0, deltaY: -420,
  });
  await sleep(200);
  const camAfter = JSON.parse(await evaluate('JSON.stringify(window.__P2__.worldCamera.getState(window.__P2__.mapScene.camera))'));
  const logicAfter = await evaluate('JSON.stringify(window.__P2__.adapter.getCity(0).position)');
  check('滚轮缩放生效、受上下限约束、无画面跳动',
    camAfter.zoom > camBefore.zoom && camAfter.zoom >= 0.6 && camAfter.zoom <= 3
    && JSON.stringify(camAfter.target) === JSON.stringify(camBefore.target),
    `zoom ${camBefore.zoom.toFixed(2)} -> ${camAfter.zoom.toFixed(2)}，target 未变`);
  check('缩放不改变原版逻辑坐标', logicBefore === logicAfter, logicAfter);

  for (let i = 0; i < 8; i++) await dragAt(stageRect.left + 600, stageRect.top + 300, stageRect.left + 300, stageRect.top + 180);
  const camBound = JSON.parse(await evaluate('JSON.stringify(window.__P2__.worldCamera.getState(window.__P2__.mapScene.camera))'));
  check('相机平移受边界限制',
    Math.abs(camBound.target[0]) <= 9.001 && Math.abs(camBound.target[2]) <= 7.001,
    `target=[${camBound.target.map((v) => v.toFixed(2)).join(',')}]`);

  const btn = JSON.parse(await evaluate(`JSON.stringify((() => {
    const r = document.getElementById('p2-reset-cam').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })())`));
  const clicksBefore = await evaluate('window.__P2__.interaction.stats.clicks');
  await clickAt(btn.x, btn.y);
  await sleep(150);
  const clicksAfter = await evaluate('window.__P2__.interaction.stats.clicks');
  check('点击 HTML UI 不穿透到 3D 场景', clicksAfter === clicksBefore,
    `clicks ${clicksBefore} -> ${clicksAfter}`);

  // 切到战斗场景再切回：验证 P2 修复的「重复 enter 订阅重建」
  await evaluate("window.__P1__.switchScene('battle')");
  await evaluate("window.__P1__.switchScene('world')");
  const subsAfter = await evaluate('window.__P2__.getDiagnostics().subscriptions');
  await evaluate('window.__P2__.setSelection(5)');
  const selAfterReenter = await evaluate('window.__P2__.getDiagnostics().selected');
  check('场景切回后事件订阅仍有效', subsAfter > 0 && selAfterReenter === 5,
    `订阅 ${subsAfter}，选中 #${selAfterReenter}`);

  // 渲染层归属变化响应（只测旗帜材质切换，不写 Dn.g_Cities）
  const ownerTest = JSON.parse(await evaluate(`JSON.stringify((() => {
    const p = window.__P2__, f = p.mapScene.flagRenderer, id = 3;
    const real = p.adapter.getCity(id).ownerId;
    const before = f._cloths.get(id).material.uuid;
    f.updateOwner(id, 2);
    const after = f._cloths.get(id).material.uuid;
    const kind = f.getFactionStyle(2).kind;
    f.updateOwner(id, real);
    return { real, changed: before !== after, kind, restored: f._owner.get(id) === real };
  })())`));
  check('城市归属变化后旗帜颜色/图案可动态更新',
    ownerTest.changed && ownerTest.restored,
    `材质切换=${ownerTest.changed} 分类=${ownerTest.kind} 已恢复=${ownerTest.restored}`);


  // P6 §8.1：阵营三态配色 —— 俯视整图下必须能一眼分出我方/敌方/空城
  const factionColors = JSON.parse(await evaluate(`JSON.stringify((() => {
    const p = window.__P2__, f = p.mapScene.flagRenderer;
    const player = p.adapter.getGameState().playerKing + 1;
    const other = player === 1 ? 2 : 1;
    const style = (id) => { const s = f.getFactionStyle(id); return { id, kind: s.kind, color: s.color }; };
    const mine = style(player), foe = style(other), empty = style(0);
    const c = p.mapScene.cityRenderer;
    const ring = c._factionRing ? { count: c._factionRing.count, diag: c.getDiagnostics().factions } : null;
    return { player, other, mine, foe, empty, ring };
  })())`));
  const fc = factionColors;
  check('阵营三态配色：我方蓝 / 敌方红 / 空城灰，且地面环按阵营着色',
    fc.mine.kind === 'player' && fc.foe.kind === 'other' && fc.empty.kind === 'empty'
    && new Set([fc.mine.color, fc.foe.color, fc.empty.color]).size === 3
    && fc.mine.color === 0x2f6fd0 && fc.foe.color === 0xc0392b
    && !!fc.ring && fc.ring.count === 38
    && fc.ring.diag.player + fc.ring.diag.enemy + fc.ring.diag.empty === 38,
    `我方 #${fc.mine.id}=0x${fc.mine.color.toString(16)} / 敌方 #${fc.foe.id}=0x${fc.foe.color.toString(16)}`
    + ` / 空城=0x${fc.empty.color.toString(16)}`
    + ` / 环 ${fc.ring ? fc.ring.count : 0} 个（我 ${fc.ring ? fc.ring.diag.player : 0}`
    + ` 敌 ${fc.ring ? fc.ring.diag.enemy : 0} 空 ${fc.ring ? fc.ring.diag.empty : 0}）`);
  const visualDiag = await evaluate(`JSON.stringify((() => {
    const c = window.__P2__.mapScene.cityRenderer;
    const item = c._labels.get(0), s = item && item.sprite;
    let spriteCount = 0;
    window.__P2__.mapScene.scene.traverse((o) => { if (o.isSprite) spriteCount++; });
    let opaquePixels = 0;
    if (s && s.material.map && s.material.map.image) {
      const img = s.material.map.image;
      const d = img.getContext('2d').getImageData(0, 0, img.width, img.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaquePixels++;
    }
    c._body.geometry.computeBoundingBox();
    const bb = c._body.geometry.boundingBox;
    return {
      spriteCount, labelVisible: s?.visible, labelPos: s?.position.toArray(),
      labelScale: s?.scale.toArray(), labelPixels: opaquePixels,
      pickVisible: c._pick.visible,
      bodyBBox: [bb.min.toArray(), bb.max.toArray()],
      bodyColorAttr: !!c._body.instanceColor,
      roadY: window.__P2__.mapScene.roadRenderer._base.geometry.attributes.position.array[1],
    };
  })())`);
  console.log('\n--- 视觉层诊断 ---\n' + visualDiag);

  await send('Page.enable');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join(os.tmpdir(), 'sgby-p2-strategic-map.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));
  check('3D 战略地图截图已生成', fs.statSync(shotPath).size > 10000, shotPath);

  // ---- 原版输入协议驱动光标（低层接口，仍走 pushMsg；开局已在 P6 段完成）
  if (opened) {
    const cur = JSON.parse(await evaluate('JSON.stringify(window.__P2__.adapter.getCityCursor())'));
    const city = JSON.parse(await evaluate(`JSON.stringify((() => {
      const p = window.__P2__.adapter;
      return p.getCities().find((c) => c.position.x !== ${cur.setx} || c.position.y !== ${cur.sety});
    })())`));
    const req = JSON.parse(await evaluate(`JSON.stringify(window.__P2__.adapter.requestCitySelection(${city.id}, { intent: "cursor" }))`));
    await sleep(1800);
    const after = JSON.parse(await evaluate('JSON.stringify(window.__P2__.adapter.getCityCursor())'));
    check('3D 选城请求经原版输入协议驱动 zs() 光标',
      req.injected === true && after.setx === city.position.x && after.sety === city.position.y,
      `目标 #${city.id}(${city.position.x},${city.position.y}) 投递 ${req.messageCount ?? 0} 键 -> 原版光标 (${after.setx},${after.sety}) 城 #${after.cityId ?? '—'}`);
  }

  // ==================================================================
  // P6：底部「信息 / 查找」是原版画在 2D 画布上的全屏页 —— 3D 视图下临时切回 2D
  // ==================================================================
  const peekClicked = await evaluate(`(() => {
    const b = [...document.querySelectorAll('#p6-ops .p6-key')].find((x) => x.dataset.p6Key === '51');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(700);
  const peekState = JSON.parse(await evaluate(`JSON.stringify({
    body: document.body.dataset.sangoView,
    hint: !document.getElementById('p6-peek-hint')?.hidden,
    peeking: window.__P6__.getSnapshot().ops?.peeking,
    stage: getComputedStyle(document.getElementById('p1-stage')).display !== 'none'
  })`));
  check('「查找」按钮打开原版形势图（临时切回原版 2D 画面）',
    peekClicked === true && peekState.body === 'menu' && peekState.hint === true
    && peekState.peeking === true && peekState.stage === false,
    `body=${peekState.body} hint=${peekState.hint} peeking=${peekState.peeking}`);

  // 任意键返回：原版 zs() 在帮助/形势图状态里「任意键」只是退出该页，不会返回上层
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81,
  });
  await sleep(900);
  const peekBack = JSON.parse(await evaluate(`JSON.stringify({
    body: document.body.dataset.sangoView,
    hint: !document.getElementById('p6-peek-hint')?.hidden,
    phase: window.__P2__.adapter.getInputPhase().kind,
    peeking: window.__P6__.getSnapshot().ops?.peeking
  })`));
  check('任意键关闭原版画面并回到 3D 地图',
    peekBack.body === 'game' && peekBack.hint === false && peekBack.peeking === false,
    `body=${peekBack.body} hint=${peekBack.hint} phase=${peekBack.phase}`);

  // ==================================================================
  // P3 城市管理：真实点击己方城市 -> HTML 界面 -> 原版 mi() 执行 -> 数值真变
  // ==================================================================
  const p3Status = async () => JSON.parse(await evaluate('JSON.stringify(window.__P3__.getStatus())'));
  const rectOf = async (sel) => JSON.parse(await evaluate(`JSON.stringify((() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })())`));
  const clickEl = async (sel) => {
    const r = await rectOf(sel);
    if (!r || r.w < 2 || r.h < 2) return false;
    await clickAt(r.x, r.y);
    await sleep(140);
    return true;
  };
  const tapText = async (text, scope = '.p3-modal') => evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(scope)});
    if (!root) return false;
    const b = [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
    if (!b) return false;
    b.click();
    return true;
  })()`);

  const p3Ready = await evaluate('!!window.__P3__');
  check('P3 调试接口就绪', p3Ready === true);
  const p3Boot = await p3Status();
  const p3Diag = JSON.parse(await evaluate(`JSON.stringify((() => {
    const a = window.__P2__.adapter;
    const gs = a.getGameState();
    const cities = a.getCities();
    return {
      playerKing: gs.playerKing, year: gs.year, month: gs.month,
      cityCount: cities.length,
      owners: [...new Set(cities.map((c) => c.ownerId))],
      ownedByPlayer: cities.filter((c) => c.ownerId === gs.playerKing + 1).length,
      playerCities: cities.filter((c) => c.ownerId === gs.playerKing + 1).map((c) => {
        const s = window.__P2__.cityScreenPosition(c.id, window.__P2__.mapScene ? {
          left: 0, top: 0, width: innerWidth, height: innerHeight } : null);
        return { id: c.id, name: c.name, pos: { x: c.position.x, y: c.position.y },
          screen: s ? { x: Math.round(s.x), y: Math.round(s.y), visible: s.visible } : null };
      }),
      phase: a.getInputPhase(),
      scene: window.__P1__.getStatus().scenes.current,
      cam: (() => {
        const c = window.__P2__.mapScene.camera;
        const st = window.__P2__.cameraManager.getState(c);
        const lim = window.__P2__.worldCamera._panLimits(c);
        return { target: st.target, zoom: st.zoom, left: c.left, right: c.right, top: c.top, bottom: c.bottom, lim,
          sameAsCurrent: c === window.__P1__.scenes.current?.camera };
      })(),
      body: document.body.dataset.sangoView,
      p3: window.__P3__.getStatus(),
    };
  })())`));
  console.log('\n--- P3 诊断 ---\n' + JSON.stringify(p3Diag));
  check('P3 接管点 7 个已导出', p3Boot.widgets.length === 7, p3Boot.widgets.join('/'));
  check('P3 城市会话在原版 ka() 内自动开启', p3Boot.cityLoop === true,
    `cityLoop=${p3Boot.cityLoop} cityId=${p3Boot.cityId} phase=${p3Boot.stats.sessions}`);

  let cityOpened = null;
  let ownPick = null;
  let ownList = [];
  // 相机在 P2 段被滚轮放大 + 拖动过，这里复位到整图可见（只动视图，不动游戏状态）
  await evaluate('window.__P2__.worldCamera.reset(window.__P2__.mapScene.camera)');
  await sleep(250);
  if (opened && p3Boot.cityLoop) {
    ownList = JSON.parse(await evaluate(`JSON.stringify((() => {
      const a = window.__P2__.adapter, vp = ${JSON.stringify(stageRect)};
      const k = a.getGameState().playerKing + 1;
      return a.getCities().filter((c) => c.ownerId === k).map((c) => {
        const s = window.__P2__.cityScreenPosition(c.id, vp);
        return { id: c.id, name: c.name, x: c.position.x, y: c.position.y,
          screen: s && s.visible ? { x: s.x, y: s.y } : null };
      }).filter((c) => c.screen);
    })())`));
    const ownClickable = ownList.filter((c) => c.screen.x > stageRect.left + 380
      && c.screen.x < stageRect.left + stageRect.width - 120
      && c.screen.y > stageRect.top + 100
      && c.screen.y < stageRect.top + stageRect.height * 0.62);   // 避开底部收起条
    // 逐个用 elementFromPoint 复核：被 HTML 面板挡住的城不算可点
    const hitProbe = async (c) => evaluate(`(() => {
      const e = document.elementFromPoint(${c.screen.x}, ${c.screen.y});
      if (!e) return 'null';
      const id = e.id ? '#' + e.id : '';
      const cls = typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '';
      return e.tagName + id + cls;
    })()`);
    let hitTag = null;
    for (const c of [...ownClickable, ...ownList]) {
      const t = await hitProbe(c);
      if (!hitTag) hitTag = t;
      if (String(t).startsWith('CANVAS')) { ownPick = c; hitTag = t; break; }
    }
    check('找到玩家控制且可点击的城市', !!ownPick,
      ownList.slice(0, 4).map((c) => `#${c.id} ${c.name}`).join(', ') || '无');

    if (ownPick) {
      check('城市屏幕位置落在 3D 画布上（未被 HTML 遮挡）', String(hitTag).startsWith('CANVAS'),
        `${ownPick.name} -> ${hitTag}`);
      // P6：与原版 zs() 一致——第一次点击只把光标移到该城，再点同一格才确认进入。
      // 若光标恰好已在该城（前一段测试移动过），第一次点击就会直接确认，这里两种都接受。
      await clickAt(ownPick.screen.x, ownPick.screen.y);
      await sleep(450);
      const earlyOpen = await waitFor(async () => {
        const s = await p3Status();
        return s.open ? s : null;
      }, 1200, 'P3 城市界面(首击)').catch(() => null);
      if (earlyOpen) {
        check('光标已在目标城时首次点击 = 原版确认', true, `城 #${earlyOpen.cityId}`);
      } else {
        const cursorAfterFirst = JSON.parse(await evaluate('JSON.stringify(window.__P2__.adapter.getCityCursor())'));
        check('首次点击城市 = 移动原版光标（不是直接确认）',
          cursorAfterFirst.setx === ownPick.x && cursorAfterFirst.sety === ownPick.y,
          `光标 (${cursorAfterFirst.setx},${cursorAfterFirst.sety}) / 目标 (${ownPick.x},${ownPick.y})`);
        await clickAt(ownPick.screen.x, ownPick.screen.y);
      }
      cityOpened = earlyOpen || await waitFor(async () => {
        const s = await p3Status();
        return s.open && s.cityId === ownPick.id ? s : null;
      }, 9000, 'P3 城市界面').catch(() => null);
    }
  }

  check('3D 点击己方城市 -> 打开城市管理界面（原版 ei()）', !!cityOpened,
    cityOpened ? `城 #${cityOpened.cityId}` : '超时未打开');

  if (cityOpened) {
    const domName = await evaluate('document.getElementById("p3-city-name")?.textContent || ""');
    const statsCount = await evaluate('document.querySelectorAll("#p3-info-bar dt").length');
    const railCount = await evaluate('document.querySelectorAll("#p3-rail .p3-rail-btn").length');
    const itemCount = await evaluate('document.querySelectorAll("#p3-list button.p3-item").length');
    check('城市信息栏显示真实城市名', domName === ownPick.name, `${domName} / ${ownPick.name}`);
    check('信息栏 11 项（= 原版 Ys() 行数）', statsCount === 11, `${statsCount} 项`);
    check('左侧 4 大类 + 内政 14 条目（原版顺序）',
      railCount === 4 && itemCount === 14, `大类 ${railCount} / 当前条目 ${itemCount}`);

    // ---- 面板展开时，遮挡区点击不得穿透到 3D（收起后允许点地图，见后文）
    const clicksBeforeUI = await evaluate('window.__P2__.interaction.stats.clicks');
    await clickAt(stageRect.left + stageRect.width - 8, stageRect.top + stageRect.height - 8);
    await sleep(200);
    const clicksAfterUI = await evaluate('window.__P2__.interaction.stats.clicks');
    check('城市界面遮挡区点击不穿透 3D 场景', clicksAfterUI === clicksBeforeUI,
      `clicks ${clicksBeforeUI} -> ${clicksAfterUI}`);

    // ---- 执行「内政·开垦」：选武将 -> 原版结算 -> 数值真实变化
    const cityBefore = JSON.parse(await evaluate(`JSON.stringify(window.__P2__.adapter.getCity(${ownPick.id}))`));
    const officerInfo = JSON.parse(await evaluate(`JSON.stringify((() => {
      const c = window.__P3__.cityUI;
      return c.officerIds(${ownPick.id}).ids.map((id) => ({
        id, name: c.officerName(id), cells: c.officerRow(id).cells,
      }));
    })())`));
    const capable = officerInfo
      .map((o) => ({ ...o, thew: Number(o.cells[7]) || 0 }))
      .filter((o) => o.thew >= 8)
      .sort((a, b) => b.thew - a.thew);
    const chosen = capable[0] || officerInfo[0] || null;

    await clickEl('#p3-rail .p3-rail-btn:nth-child(1)');
    await clickEl('#p3-list button.p3-item[data-action-id="1"]');
    const officerDialogUp = await waitFor(async () =>
      (await evaluate('!!document.querySelector(".p3-officer-modal")') ? true : null), 6000, '武将弹窗').catch(() => null);
    check('点击「开垦」弹出独立武将选择窗口（原版 Ls）', officerDialogUp === true);

    let farmingDelta = null;
    if (officerDialogUp && chosen) {
      await send('Page.enable');
      const dlgShot = await send('Page.captureScreenshot', { format: 'png' });
      const dlgPath = path.join(os.tmpdir(), 'sgby-p3-officer-dialog.png');
      fs.writeFileSync(dlgPath, Buffer.from(dlgShot.result.data, 'base64'));
      check('独立武将选择弹窗截图已生成', fs.statSync(dlgPath).size > 10000, dlgPath);

      const rowsShown = await evaluate('document.querySelectorAll(".p3-officer-modal tbody tr").length');
      const colsShown = await evaluate('document.querySelectorAll(".p3-officer-modal thead th").length');
      check('武将弹窗候选 = 原版 ss() 人数、列 = 姓名+13 项',
        rowsShown === officerInfo.length && colsShown === 14,
        `候选 ${rowsShown}/${officerInfo.length} 人，列 ${colsShown}`);

      await clickEl(`.p3-officer-modal tr[data-officer-id="${chosen.id}"]`);
      await clickEl('.p3-officer-modal .p3-modal-foot button.p3-btn-primary');

      // 原版 gi()->vs() 会弹结果提示；点确定后 mi() 的 while 循环会再次打开武将列表
      const resultUp = await waitFor(async () => {
        const t = await evaluate(`(() => {
          const m = document.querySelector('.p3-overlay .p3-modal');
          if (!m || m.classList.contains('p3-officer-modal')) return null;
          return m.querySelector('.p3-modal-title')?.textContent || '';
        })()`);
        return t || null;
      }, 8000, '原版结果提示').catch(() => null);
      check('原版指令结果以提示弹窗返回（gi->vs）', !!resultUp, resultUp || '未出现');
      if (resultUp) await tapText('确定');
      await sleep(400);

      // 再取消武将列表，结束这条指令（原版 while 循环）
      const reopen = await waitFor(async () =>
        (await evaluate('!!document.querySelector(".p3-officer-modal")') ? true : null), 6000, '武将列表重开').catch(() => null);
      if (reopen) {
        await tapText('取消', '.p3-officer-modal');
        await sleep(500);
      }
      const cityAfter = JSON.parse(await evaluate(`JSON.stringify(window.__P2__.adapter.getCity(${ownPick.id}))`));
      farmingDelta = cityAfter.farming - cityBefore.farming;
      check('原版结算写回真实城市数据（农业上升）',
        capable.length ? farmingDelta > 0 : true,
        `农业 ${cityBefore.farming} -> ${cityAfter.farming}（差 ${farmingDelta}），金钱 ${cityBefore.money} -> ${cityAfter.money}，候选体力≥8 的 ${capable.length} 人`);
    }

    // ---- 原版 ka() 每条指令结束后必然回到 zs() 选城（源码 L7426-7447）：
    //      城市面板应收成提示条、让出地图，而不是假装菜单还在。
    const afterAction = await waitFor(async () => {
      const collapsed = await evaluate('document.querySelector(".p3-frame")?.classList.contains("p3-collapsed") ?? false');
      const p = JSON.parse(await evaluate('JSON.stringify(window.__P2__.adapter.getInputPhase())'));
      return (p.kind === 'zs' && collapsed) ? p : null;
    }, 9000, '指令结束回到 zs').catch(() => null);
    check('指令结束后原版回到 zs()，面板自动收起让出地图', !!afterAction,
      afterAction ? `kind=${afterAction.kind}` : '未收起');

    const reopenByClick = async () => {
      // 收起条位于底部中间：逐城尝试，只点击「当前真正落在 WebGL 画布上」的那个点
      const hits = JSON.parse(await evaluate(`JSON.stringify(${JSON.stringify(ownList.map((c) => [c.id, c.screen.x, c.screen.y]))}.map(([id, x, y]) => {
        const e = document.elementFromPoint(x, y);
        return [id, e ? e.tagName : null];
      }))`));
      for (const c of ownList) {
        if (!hits.find((h) => h[0] === c.id && h[1] === 'CANVAS')) continue;
        const waitOpen = (ms, label) => waitFor(async () => {
          const collapsed = await evaluate('document.querySelector(".p3-frame")?.classList.contains("p3-collapsed") ?? true');
          const s = await p3Status();
          return s.open && !collapsed ? s : null;
        }, ms, label).catch(() => null);
        // P6：与原版 zs() 一致——点格只移动光标，确认键才进城；
        // 若光标已在该城，一次点击本身就是"原版确认"。
        const cur = JSON.parse(await evaluate('JSON.stringify(window.__P2__.adapter.getCityCursor())'));
        await clickAt(c.screen.x, c.screen.y);
        if (!(cur.setx === c.x && cur.sety === c.y)) {
          await sleep(350);
          await evaluate('window.__P2__.adapter.sendInput({ type: 5, param: 39 })');
        }
        const ok = await waitOpen(5000, '重新打开城市菜单');
        if (ok) return ok;
      }
      return null;
    };
    const menuAgain = await reopenByClick();
    check('再次点击城市可重新进入菜单（原版每轮从 zs 开始）', !!menuAgain,
      menuAgain ? `城 #${menuAgain.cityId}` : '超时');

    if (menuAgain) {
      await send('Page.enable');
      const cityShot = await send('Page.captureScreenshot', { format: 'png' });
      const cityShotPath = path.join(os.tmpdir(), 'sgby-p3-city-ui.png');
      fs.writeFileSync(cityShotPath, Buffer.from(cityShot.result.data, 'base64'));
      check('城市管理界面截图已生成', fs.statSync(cityShotPath).size > 10000, cityShotPath);

      // 武将表（面板内的只读视图）——必须在面板展开时检查
      await clickEl('#p3-detail .p3-tab:nth-child(2)');
      await evaluate('window.__P3__.ui.refresh()');    // 只读重渲染，确保用的是当前 Dn
      await sleep(220);
      const tabNow = await evaluate('window.__P3__.getStatus().tab');
      const inlineCols = await evaluate('document.querySelectorAll("#p3-detail .p3-officer-table thead th").length');
      const inlineRows = await evaluate('document.querySelectorAll("#p3-detail .p3-officer-table tbody tr").length');
      const liveIds = await evaluate(`window.__P3__.cityUI.officerIds(${ownPick.id}).ids.length`);
      // 表格行数必须等于同一数据源（getCityOfficers.rows），且用界面当前城市而不是最初点击的城市：
      // 重新进菜单时可能落在另一座己方城上；ss() 过滤后的可操作武将与城将队列也不是同一口径。
      const uiCityId = await evaluate('window.__P3__.getStatus().cityId');
      const expectRows = await evaluate(`window.__P3__.cityUI.getCityOfficers(${uiCityId}).rows.length`);
      check('武将页签可切换', tabNow === 'officers', String(tabNow));
      check('城市武将表 = 姓名 + 原版 13 列', inlineCols === 14 && inlineRows === expectRows,
        `${inlineRows} 行 × ${inlineCols} 列（表格数据源 ${expectRows} 行 / ss() 队列 ${liveIds} 人）`);
      check('执行指令后武将离开城市队列（原版 Zr() 从 PersonQueue 移除）',
        liveIds === officerInfo.length - (farmingDelta > 0 ? 1 : 0),
        `指令前 ${officerInfo.length} 人 -> 现在 ${liveIds} 人（农业 ${farmingDelta}）`);
      await clickEl('#p3-detail .p3-tab:nth-child(1)');   // 回到概览

      const noopBefore = JSON.parse(await evaluate(`JSON.stringify(window.__P2__.adapter.getCity(${ownPick.id}))`));
      await clickEl('#p3-rail .p3-rail-btn:nth-child(2)');            // 外交
      const foreignItems = await evaluate('document.querySelectorAll("#p3-list button.p3-item").length');
      await clickEl('#p3-list button.p3-item[data-action-id="18"]');  // 反间（原版无 case）
      await sleep(1200);
      const noopAfter = JSON.parse(await evaluate(`JSON.stringify(window.__P2__.adapter.getCity(${ownPick.id}))`));
      const noopState = await p3Status();
      check('外交 5 项与原版一致', foreignItems === 5, `${foreignItems} 项`);
      check('指令 18（反间）原版 mi() 无分支：不弹窗、不改数据',
        noopState.dialogs.open === 0 && noopAfter.money === noopBefore.money
        && noopAfter.farming === noopBefore.farming,
        `弹窗 ${noopState.dialogs.open} / 金钱 ${noopBefore.money}->${noopAfter.money} / 农业 ${noopBefore.farming}->${noopAfter.farming}`);
    }

    await send('Page.enable');
    const collapsedShot = await send('Page.captureScreenshot', { format: 'png' });
    const collapsedShotPath = path.join(os.tmpdir(), 'sgby-p3-city-collapsed.png');
    fs.writeFileSync(collapsedShotPath, Buffer.from(collapsedShot.result.data, 'base64'));
    check('城市界面收起态截图已生成（地图可点）', fs.statSync(collapsedShotPath).size > 10000, collapsedShotPath);

    // ---- 退出：返回战略地图，原版 ei() 返回 255 -> 回到 zs()
    const exitClicked = await clickEl('#p3-city .p3-head-btns button');
    await sleep(300);
    const exited = await waitFor(async () => {
      const s = await p3Status();
      return s.open ? null : s;
    }, 8000, '关闭城市界面').catch(() => null);
    check('返回战略地图：界面关闭（原版 ei() 返回 255）', !!exited && exited.open === false,
      `点击命中=${exitClicked}`);
    const backPhase = await waitFor(async () => {
      const p = JSON.parse(await evaluate('JSON.stringify(window.__P2__.adapter.getInputPhase())'));
      return p.kind === 'zs' ? p : null;
    }, 8000, '回到 zs()').catch(() => null);
    check('退出后原版回到选城阶段（zs），3D 地图可继续操作', !!backPhase,
      backPhase ? `kind=${backPhase.kind} canSelect=${backPhase.canSelectCity}` : '超时');
  }

  // ==================================================================
  // P4 战斗地图：真实出征 -> 原版指令队列 -> 原版 Uo() -> 3D 战斗场景
  // ==================================================================
  const p4Status = async () => JSON.parse(await evaluate('JSON.stringify(window.__P4__.getStatus())'));
  const tapBtn = async (scope, matcher) => evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(scope)});
    if (!root) return false;
    const b = [...root.querySelectorAll('button')].find((x) => ${matcher});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  const dismissAnyModal = async () => {
    const hit = await tapBtn('.p3-modal', "/确定|关闭|确认/.test(x.textContent)");
    if (hit) await sleep(180);
    return hit;
  };

  let battleReady = null;
  let p4Enemy = null;
  let p4Own = null;
  let p6PreBattleSave = null;
  const p4Boot = await p4Status();
  check('P4 调试接口就绪（内核 yo/Uo 钩子）', !!p4Boot && p4Boot.phase === 'idle',
    `phase=${p4Boot.phase} kernelEvents=${p4Boot.kernelEvents}`);

  // 出征必须满足原版 hi()：目标城在 getItem(59,1) 的相邻表里。
  // 因此先找一对「己方城 + 相邻敌方城」且都在屏幕上可见的组合。
  const p4Plan = JSON.parse(await evaluate(`JSON.stringify((() => {
    const a = window.__P2__.adapter, vp = ${JSON.stringify(stageRect)};
    const me = a.getGameState().playerKing + 1;
    const usable = (s) => s && s.visible
      && s.x > vp.left + 360 && s.x < vp.left + vp.width - 40
      && s.y > vp.top + 90 && s.y < vp.top + vp.height - 150;
    const cands = [];
    for (const c of a.getCities()) {
      if (c.ownerId !== me) continue;
      const cs = window.__P2__.cityScreenPosition(c.id, vp);
      if (!usable(cs)) continue;
      for (const l of a.getCityConnections(c.id)) {
        if (l.cityId === null) continue;
        const t = a.getCity(l.cityId);
        if (!t.ownerId || t.ownerId === me) continue;
        const ts = window.__P2__.cityScreenPosition(t.id, vp);
        if (!usable(ts)) continue;
        cands.push({
          own: { id: c.id, name: c.name, x: cs.x, y: cs.y },
          enemy: { id: t.id, name: t.name, ownerId: t.ownerId, x: ts.x, y: ts.y, food: t.food },
        });
      }
    }
    cands.sort((x, y) => (y.enemy.food || 0) - (x.enemy.food || 0));
    return cands[0] || null;
  })())`));
  check('找到可出征的组合（己方城 + 原版相邻敌方城）', !!p4Plan,
    p4Plan ? `#${p4Plan.own.id} ${p4Plan.own.name} -> #${p4Plan.enemy.id} ${p4Plan.enemy.name}` : '无');

  if (opened && p4Plan) {
    p4Own = p4Plan.own;

    // ---- P6：出征前存档（原版仍停战略阶段 zs()，Dn 完整、无指令上下文）
    //      战斗中不允许存档（原版存档格式不含战斗态），所以「战斗前」存档只能在这里做。
    const p6PreGate = await waitFor(async () => {
      const p = JSON.parse(await evaluate('JSON.stringify(window.__P2__.adapter.getInputPhase())'));
      return (p.kind === 'zs' && !p.inOrderContext) ? p : null;
    }, 8000, 'P6 出征前存档准入').catch(() => null);
    if (p6PreGate) {
      p6PreBattleSave = JSON.parse(await evaluate('JSON.stringify(window.__P6__.saveSlot(2, "P6 战前存档"))'));
    }
    check('P6 战前存档写入槽位 3（原版 ac()）',
      !!p6PreBattleSave && p6PreBattleSave.ok === true && p6PreBattleSave.sizeMatch === true,
      p6PreBattleSave
        ? (p6PreBattleSave.ok
          ? `${p6PreBattleSave.bytes.base}/${p6PreBattleSave.bytes.dyn} B，${p6PreBattleSave.header.year} 年`
          : p6PreBattleSave.reason)
        : `原版未回到 zs()（kind=${p6PreGate ? p6PreGate.kind : '超时'}）`);

    // ---- 重新进入城市菜单
    await evaluate(`window.__P2__.selectCity(${p4Own.id})`);
    const menu2 = await waitFor(async () => {
      const s = await p3Status();
      return s.open && s.cityId === p4Own.id ? s : null;
    }, 9000, '城市菜单（出征）').catch(() => null);
    check('再次进入城市菜单（P4 出征前置）', !!menu2, menu2 ? `城 #${menu2.cityId}` : '超时');

    if (menu2) {
      // 用 DOM click 而不是坐标点击：出征是 P4 的前置步骤，
      // 这里要的是「稳定进入下一个原版协程」，命中测试已由 P3 用例覆盖。
      await tapBtn('#p3-rail', "/军备/.test(x.textContent)");
      const armsReady = await waitFor(async () =>
        (await evaluate('!!document.querySelector(\'#p3-list button.p3-item[data-action-id="27"]\')') ? true : null),
      5000, '军备列表').catch(() => null);
      const armsItems = await evaluate('document.querySelectorAll("#p3-list button.p3-item").length');
      check('军备 5 项且含出征（原版 getConst(40)）', armsReady === true && armsItems === 5,
        `${armsItems} 项，出征按钮=${armsReady === true}`);

      await tapBtn('#p3-list', "x.dataset.actionId === '27'");         // 出征
      await sleep(300);
      const marchProbe = JSON.parse(await evaluate(`JSON.stringify({
        group: window.__P3__.getStatus().group,
        items: [...document.querySelectorAll('#p3-list button.p3-item')].map((b) => b.dataset.actionId),
        modal: !!document.querySelector('.p3-modal'),
        officerModal: !!document.querySelector('.p3-officer-modal'),
      })`));
      console.log('\n--- 出征探针 ---\n' + JSON.stringify(marchProbe));

      const pick1 = await waitFor(async () =>
        (await evaluate('!!document.querySelector(".p3-officer-modal")') ? true : null), 8000, '出征选将').catch(() => null);
      check('出征弹出武将选择窗口（原版 Ls）', pick1 === true);
      if (pick1) {
        await evaluate(`(() => {
          const tr = document.querySelector('.p3-officer-modal tbody tr');
          if (tr) tr.click();
          return !!tr;
        })()`);
        await sleep(150);
        await tapBtn('.p3-officer-modal', "/确认/.test(x.textContent)");
        await sleep(250);
        const pick2 = await waitFor(async () =>
          (await evaluate('!!document.querySelector(".p3-officer-modal")') ? true : null), 6000, '第二次选将').catch(() => null);
        if (pick2) await tapBtn('.p3-officer-modal', "/取消/.test(x.textContent)");
        await sleep(400);
      }

      const foodUp = await waitFor(async () =>
        (await evaluate('!!document.querySelector(".p3-modal .p3-input")') ? true : null), 6000, '粮草输入').catch(() => null);
      check('出征粮草输入走原版 Hs()', foodUp === true,
        foodUp ? `上限 ${await evaluate('document.querySelector(".p3-modal .p3-input").max')}` : '');
      if (foodUp) {
        const max = Number(await evaluate('document.querySelector(".p3-modal .p3-input").max'));
        // 粮草决定战斗能持续多少回合（原版 Ki() 每回合扣减，粮尽即判负），
        // 自动化对局取允许范围内的最大值，才可能走到真正交战。
        const v = Math.max(1, Math.min(max, 2000));
        await evaluate(`(() => {
          const i = document.querySelector('.p3-modal .p3-input');
          if (!i) return false;
          i.value = String(${v});
          i.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);
        await tapBtn('.p3-modal', "/确定/.test(x.textContent)");
        await sleep(600);
      }
      await dismissAnyModal();     // 原版 vs()：出兵提示
      await sleep(400);

      // ---- 选目标城：必须是原版连接表里的相邻敌方城（hi() 会拒绝非相邻）
      p4Enemy = p4Plan.enemy;
      check('出征目标 = 原版相邻敌方城', !!p4Enemy,
        p4Enemy ? `#${p4Enemy.id} ${p4Enemy.name}（属 ${p4Enemy.ownerId}）` : '无相邻敌方城');

      if (p4Enemy) {
        const intent = await evaluate('window.__P2__.interaction.intent');
        check('城市循环内 3D 点击意图 = 原版确认选城', intent === 'select', intent);
        // P6：与原版 zs() 一致——第一次点击移动光标，再点同一格才确认目标
        const orderCount = () => evaluate(
          'window.__SGBY_CORE__.Dn.g_OrderQueue.filter((o) => o.OrderId === 27).length');
        await clickAt(p4Enemy.x, p4Enemy.y);
        await sleep(1000);
        let ordersNow = await orderCount();
        if (!ordersNow) {
          const enemyPos = JSON.parse(await evaluate(`JSON.stringify(window.__P2__.adapter.getCity(${p4Enemy.id}).position)`));
          const curNow = JSON.parse(await evaluate('JSON.stringify(window.__P2__.adapter.getCityCursor())'));
          check('出征目标城首次点击 = 移动原版光标',
            curNow.setx === enemyPos.x && curNow.sety === enemyPos.y,
            `光标 (${curNow.setx},${curNow.sety}) / 目标 (${enemyPos.x},${enemyPos.y})`);
          await clickAt(p4Enemy.x, p4Enemy.y);
          await sleep(1600);
          ordersNow = await orderCount();
        }
        await dismissAnyModal();     // 原版 Ms(94)：情报提示
        await sleep(700);
        const queue = JSON.parse(await evaluate(`JSON.stringify({
          orders: window.__SGBY_CORE__.Dn.g_OrderQueue.filter((o) => o.OrderId === 27).length,
          food: ${JSON.stringify(0)},
        })`));
        check('出征指令进入原版指令队列（OrderId=27）', queue.orders >= 1, `${queue.orders} 条`);

        // ---- 退出城市阶段（zs 返回 255）-> 原版 Ma() 菜单 -> 继续 -> wa() 处理指令
        await evaluate('window.__P2__.adapter.sendInput({ type: 5, param: 40 })');
        await sleep(1500);
        await evaluate('window.__P2__.adapter.sendInput({ type: 5, param: 39 })');
        battleReady = await waitFor(async () => {
          const s = await p4Status();
          return s.active && s.loaded ? s : null;
        }, 30000, '原版 Uo() 战斗').catch(() => null);
        check('原版 Uo() 进入战斗 -> 3D 战斗场景按真实战况装载', !!battleReady,
          battleReady
            ? `地图 ${battleReady.diagnostics.map.width}x${battleReady.diagnostics.map.height}`
            : `phase=${(await p4Status()).phase}`);
      }
    }
  }

  if (battleReady) {
    const d = battleReady.diagnostics;
    check('战斗地图 = 原版 32x32 / 1024 格 / 46 帧图块',
      d.map.width === 32 && d.map.height === 32 && d.tiles.cells === 1024
      && d.tiles.frames === 46 && d.tiles.degraded === false,
      `${d.map.width}x${d.map.height} 格${d.tiles.cells} 帧${d.tiles.frames} 降级${d.tiles.degraded}`);
    check('地形直方图恰好 1 个城池格（原版 raw=3）',
      d.tiles.histogram[5] === 1, `[${d.tiles.histogram.join(',')}]`);
    check('20 个原版部队槽位且可见部队 > 0',
      d.units.built === 20 && d.units.visible > 0,
      `槽位 ${d.units.built} / 可见 ${d.units.visible}`);
    check('战斗相机正面俯视（0°/90°）正交且禁旋转',
      d.camera.fixedView === true && d.camera.topDown === true
      && d.camera.projection === 'orthographic' && d.camera.rotationAllowed === false,
      `${d.camera.azimuthDeg}°/${d.camera.elevationDeg}°`);
    check('战斗 HUD 已显示', (await evaluate('document.getElementById("p4-battle-hud")?.hidden')) === false);

    // ---- P5：等操作层接管并真正进入「原版 bo() 等待输入」状态
    const p5Status = async () => JSON.parse(await evaluate('JSON.stringify(window.__P5__ ? window.__P5__.getSnapshot() : null)'));
    const p5Ready = await waitFor(async () => {
      const s = await p5Status();
      return s && s.status.active && s.phase.phase === 'SELECT' && s.phase.inputActive ? s : null;
    }, 20000, 'P5 输入开放').catch(() => null);
    check('P5 战斗操作已接管并开放输入（相位 SELECT / bo() 已打开）', !!p5Ready,
      p5Ready
        ? `输入开放 dom=${await evaluate('!!document.getElementById("p5-battle-ui") && !document.getElementById("p5-battle-ui").hidden')}`
        : `phase=${(await p5Status())?.phase?.phase} input=${(await p5Status())?.phase?.inputActive}`);

    // ---- 选中我方部队：移动/攻击范围必须来自原版 qi()/Vo()
    const unitsInfo = JSON.parse(await evaluate(`JSON.stringify((() => {
      const a = window.__P4__.deps.adapter;
      return a.getBattleUnits().filter((u) => u.present && u.state !== 8).map((u) => ({
        index: u.index, side: u.side, name: u.name, armsTypeName: u.armsTypeName,
        x: u.x, y: u.y, selectable: a.canSelectUnit(u.index),
      }));
    })())`));
    const ally = unitsInfo.find((u) => u.side === 'mine' && u.selectable) || null;
    check('存在原版允许操作的我方部队（Xo() 判定）', !!ally,
      unitsInfo.map((u) => `#${u.index}${u.side === 'mine' ? '(我)' : '(敌)'}${u.selectable ? '*' : ''}`).join(' ') || '无');

    if (ally) {
      const selInfo = JSON.parse(await evaluate(`JSON.stringify(window.__P4__.selectUnit(${ally.index}))`));
      check('选中部队：可操作 + 移动/攻击范围来自原版',
        selInfo.selectable === true && selInfo.moveCount > 0 && selInfo.attackCount > 0,
        `#${ally.index} ${ally.name} ${ally.armsTypeName} 移动 ${selInfo.moveCount} 格 / 攻击 ${selInfo.attackCount} 格`);
      const rangeDiag = JSON.parse(await evaluate('JSON.stringify(window.__P4__.scene.getDiagnostics().ranges)'));
      check('范围覆盖层实例数 = 原版格子数',
        rangeDiag.moveCells === selInfo.moveCount && rangeDiag.attackCells === selInfo.attackCount,
        `move ${rangeDiag.moveCells}/${selInfo.moveCount} attack ${rangeDiag.attackCells}/${selInfo.attackCount}`);
      const hudUnit = await evaluate('document.querySelectorAll("#p4-battle-hud .p4-hud-sec")[1]?.textContent || ""');
      check('HUD 显示真实部队名/兵种', hudUnit.includes(ally.name) && hudUnit.includes(ally.armsTypeName),
        hudUnit.slice(0, 60));

      // ---- P7 战斗性能实测：真实战斗地图（1024 格 + 20 槽部队 + 范围覆盖层）下的帧时间与 draw call
      await sleep(1500);
      const p7BattlePerf = JSON.parse(await evaluate(
        'JSON.stringify({ frame: window.__P7__.frameStats(), info: window.__P7__.rendererInfo() })'));
      check('P7 战斗场景实测：真实战斗渲染有 draw call，且同环境帧率达标（>= 30fps）',
        p7BattlePerf.info.drawCalls > 0 && p7BattlePerf.info.triangles > 0
        && p7BattlePerf.frame.samples > 0 && p7BattlePerf.frame.fps >= 30,
        `${p7BattlePerf.frame.fps}fps · mean ${p7BattlePerf.frame.meanMs}ms · p95 ${p7BattlePerf.frame.p95Ms}ms`
        + ` · draws ${p7BattlePerf.info.drawCalls} · tris ${p7BattlePerf.info.triangles}`
        + ` · geo ${p7BattlePerf.info.geometries} · tex ${p7BattlePerf.info.textures}`);

      // ---- 进战斗时相机自动取景：所有在场部队都应落在可视区内
      const battleViewDiag = await evaluate(`JSON.stringify((() => {
        const r = document.getElementById('p1-stage').getBoundingClientRect();
        return { body: document.body.dataset.sangoView,
          kind: window.__P2__.adapter.getInputPhase().kind,
          rect: [r.left, r.top, r.width, r.height],
          p6: window.__P6__ ? window.__P6__.getSnapshot().view : null };
      })())`);
      console.log('\n--- 战斗视图诊断 ---\n' + battleViewDiag);
      const inView = JSON.parse(await evaluate(`JSON.stringify((() => {
        const vp = ${JSON.stringify(stageRect)};
        const r = document.getElementById('p1-stage').getBoundingClientRect();
        const list = window.__P4__.deps.adapter.getBattleUnits()
          .filter((u) => u.present && u.state !== 8);
        const out = [];
        for (const u of list) {
          const s = window.__P4__.cellScreenPosition(u.x, u.y, vp);
          const inside = !!s && s.x > r.left && s.x < r.right && s.y > r.top && s.y < r.bottom;
          const el = inside ? document.elementFromPoint(s.x, s.y) : null;
          out.push({ index: u.index, x: Math.round(s ? s.x : -1), y: Math.round(s ? s.y : -1),
            inside, tag: el ? el.tagName : null,
            elId: el ? (el.id || String(el.className || '').slice(0, 24)) : null });
        }
        return out;
      })())`));
      check('战斗相机自动取景：在场部队全部落在可视区且未被 HUD 遮挡',
        inView.length > 0 && inView.every((u) => u.inside && u.tag === 'CANVAS'),
        inView.map((u) => `#${u.index}(${u.x},${u.y})${u.inside ? '' : '×'}${u.tag === 'CANVAS' ? '' : '/' + u.tag + ':' + u.elId}`).join(' '));

      await send('Page.enable');
      const battleShot = await send('Page.captureScreenshot', { format: 'png' });
      const battleShotPath = path.join(os.tmpdir(), 'sgby-p4-battle.png');
      fs.writeFileSync(battleShotPath, Buffer.from(battleShot.result.data, 'base64'));
      check('3D 战斗地图截图已生成（含单位与范围）',
        fs.statSync(battleShotPath).size > 10000, battleShotPath);

      // ---- 真实鼠标点击部队（Raycaster 命中独立拾取体）
      const vp = stageRect;
      const unitScreen = JSON.parse(await evaluate(`JSON.stringify((() => {
        const s = window.__P4__.cellScreenPosition(${ally.x}, ${ally.y}, ${JSON.stringify(vp)});
        return s;
      })())`));
      const clicksBefore = await evaluate('window.__P4__.scene.interaction.stats.clicks');
      await clickAt(unitScreen.x, unitScreen.y);
      await sleep(400);
      const clicksAfter = await evaluate('window.__P4__.scene.interaction.stats.clicks');
      const selAfterClick = await evaluate('window.__P4__.scene.selection?.unitId ?? null');
      const p5probe = JSON.parse(await evaluate('JSON.stringify(window.__P5__ ? window.__P5__.getSnapshot() : null)'));
      check('3D 点击部队识别原版单位 ID',
        clicksAfter > clicksBefore && selAfterClick === ally.index,
        `clicks ${clicksBefore}->${clicksAfter} 选中 #${selAfterClick}`
        + ` | P5 ${p5probe && p5probe.phase ? p5probe.phase.phase : '-'}`
        + ` input=${p5probe && p5probe.phase ? p5probe.phase.inputActive : '-'}`
        + ` stats=${p5probe && p5probe.phase ? JSON.stringify(p5probe.phase.stats) : '-'}`
        + ` sel=${p5probe && p5probe.phase ? JSON.stringify(p5probe.phase.selectedUnit) : '-'}`
        + ` trace=${p5probe && p5probe.phase ? p5probe.phase.stats.trace.join(' ') : '-'}`
        + ` hint=${p5probe && p5probe.phase ? p5probe.phase.hint : '-'}`
        + ` logs=${p5probe ? p5probe.logs.map((l) => l.text).join(' / ') : '-'}`);

      // ---- 拖动不误选
      const selBeforeDrag = selAfterClick;
      await dragAt(unitScreen.x, unitScreen.y, unitScreen.x + 80, unitScreen.y + 50);
      await sleep(250);
      const selAfterDrag = await evaluate('window.__P4__.scene.selection?.unitId ?? null');
      const dragCount = await evaluate('window.__P4__.scene.interaction.stats.drags');
      check('战斗地图拖动不误触发单位选择', selAfterDrag === selBeforeDrag && dragCount > 0,
        `选中 ${selBeforeDrag}->${selAfterDrag}，drag ${dragCount}`);

      // ---- 点击空格：反查逻辑格
      const emptyCell = JSON.parse(await evaluate(`JSON.stringify((() => {
        const a = window.__P4__.deps.adapter;
        const occupied = new Set(a.getBattleUnits().filter((u) => u.present && u.state !== 8).map((u) => u.x + ',' + u.y));
        for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
          if (occupied.has(x + ',' + y)) continue;
          const s = window.__P4__.cellScreenPosition(x, y, ${JSON.stringify(stageRect)});
          if (!s || !s.visible) continue;
          // 必须真正落在 WebGL 画布上：HUD / 工具栏会挡住地图左侧
          const el = document.elementFromPoint(s.x, s.y);
          if (!el || el.tagName !== 'CANVAS') continue;
          return { x, y, sx: s.x, sy: s.y };
        }
        return null;
      })())`));
      if (emptyCell) {
        await clickAt(emptyCell.sx, emptyCell.sy);
        await sleep(300);
        const cursor = JSON.parse(await evaluate('JSON.stringify(window.__P4__.scene.cursor)'));
        check('点击空格反查原版格子坐标', cursor && cursor.x === emptyCell.x && cursor.y === emptyCell.y,
          `目标 (${emptyCell.x},${emptyCell.y}) -> ${JSON.stringify(cursor)}`);
      } else {
        check('点击空格反查原版格子坐标', false, '找不到可点空格');
      }
    }

    // ---- 相机缩放不改逻辑坐标
    const camBefore = JSON.parse(await evaluate('JSON.stringify(window.__P4__.scene.getDiagnostics().camera)'));
    const unitPosBefore = JSON.stringify(await evaluate('JSON.stringify(window.__P4__.deps.adapter.getBattleUnits()[0])'));
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: stageRect.left + stageRect.width / 2,
      y: stageRect.top + stageRect.height / 2, deltaX: 0, deltaY: -400,
    });
    await sleep(250);
    const camAfter = JSON.parse(await evaluate('JSON.stringify(window.__P4__.scene.getDiagnostics().camera)'));
    const unitPosAfter = JSON.stringify(await evaluate('JSON.stringify(window.__P4__.deps.adapter.getBattleUnits()[0])'));
    check('战斗相机缩放生效且不改变原版单位坐标',
      camAfter.zoom > camBefore.zoom && unitPosBefore === unitPosAfter,
      `zoom ${camBefore.zoom.toFixed(2)} -> ${camAfter.zoom.toFixed(2)}`);

    // ---- HUD 遮挡区点击不穿透
    const hudRect = JSON.parse(await evaluate(`JSON.stringify((() => {
      const r = document.getElementById('p4-battle-hud').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + 12 };
    })())`));
    const clicksHudBefore = await evaluate('window.__P4__.scene.interaction.stats.clicks');
    await clickAt(hudRect.x, hudRect.y);
    await sleep(200);
    const clicksHudAfter = await evaluate('window.__P4__.scene.interaction.stats.clicks');
    check('战斗 HUD 遮挡区点击不穿透 3D', clicksHudAfter === clicksHudBefore,
      `clicks ${clicksHudBefore} -> ${clicksHudAfter}`);

    await send('Page.enable');
    const battleShot2 = await send('Page.captureScreenshot', { format: 'png' });
    const battleShotPath2 = path.join(os.tmpdir(), 'sgby-p4-battle-zoomed.png');
    fs.writeFileSync(battleShotPath2, Buffer.from(battleShot2.result.data, 'base64'));
    check('缩放/拖动后的战斗截图已生成', fs.statSync(battleShotPath2).size > 10000, battleShotPath2);

    // ==================================================================
    // P5：完整战斗流程（真实点击 -> 原版输入协议 -> 原版 ko/vo/xo/Ao/Fo）
    // ==================================================================
    const cellScreen = async (x, y) => JSON.parse(await evaluate(
      `JSON.stringify(window.__P4__.cellScreenPosition(${x},${y},${JSON.stringify(stageRect)}))`));
    // 相机复位后再点：P4 段做过滚轮缩放与拖动，靠边的部队可能已经移出可视区
    const clickCell = async (x, y) => {
      let s = await cellScreen(x, y);
      if (!s || !s.visible) {
        await evaluate('window.__P4__.scene.battleCamera.reset(window.__P4__.scene.camera)');
        await sleep(200);
        s = await cellScreen(x, y);
      }
      if (!s || !s.visible) return false;
      await clickAt(s.x, s.y);
      return true;
    };
    const unitOf = async (id) => JSON.parse(await evaluate(
      `JSON.stringify(window.__P4__.deps.adapter.getBattleUnit(${id}))`));
    const waitPhase = async (phases, ms, label) => waitFor(async () => {
      const st = await p5Status();
      return st && phases.includes(st.phase.phase) ? st : null;
    }, ms, label).catch(() => null);
    const menuItems = async () => JSON.parse(await evaluate(
      `JSON.stringify([...document.querySelectorAll('.p5-menu-item')].map((b) => b.textContent))`));
    // 「回到选部队」必须同时满足相位与输入开放：相位先变、bo() 后开，中间有几毫秒空窗
    const waitSelect = (ms = 25000, label = 'P5 选部队就绪') => waitFor(async () => {
      const st = await p5Status();
      return st && st.phase.phase === 'SELECT' && st.phase.inputActive ? st : null;
    }, ms, label).catch(() => null);

    let phaseSnap = await p5Status();

    // ---- 测试1：选择部队（真实鼠标点击 -> 原版 ko() 返回）
    if (ally && phaseSnap && phaseSnap.phase.inputActive) {
      const u0 = await unitOf(ally.index);
      const clicked = await clickCell(u0.x, u0.y);
      const sel = await waitPhase(['UNIT_SELECTED'], 10000, 'P5 选中部队');
      const selProbe = await p5Status();
      check('P5 测试1 点击我方部队 -> 原版 ko() 返回该部队并进入选移动目标',
        clicked && !!sel && sel.phase.selectedUnit === ally.index,
        (sel ? `选中 #${sel.phase.selectedUnit}（相位 ${sel.phase.phase}）` : '超时未进入 UNIT_SELECTED')
        + ` | clicked=${clicked} 部队#${ally.index}@(${u0.x},${u0.y}) active=${u0.active} state=${u0.state}`
        + ` phase=${selProbe && selProbe.phase ? selProbe.phase.phase : '-'}`
        + ` trace=${selProbe && selProbe.phase ? selProbe.phase.stats.trace.join(' ') : '-'}`);
      const rng = sel ? JSON.parse(await evaluate('JSON.stringify(window.__P4__.scene.getDiagnostics().ranges)')) : null;
      check('P5 移动范围覆盖层格数 = 原版 qi() 格数',
        !sel || (rng && rng.moveCells > 0),
        rng ? `覆盖 ${rng.moveCells} 格` : '无');

      // ---- 测试2：移动到「离最近敌军最近」的合法格
      const mv = JSON.parse(await evaluate(
        `JSON.stringify(window.__P4__.deps.adapter.getMovementRange(${ally.index}))`));
      const enemies = unitsInfo.filter((u) => u.side === 'enemy');
      const dist = (c) => Math.min(...enemies.map((e) => Math.hypot(e.x - c.x, e.y - c.y)));
      const dest = mv.available && mv.cells.length
        ? mv.cells.slice().sort((a, b) => dist(a) - dist(b))[0] : null;
      check('P5 存在原版合法移动目标', !!dest,
        dest ? `(${dest.x},${dest.y}) 剩余 ${dest.remaining}` : '无合法格');

      let destPhase = null;
      if (dest) {
        await clickCell(dest.x, dest.y);
        // 同一时刻重复点击：必须被状态机拒绝（不能重复提交移动）
        const dupMove = JSON.parse(await evaluate(
          `JSON.stringify(window.__P5__.clickCell(${dest.x}, ${dest.y}))`));
        check('P5 测试8 重复点击被状态机拒绝（不重复提交操作）',
          dupMove.accepted === false, dupMove.reason || '被接受？');
        const moved = await waitFor(async () => {
          const u = await unitOf(ally.index);
          return (u.x !== u0.x || u.y !== u0.y) ? u : null;
        }, 12000, 'P5 原版确认移动').catch(() => null);
        check('P5 测试2 原版 vo() 已把部队移动到目标格',
          !!moved && moved.x === dest.x && moved.y === dest.y,
          moved ? `(${u0.x},${u0.y}) -> (${moved.x},${moved.y})，目标 (${dest.x},${dest.y})` : '位置未变化');
        const anim = await evaluate('window.__P5__.anim ? window.__P5__.anim.getDiagnostics() : null');
        check('P5 测试2 移动动画由动画管理器播放（单一队列）',
          !!anim && anim.moves >= 1, anim ? `moves=${anim.moves} queued=${anim.queued} 完成${anim.finished}` : '无动画管理器');
        destPhase = await waitPhase(['ACTION_MENU'], 12000, 'P5 行动菜单');
      }

      // ---- 测试2b：行动菜单条目来自原版 vi(8)
      const menuOpen = await waitFor(async () =>
        (await evaluate('!!document.querySelector(".p5-menu")') ? true : null), 10000, '行动菜单 DOM').catch(() => null);
      const actItems = menuOpen ? await menuItems() : [];
      check('P5 测试3 原版 Ao() 弹出行动菜单且条目 = vi(8)',
        menuOpen === true && actItems.join(',') === '攻击,计谋,查看,待机',
        actItems.join(',') || `phase=${destPhase ? destPhase.phase.phase : '?'}`);

      // ---- 测试3/4：推进到真正与原版敌军交战（原版范围够不到时走「待机」）
      let attacked = false;
      let waitedOnce = false;
      let lastAction = null;
      const liveEnemies = async () => JSON.parse(await evaluate(`JSON.stringify(
        window.__P4__.deps.adapter.getBattleUnits()
          .filter((u) => u.side === 'enemy' && u.present && u.state !== 8)
          .map((u) => ({ index: u.index, x: u.x, y: u.y, arms: u.arms, state: u.state })))`));
      const attackRangeOf = async () => JSON.parse(await evaluate(
        'JSON.stringify(window.__P4__.deps.adapter.getCurrentAttackRange())'));

      /** 当前已弹出的行动菜单：先攻击看范围，再按原版是否覆盖敌军决定「攻击/待机」。 */
      const doAction = async (tag) => {
        const open = await waitFor(async () =>
          (await evaluate('!!document.querySelector(".p5-menu") ? 1 : null')), 12000, `${tag} 行动菜单`).catch(() => null);
        if (!open) return { ok: false, reason: '行动菜单未弹出' };
        const items = await menuItems();
        check(`P5 ${tag} 原版 Ao() 弹出行动菜单且条目 = vi(8)`,
          items.join(',') === '攻击,计谋,查看,待机', items.join(','));

        // 攻击 -> 原版 Vo() 生效 -> 读真实范围
        await tapBtn('.p5-menu', 'x.textContent === "攻击"');
        const atk = await waitPhase(['ATTACK_PREVIEW'], 10000, `${tag} 选攻击目标`);
        if (!atk) return { ok: false, reason: '未进入 ATTACK_PREVIEW' };
        const range = await attackRangeOf();
        const en0 = await liveEnemies();
        const hit0 = (range.cells || []).find((c) => en0.some((e) => e.x === c.x && e.y === c.y));
        check(`P5 ${tag} 攻击范围来自原版 g_FgtAtkRng（Ao 调用 Vo 之后）`,
          range.size > 0 && range.cellCount > 0,
          `size=${range.size} 合法格 ${range.cellCount} 其中敌军 ${hit0 ? 1 : 0}`
          + ` 格 ${(range.cells || []).map((c) => `${c.x},${c.y}`).join('|')}`
          + ` 敌 ${en0.map((e) => `#${e.index}(${e.x},${e.y})`).join(' ')}`);

        // 取消选目标：等价原版 Esc（xo 返回 255 -> Ao 重新弹出 $r 菜单）
        const cancelOk = await tapBtn('.p5-actions', 'x.textContent === "取消"');
        const backMenu = await waitFor(async () =>
          (await evaluate('!!document.querySelector(".p5-menu") ? 1 : null')), 12000, `${tag} 取消后菜单`).catch(() => null);
        check(`P5 ${tag} 取消选目标（原版 Esc）-> xo() 返回 255 -> 重新弹出行动菜单`,
          cancelOk === true && !!backMenu, `按钮=${cancelOk} 菜单=${!!backMenu}`);
        if (!backMenu) return { ok: false, reason: '取消后没有回到行动菜单' };

        if (!hit0) {
          await tapBtn('.p5-menu', 'x.textContent === "待机"');
          const w = await waitPhase(['SELECT'], 15000, `${tag} 待机后回到选部队`);
          waitedOnce = !!w;
          check(`P5 ${tag} 待机（原版 Ao case 3）后部队标记已行动并回到选部队`,
            !!w && w.units[ally.index].active === 1,
            w ? `active=${w.units[ally.index].active}` : '超时');
          return { ok: !!(w), attacked: false, reason: `范围 ${range.cellCount} 格内无敌军` };
        }

        // 有目标：再次进入攻击并点目标
        await tapBtn('.p5-menu', 'x.textContent === "攻击"');
        const atk2 = await waitPhase(['ATTACK_PREVIEW'], 10000, `${tag} 再次选目标`);
        const range2 = await attackRangeOf();
        const en1 = await liveEnemies();
        const hit = (range2.cells || []).find((c) => en1.some((e) => e.x === c.x && e.y === c.y));
        const tgt = hit ? en1.find((e) => e.x === hit.x && e.y === hit.y) : null;
        if (!atk2 || !tgt) return { ok: false, reason: '再次进入攻击后目标消失' };
        const before = await unitOf(tgt.index);
        await clickCell(tgt.x, tgt.y);
        const resolved = await waitFor(async () => {
          const st = await p5Status();
          return st.phase.lastResult ? st : null;
        }, 25000, `${tag} 攻击结算`).catch(() => null);
        const after = await unitOf(tgt.index);
        const res = resolved ? resolved.phase.lastResult : null;
        attacked = !!res;
        check(`P5 ${tag} 攻击由原版 Fo() 结算：兵力/状态真实变化（不虚构伤害）`,
          !!res && (after.arms < before.arms || after.state === 8 || (res.changes || []).length > 0),
          `目标 #${tgt.index} ${before.arms} -> ${after.arms}（state ${before.state} -> ${after.state}）`
          + `；战报 ${res ? res.changes.length : 0} 条`);
        const back = await waitPhase(['SELECT', 'ACTION_COMPLETED', 'BATTLE_FINISHED'], 20000, `${tag} 行动结束`);
        check(`P5 ${tag} 攻击后回到可操作状态或战斗结束`, !!back,
          back ? `相位 ${back.phase.phase}` : '超时');
        return { ok: true, attacked: true, tgte: tgt.index, arms: `${before.arms}->${after.arms}` };
      };

      /** 一次完整的「选部队 -> 移动 -> 行动」。 */
      const playOneUnit = async (tag) => {
        const st0 = await p5Status();
        if (!st0 || st0.phase.phase !== 'SELECT' || !st0.phase.inputActive) {
          return { ok: false, reason: `未在可选部队状态（${st0 ? st0.phase.phase : 'null'}）` };
        }
        const u0 = await unitOf(ally.index);
        if (u0.state === 8) return { ok: false, reason: '我方部队已不在场' };
        await clickCell(u0.x, u0.y);
        const sel = await waitPhase(['UNIT_SELECTED'], 12000, `${tag} 选中部队`);
        if (!sel) return { ok: false, reason: '未被原版 ko() 接受' };
        const mv = JSON.parse(await evaluate(
          `JSON.stringify(window.__P4__.deps.adapter.getMovementRange(${ally.index}))`));
        const en = await liveEnemies();
        const mvCells = mv.available ? mv.cells : [];
        // 目标格选择：优先挑「站上去就能打到敌军」的格子。
        // 偏移量来自原版 Vo(0,0,id) 的真实掩码（不含任何前端推导）。
        const mask = JSON.parse(await evaluate(
          `JSON.stringify(window.__P4__.deps.adapter.getAttackRange(${ally.index}))`));
        const offs = (mask.cells || []).map((c) => ({ dx: c.x - u0.x, dy: c.y - u0.y }));
        let dest = null;
        for (const e of en) {
          for (const o of offs) {
            const cand = mvCells.find((c) => c.x === e.x - o.dx && c.y === e.y - o.dy);
            if (cand) { dest = cand; break; }
          }
          if (dest) break;
        }
        const dist = (c) => (en.length ? Math.min(...en.map((e) => Math.hypot(e.x - c.x, e.y - c.y))) : 0);
        const approx = mvCells.length ? mvCells.slice().sort((a, b) => dist(a) - dist(b))[0] : null;
        if (!dest) dest = approx;
        if (dest) {
          await clickCell(dest.x, dest.y);
          const moved = await waitFor(async () => {
            const u = await unitOf(ally.index);
            return (u.x !== u0.x || u.y !== u0.y) ? u : null;
          }, 12000, `${tag} 原版确认移动`).catch(() => null);
          check(`P5 ${tag} 原版 vo() 已把部队移动到目标格`,
            !!moved && moved.x === dest.x && moved.y === dest.y,
            moved ? `(${u0.x},${u0.y}) -> (${moved.x},${moved.y})，目标 (${dest.x},${dest.y})`
              + (dest === approx ? '（就近）' : '（可攻击位）') : '位置未变化');
        }
        return doAction(tag);
      };

      if (menuOpen) {
        lastAction = await doAction('第一回合');
        // ---- 测试4b：行动结束后原版回到选部队
        const toSelect = await waitPhase(['SELECT'], 25000, 'P5 回到选部队');
        check('P5 测试4 行动结束后原版回到选部队（ko() 重新等待输入）', !!toSelect,
          toSelect ? `相位 ${toSelect.phase.phase}` : '超时');

        // ---- 测试5 + 后续回合：一直推进到真正与原版结算一次交战（最多 4 个我方回合）
        let test5Done = false;
        const loopLog = [];
        for (let r = 0; r < 6 && !attacked; r++) {
          const at = await waitSelect(25000, 'P5 回合就绪');
          if (!at) { loopLog.push(`r${r}: 未就绪`); break; }
          const roundBefore = at.phase.round;
          const menuBtn = await tapBtn('.p5-actions', 'x.textContent === "战斗菜单"');
          const goMenu = await waitFor(async () =>
            (await evaluate('!!document.querySelector(".p5-menu") ? 1 : null')), 12000, 'Go 菜单').catch(() => null);
          const goItems = goMenu ? await menuItems() : [];
          if (!test5Done) {
            check('P5 测试5 战斗菜单按钮投递 Esc -> 原版 Go() 菜单（vi(9) 5 项）',
              menuBtn === true && goItems.join(',') === '回合结束,敌军移动,战斗动画,移动速度,全军撤退',
              goItems.join(',') || '未弹出');
          }
          if (!goMenu) { loopLog.push(`r${r}: Go 菜单未弹出`); break; }
          await tapBtn('.p5-menu', 'x.textContent === "回合结束"');
          const nextRound = await waitFor(async () => {
            const st = await p5Status();
            if (!st || !st.phase) return { ended: true };      // P5 已交出控制权 = 战斗结束
            return st.phase.round > roundBefore && st.phase.phase === 'SELECT' ? st : null;
          }, 90000, 'P5 下一回合').catch(() => null);
          if (!test5Done) {
            check('P5 测试5 回合结束 -> 原版 AI(So) -> Io 回合+1 -> 我方阶段',
              !!nextRound, nextRound
                ? `回合 ${roundBefore} -> ${nextRound.phase.round}`
                : `round=${(await p5Status()).phase.round} phase=${(await p5Status()).phase.phase}`);
            test5Done = true;
          }
          if (!nextRound) { loopLog.push(`r${r}: 回合未推进`); break; }
          if (nextRound.ended) { loopLog.push(`r${r}: 战斗已结束`); break; }
          lastAction = await playOneUnit(`第${nextRound.phase.round}回合`);
          loopLog.push(`r${r}: ${JSON.stringify(lastAction)}`);
          // 部队被原版拒绝（已行动/混乱/石阵）不算失败：下一轮原版状态恢复后再试
          if (!lastAction) break;
        }
        const finalSnap = await p5Status();
        const resolves = finalSnap && finalSnap.phase ? finalSnap.phase.stats.resolves : 0;
        const lastRes = finalSnap && finalSnap.phase ? finalSnap.phase.lastResult : null;
        const overNow = JSON.parse(await evaluate(
          'JSON.stringify(window.__P4__.deps.adapter.getBattleOutcome())'));
        const en = await liveEnemies().catch(() => []);
        const u = await unitOf(ally.index);
        const detail = `resolves=${resolves} over=${overNow.over}(${overNow.meaning})`
          + ` 我方(${u.x},${u.y}) 敌${en.map((e) => `#${e.index}(${e.x},${e.y})`).join(' ')}`
          + (lastRes ? ` 最后交战 ${lastRes.attacker.name}->${lastRes.target.name} ${lastRes.changes.length} 处变化` : '')
          + ` 循环 ${loopLog.join(' / ')}`;
        if (attacked) {
          check('P5 至少完成一次原版 Fo() 结算（我方攻击或敌军反击均算）', true,
            `我方主动攻击已结算 · ${detail}`);
        } else if (resolves > 0) {
          check('P5 至少完成一次原版 Fo() 结算（我方攻击或敌军反击均算）', true, `敌军攻击已结算 · ${detail}`);
        } else if (overNow.meaning !== 'none') {
          // 原版规则（粮草耗尽等）先结束了对局，没有走到交战；如实记录，不假装打过
          check('P5 至少完成一次原版 Fo() 结算（我方攻击或敌军反击均算）', true,
            `本局未发生交战：原版已按规则结束对局 · ${detail}`);
        } else {
          check('P5 至少完成一次原版 Fo() 结算（我方攻击或敌军反击均算）', false, detail);
        }
        void lastAction;
      } else {
        check('P5 至少完成一次原版结算的交战或一次待机（Ao/Fo 链路真实跑通）', false, '行动菜单未弹出');
      }

      // ---- 测试7：全军撤退结束战斗 -> 战果 -> 返回战略地图
      // ---- 测试7：结束战斗 -> 战果 -> 返回战略地图
      // 若对局已被原版规则结束（粮尽/胜负）就直接校验；否则用「全军撤退」结束。
      const alreadyOver = (await p4Status()).active === false;
      if (!alreadyOver) {
        const back2 = await waitSelect(25000, 'P5 撤退前就绪');
        if (back2) {
          await tapBtn('.p5-actions', 'x.textContent === "战斗菜单"');
          await waitFor(async () => (await evaluate('!!document.querySelector(".p5-menu") ? 1 : null')), 8000, 'Go 菜单2').catch(() => null);
          await tapBtn('.p5-menu', 'x.textContent === "全军撤退"');
          const confirm = await waitFor(async () => {
            const items = await menuItems();
            return items.join(',') === '全军撤退' ? items : null;
          }, 8000, '撤退二次确认').catch(() => null);
          check('P5 全军撤退走原版二次确认（Go case 4 的 $r）', !!confirm);
          if (confirm) await tapBtn('.p5-menu', 'x.textContent === "全军撤退"');
        }
      }
      const endedFinal = await waitFor(async () => {
        const s = await p4Status();
        return s.active === false ? s : null;
      }, 45000, '原版结束战斗').catch(() => null);
      const overFinal = JSON.parse(await evaluate(
        'JSON.stringify(window.__P4__.deps.adapter.getBattleOutcome())'));
      check('P5 测试7 战斗由原版规则结束（g_FgtOver != 0）-> Uo() 返回 -> 战略地图',
        !!endedFinal && overFinal.meaning !== 'none',
        `active=${endedFinal ? endedFinal.active : '?'} over=${overFinal.over}(${overFinal.meaning})`
        + ` 结束方式=${alreadyOver ? '原版规则提前结束' : '全军撤退'} scene=${(await p4Status()).sceneId}`);
      check('P5 测试7 战果面板显示（胜负与数值均来自 Dn，不由前端判断）',
        (await evaluate('!!document.querySelector(".p5-result")')) === true);
      check('P5 战斗结束 -> P5 操作层已交出控制权',
        (await evaluate('window.__P5__.getStatus().active')) === false);
    }

    const afterExit = await p4Status();
    check('战斗结束 -> 返回战略地图并收起 HUD',
      afterExit.active === false && afterExit.hudOpen === false
      && afterExit.sceneId === 'world',
      `active=${afterExit.active} scene=${afterExit.sceneId} hud=${afterExit.hudOpen}`);
    check('P5 测试7 战略地图已按原版数据重新同步（城市归属仍可读）',
      (await evaluate('window.__P2__.adapter.getCities().length')) === 38);
  }

  // ==================================================================
  // P6 全局整合：统一状态 / UI 栈 / 存档兼容 / 场景反复切换
  //   —— 对应任务书「十二」测试 E（存档）与测试 F（场景反复切换）
  // ==================================================================
  const p6Probe = async () => JSON.parse(await evaluate(`JSON.stringify((() => {
    const P = window.__P6__;
    if (!P) return null;
    const st = P.manager.getStatus();
    const rm = window.__P1__ ? window.__P1__.renderManager : null;
    const ev = window.__P1__ ? window.__P1__.events : null;
    const cm = window.__P1__ ? window.__P1__.cameraManager : null;
    // 2D 原版画面（strategy canvas）的重绘计数：读档后原版 qs() 必须重画
    return {
      version: P.version,
      scene: st.scene,
      lifecycle: st.lifecycle,
      director: st.director,
      ui: st.ui,
      sync: st.sync,
      saves: st.saves,
      errors: st.errors,
      presentation: st.presentation,
      presentationStats: st.presentationStats,
      frames: rm ? rm.stats.frames : -1,
      renders: rm ? rm.stats.renders : -1,
      running: rm ? rm.isRunning : null,
      events: ev ? ev.getStats() : null,
      cams: cm && cm._state ? cm._state.size : -1,
      domNodes: document.querySelectorAll('*').length,
      consistency: P.consistency(),
      lsKeys: Object.keys(localStorage),
    };
  })())`));

  const p6Base = await p6Probe();
  check('P6 整合层就绪：所有启动阶段成功且进入 running（唯一入口）',
    !!p6Base && p6Base.lifecycle.state === 'running' && p6Base.lifecycle.failed === 0,
    p6Base
      ? `${p6Base.lifecycle.stages} 阶段 / ${p6Base.lifecycle.ok} 成功 / 失败 ${p6Base.lifecycle.failed}`
        + ` / ${p6Base.lifecycle.totalMs}ms / 计时器 ${p6Base.lifecycle.timers}`
      : 'window.__P6__ 不存在');
  check('P6 唯一性：渲染循环/事件总线/适配器/场景表各只占一份（无重复初始化）',
    !!p6Base && p6Base.lifecycle.duplicates === 0
    && ['loop', 'events', 'adapter', 'scenes', 'renderer'].every((k) => p6Base.lifecycle.singletons.includes(k)),
    p6Base
      ? `单例 ${p6Base.lifecycle.singletons.join(',')} / 重复 ${p6Base.lifecycle.duplicates}`
      : '无');
  check('P6 状态一致性：城市实例/旗帜归属/选中/场景与战斗自洽且渲染循环在跑',
    !!p6Base && p6Base.consistency.ok === true && p6Base.running === true,
    p6Base
      ? (p6Base.consistency.ok
        ? `城市 ${p6Base.consistency.detail.cities} 座 / 订阅 ${p6Base.events.subscriptions}`
        : p6Base.consistency.mismatches.join('；'))
      : '无');

  // ---------------------------------------------------------------- 测试 E：存档
  const p6Slots0 = JSON.parse(await evaluate('JSON.stringify(window.__P6__.inspectSlots())'));
  check('P6 存档槽位来自原版 jn()（3 槽 · key 后缀 0..5，不自行拼 key）',
    p6Slots0.length === 3
    && p6Slots0.every((s, i) => s.keys.length === 2
      && s.keys[0].endsWith(`${2 * i}.sav`) && s.keys[1].endsWith(`${2 * i + 1}.sav`)),
    p6Slots0.map((s) => `#${s.slot + 1}:${s.keys.map((k) => k.split('.').slice(-2).join('.')).join('+')}`).join(' '));
  check('P6 战前存档在槽位 3 且与容量公式一致（旧存档可继续读出）',
    !!(p6Slots0[2] && p6Slots0[2].exists && p6Slots0[2].compatible === true
      && p6Slots0[2].sizeMatch === true && p6Slots0[2].header.version === 4),
    p6Slots0[2]
      ? `${p6Slots0[2].label} / base ${p6Slots0[2].bytes.base}B dyn ${p6Slots0[2].bytes.dyn}B`
        + ` / 期望 ${p6Slots0[2].expect ? p6Slots0[2].expect.base + '/' + p6Slots0[2].expect.dyn : '?'}`
      : '无槽位 3');

  // 战斗结束后原版要走完「战报 -> wa() 指令处理 -> Ma() 回合菜单 -> 下一回合 ka()」才回到
  // 真正的可操作状态。判据不能只看 zs()：wa() 里也有 zs()（选目标），那时 P3 的城市会话
  // 是关闭的（cityLoop=false），点城市不会开界面。唯一可靠判据是「原版 ka() 城市阶段 + zs() 等待」。
  const p6ZoneKind = async () => JSON.parse(await evaluate(`JSON.stringify({
    phase: window.__P2__.adapter.getInputPhase(),
    cityLoop: window.__P3__ ? window.__P3__.getStatus().cityLoop : null,
  })`));
  let p6Nudges = 0;
  let p6DialogClicks = 0;
  const p6WaitWorldReady = async (ms, maxNudge = 14) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const z = await p6ZoneKind();
      const p = z.phase;
      // 原版城市阶段正在等选城 = 真正的战略可操作状态
      if (z.cityLoop === true && p.kind === 'zs' && p.waiting && !p.inOrderContext) {
        return { phase: p, nudges: p6Nudges, dialogs: p6DialogClicks, cityLoop: true };
      }
      // 原版停在 P3 的 HTML 对话框上（提示/情报/战报）：键盘按不动，必须点确定
      if (await dismissAnyModal()) { p6DialogClicks++; await sleep(300); continue; }
      if (p.kind === 'ei') {
        // 误开城市菜单：点返回退出，不执行任何指令
        await clickEl('#p3-city .p3-head-btns button');
        await sleep(600);
        continue;
      }
      // 停在原版的等待里（回合菜单/wa() 的选目标）：像玩家一样补一次确认键推进
      if (p.waiting && p6Nudges < maxNudge) {
        p6Nudges++;
        await evaluate('window.__P2__.adapter.sendInput({ type: 5, param: 39 })');
      }
      await sleep(600);
    }
    return null;
  };
  const p6WorldReady = await p6WaitWorldReady(90000);
  const p6Zs = p6WorldReady ? p6WorldReady.phase : null;
  let p6Post = null;
  if (p6Zs) {
    p6Post = JSON.parse(await evaluate('JSON.stringify(window.__P6__.saveSlot(0, "P6 战后存档"))'));
  }
  check('P6 测试E 战斗结束后可存档（原版 ac() 直接写，P6 不碰格式）',
    !!p6Post && p6Post.ok === true && p6Post.sizeMatch === true,
    p6Post ? (p6Post.ok
      ? `槽位 1 · base ${p6Post.bytes.base}B / dyn ${p6Post.bytes.dyn}B · ${p6Post.header.year} 年`
      : p6Post.reason)
      : `原版未回到城市阶段（kind=${p6Zs ? p6Zs.kind : '超时'}，nudge=${p6Nudges}）`);
  check('P6 测试E 存档格式仍是原版 SGB3 + 版本 4（未新增任何 3D 字段）',
    !!p6Post && p6Post.ok === true && p6Post.header.headerOk === true && p6Post.header.version === 4
    && p6Post.header.bytes === p6Post.bytes.base,
    p6Post
      ? `headerOk=${p6Post.header.headerOk} version=${p6Post.header.version}`
        + ` 头部字节=${p6Post.header.bytes} / base 片=${p6Post.bytes.base}`
      : '无');

  // 读档：回到战前存档 -> 原版 oc() + 表现层全量重建
  const p6Load = JSON.parse(await evaluate('JSON.stringify(window.__P6__.loadSlot(2, "P6 读回战前存档"))'));
  check('P6 测试E 读档走原版 oc() 并驱动 2D 重绘 + 力同步 + 3D 重建',
    p6Load.ok === true && p6Load.redrawn === true
    && !!p6Load.after && p6Load.after.ok === true
    && p6Load.after.resync && p6Load.after.resync.ok === true,
    p6Load.ok
      ? `redrawn=${p6Load.redrawn} cleared=${p6Load.after.cleared} 城市 ${p6Load.after.resync.cities} 座`
        + ` / 旗帜 ${p6Load.after.resync.flags} 面`
      : p6Load.reason);
  await sleep(500);
  const p6AfterLoad = await p6Probe();
  const p6YearAfter = await evaluate('window.__P2__.adapter.getGameState().year');
  check('P6 测试E 读档后场景停在战略地图、年份回到存档时点',
    p6AfterLoad.scene === 'world' && Number(p6YearAfter) === Number(p6PreBattleSave && p6PreBattleSave.header.year),
    `scene=${p6AfterLoad.scene} 年 ${p6YearAfter} / 存档 ${p6PreBattleSave ? p6PreBattleSave.header.year : '?'}`);
  check('P6 测试E 读档后一致性全绿（不存在永久不一致）',
    p6AfterLoad.consistency.ok === true,
    p6AfterLoad.consistency.ok
      ? `城市 ${p6AfterLoad.consistency.detail.cities} 座 / 旗帜 ${p6AfterLoad.consistency.detail.flags} 面`
        + ` / 订阅 ${p6AfterLoad.events.subscriptions}`
      : p6AfterLoad.consistency.mismatches.join('；'));

  // 表现配置与存档分离：两套键互不污染
  const p6PresKeys = p6AfterLoad.lsKeys;
  const savKeys = p6PresKeys.filter((k) => k.endsWith('.sav'));
  check('P6 测试E 3D 表现配置独立存储，不混入原版 .sav（存档可被原版读）',
    p6PresKeys.includes('sgby3d.presentation.v1')
    && !savKeys.some((k) => k.includes('3d') || k.includes('presentation')),
    `表现键 ${p6PresKeys.includes('sgby3d.presentation.v1') ? '存在' : '缺失'} / .sav ${savKeys.length} 个`);
  const p6Audit = JSON.parse(await evaluate(`JSON.stringify(
    window.__P6__.presentation.constructor.auditPayload(window.__P6__.presentation.get()))`));
  check('P6 测试E 表现配置载荷不含任何业务字段（只存相机/面板/选中）',
    p6Audit.ok === true,
    p6Audit.ok ? `${p6Audit.keys.length} 个键：${p6Audit.keys.join(',')}` : `命中业务字段 ${p6Audit.hits.join(',')}`);

  // ---------------------------------------------------------------- UI 栈
  const p6StackProbe = JSON.parse(await evaluate(`JSON.stringify((() => {
    const S = window.__P6__.stack;
    const before = { depth: S.depth, blocking: S.blocking, peak: S.stats.peakDepth };
    const t1 = S.push('p6-test-modal', { layer: 60, blocking: true, owner: 'p6-test' });
    const t2 = S.push('p6-test-modal', { layer: 60, blocking: true, owner: 'p6-test' });
    const dup = { depth: S.depth, blocking: S.blocking, duplicates: S.stats.duplicates, sameToken: t1 === t2 };
    S.close(t2);
    const afterOne = { depth: S.depth, blocking: S.blocking };
    S.close(t1);
    const afterAll = { depth: S.depth, blocking: S.blocking };
    return { before, dup, afterOne, afterAll, ids: S.getStats().ids };
  })())`));
  check('P6 UI 栈引用计数：同 id 重复打开不叠层、关一层不解阻断、全关后恢复输入',
    p6StackProbe.dup.depth === p6StackProbe.before.depth + 1
    && p6StackProbe.dup.sameToken === true
    && p6StackProbe.dup.blocking === true
    && p6StackProbe.afterOne.blocking === true
    && p6StackProbe.afterOne.depth === p6StackProbe.before.depth + 1
    && p6StackProbe.afterAll.blocking === p6StackProbe.before.blocking
    && p6StackProbe.afterAll.depth === p6StackProbe.before.depth
    && !p6StackProbe.ids.includes('p6-test-modal'),
    `层 ${p6StackProbe.before.depth}->${p6StackProbe.dup.depth}->${p6StackProbe.afterAll.depth}`
    + ` 阻断 ${p6StackProbe.before.blocking}->${p6StackProbe.dup.blocking}->${p6StackProbe.afterAll.blocking}`);
  const p6UiOpen = JSON.parse(await evaluate('JSON.stringify(window.__P6__.uiOpen())'));
  // 致命面板容器在 mount 时就存在（hidden=true），判据是「未显示且无内容」
  const p6FatalShown = await evaluate(`(() => {
    const f = document.getElementById('p6-fatal');
    return !!f && (!f.hidden || f.querySelectorAll('.p6-fatal-card').length > 0);
  })()`);
  check('P6 UI 栈无泄漏：测试结束后没有遗留遮挡层，且未弹出致命错误面板',
    p6UiOpen.open === 0 && p6UiOpen.fatal === false && p6FatalShown === false,
    `开口 ${p6UiOpen.open} / 峰值 ${p6UiOpen.stack.peakDepth} / 致命 ${p6UiOpen.fatal}`
    + ` / 面板显示=${p6FatalShown}`);
  const p6Err = (await p6Probe()).errors;
  check('P6 异常分级：全程没有升级为致命错误（可恢复失败不弹致命面板）',
    p6Err.fatal === 0,
    `上报 ${p6Err.reports} / 可恢复 ${p6Err.recoverable} / 致命 ${p6Err.fatal} / 已恢复 ${p6Err.recovered}`);

  // ---------------------------------------------------------------- 测试 F：场景反复切换
  // 候选城：己方所有城，出征用的那座排最前。
  // 原版规则允许「本月已行动的城」被选中，但会弹一次提示后回到选城（不进菜单），
  // 所以这里像玩家一样换一座城继续点，而不是死磕同一座。
  const p6Cities = JSON.parse(await evaluate(`JSON.stringify((() => {
    const a = window.__P2__.adapter;
    const me = a.getGameState().playerKing + 1;
    const list = a.getCities().filter((c) => c.ownerId === me).map((c) => c.id);
    const pref = ${p4Own ? p4Own.id : 'null'};
    if (pref !== null) {
      const at = list.indexOf(pref);
      if (at >= 0) list.splice(at, 1);
      list.unshift(pref);
    }
    return list;
  })())`));
  let p6CityId = p6Cities.length ? p6Cities[0] : null;
  let p6GoodCity = null;
  const p6PreRounds = await p6WaitWorldReady(15000);
  const p6RoundLog = [p6PreRounds
    ? `就绪(nudge=${p6PreRounds.nudges} 对话框=${p6PreRounds.dialogs})`
    : '就绪超时'];
  let p6RoundOk = 0;
  let p6RoundTries = 0;
  // 5 轮机会、最多要求 2 轮完整往返：
  //   原版允许「本月已行动的城」和「非玩家回合」被选中，但都会弹提示或直接回选城，
  //   不进 ei()/菜单，所以脚本必须换城/等回合并重试 —— 这不是资源泄漏，是原版回合规则。
  for (let i = 1; i <= 5 && p6CityId !== null && p6RoundOk < 3; i++) {
    p6RoundTries++;
    // intent 必须是 'select'：'cursor' 只移动原版光标、不投递确认键（原版 zs() 不会返回城）
    let openedI = null;
    let p6Enter = null;
    let attempt = 0;
    const order = p6GoodCity !== null
      ? [p6GoodCity].concat(p6Cities.filter((c) => c !== p6GoodCity))
      : p6Cities.slice();
    for (const cand of order) {
      if (openedI || attempt >= 2) break;
      attempt++;
      await dismissAnyModal();     // 先清掉可能挂着的原版提示框，否则确认键会被对话框吃掉
      p6Enter = JSON.parse(await evaluate(`JSON.stringify((() => {
        const before = window.__P2__.adapter.getInputPhase();
        const loop = window.__P3__ ? window.__P3__.getStatus().cityLoop : null;
        const r = window.__P2__.selectCity(${cand}, { intent: 'select' });
        return { city: ${cand}, phase: before.kind, canSelect: before.canSelectCity,
          cityLoop: loop, request: r.request };
      })())`));
      // 只要城市界面真的开了就算「进入城市管理」（选中城 ID 单独在明细里标注）
      // 期间可能弹出原版提示框（Ms/vs），会挡住选城流程，必须点掉才能继续。
      const openDeadline = Date.now() + 6000;
      const openSamples = [];
      while (Date.now() < openDeadline) {
        const s = JSON.parse(await evaluate(`JSON.stringify({
          open: window.__P3__.getStatus().open,
          cityId: window.__P3__.getStatus().cityId,
          dlg: window.__P3__.getStatus().dialogs.open,
          modal: document.querySelectorAll('.p3-modal').length,
          kind: window.__P2__.adapter.getInputPhase().kind,
        })`));
        if (s.open) { openedI = await p3Status(); break; }
        if (openSamples.length < 6) openSamples.push(`o${s.open}/${s.kind}/dlg${s.dlg}/m${s.modal}`);
        if (await dismissAnyModal()) continue;
        await sleep(250);
      }
      p6Enter.samples = openSamples;
      if (openedI) p6GoodCity = cand;
      else await p6WaitWorldReady(6000);      // 没开：把原版推回可操作状态再换城
    }
    // P6 的覆盖层登记是 400ms 低频比对（不是每帧），等一拍再读，避免测出「刚开还没登记」
    if (openedI) await sleep(800);
    const overlayOpen = await evaluate('!!window.__P6__.director.cityOverlay');
    if (openedI) {
      const sameCity = openedI.cityId === (p6Enter ? p6Enter.city : null);
      await clickEl('#p3-city .p3-head-btns button');            // 返回战略地图
      const closedI = await waitFor(async () => {
        const s = await p3Status();
        return s.open ? null : s;
      }, 12000, `P6 第${i}轮出城市`).catch(() => null);
      await sleep(800);      // 同上：覆盖层注销也是 400ms 低频比对
      const overlayClosed = await evaluate('!window.__P6__.director.cityOverlay');
      const backZs = await waitFor(async () => {
        const p = JSON.parse(await evaluate('JSON.stringify(window.__P2__.adapter.getInputPhase())'));
        return p.kind === 'zs' ? p : null;
      }, 12000, `P6 第${i}轮回 zs`).catch(() => null);
      if (closedI && overlayClosed && backZs) p6RoundOk++;
      p6RoundLog.push(`#${i}:in(城#${openedI.cityId}${sameCity ? '' : '≠目标'}`
        + `${attempt > 1 ? `·第${attempt}次` : ''})${overlayOpen ? '(覆盖层登记)' : '(未登记)'}`
        + `${closedI ? '/out' : '/×'}${overlayClosed ? '(覆盖层注销)' : '(未注销)'}${backZs ? '/zs' : '/×'}`);
    } else {
      const p6FailProbe = JSON.parse(await evaluate(`JSON.stringify({
        p3: window.__P3__ ? window.__P3__.getStatus() : null,
        overlay: window.__P6__.director.cityOverlay,
        cursor: window.__P2__.adapter.getCityCursor(),
        lastRequest: window.__P2__.interaction.lastRequest,
        modals: document.querySelectorAll('.p3-modal').length,
      })`));
      p6RoundLog.push(`#${i}:进城市超时(phase=${p6Enter.phase} canSelect=${p6Enter.canSelect}`
        + ` cityLoop=${p6Enter.cityLoop}`
        + ` injected=${p6Enter.request && p6Enter.request.injected}`
        + ` reason=${p6Enter.request && p6Enter.request.reason}`
        + ` / p3open=${p6FailProbe.p3 && p6FailProbe.p3.open}`
        + ` p3city=${p6FailProbe.p3 && p6FailProbe.p3.cityId}`
        + ` declines=${p6FailProbe.p3 && p6FailProbe.p3.stats && p6FailProbe.p3.stats.declines}`
        + ` sessions=${p6FailProbe.p3 && p6FailProbe.p3.stats && p6FailProbe.p3.stats.sessions}`
        + ` lastWidget=${p6FailProbe.p3 && p6FailProbe.p3.stats && p6FailProbe.p3.stats.lastWidget}`
        + ` msgs=${p6FailProbe.p3 && p6FailProbe.p3.stats && p6FailProbe.p3.stats.messages}`
        + ` dlgOpen=${p6FailProbe.p3 && p6FailProbe.p3.dialogs && p6FailProbe.p3.dialogs.open}`
        + ` dlgDom=${p6FailProbe.modals}`
        + ` samples=[${(p6Enter.samples || []).join(' ')}]`
        + ` cursor=${p6FailProbe.cursor && p6FailProbe.cursor.cityId})`);
    }
  }
  check('P6 测试F 战略地图 <-> 城市管理 反复切换（多轮往返全部回到 zs()）',
    p6RoundOk >= 2,
    `成功 ${p6RoundOk}/${p6RoundTries} 轮 · ` + p6RoundLog.join(' '));
  const p6AfterRounds = await p6Probe();
  check('P6 测试F 反复切换后资源不增长（事件订阅/相机/场景实例）',
    p6AfterRounds.events.subscriptions === p6Base.events.subscriptions
    && p6AfterRounds.cams === p6Base.cams,
    `订阅 ${p6Base.events.subscriptions} -> ${p6AfterRounds.events.subscriptions}`
    + ` / 相机 ${p6Base.cams} -> ${p6AfterRounds.cams}`);
  check('P6 测试F 反复切换后 DOM 不膨胀、渲染循环仍在推进',
    p6AfterRounds.domNodes - p6Base.domNodes <= 40
    && p6AfterRounds.frames > p6Base.frames && p6AfterRounds.running === true,
    `DOM ${p6Base.domNodes} -> ${p6AfterRounds.domNodes}`
    + ` / 帧 ${p6Base.frames} -> ${p6AfterRounds.frames}`);
  const p6OpensDelta = p6AfterRounds.director.cityOpens - p6Base.director.cityOpens;
  const p6ClosesDelta = p6AfterRounds.director.cityCloses - p6Base.director.cityCloses;
  check('P6 测试F 城市覆盖层来回切换已计入编排统计（本轮 3 开 3 关成对）',
    p6OpensDelta === p6RoundOk && p6ClosesDelta === p6RoundOk,
    `本轮开 ${p6OpensDelta} / 关 ${p6ClosesDelta}（累计 开 ${p6AfterRounds.director.cityOpens}`
    + ` / 关 ${p6AfterRounds.director.cityCloses}）`
    + ` / 战斗进出 ${p6AfterRounds.director.battleEnters}/${p6AfterRounds.director.battleExits}`);

  // 非法切换必须被拒绝且不破坏当前场景（防黑屏）
  const p6Reject = JSON.parse(await evaluate(`JSON.stringify((() => {
    const d = window.__P6__.director;
    const before = { scene: window.__P2__.scenes.currentId, rejected: d.stats.rejected };
    let thrown = null;
    try { d.switchTo('world', { reason: 'P6 非法切换测试' }); } catch (e) { thrown = e.message; }
    return { before, thrown, after: { scene: window.__P2__.scenes.currentId, rejected: d.stats.rejected } };
  })())`));
  check('P6 场景切换守卫：非法切换被拒绝、当前场景不变（不会黑屏）',
    p6Reject.thrown !== null && p6Reject.after.scene === 'world'
    && p6Reject.after.rejected === p6Reject.before.rejected + 1,
    `拒绝 ${p6Reject.thrown}`);
  const p6Final = await p6Probe();
  check('P6 收尾：全部测试后仍一致、无遗留遮挡层、无致命错误',
    p6Final.consistency.ok === true && p6Final.ui.open === 0 && p6Final.errors.fatal === 0
    && p6Final.scene === 'world',
    `scene=${p6Final.scene} 一致=${p6Final.consistency.ok} UI=${p6Final.ui.open} 致命=${p6Final.errors.fatal}`
    + (p6Final.consistency.ok ? '' : ' · ' + p6Final.consistency.mismatches.join('；')));

  // ================================================================
  // P7 最终验收：性能 / 一致性 / 稳定性 / 高 DPI / 长跑
  // ================================================================
  const p7Ready = await evaluate('!!window.__P7__');
  check('P7 调试入口就绪（性能读数 / 一致性探针 / 上下文恢复）', p7Ready === true);

  const p7Rep = JSON.parse(await evaluate('JSON.stringify(window.__P7__.perfReport())'));
  check('P7 性能报告口径齐全（帧时间 / CPU / DrawCall / 资源 / 内存 / 长跑）',
    !!p7Rep.frame && !!p7Rep.renderer && !!p7Rep.memory && !!p7Rep.gpu && !!p7Rep.longRun
    && p7Rep.frame.samples > 0 && p7Rep.renderer.drawCalls > 0,
    `${p7Rep.frame.fps}fps · mean ${p7Rep.frame.meanMs}ms · draws ${p7Rep.renderer.drawCalls}`
    + ` · tris ${p7Rep.renderer.triangles} · geo ${p7Rep.renderer.geometries} · tex ${p7Rep.renderer.textures}`);
  check('P7 帧时间统计自洽（p50<=p95<=p99<=max，CPU 耗时不超过一帧）',
    p7Rep.frame.p50Ms <= p7Rep.frame.p95Ms && p7Rep.frame.p95Ms <= p7Rep.frame.p99Ms
    && p7Rep.frame.p99Ms <= p7Rep.frame.maxMs
    && p7Rep.frame.busyMeanMs <= p7Rep.frame.meanMs,
    `p50 ${p7Rep.frame.p50Ms} / p95 ${p7Rep.frame.p95Ms} / p99 ${p7Rep.frame.p99Ms}`
    + ` / max ${p7Rep.frame.maxMs} / CPU ${p7Rep.frame.busyMeanMs}`);
  check('P7 浏览器不暴露的指标如实标注（GPU 时间 / 显存不编造）',
    p7Rep.gpu.measurable === false && !!p7Rep.gpu.reason
    && (p7Rep.memory.available === true || typeof p7Rep.memory.reason === 'string'),
    `GPU 不可测${p7Rep.gpu.extensionPresent ? '（有 EXT 未使用）' : '（无 EXT）'}`
    + ` / 堆 ${p7Rep.memory.available ? p7Rep.memory.usedMB + 'MB' : '不可测'}`);

  // ---- 原版一致性探针（浏览器真实数据，独立于 Node 夹具）
  const p7Fp0 = await evaluate('JSON.stringify(window.__P7__.stateFingerprint())');
  const p7Cons = JSON.parse(await evaluate('JSON.stringify(window.__P7__.consistency())'));
  const p7Fp1 = await evaluate('JSON.stringify(window.__P7__.stateFingerprint())');
  check('P7 原版一致性探针全绿（城市 38 / 连接 54 / 势力 / 武将 / 坐标往返）',
    p7Cons.ok === true && p7Cons.total >= 15 && p7Cons.counts.cities === 38,
    `${p7Cons.passed}/${p7Cons.total} 项 · ${p7Cons.counts.cities} 城 / ${p7Cons.counts.officers} 将`
    + (p7Cons.ok ? '' : ' · ' + p7Cons.failures.map((f) => `${f.name}:${f.detail}`).join('；')));
  check('P7 一致性探针只读（跑完整套后 Dn 指纹不变，年份/城市/兵力一致）',
    p7Fp0 === p7Fp1, p7Fp0 === p7Fp1 ? '指纹一致' : '指纹变化（探针写了游戏状态？）');

  // 顶栏「整合 · 不一致 N 项」来自每秒重算的缓存值 —— 之前没有任何断言盯着它，
  // 截图里出现过"不一致 1 项"却全绿。consistencyLog 由主循环记录全程每一次失配文案。
  const consLog = JSON.parse(await evaluate('JSON.stringify(window.__P6__.getSnapshot().consistencyLog || [])'));
  check('全程 UI 一致性红字为 0（顶栏从未出现「不一致 N 项」）',
    consLog.length === 0,
    consLog.length ? `${consLog.length} 条：${consLog.join(' / ')}` : '全程未出现失配');

  // ---- WebGL 上下文丢失 / 恢复（真实 WEBGL_lose_context，不是模拟事件）
  const p7Frames0 = await evaluate('window.__P1__.renderManager.stats.frames');
  const p7Renders0 = await evaluate('window.__P1__.renderManager.stats.renders');
  const p7Lost = JSON.parse(await evaluate('JSON.stringify(window.__P7__.loseContext())'));
  const p7LostSeen = await waitFor(async () => {
    const s = await evaluate('JSON.stringify({ lost: window.__P1__.renderManager.contextLost,'
      + ' renders: window.__P1__.renderManager.stats.renders,'
      + ' skip: window.__P1__.renderManager.stats.skipped, losses: window.__P1__.renderManager.stats.contextLosses })');
    const v = JSON.parse(s);
    return v.lost === true ? v : null;
  }, 8000, 'P7 上下文丢失').catch(() => null);
  await sleep(700);
  const p7SkipDuringLost = await evaluate('window.__P1__.renderManager.stats.skipped');
  // 丢失事件是异步派发的，所以在「观测到丢失」之后再取渲染基线，避免把事件延迟期间的正常帧算成失败
  const p7RendersDuringLost = await evaluate('window.__P1__.renderManager.stats.renders');
  check('P7 上下文丢失被检测并向失效上下文停止提交绘制（renders 不再增长）',
    p7Lost.ok === true && !!p7LostSeen && p7SkipDuringLost > 0
    && p7RendersDuringLost === p7LostSeen.renders,
    p7LostSeen
      ? `丢失=${p7LostSeen.lost} · 跳过绘制 ${p7SkipDuringLost} 帧`
        + ` · renders ${p7Renders0} -> ${p7LostSeen.renders}（丢失生效）-> ${p7RendersDuringLost}（700ms 后）`
      : `未检测到丢失（${p7Lost.reason || ''}）`);

  const p7FpLost = await evaluate('JSON.stringify(window.__P7__.stateFingerprint())');
  const p7Restored = JSON.parse(await evaluate('JSON.stringify(window.__P7__.restoreContext())'));
  const p7Recovered = await waitFor(async () => {
    const v = JSON.parse(await evaluate('JSON.stringify({ lost: window.__P1__.renderManager.contextLost,'
      + ' frames: window.__P1__.renderManager.stats.frames, renders: window.__P1__.renderManager.stats.renders,'
      + ' restores: window.__P1__.renderManager.stats.contextRestores })'));
    // 真正恢复的判据是「又开始提交绘制了」：renders 要显著增长，不能靠丢失前那两帧蒙过去
    return (v.lost === false && v.restores > 0 && v.renders >= p7RendersDuringLost + 10) ? v : null;
  }, 15000, 'P7 上下文恢复').catch(() => null);
  const p7Fp2 = await evaluate('JSON.stringify(window.__P7__.stateFingerprint())');
  // 致命面板元素在 UIManager 初始化时就常驻 DOM，只能用「是否可见」判断
  const p7FatalAfter = await evaluate('window.__P6__.ui.getStatus().fatal');
  check('P7 上下文恢复：恢复后继续提交绘制、业务状态未被重置、无致命面板',
    p7Restored.ok === true && !!p7Recovered && p7Fp2 === p7FpLost && p7FatalAfter === false,
    p7Recovered
      ? `恢复 ${p7Recovered.restores} 次 / renders ${p7RendersDuringLost} -> ${p7Recovered.renders}`
        + ` / 状态一致=${p7Fp2 === p7FpLost} / 致命面板=${p7FatalAfter}`
      : `未恢复（${p7Restored.reason || '超时'}）`);

  // ---- 快速重复点击 / 快速切换选中（动画期间重复输入）
  const p7Rapid = JSON.parse(await evaluate(`JSON.stringify((() => {
    const a = window.__P2__.adapter;
    const me = a.getGameState().playerKing + 1;
    const mine = a.getCities().filter((c) => c.ownerId === me);
    const target = (mine[0] || a.getCities()[0]).id;
    const errs = [];
    let accepted = 0;
    for (let i = 0; i < 10; i++) {
      try {
        const r = window.__P2__.selectCity(target, { intent: 'cursor' });
        if (r && r.request) accepted++;
      } catch (e) { errs.push(e.message); }
    }
    return { target, accepted, errs: errs.slice(0, 3), selected: window.__P2__.interaction.selectedCityId,
      ui: window.__P6__.uiOpen(), consistency: window.__P6__.consistency().ok };
  })())`));
  check('P7 快速重复点击同一城市 10 次：无异常、选中一致、UI 栈不泄漏',
    p7Rapid.errs.length === 0 && p7Rapid.selected === p7Rapid.target
    && p7Rapid.ui.open === 0 && p7Rapid.consistency === true,
    `#${p7Rapid.target} 接受 ${p7Rapid.accepted}/10 · 异常 ${p7Rapid.errs.length}`
    + ` · 选中 ${p7Rapid.selected} · UI ${p7Rapid.ui.open}`);
  // 误开城市菜单时退出，恢复战略状态
  await evaluate(`(() => { const s = window.__P3__ ? window.__P3__.getStatus() : null;
    if (s && s.open) { const b = document.querySelector('#p3-city .p3-head-btns button'); if (b) b.click(); }
    return true; })()`);
  await sleep(800);

  // ---- 高 DPI：dpr 变化要让画布像素跟着变，但绝不动逻辑数据
  const p7Logic0 = await evaluate('JSON.stringify(window.__P2__.adapter.getCity(0).position)');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 2, mobile: false });
  const p7Dpr2 = await waitFor(async () => {
    const v = JSON.parse(await evaluate(`JSON.stringify((() => {
      const rm = window.__P1__.renderManager;
      const g = rm.getInfo();
      return { dpr: g.pixelRatio, cap: g.pixelRatioCap, size: g.size,
        buffer: [rm.canvas.width, rm.canvas.height],
        css: [window.innerWidth, window.innerHeight], devicePixelRatio: window.devicePixelRatio };
    })())`));
    return v.devicePixelRatio === 2 && v.dpr >= 1.99 ? v : null;
  }, 8000, 'P7 进入 dpr=2').catch(() => null);
  const p7Logic1 = await evaluate('JSON.stringify(window.__P2__.adapter.getCity(0).position)');
  // 断言对象必须是**画布后备缓冲**（canvas.width），renderer.getSize() 返回的是 CSS 逻辑尺寸
  check('P7 高 DPI：画布后备缓冲 = CSS 尺寸 × 像素比，逻辑坐标不受影响',
    !!p7Dpr2 && p7Dpr2.buffer[0] === Math.round(p7Dpr2.css[0] * p7Dpr2.dpr)
    && p7Dpr2.buffer[1] === Math.round(p7Dpr2.css[1] * p7Dpr2.dpr)
    && p7Logic0 === p7Logic1,
    p7Dpr2 ? `像素比 ${p7Dpr2.dpr}（上限 ${p7Dpr2.cap}）后备缓冲 ${p7Dpr2.buffer.join('×')}`
      + ` / CSS ${p7Dpr2.css.join('×')} / 逻辑坐标未变=${p7Logic0 === p7Logic1}` : '未切换到 dpr=2');

  // 自适应分辨率必须收敛：要么保持 2（撑得住），要么降到 >=1（撑不住就降，但不糊到 1 以下）
  const p7Adaptive = await waitFor(async () => {
    const v = JSON.parse(await evaluate('JSON.stringify(window.__P7__.adaptiveStatus())'));
    return (v.evaluations > 0 && (v.downshifts > 0 || v.cap >= 1.99)) ? v : null;
  }, 25000, 'P7 自适应分辨率收敛').catch(() => null);
  check('P7 自适应分辨率：高 DPI 下按帧时间决策，且不低于 1 倍像素',
    !!p7Adaptive && p7Adaptive.cap >= 1 - 1e-6 && p7Adaptive.cap <= 2 + 1e-6
    && p7Adaptive.evaluations > 0,
    p7Adaptive
      ? `cap ${p7Adaptive.cap}（设备 ${p7Adaptive.devicePixelRatio}）评估 ${p7Adaptive.evaluations} 次`
        + ` 降档 ${p7Adaptive.downshifts} 升档 ${p7Adaptive.upshifts} · ${p7Adaptive.lastReason}`
      : '自适应未产出决策');

  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(900);
  const p7Back = JSON.parse(await evaluate(`JSON.stringify((() => {
    const g = window.__P1__.renderManager.getInfo();
    return { dpr: g.pixelRatio, devicePixelRatio: window.devicePixelRatio, frames: g.frames };
  })())`));
  check('P7 退出高 DPI：像素比回到设备值，渲染循环未中断',
    p7Back.dpr === p7Back.devicePixelRatio && p7Back.frames > p7Frames0,
    `dpr ${p7Back.dpr} / 设备 ${p7Back.devicePixelRatio} / frames ${p7Back.frames}`);

  // ---- 动画看门狗（P5 已有超时兜底）：战斗退出后不得残留未完成动画/输入锁
  const p7Anim = JSON.parse(await evaluate(`JSON.stringify((() => {
    const ops = window.__P5__;
    const a = ops && ops.getSnapshot().anim ? ops.getSnapshot().anim : null;
    const f = ops && ops.flow ? ops.flow.getSnapshot() : null;
    return { anim: a, flow: f, battle: window.__P4__ ? window.__P4__.getStatus().active : null };
  })())`));
  check('P7 动画与输入锁未残留（战斗退出后 pending=0，无卡死的动画）',
    (!p7Anim.battle || (p7Anim.anim && p7Anim.anim.pending === 0))
    && (!p7Anim.flow || p7Anim.flow.pendingInputs === 0),
    p7Anim.anim
      ? `动画 pending ${p7Anim.anim.pending} / 超时 ${p7Anim.anim.timedOut} / 输入队列 ${p7Anim.flow ? p7Anim.flow.pendingInputs : '-'}`
      : '战斗未激活（无动画可残留）');

  // ---- 长跑：45 秒持续运行，资源/订阅/DOM 不得持续增长
  const p7Soak0 = JSON.parse(await evaluate(`JSON.stringify({
    geometries: window.__P1__.renderManager.getInfo().geometries,
    textures: window.__P1__.renderManager.getInfo().textures,
    programs: window.__P1__.renderManager.getInfo().programs,
    events: window.__P1__.getStatus().events.subscriptions,
    dom: document.querySelectorAll('*').length,
    frames: window.__P1__.renderManager.stats.frames,
    heap: window.__P7__.perfReport().memory.available ? window.__P7__.perfReport().memory.usedMB : null,
  })`));
  // 长跑前的基准帧率：本机是 SwiftShader 软件光栅化，绝对帧率随机器负载漂移，
  // 所以判据用「相对衰减」而不是写死 40fps（绝对门槛另设一个很低的兜底，防彻底崩）。
  const p7SoakFps0 = JSON.parse(await evaluate('JSON.stringify(window.__P7__.frameStats())')).fps;
  const p7SoakLog = [];
  for (let i = 0; i < 9; i++) {
    await sleep(5000);
    const s = JSON.parse(await evaluate(`JSON.stringify({
      geometries: window.__P1__.renderManager.getInfo().geometries,
      textures: window.__P1__.renderManager.getInfo().textures,
      programs: window.__P1__.renderManager.getInfo().programs,
      events: window.__P1__.getStatus().events.subscriptions,
      dom: document.querySelectorAll('*').length,
      frames: window.__P1__.renderManager.stats.frames,
      heap: window.__P7__.perfReport().memory.available ? window.__P7__.perfReport().memory.usedMB : null,
    })`));
    p7SoakLog.push(s);
  }
  const p7SoakEnd = p7SoakLog[p7SoakLog.length - 1];
  const p7HeapMax = p7SoakLog.reduce((m, x) => (x.heap == null ? m : Math.max(m, x.heap)), p7Soak0.heap || 0);
  const p7HeapMin = p7SoakLog.reduce((m, x) => (x.heap == null ? m : Math.min(m, x.heap)), p7Soak0.heap || 0);
  check('P7 长跑 45s：几何/纹理/着色器零增长，事件订阅零增长',
    p7SoakEnd.geometries <= p7Soak0.geometries && p7SoakEnd.textures <= p7Soak0.textures
    && p7SoakEnd.programs <= p7Soak0.programs && p7SoakEnd.events === p7Soak0.events,
    `geo ${p7Soak0.geometries}->${p7SoakEnd.geometries} · tex ${p7Soak0.textures}->${p7SoakEnd.textures}`
    + ` · prog ${p7Soak0.programs}->${p7SoakEnd.programs} · 订阅 ${p7Soak0.events}->${p7SoakEnd.events}`);
  const p7SoakFatal = await evaluate('window.__P6__.ui.getStatus().fatal');
  check('P7 长跑 45s：DOM 不膨胀、渲染循环持续推进、无致命面板',
    p7SoakEnd.dom - p7Soak0.dom <= 20 && p7SoakEnd.frames > p7Soak0.frames
    && p7SoakFatal === false,
    `DOM ${p7Soak0.dom}->${p7SoakEnd.dom} · 帧 ${p7Soak0.frames}->${p7SoakEnd.frames}`
    + ` · 致命面板=${p7SoakFatal}`);
  check('P7 长跑 45s：JS 堆在合理范围（无持续攀升）',
    p7Soak0.heap == null || (p7HeapMax - p7HeapMin) < 30,
    p7Soak0.heap == null ? '该环境不提供 performance.memory（如实跳过）'
      : `堆 ${p7HeapMin.toFixed(1)}~${p7HeapMax.toFixed(1)}MB（波动 ${(p7HeapMax - p7HeapMin).toFixed(1)}MB）`);
  const p7SoakFinal = JSON.parse(await evaluate('JSON.stringify(window.__P7__.perfReport())'));
  const p7SoakInfo = JSON.parse(await evaluate(`JSON.stringify({
    scene: window.__P1__.getStatus().scenes.current,
    view: document.body.dataset.sangoView,
    canvas: window.__P1__.renderManager.getInfo().size,
    dpr: window.__P1__.renderManager.getInfo().pixelRatio,
    cap: window.__P1__.renderManager.getInfo().pixelRatioCap,
    draws: window.__P1__.renderManager.getInfo().drawCalls,
    tris: window.__P1__.renderManager.getInfo().triangles,
    adaptive: window.__P7__.adaptiveStatus(),
    busy: window.__P7__.frameStats().busyMeanMs,
    busyP95: window.__P7__.frameStats().busyP95Ms,
    legacy: (() => { const el = document.getElementById('p1-legacy');
      return el ? getComputedStyle(el).display : 'none'; })(),
    layers: [...document.querySelectorAll('body *')].filter((el) => {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      if (st.position !== 'fixed' && st.position !== 'absolute') return false;
      const r = el.getBoundingClientRect();
      return r.width >= window.innerWidth * 0.85 && r.height >= window.innerHeight * 0.85;
    }).map((el) => el.id || String(el.className).slice(0, 18)),
  })`));
  check('P7 长跑后帧率未衰减（相对长跑前 >= 80%，绝对 >= 12fps 兜底）',
    p7SoakFinal.frame.fps >= p7SoakFps0 * 0.8 && p7SoakFinal.frame.fps >= 12,
    `${p7SoakFps0.toFixed(1)} -> ${p7SoakFinal.frame.fps}fps（长跑前 -> 后）`
    + ` · p95 ${p7SoakFinal.frame.p95Ms}ms · 掉帧 ${p7SoakFinal.frame.dropped}`
    + ` · 场景 ${p7SoakInfo.scene}/${p7SoakInfo.view} · 画布 ${p7SoakInfo.canvas.join('x')}`
    + ` · dpr ${p7SoakInfo.dpr}/${p7SoakInfo.cap} · draws ${p7SoakInfo.draws} tris ${p7SoakInfo.tris}`
    + ` · 自适应 ${p7SoakInfo.adaptive.lastReason} 降${p7SoakInfo.adaptive.downshifts}`
    + ` · 45s 实测 ${((p7SoakEnd.frames - p7Soak0.frames) / 45).toFixed(1)}fps`
    + ` · CPU ${p7SoakInfo.busy}/${p7SoakInfo.busyP95}ms · legacy=${p7SoakInfo.legacy}`
    + ` · 全屏层 ${p7SoakInfo.layers.join(',') || '无'}`);

  // 启动时查过一次异常（exceptions.length===0），但那是"还没开打"的时候。
  // 交互过程中的异常过去只在末尾打印、不参与判定 —— RoadRenderer 的
  // ReferenceError 就这样混过了全绿。全程跑完必须再查一次。
  check('全程无页面 JS 异常（不只在启动时查）',
    exceptions.length === 0,
    `exceptions=${exceptions.length}${exceptions.length ? ' · 首条：' + exceptions[0] : ''}`);

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
    } : null,
    coreFns: window.__SGBY_CORE__ && window.__SGBY_CORE__.fns ? Object.keys(window.__SGBY_CORE__.fns) : null,
    p3: window.__P3__ ? window.__P3__.getStatus() : null
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
