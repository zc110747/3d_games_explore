/**
 * P1 CameraManager —— 固定斜 45° 正交相机，禁止自由旋转。
 *
 * 逻辑坐标 -> 世界坐标由 CoordinateSystem 负责；这里只负责「相机投影/视图」，
 * 两者不混在一个函数里。城市场景 P1 不锁定渲染方案，默认复用战略相机配置。
 */
import { CAMERA_CONFIG } from './config.mjs';

export class CameraManager {
  constructor({ THREE }) {
    if (!THREE) throw new TypeError('CameraManager 需要 THREE');
    this.THREE = THREE;
    this.cameras = new Map();
    this._state = new Map();   // camera -> {target, base, cfg}
  }

  /** kind: 'world' | 'battle' | 'city'（city 复用 world 参数）。 */
  create(kind = 'world', aspect = 1) {
    const name = CAMERA_CONFIG.city.reuse && kind === 'city' ? 'world' : kind;
    const cfg = CAMERA_CONFIG[name] || CAMERA_CONFIG.world;
    const camera = new this.THREE.OrthographicCamera(-1, 1, 1, -1, cfg.near, cfg.far);
    const target = new this.THREE.Vector3(0, 0, 0);
    const state = { cfg, target, zoom: cfg.zoom };
    this._state.set(camera, state);
    this._applyDirection(camera, state);
    this.updateProjection(camera, aspect);
    camera.userData.kind = kind;
    return camera;
  }

  _applyDirection(camera, state) {
    const { distance, azimuthDeg, elevationDeg } = state.cfg;
    const el = elevationDeg * Math.PI / 180;
    const az = azimuthDeg * Math.PI / 180;
    const horiz = distance * Math.cos(el);
    camera.position.set(
      state.target.x + horiz * Math.sin(az),
      state.target.y + distance * Math.sin(el),
      state.target.z + horiz * Math.cos(az),
    );
    camera.up.set(0, 1, 0);          // 锁定 up，不提供旋转接口
    camera.lookAt(state.target);
    camera.zoom = state.zoom;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  updateProjection(camera, aspect = 1) {
    const state = this._state.get(camera);
    if (!state) return;
    const h = state.cfg.frustumHeight;
    const w = h * Math.max(0.0001, aspect);
    camera.left = -w / 2; camera.right = w / 2;
    camera.top = h / 2; camera.bottom = -h / 2;
    camera.updateProjectionMatrix();
  }

  /** 平移：同时移动相机与注视点，受边界限制；不允许旋转。 */
  pan(camera, dx, dz) {
    const state = this._state.get(camera);
    if (!state) return false;
    const { panLimitX, panLimitZ } = state.cfg;
    const nx = Math.max(-panLimitX, Math.min(panLimitX, state.target.x + dx));
    const nz = Math.max(-panLimitZ, Math.min(panLimitZ, state.target.z + dz));
    state.target.set(nx, 0, nz);
    this._applyDirection(camera, state);
    return true;
  }

  zoom(camera, factor) {
    const state = this._state.get(camera);
    if (!state) return false;
    const { minZoom, maxZoom } = state.cfg;
    state.zoom = Math.max(minZoom, Math.min(maxZoom, state.zoom * factor));
    camera.zoom = state.zoom;
    camera.updateProjectionMatrix();
    return true;
  }

  reset(camera) {
    const state = this._state.get(camera);
    if (!state) return false;
    state.target.set(0, 0, 0);
    state.zoom = state.cfg.zoom;
    this._applyDirection(camera, state);
    return true;
  }

  /** 由 RenderManager.resize() 调用：所有相机共用同一个 aspect。 */
  onResize(aspect) {
    for (const camera of this._state.keys()) this.updateProjection(camera, aspect);
  }

  getState(camera) {
    const s = this._state.get(camera);
    if (!s) return null;
    return {
      kind: camera.userData.kind,
      zoom: s.zoom,
      elevationDeg: s.cfg.elevationDeg,
      azimuthDeg: s.cfg.azimuthDeg,
      target: s.target.toArray(),
    };
  }

  dispose() { this.cameras.clear(); this._state.clear(); }
}
