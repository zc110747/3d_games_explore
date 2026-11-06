/**
 * P4 BattleInteraction —— 战斗地图拾取与相机操作。
 *
 * 拾取优先级（P4 §11.3）：
 *   1) 部队独立拾取体（不渲染但可命中）—— 建筑细节不影响点选；
 *   2) 地面平面 -> worldToGrid 反查逻辑格；
 *   3) 都没命中 -> 空点（只更新统计，不改变选中）。
 *
 * 「拖动不误选」由 P1 InputManager 保证：只有位移 <= dragThresholdPx 才发 click。
 * 覆盖层（移动/攻击范围）不参与 Raycaster，因此绝不会挡住部队拾取。
 *
 * 本类不修改任何游戏状态：选中只是表现层高亮，是否允许操作由
 * GameAdapter.canSelectUnit()（原版 Xo()）判定。
 */
import { BATTLE_INTERACTION_CONFIG as I } from './config.mjs';

export class BattleInteraction {
  constructor({ THREE, input, adapter, scene, battleCamera, getCamera, isActive = () => true, callbacks = {} }) {
    if (!THREE || !input || !adapter || !scene || !battleCamera) {
      throw new TypeError('BattleInteraction 依赖不完整');
    }
    this.THREE = THREE;
    this.input = input;
    this.adapter = adapter;
    this.scene = scene;
    this.battleCamera = battleCamera;
    this._getCamera = getCamera || (() => scene.camera);
    this.isActive = isActive;
    this.callbacks = callbacks;
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.ground = null;
    this.stats = { clicks: 0, unitClicks: 0, cellClicks: 0, misses: 0, drags: 0, wheels: 0, blockedByInactive: 0, hovers: 0 };
    this._offs = [];
    this._lastHover = null;
    this._hoverRaf = 0;
  }

  /** 地面拾取面：不可见但可被射线命中（与地图同尺寸）。 */
  setGround(mesh) { this.ground = mesh; }

  bind() {
    const input = this.input;
    this._offs.push(input.on('click', (p) => {
      if (!this.isActive()) { this.stats.blockedByInactive++; return; }
      this.stats.clicks++;
      const hit = this.pick(p.ndcX, p.ndcY);
      if (hit.unitId !== null) {
        this.stats.unitClicks++;
        if (this.callbacks.onUnitClick) this.callbacks.onUnitClick(hit.unitId, hit);
      } else if (hit.cell) {
        this.stats.cellClicks++;
        if (this.callbacks.onCellClick) this.callbacks.onCellClick(hit.cell, hit);
      } else {
        this.stats.misses++;
        if (this.callbacks.onMiss) this.callbacks.onMiss(hit);
      }
    }));
    this._offs.push(input.on('pointermove', (p) => {
      if (!this.isActive() || !this.callbacks.onHover) return;
      // 悬停拾取要打射线，按帧节流，避免每次 pointermove 都做一次全场景求交
      if (this._hoverRaf) return;
      this._hoverRaf = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame(() => {
          this._hoverRaf = 0;
          if (!this.isActive()) return;
          const hit = this.pick(p.ndcX, p.ndcY);
          const key = hit.unitId !== null ? `u${hit.unitId}` : hit.cell ? `c${hit.cell.x},${hit.cell.y}` : 'none';
          this._lastHover = key;
          this.stats.hovers++;
          try { this.callbacks.onHover(hit); } catch (_) { /* 悬停失败不影响操作 */ }
        })
        : 0;
    }));
    this._offs.push(input.on('drag', ({ dx, dy }) => {
      if (!this.isActive()) return;
      this.stats.drags++;
      this.battleCamera.panByPixels(this._getCamera(), dx, dy);
    }));
    this._offs.push(input.on('wheel', ({ deltaY }) => {
      if (!this.isActive()) return;
      this.stats.wheels++;
      this.battleCamera.zoomBy(this._getCamera(), 1 - deltaY * I.wheelZoomScale);
    }));
    this._offs.push(input.on('keydown', ({ key }) => {
      if (!this.isActive()) return;
      if (key === 'r' || key === 'R') this.battleCamera.reset(this._getCamera());
    }));
    return this;
  }

  /** 射线拾取：部队优先，其次格子。返回 { unitId, cell, point }（未命中为 null）。 */
  pick(ndcX, ndcY) {
    const camera = this._getCamera();
    if (!camera) return { unitId: null, cell: null, point: null };
    this.ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndc, camera);

    const pickables = this.scene.getUnitPickables ? this.scene.getUnitPickables() : [];
    if (pickables.length) {
      const hits = this.raycaster.intersectObjects(pickables, false);
      if (hits.length) {
        const id = hits[0].object.userData.unitId;
        return { unitId: Number.isInteger(id) ? id : null, cell: null, point: hits[0].point, object: hits[0].object };
      }
    }
    if (this.ground) {
      const hits = this.raycaster.intersectObject(this.ground, false);
      if (hits.length) {
        // 由场景提供「世界 -> 战斗格」，避免本模块去碰 12x9 战略地图配置
        const g = this.scene.worldToGrid(hits[0].point.x, hits[0].point.z);
        if (g.inBounds) return { unitId: null, cell: { x: g.col, y: g.row }, point: hits[0].point };
        return { unitId: null, cell: null, point: hits[0].point, outOfMap: g };
      }
    }
    return { unitId: null, cell: null, point: null };
  }

  unbind() {
    if (this._hoverRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._hoverRaf);
    this._hoverRaf = 0;
    for (const off of this._offs.splice(0)) { try { off(); } catch (_) { /* ignore */ } }
  }

  getStats() { return { ...this.stats }; }
}
