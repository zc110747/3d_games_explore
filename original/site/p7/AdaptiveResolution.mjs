/**
 * P7 AdaptiveResolution —— 按帧时间反馈调整渲染像素比（动态分辨率）。
 *
 * 为什么只动像素比：
 *   P7 基线实测瓶颈在填充率（1600x900@dpr2 时帧时间 41ms，而 draw call 仅 50~88、三角形 13k），
 *   降低像素比是唯一「不改场景层次、不改拾取、不改动画」就能减轻 GPU 压力的手段。
 *
 * 策略（全部基于实测帧时间，不猜设备）：
 *   - 掉到 p95 > 22ms（约 <45fps）       -> 立即降 1 档；p95 > 44ms 一次降 2 档（快收敛）
 *   - 稳定跑满 vsync（mean < 18ms）2 窗口 -> 升 1 档（试探更高分辨率）
 *   - 降档记「天花板」：刚失败过的档位 30s 内不再尝试，避免 1.25/1.5 之间来回抖
 *   - 启动前 3 个窗口不决策（加载/首帧抖动不是填充率问题）
 *   - 设备像素比变化（窗口拖到另一块屏）时重新从该屏原生像素比起步
 *
 * 边界：
 *   - 只调用 renderManager.setPixelRatioCap()，不改相机、不改任何游戏数据。
 *   - 有效下限 = min(1, 设备像素比)：dpr=1 的屏幕上不把画面降到原生分辨率以下。
 */
import { ADAPTIVE_CONFIG } from './config.mjs';

export class AdaptiveResolution {
  constructor({ renderManager, perf, config = ADAPTIVE_CONFIG, log = null } = {}) {
    if (!renderManager) throw new TypeError('AdaptiveResolution 需要 renderManager');
    if (!perf) throw new TypeError('AdaptiveResolution 需要 perf');
    this.renderManager = renderManager;
    this.perf = perf;
    this.config = config;
    this.log = log;
    this.enabled = !!config.enabled;
    this._upStreak = 0;
    this._lastChangeAt = 0;
    this._ceiling = config.maxCap;
    this._ceilingUntil = 0;
    this._lastDpr = this._devicePixelRatio();
    this._timer = null;
    this.stats = {
      evaluations: 0, downshifts: 0, upshifts: 0, dprChanges: 0,
      cap: this._initialCap(), minCap: this._effectiveMinCap(), maxCap: config.maxCap,
      lastReason: 'init', history: [],
    };
  }

  _devicePixelRatio() {
    if (typeof window !== 'undefined' && window.devicePixelRatio) return window.devicePixelRatio;
    return 1;
  }

  _initialCap() {
    const dpr = this._devicePixelRatio();
    const cap = this.config.startAtDevicePixelRatio ? Math.min(dpr, this.config.maxCap) : this.config.maxCap;
    return Math.max(this._effectiveMinCap(), Math.min(this.config.maxCap, cap));
  }

  /** 有效下限：不低于 min(1, 设备像素比)。 */
  _effectiveMinCap() {
    return Math.min(1, Math.min(this._devicePixelRatio(), this.config.maxCap));
  }

  _indexOfNearest(cap) {
    const steps = this.config.steps;
    let idx = 0, best = Infinity;
    for (let i = 0; i < steps.length; i++) {
      const d = Math.abs(steps[i] - cap);
      if (d < best) { best = d; idx = i; }
    }
    return idx;
  }

  _step(cap, dir, count = 1) {
    const steps = this.config.steps;
    const idx = this._indexOfNearest(cap);
    const next = steps[Math.max(0, Math.min(steps.length - 1, idx + dir * count))];
    return Math.max(this._effectiveMinCap(), Math.min(this.config.maxCap, next));
  }

  start() {
    if (this._timer || !this.enabled) return false;
    this._lastChangeAt = Date.now();          // 启动即进入冷却，吸收启动抖动
    this.renderManager.setPixelRatioCap(this.stats.cap);
    this._timer = setInterval(() => this.evaluate(), this.config.windowMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    return true;
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    return true;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) {
      this.stop();
      // 关闭时回到设备像素比，不做「降到最低」这种破坏画质的收尾
      this.stats.cap = this._initialCap();
      this.renderManager.setPixelRatioCap(this.stats.cap);
      this.stats.lastReason = 'disabled';
    } else {
      this.start();
    }
    return this.enabled;
  }

  /** 设备像素比变化：重新从该屏原生像素比起步，清空天花板与连续计数。 */
  _syncDevicePixelRatio(now) {
    const dpr = this._devicePixelRatio();
    if (Math.abs(dpr - this._lastDpr) < 1e-6) return null;
    this._lastDpr = dpr;
    this._ceiling = this.config.maxCap;
    this._ceilingUntil = 0;
    this._upStreak = 0;
    this.stats.dprChanges++;
    const target = Math.max(this._effectiveMinCap(), Math.min(this.config.maxCap, dpr));
    if (Math.abs(target - this.stats.cap) > 1e-3) {
      this._apply(target, `设备像素比变为 ${dpr}`, now);
      return { changed: true, cap: this.stats.cap, reason: 'dpr-change' };
    }
    return { changed: false, cap: this.stats.cap, reason: 'dpr-change(no-op)' };
  }

  /**
   * 单次评估：读窗口帧统计决定是否调整。
   * 返回 {changed, cap, reason, frame}，供面板与测试使用。
   */
  evaluate(nowArg) {
    const now = Number.isFinite(nowArg) ? nowArg : Date.now();
    const frame = this.perf.frameStats();
    this.stats.evaluations++;
    const out = { changed: false, cap: this.stats.cap, reason: '', frame };

    if (!this.enabled) { out.reason = 'disabled'; return out; }

    // 设备像素比变化要**立刻**吸收（窗口拖到另一块屏 / 演示时改缩放），不能等预热结束，
    // 否则会在这段时间里一直用旧屏的分辨率渲染。
    const dprChange = this._syncDevicePixelRatio(now);
    if (dprChange) return { ...out, ...dprChange, frame };

    if (this.stats.evaluations <= (this.config.warmupWindows || 0)) { out.reason = 'warmup'; return out; }

    if (!frame.samples || frame.meanMs <= 0) { out.reason = 'no-samples'; return out; }
    if (now - this._lastChangeAt < this.config.cooldownMs) { out.reason = 'cooldown'; return out; }

    const minCap = this._effectiveMinCap();
    const maxCap = Math.min(this.config.maxCap, this._devicePixelRatio());

    // 1) 帧时间失控：立即降档（严重时一次降两档，避免长时间掉帧）
    if (frame.p95Ms > this.config.downAboveP95Ms && this.stats.cap > minCap + 1e-3) {
      const severe = frame.p95Ms > this.config.downAboveP95Ms * 2;
      const from = this.stats.cap;
      const next = this._step(from, -1, severe ? 2 : 1);
      if (next < from - 1e-3) {
        this._ceiling = from;                       // 该档位实测撑不住，30s 内不再尝试
        this._ceilingUntil = now + (this.config.ceilingMs || 30000);
        this._upStreak = 0;
        this._apply(next, `p95 ${frame.p95Ms}ms > ${this.config.downAboveP95Ms}ms${severe ? '（严重，降两档）' : ''}`, now);
        this.stats.downshifts++;
        return { ...out, changed: true, cap: this.stats.cap, reason: 'downshift' };
      }
    }

    // 2) 稳定跑满 vsync：试探升档（受天花板与冷却约束；p95 也必须是干净 60fps）
    const p95Clean = frame.p95Ms <= (this.config.upBelowP95Ms || this.config.downAboveP95Ms * 0.85);
    if (frame.meanMs < this.config.upBelowMeanMs && p95Clean && this.stats.cap < maxCap - 1e-3) {
      this._upStreak++;
      if (this._upStreak >= this.config.consecutiveWindows) {
        const next = this._step(this.stats.cap, 1, 1);
        const blockedByCeiling = next >= this._ceiling - 1e-3 && now < this._ceilingUntil;
        if (next > this.stats.cap + 1e-3 && !blockedByCeiling) {
          this._upStreak = 0;
          this._apply(next, `mean ${frame.meanMs}ms < ${this.config.upBelowMeanMs}ms（稳定 60fps）`, now);
          this.stats.upshifts++;
          return { ...out, changed: true, cap: this.stats.cap, reason: 'upshift' };
        }
        out.reason = blockedByCeiling ? 'ceiling-hold' : 'stable-at-max';
        return out;
      }
      out.reason = 'can-up(wait)';
      return out;
    }

    this._upStreak = 0;
    out.reason = 'stable';
    return out;
  }

  _apply(cap, reason, now) {
    const r = this.renderManager.setPixelRatioCap(cap);
    this.stats.cap = +Number(cap).toFixed(3);
    this.stats.minCap = this._effectiveMinCap();
    this._lastChangeAt = now;
    this.stats.lastReason = reason;
    this.stats.history.push({ at: now, cap: this.stats.cap, dpr: r.dpr, reason });
    if (this.stats.history.length > 40) this.stats.history.shift();
    if (this.log) this.log(`自适应分辨率 -> ${this.stats.cap}（${reason}）`);
    return r;
  }

  getStatus() {
    const frame = this.perf.frameStats();
    return {
      enabled: this.enabled,
      cap: this.stats.cap,
      devicePixelRatio: this._devicePixelRatio(),
      effectivePixelRatio: this.renderManager.effectivePixelRatio ?? null,
      minCap: this._effectiveMinCap(),
      maxCap: this.stats.maxCap,
      ceiling: this._ceiling,
      dprChanges: this.stats.dprChanges,
      warmupWindows: this.config.warmupWindows || 0,
      evaluations: this.stats.evaluations,
      downshifts: this.stats.downshifts,
      upshifts: this.stats.upshifts,
      lastReason: this.stats.lastReason,
      p95Ms: frame.p95Ms,
      meanMs: frame.meanMs,
      history: this.stats.history.slice(-8),
    };
  }
}
