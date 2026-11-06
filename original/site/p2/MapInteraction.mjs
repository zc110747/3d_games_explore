/**
 * P2 MapInteraction —— 战略地图输入交互（复用 P1 InputManager，不新建输入管理器）。
 *
 * 点击链路（P2 §9.2，按真实源码校正）：
 *   1) Raycaster 命中城市 InstancedMesh -> instanceId -> 原版 cityId
 *   2) GameAdapter.requestCitySelection() 走【原版输入协议】驱动 zs() 选城循环
 *      （原版没有命令式 selectCity；P1 已如实标注 UnsupportedError）
 *   3) GameAdapter.notifyCitySelected() 发表现层 CITY_SELECTED 事件
 *   4) StrategicMapScene 订阅该事件 -> 城市高亮 + 名称突出 + 相邻路径高亮
 *   5) 原版处理结果由 getCityCursor() 事后观测，绝不伪造「原版已选中」
 *
 * 拖动不误选、UI 弹窗阻断、滚轮只作用于画布：由 P1 InputManager 的
 * dragThresholdPx / setUIOpen / data-p1-ui-block 保证，本类不重复实现。
 */
import { MAP_INTERACTION_CONFIG as I } from './config.mjs';

export class MapInteraction {
  constructor({ THREE, input, adapter, scene, worldCamera, getCamera, isActive = () => true }) {
    if (!THREE || !input || !adapter || !scene || !worldCamera) {
      throw new TypeError('MapInteraction 依赖不完整');
    }
    this.THREE = THREE;
    this.input = input;
    this.adapter = adapter;
    this.scene = scene;
    this.worldCamera = worldCamera;
    this._getCamera = getCamera || (() => scene.camera);
    this.isActive = isActive;   // 只在战略地图场景响应，避免切到城市场景误操作
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._unbind = [];
    this.intent = 'cursor';        // cursor 只定位原版光标；select 触发原版确认选城
    this.selectedCityId = null;
    this.lastRequest = null;
    this.lastOriginalCursor = null;
    this.stats = { clicks: 0, cityHits: 0, emptyClicks: 0, drags: 0, wheels: 0, blockedByUI: 0 };
  }

  setIntent(intent) {
    if (intent !== 'cursor' && intent !== 'select') throw new RangeError(`未知 intent: ${intent}`);
    this.intent = intent;
    return this.intent;
  }

  bind() {
    const offDrag = this.input.on('drag', ({ dx, dy }) => {
      if (!this.isActive()) return;
      this.stats.drags++;
      const cam = this._getCamera();
      if (cam) this.worldCamera.panByPixels(cam, dx, dy);
    });
    const offWheel = this.input.on('wheel', ({ deltaY }) => {
      if (!this.isActive()) return;
      this.stats.wheels++;
      const cam = this._getCamera();
      if (cam) this.worldCamera.zoomBy(cam, 1 - deltaY * I.wheelZoomScale);
    });
    const offClick = this.input.on('click', (p) => {
      if (!this.isActive()) return;
      this.stats.clicks++;
      const cityId = this.pick(p.ndcX, p.ndcY);
      if (cityId === null) { this.stats.emptyClicks++; return; }
      this.stats.cityHits++;
      this.handleCityClick(cityId);
    });
    const offKey = this.input.on('keydown', ({ key }) => {
      if (!this.isActive()) return;
      const cam = this._getCamera();
      if (!cam) return;
      if (key === 'r' || key === 'R') this.worldCamera.reset(cam);
      else if (key === '+' || key === '=') this.worldCamera.zoomBy(cam, 1.12);
      else if (key === '-' || key === '_') this.worldCamera.zoomBy(cam, 1 / 1.12);
    });
    this._unbind.push(offDrag, offWheel, offClick, offKey);
    return this;
  }

  /** Raycaster 拾取；使用独立的透明拾取区 + 城廓实例，返回原版 cityId。 */
  pick(ndcX, ndcY) {
    const cam = this._getCamera();
    if (!cam || !this.scene.cityRenderer) return null;
    this.scene.scene.updateMatrixWorld(true);
    this._ndc.set(ndcX, ndcY);
    this._raycaster.setFromCamera(this._ndc, cam);
    const hits = this._raycaster.intersectObjects(this.scene.cityRenderer.getPickables(), false);
    for (const hit of hits) {
      const id = this.scene.cityRenderer.resolveHit(hit);
      if (id !== null) return id;
    }
    return null;
  }

  /** 城市点击主流程。返回完整的真实结果（含未注入原因），不伪造成功。 */
  handleCityClick(cityId, { intent = this.intent } = {}) {
    let request;
    try {
      request = this.adapter.requestCitySelection(cityId, { intent });
    } catch (e) {
      request = { injected: false, reason: `${e.name}: ${e.message}` };
    }
    this.adapter.notifyCitySelected(cityId);   // -> scene 订阅后更新高亮/道路
    this.selectedCityId = cityId;
    this.lastRequest = request;
    this.lastOriginalCursor = null;
    this._scheduleCursorObservation();
    return { cityId, request, source: 'MapInteraction.handleCityClick' };
  }

  /** 原版输入是异步协程：延时读取真实 Dn.g_CityPos / citymap 作为结果观测。 */
  _scheduleCursorObservation() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      try { this.lastOriginalCursor = this.adapter.getCityCursor(); }
      catch (e) { this.lastOriginalCursor = { error: e.message }; }
    }, 260);
  }

  /** 调试面板用的当前选中城市完整信息（全部来自原版实时数据）。 */
  getSelectionInfo() {
    if (this.selectedCityId === null) return null;
    const id = this.selectedCityId;
    const city = this.adapter.getCity(id);
    const world = this.scene.cityRenderer?.getCityWorldPosition(id) || null;
    const connections = this.adapter.getCityConnections(id);
    const style = this.scene.flagRenderer?.getFactionStyle(city.ownerId) || null;
    return {
      id: city.id, name: city.name,
      logical: { ...city.position },
      world,
      ownerId: city.ownerId,
      faction: style,
      state: city.state,
      connectionCount: connections.filter((c) => c.cityId !== null).length,
      connections: connections.map((c) => ({ dir: c.dir, cityId: c.cityId, distance: c.distance })),
      originalCursor: this.lastOriginalCursor,
      lastRequest: this.lastRequest,
      source: 'GameAdapter.getCity/getCityConnections + CityRenderer + FlagRenderer',
    };
  }

  getStats() {
    return { ...this.stats, intent: this.intent, selectedCityId: this.selectedCityId,
      input: this.input.getStats() };
  }

  dispose() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    for (const off of this._unbind.splice(0)) off();
  }
}
