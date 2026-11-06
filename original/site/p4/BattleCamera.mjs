/**
 * P4 BattleCamera —— 战斗相机（薄封装 P1 CameraManager，不重复实现投影/边界）。
 *
 * 与战略地图相机独立配置（P1 CAMERA_CONFIG.battle）：正交投影、固定 45/45、
 * 不允许旋转；本类只补三件战斗场景需要的事：
 *   1) fit()：按**真实地图宽高**算投影跨度，保证整张地图可见（32x32 也适用）；
 *   2) panByPixels()：把屏幕像素拖动换算到相机 right/up 在地面的基向量；
 *   3) setTargetAt()：进战斗时把注视点对准地图中心（地图中心就是世界原点）。
 */
import { BATTLE_CAMERA_CONFIG as C } from './config.mjs';

/** 世界 X/Z 平面在斜视角正交相机屏幕上的投影跨度（单位：格）。 */
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

export class BattleCamera {
  constructor({ THREE, cameraManager }) {
    if (!THREE || !cameraManager) throw new TypeError('BattleCamera 需要 THREE 与 P1 CameraManager');
    this.THREE = THREE;
    this.cameraManager = cameraManager;
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this.lastFit = null;
    // 视口高度（CSS 像素）：屏幕位移 -> 世界位移必须按它换算，
    // 否则 32x32 这种大 frustum 下拖动会明显偏慢（P1 的固定系数只适合战略地图）。
    this.viewportHeight = 720;
  }

  setViewportHeight(h) {
    if (h > 0) this.viewportHeight = h;
    return this.viewportHeight;
  }

  create(aspect = 1, { cols = 32, rows = 32 } = {}) {
    const camera = this.cameraManager.create('battle', aspect);
    this.fit(camera, aspect, { cols, rows });
    return camera;
  }

  /** 按真实地图宽高调整 frustum；不改 camera.zoom，因此与用户缩放互不干扰。 */
  fit(camera, aspect, { cols, rows, margin = C.fitMargin } = {}) {
    if (!camera || !(aspect > 0)) return null;
    const c = cols || 32, r = rows || 32;
    const span = projectedSpan(c, r, C.azimuthDeg, C.elevationDeg);
    const needed = Math.max(span.height, span.width / aspect) * margin;
    camera.top = needed / 2;
    camera.bottom = -needed / 2;
    camera.left = -needed * aspect / 2;
    camera.right = needed * aspect / 2;
    camera.updateProjectionMatrix();
    this.lastFit = { needed, span, cols: c, rows: r, aspect };
    return this.lastFit;
  }

  /** 屏幕像素位移 -> 世界平移（尊重相机方位角；换算按真实视口/缩放推导）。 */
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
    // 世界单位/像素 = frustum 高 / (视口高 * zoom)
    const frustum = Math.abs((camera.top - camera.bottom) || 1);
    const k = frustum / (Math.max(1, this.viewportHeight) * Math.max(0.0001, camera.zoom || 1));
    const worldDx = -dx * this._right.x * k + dy * this._up.x * k;
    const worldDz = -dx * this._right.z * k + dy * this._up.z * k;
    return this.cameraManager.pan(camera, worldDx, worldDz);
  }

  zoomBy(camera, factor) {
    if (!(factor > 0)) return false;
    return this.cameraManager.zoom(camera, factor);
  }

  reset(camera) { return this.cameraManager.reset(camera); }

  getState(camera) {
    const s = this.cameraManager.getState(camera);
    if (!s) return null;
    return Object.freeze({
      ...s,
      projection: C.projection,
      fixed45: s.azimuthDeg === C.azimuthDeg && s.elevationDeg === C.elevationDeg,
      rotationAllowed: false,
      fit: this.lastFit,
      source: 'P1 CameraManager(battle) + P4 BattleCamera.fit()',
    });
  }
}
