/**
 * P1 CityScene —— 城市管理场景框架。
 * 本阶段只做：场景入口 / 生命周期 / cityId 上下文 / HTML UI 挂载入口 / 基础占位。
 * 不实现城市模型与菜单功能（属 P4）；城市信息来自 GameAdapter 的真实数据。
 */
import { BaseScene } from './BaseScene.mjs';
import { EVENTS } from '../core/EventManager.mjs';

export class CityScene extends BaseScene {
  constructor(deps) {
    super({ id: 'city', ...deps });
    this.uiContainer = deps.uiContainer || null;
  }

  _build() {
    const THREE = this.THREE;
    // 城市场景 P1 不锁定渲染方案：复用战略相机配置，后续可整体替换。
    this.camera = this.cameraManager.create('city', 1);
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1.7, 0.3, 20),
      new THREE.MeshBasicMaterial({ color: 0x3b4550 }),
    );
    base.position.y = 0.15;
    this.scene.add(base);
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 1.2, 0.9),
      new THREE.MeshBasicMaterial({ color: 0xd8a34a }),
    );
    marker.position.y = 0.9;
    this.scene.add(marker);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1));

    this.onEvent(EVENTS.CITY_UPDATED, ({ cityId }) => {
      if (cityId === this.context.cityId) this._renderUI();
    });
    this.onEvent(EVENTS.CITY_OWNER_CHANGED, ({ cityId }) => {
      if (cityId === this.context.cityId) this._renderUI();
    });
  }

  enter(context = {}) {
    super.enter(context);
    const container = this.uiContainer || (typeof document !== 'undefined' ? document.getElementById('p1-ui') : null);
    this.mountUI(container);
    this._renderUI();
    return this;
  }

  _renderUI() {
    const host = this._uiHost;
    if (!host) return;
    host.replaceChildren();
    const card = document.createElement('div');
    card.className = 'p1-card p1-scene-card';
    const title = document.createElement('h2');
    title.textContent = '城市管理场景（P1 框架）';
    card.appendChild(title);
    const info = document.createElement('div');
    info.className = 'p1-hint';
    const id = this.context.cityId;
    if (this.adapter && Number.isInteger(id)) {
      try {
        const c = this.adapter.getCity(id);
        const acts = this.adapter.getCityActions(id);
        info.textContent = `城市：${c.name}（ID ${c.id}）｜归属 ${c.ownerId}｜坐标 (${c.position.x}, ${c.position.y})`
          + `｜金钱 ${c.money}｜粮食 ${c.food}｜武将 ${c.officerCount}｜菜单 ${acts.main.join('/')}`;
      } catch (e) { info.textContent = `读取城市失败：${e.message}`; }
    } else {
      info.textContent = '未提供 cityId（测试入口）';
    }
    card.appendChild(info);
    const note = document.createElement('div');
    note.className = 'p1-hint';
    note.textContent = 'P1 不实现完整城市菜单；UI 由 HTML/CSS 承载，3D 只做展示。';
    card.appendChild(note);
    host.appendChild(card);
  }

  update(dt) { super.update(dt); }
}
