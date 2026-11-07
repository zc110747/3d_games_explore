/**
 * P7 Node 测试 —— 性能监控 / 自适应分辨率 / 渲染层稳定性契约
 *
 * 这里不模拟游戏数据：PerfMonitor 只吃「帧时间/渲染统计」，用构造的帧序列验证算法本身；
 * 自适应分辨率同理（它只调像素比，不涉及任何业务字段）。
 * 渲染层契约用静态源码断言（单 rAF / 上下文事件 / 像素比钳位），避免在 Node 里假造 WebGL。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PerfMonitor } from '../original/site/p7/PerfMonitor.mjs';
import { AdaptiveResolution } from '../original/site/p7/AdaptiveResolution.mjs';
import { ADAPTIVE_CONFIG, PERF_CONFIG, P7_VERSION } from '../original/site/p7/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..', 'original', 'site');

/** 最小 renderManager 假件：只实现 PerfMonitor/AdaptiveResolution 用到的接口。 */
function fakeRenderManager({ geometries = 10, textures = 40, programs = 4 } = {}) {
  const hooks = [];
  let cap = 2;
  return {
    contextLost: false,
    THREE: { Vector2: class { constructor() { this.x = 0; this.y = 0; } set(x, y) { this.x = x; this.y = y; return this; } toArray() { return [this.x, this.y]; } } },
    renderer: {
      info: { render: { calls: 88, triangles: 13046, lines: 2, points: 0 }, memory: { geometries, textures }, programs: [] },
      getPixelRatio: () => cap,
      getSize: (v) => v.set(1600, 900),
      getContext: () => null,
    },
    addFrameHook(fn) { hooks.push(fn); return () => { const i = hooks.indexOf(fn); if (i >= 0) hooks.splice(i, 1); }; },
    emitFrame(dtMs, busy = 0.1) { for (const h of hooks) h(dtMs / 1000, 0, busy, false); },
    hookCount: () => hooks.length,
    setPixelRatioCap(v) { cap = Math.max(0.5, Math.min(2, v)); this.effectivePixelRatio = cap; return { cap, dpr: cap, changed: true }; },
    getPixelRatioCap: () => cap,
    effectivePixelRatio: 2,
  };
}

test('PerfMonitor：只挂一个帧钩子，重复 attach 不叠加', () => {
  const rm = fakeRenderManager();
  const perf = new PerfMonitor({ renderManager: rm });
  assert.equal(perf.attach(), true);
  assert.equal(perf.attach(), false);
  assert.equal(rm.hookCount(), 1);
  perf.detach();
  assert.equal(rm.hookCount(), 0);
  perf.detach();
});

test('PerfMonitor：60fps 帧序列统计正确（fps/p95/掉帧）', () => {
  const rm = fakeRenderManager();
  const perf = new PerfMonitor({ renderManager: rm });
  perf.attach();
  for (let i = 0; i < 120; i++) rm.emitFrame(16.7, 0.2);
  const s = perf.frameStats();
  assert.ok(Math.abs(s.fps - 59.88) < 0.2, `fps=${s.fps}`);
  assert.ok(Math.abs(s.meanMs - 16.7) < 0.05, `mean=${s.meanMs}`);
  assert.ok(s.p95Ms >= 16.7 && s.p95Ms <= 17, `p95=${s.p95Ms}`);
  assert.equal(s.dropped, 0);
  assert.equal(s.samples, 120);
  perf.dispose();
});

test('PerfMonitor：掉帧按 >20ms 计数，慢帧按 >25ms 计数', () => {
  const rm = fakeRenderManager();
  const perf = new PerfMonitor({ renderManager: rm });
  perf.attach();
  for (let i = 0; i < 60; i++) rm.emitFrame(16.7);
  for (let i = 0; i < 10; i++) rm.emitFrame(33.4);
  for (let i = 0; i < 5; i++) rm.emitFrame(26);
  const s = perf.frameStats();
  assert.equal(s.dropped, 15);
  assert.equal(perf.report().slowFrames, 15);
  assert.ok(s.maxMs >= 33.3);
  perf.dispose();
});

test('PerfMonitor：renderer 统计来自 renderer.info（不编造）', () => {
  const rm = fakeRenderManager({ geometries: 12, textures: 41, programs: 5 });
  const perf = new PerfMonitor({ renderManager: rm });
  perf.attach();
  rm.emitFrame(16.7);
  const r = perf.rendererInfo();
  assert.equal(r.drawCalls, 88);
  assert.equal(r.triangles, 13046);
  assert.equal(r.geometries, 12);
  assert.equal(r.textures, 41);
  assert.deepEqual(r.canvas, [1600, 900]);
  perf.dispose();
});

test('PerfMonitor：不可测量的指标如实标 unavailable', () => {
  const rm = fakeRenderManager();
  const perf = new PerfMonitor({ renderManager: rm });
  perf.attach();
  const mem = perf.memory();
  // Node 没有 performance.memory -> 必须明确不可用，而不是返回 0
  assert.equal(mem.available, false);
  assert.match(mem.reason, /performance\.memory/);
  const gpu = perf.gpu();
  assert.equal(gpu.measurable, false);
  assert.match(gpu.reason, /WebGL/);
  perf.dispose();
});

test('PerfMonitor：report 结构完整，长跑增长自基线起算', () => {
  const rm = fakeRenderManager();
  const perf = new PerfMonitor({ renderManager: rm });
  perf.attach();
  for (let i = 0; i < 30; i++) rm.emitFrame(16.7, 0.15);
  const rep = perf.report();
  for (const k of ['version', 'frame', 'renderer', 'memory', 'gpu', 'longRun', 'scene', 'adaptive']) {
    assert.ok(k in rep, `缺字段 ${k}`);
  }
  assert.equal(rep.version, P7_VERSION);
  assert.equal(rep.longRun.geometries, 0);
  assert.equal(rep.longRun.textures, 0);
  assert.equal(rep.frame.busyMeanMs > 0, true);
  assert.ok(rep.frame.busyShare < 0.1, `busyShare=${rep.frame.busyShare}`);
  perf.dispose();
});

test('PerfMonitor：空场景基线自动重设（不把场景装配误报成资源泄漏）', () => {
  // attach() 发生在场景装配之前：那一刻 geo/tex 都是 0，直接相减会把装配读成「+10 几何体」
  const rm = fakeRenderManager({ geometries: 0, textures: 0 });
  const perf = new PerfMonitor({ renderManager: rm });
  perf.attach();
  rm.renderer.info.memory.geometries = 10;
  rm.renderer.info.memory.textures = 40;
  const first = perf.longRun();
  assert.equal(first.rebased, true);
  assert.equal(first.geometries, 0);
  assert.equal(first.textures, 0);
  const second = perf.longRun();
  assert.equal(second.rebased, false);
  assert.equal(second.geometries, 0);
  rm.renderer.info.memory.geometries = 12;   // 真泄漏时才应显示 +2
  assert.equal(perf.longRun().geometries, 2);
  perf.dispose();
});

test('PerfMonitor：场景切换打点只累加，不新建计时器', () => {
  const rm = fakeRenderManager();
  const perf = new PerfMonitor({ renderManager: rm });
  perf.attach();
  perf.noteSceneSwitch('battle', 42.5);
  perf.noteSceneSwitch('world', 17.5);
  const s = perf.sceneSwitches;
  assert.equal(s.count, 2);
  assert.equal(s.lastTo, 'world');
  assert.equal(s.avgMs, 30);
  perf.dispose();
});

const NO_WARMUP = { ...ADAPTIVE_CONFIG, warmupWindows: 0 };

/** 临时把 devicePixelRatio 改成 dpr（Node 无 window），结束后严格还原。 */
function withDpr(dpr, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = { devicePixelRatio: dpr };
  try {
    return fn();
  } finally {
    if (had) globalThis.window = prev;
    else delete globalThis.window;
  }
}

test('AdaptiveResolution：掉帧立即降一档（保护优先，不等第二个窗口）', () => withDpr(2, () => {
    const rm = fakeRenderManager();
    const perf = { frameStats: () => ({ samples: 60, meanMs: 30, p95Ms: 30 }) };
    const ar = new AdaptiveResolution({ renderManager: rm, perf, config: NO_WARMUP });
    ar.stats.cap = 2;
    const a = ar.evaluate(100000);
    assert.equal(a.changed, true, 'p95 超阈值应立即降档');
    assert.equal(ar.stats.cap, 1.75);
    assert.equal(ar.stats.downshifts, 1);
    assert.equal(ar.stats.lastReason.includes('p95'), true);
}));

test('AdaptiveResolution：严重掉帧（p95 > 2 倍阈值）一次降两档', () => withDpr(2, () => {
    const rm = fakeRenderManager();
    const perf = { frameStats: () => ({ samples: 60, meanMs: 60, p95Ms: 50 }) };
    const ar = new AdaptiveResolution({ renderManager: rm, perf, config: NO_WARMUP });
    ar.stats.cap = 2;
    ar.evaluate(100000);
    assert.equal(ar.stats.cap, 1.5, `cap=${ar.stats.cap}`);
    assert.equal(ar.stats.downshifts, 1);
}));

test('AdaptiveResolution：降档后记住天花板，有效期内不回到失败档位', () => withDpr(2, () => {
  const rm = fakeRenderManager();
  let p95 = 30, mean = 30;
  const perf = { frameStats: () => ({ samples: 60, meanMs: mean, p95Ms: p95 }) };
  const ar = new AdaptiveResolution({ renderManager: rm, perf, config: NO_WARMUP });
  ar.stats.cap = 2;
  ar.evaluate(100000);                     // 2 -> 1.75（天花板=2）
  assert.equal(ar.stats.cap, 1.75);
  p95 = 12; mean = 11;                     // 突然变好：想升档，但天花板挡住
  ar.evaluate(100000 + 5000);
  const r2 = ar.evaluate(100000 + 5100);
  assert.equal(r2.changed, false, '天花板期内不应回到刚失败过的档位');
  assert.equal(r2.reason, 'ceiling-hold');
  assert.equal(ar.stats.cap, 1.75);
  // 天花板过期（ceilingMs）后允许再试
  const r3 = ar.evaluate(100000 + ADAPTIVE_CONFIG.ceilingMs + 1000);
  const r4 = ar.evaluate(100000 + ADAPTIVE_CONFIG.ceilingMs + 1100);
  assert.equal(r4.changed || r3.changed, true, '天花板过期后应允许再升档');
  assert.equal(ar.stats.cap, 2);
}));

test('AdaptiveResolution：启动预热窗口不参与决策（加载抖动不算填充率不足）', () => withDpr(2, () => {
    const rm = fakeRenderManager();
    const perf = { frameStats: () => ({ samples: 60, meanMs: 60, p95Ms: 90 }) };
    const ar = new AdaptiveResolution({ renderManager: rm, perf });
    ar.stats.cap = 2;
    const reasons = [];
    for (let i = 0; i < ADAPTIVE_CONFIG.warmupWindows; i++) reasons.push(ar.evaluate(1000 + i).reason);
    assert.deepEqual(reasons, Array(ADAPTIVE_CONFIG.warmupWindows).fill('warmup'));
    assert.equal(ar.stats.cap, 2, '预热期不应降档');
}));

test('AdaptiveResolution：dpr=1 的屏幕不会把画面降到原生分辨率以下', () => {
  const rm = fakeRenderManager();
  const perf = { frameStats: () => ({ samples: 60, meanMs: 80, p95Ms: 90 }) };
  const ar = new AdaptiveResolution({ renderManager: rm, perf, config: NO_WARMUP });
  ar.stats.cap = 1;
  let t = 0;
  for (let i = 0; i < 20; i++) { t += 3000; ar.evaluate(t); }
  assert.equal(ar.stats.cap, 1, `不应低于 1（cap=${ar.stats.cap}）`);
  assert.equal(ar.stats.downshifts, 0);
});

test('AdaptiveResolution：冷却期内不再调整', () => withDpr(2, () => {
    const rm = fakeRenderManager();
    const perf = { frameStats: () => ({ samples: 60, meanMs: 41, p95Ms: 41 }) };
    const ar = new AdaptiveResolution({ renderManager: rm, perf, config: NO_WARMUP });
    ar.stats.cap = 2;
    ar.evaluate(1000);          // 立即降档
    const before = ar.stats.cap;
    const r = ar.evaluate(1001);   // 冷却中
    assert.equal(r.reason, 'cooldown');
    assert.equal(ar.stats.cap, before);
}));

test('AdaptiveResolution：帧时间恢复到余量后升档，且不超过 maxCap / 设备像素比', () => withDpr(2, () => {
    const rm = fakeRenderManager();
    const perf = { frameStats: () => ({ samples: 60, meanMs: 11, p95Ms: 12 }) };
    const ar = new AdaptiveResolution({ renderManager: rm, perf, config: NO_WARMUP });
    ar.stats.cap = 1;
    ar.evaluate(1e6);
    ar.evaluate(1e6 + 1);
    assert.ok(ar.stats.cap > 1, `cap=${ar.stats.cap}`);
    assert.ok(ar.stats.cap <= ADAPTIVE_CONFIG.maxCap);
    assert.equal(ar.stats.upshifts, 1);
}));

test('AdaptiveResolution：不会降到 minCap 以下，也不会超过 maxCap', () => {
  const rm = fakeRenderManager();
  const perf = { frameStats: () => ({ samples: 60, meanMs: 90, p95Ms: 90 }) };
  const ar = new AdaptiveResolution({ renderManager: rm, perf, config: NO_WARMUP });
  ar.stats.cap = 2;
  let t = 0;
  for (let i = 0; i < 40; i++) { t += 3000; ar.evaluate(t); }
  assert.ok(ar.stats.cap >= ADAPTIVE_CONFIG.minCap, `cap=${ar.stats.cap}`);
  const down = ar.stats.cap;
  const rm2 = fakeRenderManager();
  const perf2 = { frameStats: () => ({ samples: 60, meanMs: 8, p95Ms: 9 }) };
  const ar2 = new AdaptiveResolution({ renderManager: rm2, perf: perf2, config: NO_WARMUP });
  ar2.stats.cap = 1;
  let t2 = 0;
  for (let i = 0; i < 40; i++) { t2 += 3000; ar2.evaluate(t2); }
  assert.ok(ar2.stats.cap <= ADAPTIVE_CONFIG.maxCap, `cap=${ar2.stats.cap}`);
  assert.ok(down > 0);
});

test('AdaptiveResolution：无样本/关闭时不动作', () => {
  const rm = fakeRenderManager();
  const perf = { frameStats: () => ({ samples: 0, meanMs: 0, p95Ms: 0 }) };
  const ar = new AdaptiveResolution({ renderManager: rm, perf, config: NO_WARMUP });
  assert.equal(ar.evaluate(1).reason, 'no-samples');
  ar.setEnabled(false);
  assert.equal(ar.evaluate(2).reason, 'disabled');
  // Node 无 window -> devicePixelRatio 视为 1，关闭后应回到设备像素比而不是「降到最低」
  assert.equal(ar.stats.cap, 1, `cap=${ar.stats.cap}`);
  assert.equal(rm.getPixelRatioCap(), 1);
});

test('RenderManager 契约：唯一 rAF / 帧钩子 / 上下文事件 / 像素比钳位', () => {
  const src = fs.readFileSync(path.join(SITE, 'p1', 'core', 'RenderManager.mjs'), 'utf8');
  assert.equal((src.match(/requestAnimationFrame\(/g) || []).length, 2, '只允许 _loop 内续帧 + start() 首帧');
  assert.match(src, /addFrameHook/);
  assert.match(src, /webglcontextlost/);
  assert.match(src, /webglcontextrestored/);
  assert.match(src, /preventDefault/);
  assert.match(src, /setPixelRatioCap/);
  assert.match(src, /visibilitychange/);
  assert.match(src, /contextLost/);
});

test('P7 配置：阈值有据可依（来自实测），且不被业务字段污染', () => {
  assert.equal(P7_VERSION, '7.0.0-p7');
  assert.ok(PERF_CONFIG.windowSize >= 120);
  assert.ok(PERF_CONFIG.dropThresholdMs > 16.7);
  assert.ok(ADAPTIVE_CONFIG.downAboveP95Ms > ADAPTIVE_CONFIG.upBelowMeanMs);
  assert.ok(ADAPTIVE_CONFIG.steps[0] === ADAPTIVE_CONFIG.minCap);
  assert.equal(ADAPTIVE_CONFIG.steps[ADAPTIVE_CONFIG.steps.length - 1], ADAPTIVE_CONFIG.maxCap);
  const text = fs.readFileSync(path.join(SITE, 'p7', 'config.mjs'), 'utf8');
  for (const field of ['city', 'officer', 'king', 'money', 'food', 'arms', 'belong']) {
    assert.ok(!new RegExp(`\\b${field}\\s*:`).test(text), `配置里不应出现业务字段 ${field}`);
  }
});
