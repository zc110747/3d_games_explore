/**
 * P1 BattleScene —— 战斗场景框架。
 * 本阶段只做：场景入口 / Scene 与 Camera / 战斗状态上下文 / HTML UI 挂载入口 / 基础地面与格线。
 * 不实现真实战斗地图地形与部队模型（属 P5）；格子数 32x32 来自原版战斗地图头部真实数据。
 */
import { BaseScene } from './BaseScene.mjs';
import { EVENTS } from '../core/EventManager.mjs';

export class BattleScene extends BaseScene {
  constructor(deps) {
    super({ id: 'battle', ...deps });
    this.uiContainer = deps.uiContainer || null;
  }

  _build() {
    const THREE = this.THREE;
    const cfg = this.coordinate.getConfig().battle;
    const t = cfg.tileSize;
    this.camera = this.cameraManager.create('battle', 1);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(cfg.cols * t, cfg.rows * t),
      new THREE.MeshBasicMaterial({ color: 0x2d362c, side: THREE.DoubleSide }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(cfg.cols * t, cfg.cols, 0x4a5a48, 0x3c493b);
    grid.position.y = 0.002;
    this.scene.add(grid);

    // 中心占位（仅表示场景存在，不代表部队）
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.6, 0.6),
      new THREE.MeshBasicMaterial({ color: 0x8fb3d9 }),
    );
    const c = this.coordinate.gridToWorld(Math.floor(cfg.cols / 2), Math.floor(cfg.rows / 2), { height: 0.3 });
    marker.position.set(c.x, c.y, c.z);
    this.scene.add(marker);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1));

    this.onEvent(EVENTS.BATTLE_STATE_UPDATED, () => this._renderUI());
    this.onEvent(EVENTS.BATTLE_STARTED, () => this._renderUI());
    this.onEvent(EVENTS.BATTLE_FINISHED, () => this._renderUI());
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
    title.textContent = '战斗场景（P1 框架）';
    card.appendChild(title);
    const info = document.createElement('div');
    info.className = 'p1-hint';
    const cfg = this.coordinate.getConfig().battle;
    if (this.adapter) {
      try {
        const b = this.adapter.getBattleState();
        info.textContent = `格子 ${cfg.cols}×${cfg.rows}｜原版地图 ${b.width}×${b.height}｜MapId ${b.mapId}`
          + `｜回合 ${b.round}｜结束标志 ${b.over}｜视口 ${b.viewport.cols}×${b.viewport.rows}`;
      } catch (e) { info.textContent = `读取战斗状态失败：${e.message}`; }
    } else {
      info.textContent = `格子 ${cfg.cols}×${cfg.rows}（无 Adapter）`;
    }
    card.appendChild(info);
    const note = document.createElement('div');
    note.className = 'p1-hint';
    note.textContent = 'P1 不实现地形、部队与战斗动画；格子逻辑坐标保持原版 32×32 行列关系。';
    card.appendChild(note);
    host.appendChild(card);
  }

  update(dt) { super.update(dt); }
}
