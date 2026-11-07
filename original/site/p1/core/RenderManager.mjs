/**
 * P1 RenderManager —— 全应用唯一 WebGLRenderer、唯一 rAF 循环。
 *
 * - 场景切换不重建 Renderer；start()/stop() 幂等，绝不重复注册动画循环。
 * - 渲染循环只做 update + render，不读取任何游戏数据（状态读取由 GameAdapter/EventManager 负责）。
 * - 支持 pause/resume（暂停时仍保持循环以便恢复，但不渲染）。
 * - 窗口尺寸 / 容器尺寸变化统一处理；像素比受控；WebGL 初始化失败有明确降级提示。
 *
 * P7 追加（都是浏览器真实事件，不是模拟）：
 * - 帧时间钩子 addFrameHook()：给 PerfMonitor 采样用，不改渲染流程。
 * - WebGL 上下文丢失/恢复：丢失期间**跳过帧回调**（不再向失效上下文提交），恢复后自动继续，
 *   并派发 RENDERER_CONTEXT_LOST / RENDERER_CONTEXT_RESTORED。业务状态一律不动。
 * - 像素比上限 setPixelRatioCap()：供自适应分辨率使用（降低填充率压力，不改逻辑）。
 * - 页面隐藏自动暂停、可见恢复（标签页切换不累积无效绘制）。
 */
import { RENDER_CONFIG } from './config.mjs';
import { EVENTS } from './EventManager.mjs';

/** Node 测试里没有 performance/window，统一兜底，避免模块级依赖全局。 */
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class RenderManager {
  constructor({ THREE, container, events, config = RENDER_CONFIG, onResize = null }) {
    if (!THREE) throw new TypeError('RenderManager 需要 THREE');
    if (!container) throw new TypeError('RenderManager 需要容器元素');
    this.THREE = THREE;
    this.container = container;
    this.events = events;
    this.config = config;
    this._onResize = onResize;
    this._running = false;
    this._paused = false;
    this._raf = 0;
    this._lastTime = 0;
    this._frameCallback = null;
    this._frameHooks = [];
    this._resizeHandler = null;
    this._observer = null;
    this._contextHandlers = null;
    this._visibilityHandler = null;
    this._pixelCap = config.maxPixelRatio;   // P7：自适应分辨率下调整；默认与配置一致
    this._effectiveDpr = 1;
    this.contextLost = false;
    this.failed = false;
    this.stats = {
      frames: 0, renders: 0, resizes: 0, skipped: 0,
      contextLosses: 0, contextRestores: 0, visibilityPauses: 0,
      busyMsLast: 0, busyMsTotal: 0,
    };

    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: config.antialias,
        alpha: config.alpha,
        powerPreference: config.powerPreference,
      });
      this.renderer.setClearColor(config.background, 1);
      if (config.colorSpace === 'srgb' && THREE.SRGBColorSpace) {
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      }
      if (config.toneMapping === 'none' && THREE.NoToneMapping !== undefined) {
        this.renderer.toneMapping = THREE.NoToneMapping;
      }
      this.renderer.shadowMap.enabled = !!config.shadowEnabled;
      this.canvas = this.renderer.domElement;
      this.canvas.setAttribute('data-p1-stage', '1');
      this.container.appendChild(this.canvas);
      this._installResize();
      this._installContextEvents();
      this._installVisibility();
      this.resize();
    } catch (e) {
      this.failed = true;
      this.error = e;
      this._showFatal(e);
      if (events) events.emit(EVENTS.RENDERER_ERROR, { stage: 'init', message: e.message });
    }
  }

  _showFatal(e) {
    if (typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.id = 'p1-fatal';
    el.textContent = `WebGL 初始化失败：${e.message}。原版 2D 画面仍可正常运行；请检查浏览器 WebGL / 显卡驱动。`;
    this.container.appendChild(el);
  }

  _installResize() {
    if (typeof window === 'undefined') return;
    this._resizeHandler = () => this.resize();
    window.addEventListener('resize', this._resizeHandler);
    if (typeof ResizeObserver !== 'undefined') {
      this._observer = new ResizeObserver(() => this.resize());
      this._observer.observe(this.container);
    }
  }

  /**
   * P7：WebGL 上下文丢失/恢复。
   * three.js 自己在 restore 时会重建 GL 状态/属性缓存，资源在下一帧按需重新上传；
   * 这里只负责「丢失期间不再提交绘制」+ 通知上层给用户明确提示。
   */
  _installContextEvents() {
    if (!this.canvas || typeof this.canvas.addEventListener !== 'function') return;
    const onLost = (event) => {
      // 必须 preventDefault，否则浏览器不会尝试恢复上下文
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      this.contextLost = true;
      this.stats.contextLosses++;
      if (this.events) {
        this.events.emit(EVENTS.RENDERER_CONTEXT_LOST, {
          at: nowMs(), frames: this.stats.frames, reason: 'webglcontextlost',
        });
      }
    };
    const onRestored = () => {
      this.contextLost = false;
      this.stats.contextRestores++;
      // 尺寸/像素比在丢失期间可能变化，恢复后重新应用一次
      try { this.resize(); } catch (_) { /* 容器可能已卸载 */ }
      if (this.events) {
        this.events.emit(EVENTS.RENDERER_CONTEXT_RESTORED, {
          at: nowMs(), frames: this.stats.frames, reason: 'webglcontextrestored',
        });
      }
    };
    this.canvas.addEventListener('webglcontextlost', onLost, false);
    this.canvas.addEventListener('webglcontextrestored', onRestored, false);
    this._contextHandlers = { onLost, onRestored };
  }

  /** P7：标签页隐藏时暂停绘制（rAF 本身也会被节流，这里显式跳过更省电）。 */
  _installVisibility() {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    this._visibilityHandler = () => {
      const hidden = !!document.hidden;
      if (hidden) {
        this.stats.visibilityPauses++;
        this.pause();
      } else {
        this.resume();
      }
      if (this.events) {
        this.events.emit(EVENTS.RENDERER_VISIBILITY_CHANGED, { hidden, paused: this._paused });
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  /** 统一尺寸更新；同时把 aspect 交给相机管理器。 */
  resize() {
    if (this.failed || this.contextLost) return;
    const w = Math.max(1, this.container.clientWidth || window.innerWidth);
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, this.config.maxPixelRatio, this._pixelCap);
    this._effectiveDpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.stats.resizes++;
    if (this._onResize) this._onResize(w / h, w, h, dpr);
  }

  /**
   * P7：像素比上限（自适应分辨率用）。只改渲染分辨率，不改任何游戏数据/相机逻辑。
   * @returns {{cap:number, dpr:number, changed:boolean}}
   */
  setPixelRatioCap(cap) {
    const max = this.config.maxPixelRatio;
    const next = Math.max(0.5, Math.min(max, Number(cap) || max));
    const changed = Math.abs(next - this._pixelCap) > 1e-3;
    this._pixelCap = next;
    if (changed) this.resize();
    return { cap: next, dpr: this._effectiveDpr, changed };
  }

  getPixelRatioCap() { return this._pixelCap; }
  get effectivePixelRatio() { return this._effectiveDpr; }

  /** 注册每帧回调（由 main 注入 SceneManager.update + render），只保留一个。 */
  setFrameCallback(fn) { this._frameCallback = fn; }

  /** P7：追加只读帧钩子；返回注销函数。不参与渲染决策。 */
  addFrameHook(fn) {
    if (typeof fn !== 'function') throw new TypeError('帧钩子必须是函数');
    this._frameHooks.push(fn);
    return () => {
      const i = this._frameHooks.indexOf(fn);
      if (i >= 0) this._frameHooks.splice(i, 1);
    };
  }

  /** 统一渲染入口。 */
  render(scene, camera) {
    if (this.failed || this.contextLost || !scene || !camera) return false;
    this.renderer.render(scene, camera);
    this.stats.renders++;
    return true;
  }

  _loop = (time) => {
    if (!this._running) return;
    // 真实帧间隔（未钳位）：性能统计必须用它，否则启动期 700ms 的着色器编译会被
    // 钳成 100ms，出现「CPU 耗时 > 平均帧时间」这种物理上不可能的数字。
    const rawMs = this._lastTime ? Math.max(0, time - this._lastTime) : 0;
    const dt = this._lastTime ? Math.min(0.1, rawMs / 1000) : 0;
    this._lastTime = time;
    this.stats.frames++;
    let busy = 0;
    if (!this._paused && !this.contextLost && this._frameCallback) {
      const t0 = nowMs();
      try { this._frameCallback(dt, time); }
      catch (e) {
        console.error('[P1] 帧回调异常:', e);
        if (this.events) this.events.emit(EVENTS.RENDERER_ERROR, { stage: 'frame', message: e.message });
      }
      busy = nowMs() - t0;
      this.stats.busyMsLast = busy;
      this.stats.busyMsTotal += busy;
    } else if (this.contextLost) {
      this.stats.skipped++;
    }
    if (this._frameHooks.length) {
      for (let i = 0; i < this._frameHooks.length; i++) {
        // 第 5 个参数是真实帧间隔（ms，未钳位），只给性能采样用
        try { this._frameHooks[i](dt, time, busy, this.contextLost, rawMs); }
        catch (e) { /* 钩子不得影响渲染循环 */ }
      }
    }
    this._raf = requestAnimationFrame(this._loop);
  };

  start() {
    if (this.failed || this._running) return false;   // 幂等：不重复注册 rAF
    this._running = true;
    this._lastTime = 0;
    this._raf = requestAnimationFrame(this._loop);
    return true;
  }

  stop() {
    if (!this._running) return false;
    this._running = false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    return true;
  }

  pause() { this._paused = true; return this._paused; }
  resume() { this._paused = false; return this._paused; }
  get isRunning() { return this._running; }
  get isPaused() { return this._paused; }

  getInfo() {
    if (this.failed) return { failed: true, message: this.error && this.error.message };
    const i = this.renderer.info;
    return {
      failed: false,
      frames: this.stats.frames,
      renders: this.stats.renders,
      resizes: this.stats.resizes,
      skipped: this.stats.skipped,
      contextLost: this.contextLost,
      contextLosses: this.stats.contextLosses,
      contextRestores: this.stats.contextRestores,
      visibilityPauses: this.stats.visibilityPauses,
      busyMsLast: +this.stats.busyMsLast.toFixed(3),
      drawCalls: i.render.calls,
      triangles: i.render.triangles,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      programs: i.programs ? i.programs.length : null,
      pixelRatio: this.renderer.getPixelRatio(),
      pixelRatioCap: this._pixelCap,
      size: this.renderer.getSize(new this.THREE.Vector2()).toArray(),
    };
  }

  dispose() {
    this.stop();
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
    if (this._observer) this._observer.disconnect();
    if (this.canvas && this._contextHandlers) {
      this.canvas.removeEventListener('webglcontextlost', this._contextHandlers.onLost);
      this.canvas.removeEventListener('webglcontextrestored', this._contextHandlers.onRestored);
      this._contextHandlers = null;
    }
    if (this._visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    this._frameHooks.length = 0;
    this._frameCallback = null;
    if (!this.failed) {
      this.renderer.dispose();
      if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}
