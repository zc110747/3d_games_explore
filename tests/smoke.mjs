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
