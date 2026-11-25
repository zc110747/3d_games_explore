#!/usr/bin/env node
/**
 * P7 性能测量（真实浏览器 + 真实本地服务，不造假数据）
 *
 * 用途：同一套脚本在「优化前 / 优化后」各跑一次，得到可对比的基线。
 *
 * 测量方式：
 *   - 页面内注入一个**只读探针**（自己的 rAF 计数），只记录帧时间戳，不读写任何游戏数据。
 *   - FPS / 帧时间由探针时间戳计算（与渲染循环同一个 vsync 时钟）。
 *   - Draw Calls / 三角形 / Geometry / Texture 直接读 renderer.info。
 *   - JS 堆读 performance.memory（仅 Chromium 提供；不提供时如实标 unavailable）。
 *   - GPU 使用率浏览器不暴露，如实标注 unmeasurable，不编造。
 *
 * 运行：
 *   node tests/perf.mjs baseline          # 优化前
 *   node tests/perf.mjs after             # 优化后
 *   SGBY_PERF_GPU=1 node tests/perf.mjs gpu   # 尝试走硬件 ANGLE（默认用 SwiftShader 软件渲染）
 *
 * 注意：默认 SwiftShader 是**软件光栅化**，FPS 绝对值不代表真实显卡表现，
 *       只用于同一环境下优化前后的相对比较。硬件数据需在带 GPU 的机器上重跑。
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
const PORT = 8792;
const DEVTOOLS_PORT = 24000 + Math.floor(Math.random() * 800);
const URL = `http://127.0.0.1:${PORT}/index3d.html`;
const LABEL = process.argv[2] || 'run';
const USE_GPU = process.env.SGBY_PERF_GPU === '1';
const IDLE_MS = Number(process.env.SGBY_PERF_IDLE_MS || 6000);
const STRESS_MS = Number(process.env.SGBY_PERF_STRESS_MS || 6000);
const SOAK_MS = Number(process.env.SGBY_PERF_SOAK_MS || 20000);

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 15000, label = '条件') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch (_) { /* 未就绪 */ }
    await sleep(150);
  }
  throw new Error(`${label} 等待超时 (${ms}ms)`);
}

function stats(ts) {
  const d = [];
  for (let i = 1; i < ts.length; i++) {
    const x = ts[i] - ts[i - 1];
    if (x > 0 && x < 2000) d.push(x);
  }
  if (!d.length) return null;
  const sorted = d.slice().sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const variance = d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length;
  return {
    frames: d.length,
    fps: +(1000 / mean).toFixed(2),
    meanMs: +mean.toFixed(2),
    p50Ms: +pct(0.5).toFixed(2),
    p95Ms: +pct(0.95).toFixed(2),
    p99Ms: +pct(0.99).toFixed(2),
    maxMs: +sorted[sorted.length - 1].toFixed(2),
    jitterMs: +Math.sqrt(variance).toFixed(2),
  };
}

const PROBE = `
window.__PERF_PROBE__ = (() => {
  const st = { ts: [], on: false, raf: 0 };
  const tick = (t) => { if (!st.on) return; st.ts.push(t); st.raf = requestAnimationFrame(tick); };
  return {
    start() { st.ts.length = 0; st.on = true; st.raf = requestAnimationFrame(tick); return true; },
    stop() { st.on = false; cancelAnimationFrame(st.raf); return st.ts.slice(); },
    count() { return st.ts.length; },
  };
})();
'ok'
`;

if (!EDGE) {
  console.error('未找到 Edge，无法测量');
  process.exit(1);
}

const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'sgby-p7-perf-'));
const server = spawn(process.execPath, [SERVER], {
  cwd: ORIGINAL,
  env: { ...process.env, PORT: String(PORT), SGBY_NO_SW: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const glArgs = USE_GPU
  ? ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
  : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

let edge = null;
let ws = null;
const out = { label: LABEL, at: new Date().toISOString(), env: {}, scenarios: {}, soak: [], notes: [] };

try {
  await waitFor(() => fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => (r.ok ? r.json() : null)), 12000, '本地服务');

  edge = spawn(EDGE, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    `--user-data-dir=${tmpProfile}`,
    `--remote-debugging-port=${DEVTOOLS_PORT}`,
    '--remote-allow-origins=*',
    '--window-size=1600,900',
    ...glArgs,
    URL,
  ], { stdio: 'ignore' });

  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`)).json();
    return list.find((t) => t.type === 'page' && t.url.includes('index3d.html'));
  }, 20000, 'CDP 目标');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const exceptions = [];
  let msgId = 0;
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails?.text || 'x');
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.text);
    return m.result?.result?.value;
  };
  await send('Runtime.enable');
  await send('Log.enable');

  await waitFor(async () => {
    const s = await evaluate('document.body && document.body.dataset.p1Status || ""');
    return s === 'ready' ? s : null;
  }, 60000, '页面 ready');

  out.env = JSON.parse(await evaluate(`JSON.stringify({
    ua: navigator.userAgent,
    dpr: window.devicePixelRatio,
    viewport: [window.innerWidth, window.innerHeight],
    gl: (() => { const c = document.createElement('canvas').getContext('webgl2'); if (!c) return null;
      const d = c.getExtension('WEBGL_debug_renderer_info');
      return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER); })(),
    threads: navigator.hardwareConcurrency,
    memory: performance.memory ? { limitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576) } : null,
    three: window.__P1__ ? window.__P1__.threeVersion : null,
    mode: ${JSON.stringify(USE_GPU ? 'gpu' : 'swiftshader')},
  })`));

  await evaluate(PROBE);
  const rect = JSON.parse(await evaluate(`JSON.stringify((() => {
    const r = document.getElementById('p1-stage').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  })())`));
  const cx = Math.round(rect.left + rect.width / 2);
  const cy = Math.round(rect.top + rect.height / 2);

  const snapshot = async () => JSON.parse(await evaluate(`JSON.stringify((() => {
    const r = window.__P1__.renderManager;
    const i = r.renderer.info;
    const mem = performance.memory ? {
      usedMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(2),
      totalMB: +(performance.memory.totalJSHeapSize / 1048576).toFixed(2),
    } : { available: false };
    return {
      scene: window.__P1__.getStatus().scenes.current,
      drawCalls: i.render.calls,
      triangles: i.render.triangles,
      lines: i.render.lines,
      points: i.render.points,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      programs: i.programs ? i.programs.length : null,
      pixelRatio: r.renderer.getPixelRatio(),
      canvas: r.renderer.getSize(new window.__P1__.renderManager.THREE.Vector2()).toArray(),
      mem,
      dom: document.querySelectorAll('*').length,
      events: window.__P1__.getStatus().events.subscriptions,
    };
  })())`));

  /**
   * 单帧真实耗时：rAF 被 vsync 卡在 ~60Hz，看不出余量。
   * 这里直接调用渲染循环注册的那一个 frameCallback（会多渲染一帧，仅测量用），
   * 再用 gl.finish() 等 GPU 光栅化完成，得到「一帧到底花多少 ms」。
   */
  const frameCost = async (n = 20) => {
    const arr = JSON.parse(await evaluate(`JSON.stringify((() => {
      const rm = window.__P1__.renderManager;
      const gl = rm.renderer.getContext();
      const cb = rm._frameCallback;
      const out = [];
      for (let i = 0; i < ${n}; i++) {
        const a = performance.now();
        cb(1 / 60, performance.now());
        gl.finish();
        out.push(performance.now() - a);
      }
      return out;
    })())`));
    const s = arr.slice().sort((a, b) => a - b);
    const median = s[Math.floor(s.length / 2)];
    return {
      n: arr.length,
      medianMs: +median.toFixed(2),
      p95Ms: +s[Math.min(s.length - 1, Math.round((s.length - 1) * 0.95))].toFixed(2),
      maxMs: +s[s.length - 1].toFixed(2),
    };
  };

  /** 当前场景纹理显存估算：遍历材质贴图，按 宽*高*4 累加（仅估算，不含 mipmap）。 */
  const texVram = async () => JSON.parse(await evaluate(`JSON.stringify((() => {
    const cur = window.__P1__.scenes.current;
    const scene = cur && cur.scene;
    if (!scene) return { available: false };
    const seen = new Set(); let bytes = 0, count = 0;
    scene.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        for (const key of ['map', 'alphaMap', 'emissiveMap', 'normalMap']) {
          const t = m && m[key];
          if (!t || seen.has(t.uuid)) continue;
          seen.add(t.uuid);
          const img = t.image || {};
          const w = img.width || 0, h = img.height || 0;
          if (w && h) { bytes += w * h * 4; count++; }
        }
      }
    });
    return { available: true, count, mb: +(bytes / 1048576).toFixed(2) };
  })())`));

  const measure = async (ms, during = null) => {
    await evaluate('window.__PERF_PROBE__.start()');
    if (during) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) await during();
    } else {
      await sleep(ms);
    }
    const ts = await evaluate('JSON.stringify(window.__PERF_PROBE__.stop())');
    return stats(JSON.parse(ts));
  };

  // ---------------------------------------------------------------- 0 预热
  // P6 起页面默认停在原版 2D 主界面，3D 渲染是**暂停**的；不先钉住 3D 视图，
  // 测到的就是"暂停后的 rAF 节拍"（曾出现空载 59fps 其实一帧没画的假数据）。
  const forced = await evaluate(`(() => {
    if (!window.__P6__ || !window.__P6__.setView) return 'no-p6';
    window.__P6__.setView('game', true);
    return document.body.dataset.sangoView;
  })()`);
  out.notes.push(`测量前固定视图：${forced}`);
  await sleep(3500);
  const appFps0 = await evaluate('window.__P7__ ? +window.__P7__.frameStats().fps.toFixed(2) : null');
  out.notes.push(`应用内帧统计（测量前）：${appFps0}fps`);

  // ---------------------------------------------------------------- 1 战略地图空闲
  out.scenarios.idleWorld = {
    ...(await measure(IDLE_MS)),
    frameCost: await frameCost(),
    tex: await texVram(),
    info: await snapshot(),
  };

  // ---------------------------------------------------------------- 2 战略地图压力（平移/缩放/悬停）
  let k = 0;
  const stress = async () => {
    k++;
    if (k % 7 === 0) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: k % 14 === 0 ? -260 : 260 });
    } else if (k % 23 === 0) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 4; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + i * 18, y: cy + i * 10, button: 'left', buttons: 1 });
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 72, y: cy + 40, button: 'left', clickCount: 1 });
    } else {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(rect.left + 200 + ((k * 37) % Math.max(200, rect.width - 400))),
        y: Math.round(rect.top + 120 + ((k * 53) % Math.max(200, rect.height - 300))),
      });
    }
    await sleep(16);
  };
  const stressFps = await measure(STRESS_MS, stress);
  out.scenarios.stressWorld = { ...stressFps, events: await evaluate('window.__P2__.interaction.stats.events || 0'), info: await snapshot() };

  // ---------------------------------------------------------------- 3 场景切换耗时
  const switchRow = async (id) => {
    const t0 = Date.now();
    await evaluate(`window.__P1__.switchScene(${JSON.stringify(id)})`);
    const buildMs = Date.now() - t0;
    const f0 = await evaluate('window.__P1__.renderManager.stats.frames');
    await waitFor(async () => (await evaluate('window.__P1__.renderManager.stats.frames')) > f0 + 2, 5000, '首帧');
    return { id, buildMs, firstFrameMs: Date.now() - t0 };
  };
  const swBattle = await switchRow('battle');
  const battleIdle = { ...(await measure(3000)), frameCost: await frameCost(), tex: await texVram(), info: await snapshot() };
  const swWorld = await switchRow('world');
  out.scenarios.switch = { toBattle: swBattle, toWorld: swWorld, battleIdle };

  // ---------------------------------------------------------------- 4 高 DPI（dpr=2，4 倍像素量）
  // 先给自适应分辨率足够时间收敛（逐档下调 + 冷却），再测稳定态。
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(16000);
  out.scenarios.dpr2World = {
    ...(await measure(4000)),
    frameCost: await frameCost(),
    info: await snapshot(),
    adaptive: await evaluate('window.__P7__ ? JSON.stringify(window.__P7__.adaptiveStatus()) : null')
      .then((v) => (v ? JSON.parse(v) : null)),
  };

  // ---------------------------------------------------------------- 5 长跑（资源增长）
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(600);
  const soakT0 = Date.now();
  while (Date.now() - soakT0 < SOAK_MS) {
    await sleep(Math.min(5000, SOAK_MS));
    const s = await snapshot();
    out.soak.push({ t: +((Date.now() - soakT0) / 1000).toFixed(1), geometries: s.geometries, textures: s.textures, programs: s.programs, usedMB: s.mem.usedMB ?? null, dom: s.dom, events: s.events });
  }

  const after = await snapshot();
  const first = out.scenarios.idleWorld.info;
  out.growth = {
    geometries: after.geometries - (out.soak[0]?.geometries ?? after.geometries),
    textures: after.textures - (out.soak[0]?.textures ?? after.textures),
    usedMB: out.soak.length && out.soak[0].usedMB != null && after.mem.usedMB != null
      ? +(after.mem.usedMB - out.soak[0].usedMB).toFixed(2) : null,
    dom: after.dom - (out.soak[0]?.dom ?? after.dom),
    events: after.events - (out.soak[0]?.events ?? after.events),
  };
  out.p7 = await evaluate('window.__P7__ ? JSON.stringify(window.__P7__.perfReport()) : null')
    .then((v) => (v ? JSON.parse(v) : null)).catch(() => null);
  out.exceptions = exceptions.length;

  fs.mkdirSync(path.join(HERE, '.perf'), { recursive: true });
  const file = path.join(HERE, '.perf', `${LABEL}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n===== P7 perf [${LABEL}] mode=${out.env.mode} gl=${out.env.gl} dpr=${out.env.dpr} =====`);
  console.log(`${pad('scenario', 14)}${pad('fps', 8)}${pad('mean', 8)}${pad('p95', 8)}${pad('max', 8)}${pad('jitter', 8)}${pad('draws', 7)}${pad('tris', 10)}${pad('geo', 6)}${pad('tex', 6)}${pad('heapMB', 8)}`);
  for (const [name, s] of Object.entries(out.scenarios)) {
    if (!s || s.fps === undefined) continue;
    const i = s.info || {};
    console.log(`${pad(name, 14)}${pad(s.fps, 8)}${pad(s.meanMs, 8)}${pad(s.p95Ms, 8)}${pad(s.maxMs, 8)}${pad(s.jitterMs, 8)}${pad(i.drawCalls, 7)}${pad(i.triangles, 10)}${pad(i.geometries, 6)}${pad(i.textures, 6)}${pad(i.mem?.usedMB ?? 'n/a', 8)}`);
  }
  console.log('switch:', JSON.stringify(out.scenarios.switch.toBattle), JSON.stringify(out.scenarios.switch.toWorld));
  console.log('frameCost:', JSON.stringify(out.scenarios.idleWorld.frameCost), '| battle:', JSON.stringify(out.scenarios.switch.battleIdle.frameCost));
  console.log('texVram:', JSON.stringify(out.scenarios.idleWorld.tex), '| battle:', JSON.stringify(out.scenarios.switch.battleIdle.tex));
  console.log('growth over soak:', JSON.stringify(out.growth));
  console.log('soak:', out.soak.map((x) => `${x.t}s geo${x.geometries}/tex${x.textures}/heap${x.usedMB}`).join('  '));
  console.log('exceptions:', out.exceptions);
  console.log('saved:', file);
  process.exitCode = 0;
} catch (e) {
  console.error('[perf] 失败:', e.message);
  console.error(serverLog.slice(-2000));
  process.exitCode = 1;
} finally {
  try { if (ws) ws.close(); } catch (_) { /* ignore */ }
  try { if (edge) edge.kill(); } catch (_) { /* ignore */ }
  try { server.kill(); } catch (_) { /* ignore */ }
}
