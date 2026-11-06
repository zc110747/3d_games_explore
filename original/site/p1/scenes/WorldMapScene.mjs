/**
 * P1 WorldMapScene —— 战略地图场景框架。
 * 本阶段只做：Scene / 正交相机 / 基础地面 / 格线 / 38 个「占位」城池对象 / 摄像机基础操作。
 * 占位对象位置来自 GameAdapter.getCities() 的真实城市坐标（不是模拟数据）。
 * 不实现真实城市模型、道路、旗帜与地图美术（属 P3）。
 */
import { BaseScene } from './BaseScene.mjs';
import { EVENTS } from '../core/EventManager.mjs';

export class WorldMapScene extends BaseScene {
  constructor(deps) {
    super({ id: 'world', ...deps });
    this._markers = new Map();
    this._lines = null;
  }

  _color(ownerId) {
    if (!ownerId) return 0x7d8792;                          // 空城
    const king = this.adapter ? this.adapter.getGameState().playerKing : -1;
    return ownerId === king + 1 ? 0xd8a34a : 0xb0554a;      // 玩家 / 敌方
  }

  _build() {
    const THREE = this.THREE;
    const cfg = this.coordinate.getConfig().world;
    const t = cfg.tileSize;
    this.camera = this.cameraManager.create('world', 1);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(cfg.cols * t, cfg.rows * t),
      new THREE.MeshBasicMaterial({ color: 0x2a3138, side: THREE.DoubleSide }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    this.scene.add(ground);

    // 12x9 逻辑格线（由统一 cols/rows 生成，不为单城特例）
    const pts = [];
    const left = -cfg.cols * t / 2, right = cfg.cols * t / 2;
    const top = -cfg.rows * t / 2, bottom = cfg.rows * t / 2;
    for (let c = 0; c <= cfg.cols; c++) {
      const x = left + c * t;
      pts.push(new THREE.Vector3(x, 0.001, top), new THREE.Vector3(x, 0.001, bottom));
    }
    for (let r = 0; r <= cfg.rows; r++) {
      const z = top + r * t;
      pts.push(new THREE.Vector3(left, 0.001, z), new THREE.Vector3(right, 0.001, z));
    }
    this._lines = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x4a5560, transparent: true, opacity: 0.55 }),
    );
    this.scene.add(this._lines);

    // 38 个占位对象：真实城市坐标 -> 世界坐标
    const cities = this.adapter ? this.adapter.getCities() : [];
    const geo = new THREE.BoxGeometry(0.28 * t, 0.28 * t, 0.28 * t);
    for (const city of cities) {
      const p = this.coordinate.mapToWorld(city.position.x, city.position.y, { height: 0.16 * t });
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: this._color(city.ownerId) }));
      mesh.position.set(p.x, p.y, p.z);
      mesh.userData = { cityId: city.id, logical: { ...city.position }, name: city.name };
      this.scene.add(mesh);
      this._markers.set(city.id, mesh);
    }

    this.scene.add(new THREE.AmbientLight(0xffffff, 1));

    this.onEvent(EVENTS.CITY_UPDATED, ({ cityId }) => this._refreshMarker(cityId));
    this.onEvent(EVENTS.CITY_OWNER_CHANGED, ({ cityId }) => this._refreshMarker(cityId));
  }

  _refreshMarker(cityId) {
    if (!this.adapter) return;
    const mesh = this._markers.get(cityId);
    if (!mesh) return;
    try { mesh.material.color.setHex(this._color(this.adapter.getCity(cityId).ownerId)); }
    catch (e) { console.warn('[P1] 占位对象刷新失败:', e.message); }
  }

  update(dt) {
    super.update(dt);
    // 占位对象只自转，位置保持不变（坐标稳定性由 CoordinateSystem 测试保证）。
    for (const mesh of this._markers.values()) mesh.rotation.y += dt * 0.25;
  }

  getMarkerCount() { return this._markers.size; }
  getMarkerWorldPosition(cityId) {
    const m = this._markers.get(cityId);
    return m ? { x: m.position.x, y: m.position.y, z: m.position.z } : null;
  }
}
