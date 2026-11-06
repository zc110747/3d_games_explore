/**
 * P1 RenderManager —— 全应用唯一 WebGLRenderer、唯一 rAF 循环。
 *
 * - 场景切换不重建 Renderer；start()/stop() 幂等，绝不重复注册动画循环。
 * - 渲染循环只做 update + render，不读取任何游戏数据（状态读取由 GameAdapter/EventManager 负责）。
 * - 支持 pause/resume（暂停时仍保持循环以便恢复，但不渲染）。
 * - 窗口尺寸 / 容器尺寸变化统一处理；像素比受控；WebGL 初始化失败有明确降级提示。
 */
import { RENDER_CONFIG } from './config.mjs';
import { EVENTS } from './EventManager.mjs';

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
    this._resizeHandler = null;
    this._observer = null;
    this.failed = false;
    this.stats = { frames: 0, renders: 0, resizes: 0 };

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

  /** 统一尺寸更新；同时把 aspect 交给相机管理器。 */
  resize() {
    if (this.failed) return;
    const w = Math.max(1, this.container.clientWidth || window.innerWidth);
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, this.config.maxPixelRatio);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.stats.resizes++;
    if (this._onResize) this._onResize(w / h, w, h, dpr);
  }

  /** 注册每帧回调（由 main 注入 SceneManager.update + render），只保留一个。 */
  setFrameCallback(fn) { this._frameCallback = fn; }

  /** 统一渲染入口。 */
  render(scene, camera) {
    if (this.failed || !scene || !camera) return false;
    this.renderer.render(scene, camera);
    this.stats.renders++;
    return true;
  }

  _loop = (time) => {
    if (!this._running) return;
    const dt = this._lastTime ? Math.min(0.1, (time - this._lastTime) / 1000) : 0;
    this._lastTime = time;
    this.stats.frames++;
    if (!this._paused && this._frameCallback) {
      try { this._frameCallback(dt, time); }
      catch (e) {
        console.error('[P1] 帧回调异常:', e);
        if (this.events) this.events.emit(EVENTS.RENDERER_ERROR, { stage: 'frame', message: e.message });
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
      drawCalls: i.render.calls,
      triangles: i.render.triangles,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      pixelRatio: this.renderer.getPixelRatio(),
      size: this.renderer.getSize(new this.THREE.Vector2()).toArray(),
    };
  }

  dispose() {
    this.stop();
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
    if (this._observer) this._observer.disconnect();
    this._frameCallback = null;
    if (!this.failed) {
      this.renderer.dispose();
      if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}
