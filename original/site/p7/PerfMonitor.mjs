/**
 * P7 PerfMonitor —— 只读性能采样器。
 *
 * 严格的边界：
 *   - 只读 renderManager 的统计与 renderer.info，不写任何游戏状态。
 *   - 不新建渲染循环，不新建 requestAnimationFrame；挂在 RenderManager 的帧钩子上。
 *   - 浏览器不暴露的指标（GPU 时间、显存精确占用）如实标 unavailable，不编造数值。
 *
 * 采样口径：
 *   frame   ：RenderManager 传入的 dt（真实帧间隔，已按 0.1s 上限截断）
 *   cpu     ：帧回调内部耗时（performance.now 差值），不含 vsync 等待
 *   renderer：renderer.info（drawCalls / triangles / geometries / textures / programs）
 *   memory  ：performance.memory（仅 Chromium）
 */
import { PERF_CONFIG, P7_VERSION } from './config.mjs';

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

export class PerfMonitor {
  constructor({ renderManager, events = null, config = PERF_CONFIG, log = null } = {}) {
    if (!renderManager) throw new TypeError('PerfMonitor 需要 renderManager');
    this.renderManager = renderManager;
    this.events = events;
    this.config = config;
    this.log = log;
    this.version = P7_VERSION;
    this._frameMs = new Float64Array(config.windowSize);
    this._busyMs = new Float64Array(config.windowSize);
    this._idx = 0;
    this._count = 0;
    this._total = 0;
    this._unhook = null;
    this._attached = false;
    this._startedAt = 0;
    this._slowFrames = 0;
    this._dropped = 0;
    this._sceneSwitches = { count: 0, lastMs: 0, totalMs: 0, lastTo: null };
    this._baseline = null;       // 附着时的资源基线（长跑增长对比）
    this._heapSamples = [];
    this._heapTimer = null;
    this._lastHeap = null;
    this.stats = { samples: 0, hooksRejected: 0 };
  }

  attach() {
    if (this._attached) return false;
    this._unhook = this.renderManager.addFrameHook(this._onFrame);
    this._attached = true;
    this._startedAt = nowMs();
    this._baseline = this.resourceSample();
    if (this.config.heapAvailable && typeof setInterval === 'function') {
      this._heapTimer = setInterval(() => this.sampleHeap(), this.config.heapSampleMs);
      if (this._heapTimer && typeof this._heapTimer.unref === 'function') this._heapTimer.unref();
    }
    return true;
  }

  detach() {
    if (!this._attached) return false;
    if (this._unhook) this._unhook();
    this._unhook = null;
    this._attached = false;
    if (this._heapTimer) { clearInterval(this._heapTimer); this._heapTimer = null; }
    return true;
  }

  get attached() { return this._attached; }

  /**
   * 帧钩子。`rawMs` 是渲染层给出的**未钳位**真实帧间隔（渲染模拟用的 dt 会被钳到 0.1s，
   * 直接用会把启动期 700ms 的着色器编译记成 100ms）。没有第 5 参时退回 dt。
   */
  _onFrame = (dt, time, busy, lost, rawMs) => {
    const frameMs = Math.max(0, Number.isFinite(rawMs) ? rawMs : dt * 1000);
    this._frameMs[this._idx] = frameMs;
    this._busyMs[this._idx] = Math.max(0, busy || 0);
    this._idx = (this._idx + 1) % this.config.windowSize;
    if (this._count < this.config.windowSize) this._count++;
    this._total++;
    this.stats.samples++;
    if (frameMs > this.config.dropThresholdMs) this._dropped++;
    if (frameMs > this.config.slowFrameMs) this._slowFrames++;
  };

  /** 当前窗口的帧统计。 */
  frameStats() {
    const n = this._count;
    if (!n) {
      return { samples: 0, fps: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, jitterMs: 0, dropped: 0, dropRate: 0 };
    }
    const frames = [];
    const busies = [];
    for (let i = 0; i < n; i++) {
      frames.push(this._frameMs[i]);
      busies.push(this._busyMs[i]);
    }
    // 第 0 帧（页面刚起）的 dt 是 0，不参与均值
    const valid = frames.filter((x) => x > 0.5);
    const sorted = valid.slice().sort((a, b) => a - b);
    const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
    const variance = valid.length ? valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length : 0;
    const busySorted = busies.filter((x) => x >= 0).sort((a, b) => a - b);
    return {
      samples: n,
      fps: mean > 0 ? +(1000 / mean).toFixed(2) : 0,
      meanMs: +mean.toFixed(2),
      p50Ms: +percentile(sorted, 0.5).toFixed(2),
      p95Ms: +percentile(sorted, 0.95).toFixed(2),
      p99Ms: +percentile(sorted, 0.99).toFixed(2),
      maxMs: +(sorted.length ? sorted[sorted.length - 1] : 0).toFixed(2),
      jitterMs: +Math.sqrt(variance).toFixed(2),
      dropped: this._dropped,
      dropRate: this._total ? +(this._dropped / this._total).toFixed(4) : 0,
      busyMeanMs: busySorted.length ? +(busySorted.reduce((a, b) => a + b, 0) / busySorted.length).toFixed(3) : 0,
      busyP95Ms: +percentile(busySorted, 0.95).toFixed(3),
      busyMaxMs: +(busySorted.length ? busySorted[busySorted.length - 1] : 0).toFixed(3),
      busyShare: mean > 0 && busySorted.length
        ? +((busySorted.reduce((a, b) => a + b, 0) / busySorted.length) / mean).toFixed(4) : 0,
    };
  }

  /** renderer.info 快照 + 像素比。 */
  rendererInfo() {
    const rm = this.renderManager;
    const r = rm.renderer;
    if (!r) return { available: false };
    const i = r.info;
    return {
      available: true,
      drawCalls: i.render.calls,
      triangles: i.render.triangles,
      lines: i.render.lines,
      points: i.render.points,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      programs: i.programs ? i.programs.length : null,
      pixelRatio: r.getPixelRatio(),
      pixelRatioCap: rm.getPixelRatioCap ? rm.getPixelRatioCap() : null,
      contextLost: !!rm.contextLost,
      canvas: r.getSize(new rm.THREE.Vector2()).toArray(),
    };
  }

  /** JS 堆：只在 Chromium 可用，其它环境如实返回 unavailable。 */
  memory() {
    if (typeof performance === 'undefined' || !performance.memory) {
      return { available: false, reason: 'performance.memory 在该浏览器不可用（仅 Chromium 提供）' };
    }
    const m = performance.memory;
    return {
      available: true,
      usedMB: +(m.usedJSHeapSize / 1048576).toFixed(2),
      totalMB: +(m.totalJSHeapSize / 1048576).toFixed(2),
      limitMB: +(m.jsHeapSizeLimit / 1048576).toFixed(2),
      usedRatio: +(m.usedJSHeapSize / m.jsHeapSizeLimit).toFixed(4),
    };
  }

  /** GPU 计时：WebGL 无标准接口；EXT_disjoint_timer_query 语义也不足以给出稳定帧时间。 */
  gpu() {
    const r = this.renderManager.renderer;
    let ext = false;
    try {
      const gl = r && r.getContext && r.getContext();
      ext = !!(gl && (gl.getExtension('EXT_disjoint_timer_query_webgl2')
        || gl.getExtension('EXT_disjoint_timer_query')));
    } catch (_) { ext = false; }
    return {
      measurable: false,
      extensionPresent: ext,
      reason: 'WebGL 不提供稳定的 GPU 帧时间读数；'
        + (ext ? 'EXT_disjoint_timer_query 存在但需专用查询管线，本项目不使用以免影响渲染路径'
          : '本环境无 EXT_disjoint_timer_query'),
    };
  }

  sampleHeap() {
    const m = this.memory();
    if (!m.available) return null;
    this._lastHeap = m;
    this._heapSamples.push({ t: nowMs(), usedMB: m.usedMB });
    if (this._heapSamples.length > 600) this._heapSamples.shift();
    return m;
  }

  /** 资源快照（长跑增长对比用）。 */
  resourceSample() {
    const info = this.rendererInfo();
    const mem = this.lastHeap || (this.sampleHeap() || { available: false });
    return {
      at: nowMs(),
      geometries: info.geometries ?? null,
      textures: info.textures ?? null,
      programs: info.programs ?? null,
      usedMB: mem.available ? mem.usedMB : null,
      domNodes: typeof document !== 'undefined' ? document.querySelectorAll('*').length : null,
    };
  }

  get lastHeap() { return this._lastHeap; }

  /** 记录一次场景切换耗时（由 main 在 switchTo 前后打点，不用自己的计时器）。 */
  noteSceneSwitch(to, durationMs) {
    this._sceneSwitches.count++;
    this._sceneSwitches.lastMs = +Number(durationMs || 0).toFixed(2);
    this._sceneSwitches.totalMs += Number(durationMs || 0);
    this._sceneSwitches.lastTo = to || null;
    return { ...this._sceneSwitches, avgMs: +(this._sceneSwitches.totalMs / this._sceneSwitches.count).toFixed(2) };
  }

  get sceneSwitches() { return { ...this._sceneSwitches, avgMs: this._sceneSwitches.count ? +(this._sceneSwitches.totalMs / this._sceneSwitches.count).toFixed(2) : 0 }; }

  /**
   * 长跑增长：从基线到现在。
   * 注意基线的成立条件：attach() 发生在场景装配之前，那一刻 geometries/textures 还是 0，
   * 直接相减会把「场景装配」误读成「资源泄漏」（面板上出现过 Geo +10 / Tex +40 / 堆 +54MB）。
   * 所以在第一次看到非空场景时把基线就地重设，之后才算真正的增长。
   */
  longRun() {
    const cur = this.resourceSample();
    let base = this._baseline;
    let rebased = false;
    if (!base) return { available: false };
    if (base.geometries === 0 && cur.geometries > 0) {
      this._baseline = cur;
      base = cur;
      rebased = true;
    }
    const heap = this._heapSamples;
    return {
      available: true,
      rebased,
      spanSec: +((cur.at - base.at) / 1000).toFixed(1),
      geometries: base.geometries == null || cur.geometries == null ? null : cur.geometries - base.geometries,
      textures: base.textures == null || cur.textures == null ? null : cur.textures - base.textures,
      programs: base.programs == null || cur.programs == null ? null : cur.programs - base.programs,
      usedMB: base.usedMB == null || cur.usedMB == null ? null : +(cur.usedMB - base.usedMB).toFixed(2),
      domNodes: base.domNodes == null || cur.domNodes == null ? null : cur.domNodes - base.domNodes,
      heapSamples: heap.length,
      heapMinMB: heap.length ? Math.min(...heap.map((x) => x.usedMB)) : null,
      heapMaxMB: heap.length ? Math.max(...heap.map((x) => x.usedMB)) : null,
    };
  }

  setAdaptive(status) { this._adaptive = status || null; return this._adaptive; }

  /** 完整报告（供 __P7__.perfReport() 与文档引用）。 */
  report() {
    return {
      version: this.version,
      attached: this._attached,
      uptimeSec: +((nowMs() - this._startedAt) / 1000).toFixed(1),
      frame: this.frameStats(),
      renderer: this.rendererInfo(),
      memory: this.memory(),
      gpu: this.gpu(),
      longRun: this.longRun(),
      scene: this.sceneSwitches,
      adaptive: this._adaptive || null,
      totalSamples: this._total,
      slowFrames: this._slowFrames,
    };
  }

  /**
   * 只重设「长跑基线」（资源/堆），**不动帧统计**。
   * 用在「场景刚装配完」这个时刻：attach() 时几何体还是 0，长跑增长会把装配算成泄漏；
   * 但帧统计必须保留，自检/面板要能立刻读到真实样本。
   */
  rebaseline() {
    this._lastHeap = null;
    this._heapSamples = [];
    this._baseline = this.resourceSample();
    return { ...this._baseline };
  }

  reset() {
    this._frameMs.fill(0);
    this._busyMs.fill(0);
    this._idx = 0;
    this._count = 0;
    this._total = 0;
    this._dropped = 0;
    this._slowFrames = 0;
    this._startedAt = nowMs();
    // 必须丢掉上一次的堆读数：attach 时的采样早于游戏数据装载，
    // 直接复用会把「装资源」算成「堆涨了 50MB」。重设基线时重新采一次。
    this._lastHeap = null;
    this._heapSamples = [];
    this._baseline = this.resourceSample();
    return true;
  }

  dispose() {
    this.detach();
    this._heapSamples = [];
    this._adaptive = null;
  }
}
