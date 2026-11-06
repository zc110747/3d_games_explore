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
  // 不变量：core.js 去掉桥接尾注、把 9 处改名反向还原后，必须与 min.js 逐字节相同。
  // 这比「前缀相同」更强：任何额外改动都会被抓到。
  // P3 接管 7 个 UI 控件，P4 追加 yo/Uo 两个战斗生命周期钩子 -> 共 9 处。
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
  ];
  const coreText = coreJs.toString('utf8');
  const bridgeAt = coreText.indexOf('/* === SGBY-P1-CORE-BRIDGE START');
  let restored = bridgeAt > 0 ? coreText.slice(0, bridgeAt) : '';
  for (const [from, to] of RENAMES) restored = restored.split(from).join(to);
  const sameAsSource = restored.replace(/\s+$/, '') === minJs.toString('utf8').replace(/\s+$/, '');
  check('sgby.core.js = sgby.min.js + 9 处改名 + 桥接尾注（业务代码零改动）',
    sameAsSource && bridgeAt > 0,
    `min=${minJs.length}B core=${coreJs.length}B delta=${coreJs.length - minJs.length}B 还原一致=${sameAsSource}`);

  edge = spawn(EDGE, [
    '--headless=new',
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
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
  check('P2 固定斜 45° 正交相机（禁旋转）',
    d2.camera.fixed45 === true && d2.camera.projection === 'orthographic'
    && d2.camera.rotationAllowed === false,
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

  // 原版未处于 zs() 选城阶段时，必须拒绝注入输入（不伪造成功）
  const phase = JSON.parse(await evaluate('JSON.stringify(window.__P2__.adapter.getInputPhase())'));
  const req = JSON.parse(await evaluate('JSON.stringify(window.__P2__.adapter.requestCitySelection(0, { intent: "cursor" }))'));
  check('原版不在选城阶段时拒绝注入输入（如实标注）',
    phase.canSelectCity === false && req.injected === false,
    `${phase.reason} / ${req.reason}`);

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

  // ---- 真实开局：验证「3D 点击 -> 原版 zs() 选城输入协议」确实可用 ----
  // 只在临时浏览器进程内推进原版流程（不写仓库文件、不写存档、不改任何规则）。
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
  const opened = openState?.year > 0 && openState?.phase.canSelectCity === true;
  check('脚本化真实开局后原版进入 zs() 选城阶段', opened,
    `按键 ${bootSteps} 次 / year=${openState?.year} / kind=${openState?.phase?.kind} / waiting=${openState?.phase?.waiting}`);
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
  check('P3 接管点 7 个已导出', p3Boot.widgets.length === 7, p3Boot.widgets.join('/'));
  check('P3 城市会话在原版 ka() 内自动开启', p3Boot.cityLoop === true,
    `cityLoop=${p3Boot.cityLoop} cityId=${p3Boot.cityId} phase=${p3Boot.stats.sessions}`);

  let cityOpened = null;
  let ownPick = null;
  let ownList = [];
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
    ownPick = ownClickable[0] || ownList[0] || null;
    check('找到玩家控制且可点击的城市', !!ownPick,
      ownList.slice(0, 4).map((c) => `#${c.id} ${c.name}`).join(', ') || '无');

    if (ownPick) {
      const hitTag = await evaluate(`(() => {
        const e = document.elementFromPoint(${ownPick.screen.x}, ${ownPick.screen.y});
        return e ? e.tagName : null;
      })()`);
      check('城市屏幕位置落在 3D 画布上（未被 HTML 遮挡）', hitTag === 'CANVAS', String(hitTag));
      await clickAt(ownPick.screen.x, ownPick.screen.y);
      cityOpened = await waitFor(async () => {
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
        await clickAt(c.screen.x, c.screen.y);
        const ok = await waitFor(async () => {
          const collapsed = await evaluate('document.querySelector(".p3-frame")?.classList.contains("p3-collapsed") ?? true');
          const s = await p3Status();
          return s.open && !collapsed ? s : null;
        }, 5000, '重新打开城市菜单').catch(() => null);
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
      const tabNow = await evaluate('window.__P3__.getStatus().tab');
      const inlineCols = await evaluate('document.querySelectorAll("#p3-detail .p3-officer-table thead th").length');
      const inlineRows = await evaluate('document.querySelectorAll("#p3-detail .p3-officer-table tbody tr").length');
      const liveIds = await evaluate(`window.__P3__.cityUI.officerIds(${ownPick.id}).ids.length`);
      check('武将页签可切换', tabNow === 'officers', String(tabNow));
      check('城市武将表 = 姓名 + 原版 13 列', inlineCols === 14 && inlineRows === liveIds,
        `${inlineRows} 行 × ${inlineCols} 列（当前 ss() ${liveIds} 人）`);
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
        return {
          own: { id: c.id, name: c.name, x: cs.x, y: cs.y },
          enemy: { id: t.id, name: t.name, ownerId: t.ownerId, x: ts.x, y: ts.y },
        };
      }
    }
    return null;
  })())`));
  check('找到可出征的组合（己方城 + 原版相邻敌方城）', !!p4Plan,
    p4Plan ? `#${p4Plan.own.id} ${p4Plan.own.name} -> #${p4Plan.enemy.id} ${p4Plan.enemy.name}` : '无');

  if (opened && p4Plan) {
    p4Own = p4Plan.own;
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
      check('出征粮草输入走原版 Hs()', foodUp === true);
      if (foodUp) {
        const max = Number(await evaluate('document.querySelector(".p3-modal .p3-input").max'));
        const v = Math.max(1, Math.min(max, 300));
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
        await clickAt(p4Enemy.x, p4Enemy.y);
        await sleep(1800);
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
    check('战斗相机固定斜 45° 正交且禁旋转',
      d.camera.fixed45 === true && d.camera.projection === 'orthographic'
      && d.camera.rotationAllowed === false,
      `${d.camera.azimuthDeg}°/${d.camera.elevationDeg}°`);
    check('战斗 HUD 已显示', (await evaluate('document.getElementById("p4-battle-hud")?.hidden')) === false);

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

      // ---- 进战斗时相机自动取景：所有在场部队都应落在可视区内
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
            inside, tag: el ? el.tagName : null });
        }
        return out;
      })())`));
      check('战斗相机自动取景：在场部队全部落在可视区且未被 HUD 遮挡',
        inView.length > 0 && inView.every((u) => u.inside && u.tag === 'CANVAS'),
        inView.map((u) => `#${u.index}(${u.x},${u.y})${u.inside ? '' : '×'}${u.tag === 'CANVAS' ? '' : '/' + u.tag}`).join(' '));

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
      check('3D 点击部队识别原版单位 ID',
        clicksAfter > clicksBefore && selAfterClick === ally.index,
        `clicks ${clicksBefore}->${clicksAfter} 选中 #${selAfterClick}`);

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

    // ---- 退出路径接线：只演练表现层（原版协程仍在战斗中，本阶段不驱动战斗）
    await evaluate("window.__SGBY_CORE__.p4.notify('exit')");
    await sleep(600);
    const afterExit = await p4Status();
    check('战斗结束通知 -> 返回战略地图并收起 HUD（表现层接线）',
      afterExit.active === false && afterExit.hudOpen === false
      && afterExit.sceneId === 'world',
      `active=${afterExit.active} scene=${afterExit.sceneId} hud=${afterExit.hudOpen}`);
  }

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
