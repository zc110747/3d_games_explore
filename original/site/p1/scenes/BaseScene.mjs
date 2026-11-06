/**
 * P1 场景基类 —— 统一生命周期 enter / update / render / exit / dispose。
 * 场景只创建自己的 Scene/Camera/资源；全局 Renderer 由 RenderManager 唯一持有。
 * 事件订阅以 this 为 owner，exit() 时统一取消，避免监听器泄漏。
 */
import { RENDER_CONFIG } from '../core/config.mjs';

export class BaseScene {
  constructor({ id, THREE, assets, events, coordinate, cameraManager, adapter }) {
    if (!THREE) throw new TypeError('场景需要 THREE');
    this.id = id;
    this.THREE = THREE;
    this.assets = assets;
    this.events = events;
    this.coordinate = coordinate;
    this.cameraManager = cameraManager;
    this.adapter = adapter;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(RENDER_CONFIG.background);
    this.camera = null;
    this.context = {};
    this._subs = [];
    this._built = false;
    this._disposed = false;
    this.elapsed = 0;
    this.frameCount = 0;
    this._uiHost = null;
  }

  onEvent(type, fn) {
    this._subs.push(this.events.on(type, fn, { owner: this }));
  }

  /** 子类实现 _build() 创建自身资源；只建一次。 */
  _build() {}

  enter(context = {}) {
    if (this._disposed) throw new Error(`场景 ${this.id} 已销毁，不能再次进入`);
    this.context = { ...context };
    if (!this._built) { this._build(); this._built = true; }
    // P2 修复：exit() 会取消该场景的全部订阅，因此每次 enter 都必须重建订阅。
    // 子类把订阅放在 _onEnter()，不要放在只执行一次的 _build() 里。
    this._onEnter(this.context);
    // SCENE_CHANGED 由 SceneManager 统一派发，避免同一切换被处理两次。
    return this;
  }

  /** 每次 enter() 都会调用；子类覆写以建立/重建事件订阅。 */
  _onEnter(_context) {}

  update(dt) {
    this.elapsed += dt;
    this.frameCount++;
  }

  /** 统一走 RenderManager.render()，场景不直接持有 renderer。 */
  render(renderManager) {
    if (!this.camera) return false;
    return renderManager.render(this.scene, this.camera);
  }

  /** HTML UI 挂载入口（城市/战斗场景使用；普通文字菜单不做成 3D）。 */
  mountUI(container) {
    if (!container) return null;
    this.unmountUI();
    const el = document.createElement('div');
    el.className = 'p1-scene-ui';
    el.dataset.p1UiBlock = '1';
    el.dataset.scene = this.id;
    container.appendChild(el);
    this._uiHost = el;
    return el;
  }

  unmountUI() {
    if (this._uiHost && this._uiHost.parentNode) this._uiHost.parentNode.removeChild(this._uiHost);
    this._uiHost = null;
  }

  exit() {
    for (const off of this._subs.splice(0)) { try { off(); } catch (_) { /* ignore */ } }
    this.events.releaseOwner(this);
    this.unmountUI();
  }

  dispose() {
    if (this._disposed) return;
    this.exit();
    if (this.assets) this.assets.disposeLocal(this.scene);
    if (this.scene && typeof this.scene.clear === 'function') this.scene.clear();
    this._disposed = true;
  }
}
