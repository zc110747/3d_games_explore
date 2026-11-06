/**
 * P2 StrategicMapScene —— 继承 P1 WorldMapScene（不新建第二个战略场景管理器）。
 *
 * 组合 TerrainRenderer / RoadRenderer / CityRenderer / FlagRenderer，
 * 全部数据经 GameAdapter 只读取得。事件订阅放在 _onEnter()（P2 修复的
 * BaseScene 生命周期钩子），保证从城市场景/战斗场景切回后仍能收到状态变化。
 */
import { WorldMapScene } from '../p1/scenes/WorldMapScene.mjs';
import { EVENTS } from '../p1/core/EventManager.mjs';
import { TerrainRenderer } from './TerrainRenderer.mjs';
import { RoadRenderer } from './RoadRenderer.mjs';
import { CityRenderer } from './CityRenderer.mjs';
import { FlagRenderer } from './FlagRenderer.mjs';
import { LABEL_CONFIG } from './config.mjs';

export class StrategicMapScene extends WorldMapScene {
  constructor(deps) {
    super({ id: 'world', ...deps });
    this.worldCamera = deps.worldCamera;
    this.mapCoordinate = deps.mapCoordinate;
    if (!this.worldCamera) throw new TypeError('StrategicMapScene 需要 WorldCamera');
    if (!this.mapCoordinate) throw new TypeError('StrategicMapScene 需要 MapCoordinateSystem');
    this.terrainRenderer = null;
    this.roadRenderer = null;
    this.cityRenderer = null;
    this.flagRenderer = null;
    this.selection = null;
    this.scene.name = 'p2-strategic-map';
  }

  _build() {
    const THREE = this.THREE;
    const coordinate = this.mapCoordinate;
    this.camera = this.worldCamera.create(1);
    this.scene.background = new THREE.Color(0x111a1d);

    // 只用一盏方向光 + 环境光产生立体感，不开阴影（P1 RENDER_CONFIG.shadowEnabled=false）
    const ambient = new THREE.AmbientLight(0xffffff, 0.78);
    const sun = new THREE.DirectionalLight(0xffe9c4, 1.05);
    sun.position.set(7, 12, 9);
    this.scene.add(ambient, sun);

    this.terrainRenderer = new TerrainRenderer({
      THREE, assets: this.assets, lib: this.adapter.lib, coordinate,
    });
    this.roadRenderer = new RoadRenderer({ THREE, adapter: this.adapter, coordinate });
    this.cityRenderer = new CityRenderer({
      THREE, assets: this.assets, adapter: this.adapter, coordinate,
    });
    this.flagRenderer = new FlagRenderer({
      THREE, assets: this.assets, adapter: this.adapter, coordinate,
    });

    this.scene.add(this.terrainRenderer.build());
    this.scene.add(this.roadRenderer.build());
    this.scene.add(this.cityRenderer.build());
    this.scene.add(this.flagRenderer.build());
    this.cityRenderer.setFlagRenderer(this.flagRenderer);
  }

  /** 每次 enter 都会重新订阅（exit 会统一取消，见 P1 BaseScene）。 */
  _onEnter() {
    this.onEvent(EVENTS.CITY_SELECTED, ({ cityId }) => this.setSelection(cityId));
    this.onEvent(EVENTS.CITY_UPDATED, ({ cityId }) => this.refreshCity(cityId));
    this.onEvent(EVENTS.CITY_OWNER_CHANGED, ({ cityId }) => this.refreshCity(cityId));
    this.onEvent(EVENTS.GAME_STATE_UPDATED, () => {
      // 状态签名变化只做轻量同步：材质按 (ownerId,player) 缓存，无变化不重建
      if (this.flagRenderer) this.flagRenderer.syncAll();
    });
    this.onEvent(EVENTS.TURN_CHANGED, () => {
      if (this.flagRenderer) this.flagRenderer.syncAll();
    });
  }

  refreshCity(cityId) {
    if (!this.cityRenderer) return false;
    return this.cityRenderer.refreshCity(cityId);
  }

  /** 选中：城市高亮 + 名称突出 + 原版相邻路径高亮。 */
  setSelection(cityId) {
    this.selection = cityId;
    if (!this.cityRenderer || !this.roadRenderer) return 0;
    this.cityRenderer.setSelected(cityId);
    return this.roadRenderer.highlightNeighbors(cityId);
  }

  /** 供测试与调试面板：按原版城市 ID 得到屏幕坐标（不是逻辑坐标）。 */
  cityScreenPosition(cityId, viewport) {
    const world = this.cityRenderer?.getCityWorldPosition(cityId);
    if (!world || !this.camera) return null;
    const v = new this.THREE.Vector3();
    const projector = (p) => {
      v.set(p.x, p.y, p.z).project(this.camera);
      return { x: v.x, y: v.y, z: v.z };
    };
    return this.mapCoordinate.worldToScreen(world, projector, viewport);
  }

  update(dt) {
    this.elapsed += dt;
    this.frameCount++;
    const cam = this.camera;
    const zoom = cam?.zoom || 1;
    if (this.cityRenderer) {
      let opts = {};
      if (cam) {
        if (!this._projVec) this._projVec = new this.THREE.Vector3();
        const v = this._projVec;
        const projector = (p) => { v.set(p.x, p.y, p.z).project(cam); return { x: v.x, y: v.y }; };
        // 正交相机投影矩阵已含 zoom：NDC 宽 = 世界宽 * 2 * zoom / frustum 宽
        const ndc = {
          w: LABEL_CONFIG.worldWidth * 2 * zoom / Math.max(1e-6, cam.right - cam.left),
          h: LABEL_CONFIG.worldHeight * 2 * zoom / Math.max(1e-6, cam.top - cam.bottom),
        };
        opts = { projector, ndc };
      }
      this.cityRenderer.update(dt, zoom, opts);
    }
    if (this.flagRenderer) this.flagRenderer.update(dt, zoom);
  }

  getDiagnostics() {
    return {
      sceneId: this.id,
      cities: this.cityRenderer?.getDiagnostics() || null,
      roads: this.roadRenderer?.getDiagnostics() || null,
      flags: this.flagRenderer?.getDiagnostics() || null,
      terrain: this.terrainRenderer ? { ...this.terrainRenderer.stats } : null,
      camera: this.worldCamera.getState(this.camera),
      selected: this.selection,
      subscriptions: this._subs.length,
    };
  }

  dispose() {
    if (this._disposed) return;
    this.cityRenderer?.dispose();
    this.flagRenderer?.dispose();
    this.roadRenderer?.dispose();
    this.terrainRenderer?.dispose();
    super.dispose();
  }
}
