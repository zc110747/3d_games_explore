/**
 * P2 WorldCamera —— 战略地图相机（薄封装，**不重复实现** P1 CameraManager）。
 *
 * P1 CameraManager 已负责：正交投影、固定视角（P6 起为正面俯视 0°/90°）、
 * 禁止旋转、平移边界、缩放上下限。
 * 本类只补两件与 P2 交互相关的事：
 *   1) 把屏幕像素拖动换算到相机 right / up 在地面的基向量（俯视时为 +X / -Z，
 *      斜视角时也不能把 dx 直接当世界 X，否则拖动方向会歪）；
 *   2) fit(aspect) 按地图投影跨度调整 frustum，保证 12x9 地图完整显示。
 *
 * fit() 直接改相机 frustum 平面，不碰 camera.zoom，因此与用户缩放互不干扰。
 */
import { MAP_INTERACTION_CONFIG as I } from './config.mjs';
import { CAMERA_CONFIG, TOP_DOWN_ELEVATION } from '../p1/core/config.mjs';

/** 世界 X/Z 在正交相机屏幕上的投影跨度（含 12x9 地图对角线）。 */
function projectedSpan(cols, rows, azimuthDeg, elevationDeg) {
  const az = azimuthDeg * Math.PI / 180;
  const el = elevationDeg * Math.PI / 180;
  const rightX = Math.cos(az), rightZ = -Math.sin(az);
  const upX = -Math.sin(az) * Math.sin(el), upZ = -Math.cos(az) * Math.sin(el);
  return {
    width: cols * Math.abs(rightX) + rows * Math.abs(rightZ),
    height: cols * Math.abs(upX) + rows * Math.abs(upZ),
  };
}

export class WorldCamera {
  constructor({ THREE, cameraManager }) {
    if (!THREE || !cameraManager) throw new TypeError('WorldCamera 需要 THREE 与 P1 CameraManager');
    this.THREE = THREE;
    this.cameraManager = cameraManager;
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
  }

  create(aspect = 1) {
    const camera = this.cameraManager.create('world', aspect);
    this.fit(camera, aspect);
    return camera;
  }

  /**
   * 按当前视口调整 frustum，保证整张地图可见（P2 §4.1）。
   * offsetY：把投影窗口整体上移（世界单位），使地图内容在屏幕上略微下移——
   * 俯视下最北一排城市的名称牌会飘到格子之外，需要让出顶部状态条的空间。
   */
  fit(camera, aspect, { margin = 1.3, offsetY = -0.1 } = {}) {
    if (!camera || !(aspect > 0)) return null;
    const cfg = CAMERA_CONFIG.world;
    const size = this.cameraManager.getState(camera);
    const span = projectedSpan(12, 9, cfg.azimuthDeg, cfg.elevationDeg);
    // 窄屏时允许 frustum 高于 P1 默认值，保证整图可见；宽屏时收紧让地图更大
    const needed = Math.max(span.height, span.width / aspect) * margin;
    camera.top = needed / 2 + offsetY;
    camera.bottom = -needed / 2 + offsetY;
    camera.left = -needed * aspect / 2;
    camera.right = needed * aspect / 2;
    camera.updateProjectionMatrix();
    return { needed, span, offsetY, zoom: size ? size.zoom : camera.zoom };
  }

  /** RenderManager.onResize 用：对所有已创建的战略相机重新 fit。 */
  fitAll(aspect) {
    let n = 0;
    for (const camera of this.cameraManager._state.keys()) {
      if (camera.userData?.kind === 'world' && this.fit(camera, aspect)) n++;
    }
    return n;
  }

  /** 屏幕像素位移 -> 世界平移（尊重相机方位角，缩放越大位移越小）。 */
  panByPixels(camera, dx, dy) {
    if (!camera) return false;
    camera.updateMatrixWorld();
    this._right.setFromMatrixColumn(camera.matrixWorld, 0);
    this._right.y = 0;
    if (this._right.lengthSq() < 1e-8) return false;
    this._right.normalize();
    this._up.setFromMatrixColumn(camera.matrixWorld, 1);
    this._up.y = 0;
    if (this._up.lengthSq() < 1e-8) return false;
    this._up.normalize();
    const k = I.panPixelsToWorld / Math.max(0.0001, camera.zoom || 1);
    const worldDx = -dx * this._right.x * k + dy * this._up.x * k;
    const worldDz = -dx * this._right.z * k + dy * this._up.z * k;
    return this.cameraManager.pan(camera, worldDx, worldDz, this._panLimits(camera));
  }

  /**
   * P6：平移上限 = max(0, 地图半幅 - 当前视野半幅)。
   * 整图可见时上限为 0（拖不动，不会把地图拖出画面）；放大后才允许平移查看局部。
   */
  _panLimits(camera) {
    const st = this.cameraManager.getState(camera);
    const span = projectedSpan(12, 9, CAMERA_CONFIG.world.azimuthDeg, CAMERA_CONFIG.world.elevationDeg);
    const visW = Math.abs(camera.right - camera.left) / (2 * Math.max(1e-6, camera.zoom || 1));
    const visH = Math.abs(camera.top - camera.bottom) / (2 * Math.max(1e-6, camera.zoom || 1));
    return {
      x: Math.max(0, span.width / 2 - visW),
      z: Math.max(0, span.height / 2 - visH),
    };
  }

  /** 以视口中心为缩放锚点：只改 zoom，不动 target，因此不会出现画面跳动。 */
  zoomBy(camera, factor) {
    if (!(factor > 0)) return false;
    return this.cameraManager.zoom(camera, factor);
  }

  reset(camera) { return this.cameraManager.reset(camera); }

  getState(camera) {
    const s = this.cameraManager.getState(camera);
    if (!s) return null;
    const cfg = CAMERA_CONFIG.world;
    return Object.freeze({
      ...s,
      /** 是否仍是配置里的固定视角（P6：0°/90° 正面俯视）。 */
      fixedView: s.azimuthDeg === cfg.azimuthDeg && s.elevationDeg === cfg.elevationDeg,
      topDown: s.elevationDeg >= TOP_DOWN_ELEVATION,
      rotationAllowed: false,
      projection: cfg.projection,
      source: 'P1 CameraManager + P2 WorldCamera.fit()',
    });
  }
}
