/**
 * P4 BattleMapScene —— 3D 战棋战斗场景。
 *
 * 继承 P1 BattleScene（同一 scene id / 生命周期约定），但把占位地面换成真实战斗地图：
 *   BattleMapRenderer（原版 46 帧图块底板 + 网格 + 装饰）
 *   BattleUnitRenderer（20 支部队，兵种/势力/状态区分）
 *   BattleRangeRenderer（原版 qi()/Vo() 给出的移动/攻击范围）
 *   BattleInteraction   （部队优先拾取 + 相机平移缩放）
 *
 * 关键约束（P4 §2）：
 *   - 不实现移动/攻击/伤害/胜负；本场景只「显示」+「选中」；
 *   - 选中高亮是表现层行为，是否可选由 GameAdapter.canSelectUnit()（原版 Xo()）判定；
 *   - 任何一次刷新都从 GameAdapter 读，场景内不保存第二套权威数据。
 */
import { BattleScene } from '../p1/scenes/BattleScene.mjs';
import { BaseScene } from '../p1/scenes/BaseScene.mjs';
import { EVENTS } from '../p1/core/EventManager.mjs';
import { BattleMapRenderer } from './BattleMapRenderer.mjs';
import { BattleUnitRenderer } from './BattleUnitRenderer.mjs';
import { BattleRangeRenderer } from './BattleRangeRenderer.mjs';
import { BattleInteraction } from './BattleInteraction.mjs';

export class BattleMapScene extends BattleScene {
  constructor(deps) {
    super({ id: 'battle', ...deps });
    this.battleCamera = deps.battleCamera;
    this.battleCoord = deps.battleCoord;
    this.input = deps.input || null;
    this.renderManager = deps.renderManager || null;
    if (!this.battleCamera) throw new TypeError('BattleMapScene 需要 BattleCamera');
    if (!this.battleCoord) throw new TypeError('BattleMapScene 需要 BattleCoordinateSystem');
    if (!this.input) throw new TypeError('BattleMapScene 需要 InputManager（复用 P1 唯一输入通道）');
    this.mapRenderer = null;
    this.unitRenderer = null;
    this.rangeRenderer = null;
    this.interaction = null;
    this.hud = null;
    this.selection = null;
    this.lastLoad = null;
    this.scene.name = 'p4-battle-map';
  }

  _build() {
    const THREE = this.THREE;
    this.camera = this.battleCamera.create(1, { cols: 32, rows: 32 });
    this.scene.background = new THREE.Color(0x0d1216);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const sun = new THREE.DirectionalLight(0xffe9c4, 1.0);
    sun.position.set(9, 16, 7);
    this.scene.add(sun);
  }

  /**
   * 不调用 P1 BattleScene.enter()：它会挂一个 430px 宽的占位卡片，
   * P4 的战斗信息由 BattleHUD 独立挂载（不遮挡 3D 拾取）。
   */
  enter(context = {}) {
    BaseScene.prototype.enter.call(this, context);
    return this;
  }

  _onEnter() {
    this.onEvent(EVENTS.BATTLE_STATE_UPDATED, () => this.refreshFromAdapter('battle-state'));
    this.onEvent(EVENTS.GAME_STATE_UPDATED, () => this.refreshFromAdapter('game-state'));
  }

  getAspect() {
    const info = this.renderManager && this.renderManager.getInfo ? this.renderManager.getInfo() : null;
    if (info && Array.isArray(info.size) && info.size[1] > 0) return info.size[0] / info.size[1];
    return 1;
  }

  getViewportHeight() {
    const info = this.renderManager && this.renderManager.getInfo ? this.renderManager.getInfo() : null;
    if (info && Array.isArray(info.size) && info.size[1] > 0) return info.size[1];
    return 720;
  }

  /** 原版 yo() 完成后调用：按真实战况重建地图/部队/范围。 */
  loadBattle() {
    const THREE = this.THREE;
    this.clearBattle();
    const map = this.adapter.getBattleMap();
    if (!map.available) {
      this.lastLoad = { ok: false, reason: map.reason };
      return this.lastLoad;
    }
    this.battleCoord.configure(map.width, map.height);

    this.mapRenderer = new BattleMapRenderer({
      THREE, assets: this.assets, coordinate: this.battleCoord, adapter: this.adapter,
    });
    this.scene.add(this.mapRenderer.build());

    this.unitRenderer = new BattleUnitRenderer({
      THREE, assets: this.assets, coordinate: this.battleCoord, adapter: this.adapter,
    });
    this.scene.add(this.unitRenderer.build());

    this.rangeRenderer = new BattleRangeRenderer({
      THREE, assets: this.assets, coordinate: this.battleCoord,
    });
    this.scene.add(this.rangeRenderer.build());

    // 地面拾取面：mapRenderer 的底板是逐格四边形，直接拿它做 Raycaster 目标会
    // 因格子边界产生缝隙；这里用一张同尺寸的不可见平面保证「点哪都能反查到格」。
    const t = this.battleCoord.getConfig().battle.tileSize;
    const groundGeo = new THREE.PlaneGeometry(map.width * t, map.height * t);
    const groundMat = new THREE.MeshBasicMaterial({
      colorWrite: false, depthWrite: false, transparent: true, opacity: 0, side: THREE.DoubleSide,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.name = 'p4-battle-ground-pick';
    this.scene.add(ground);
    this.groundPick = ground;

    this.interaction = new BattleInteraction({
      THREE, input: this.input, adapter: this.adapter, scene: this,
      battleCamera: this.battleCamera,
      getCamera: () => this.camera,
      isActive: () => !!(this.renderManager && this.renderManager.isRunning),
      callbacks: {
        onUnitClick: (unitId) => this.selectUnit(unitId, { source: 'click' }),
        onCellClick: (cell) => this.selectCell(cell),
        onMiss: () => this.setCursor(null),
      },
    });
    this.interaction.setGround(ground);
    this.interaction.bind();

    // 相机按真实地图尺寸取景（32x32 整图可见），并把注视点归零
    this.battleCamera.setViewportHeight(this.getViewportHeight());
    this.battleCamera.reset(this.camera);
    this.battleCamera.fit(this.camera, this.getAspect(), { cols: map.width, rows: map.height });
    // 战斗 HUD 固定占左侧：把地图整体向右让出半个面板宽度，避免部队被压住
    const hudWidth = this.hud && this.hud.dom ? this.hud.dom.root.getBoundingClientRect().width : 0;
    if (hudWidth > 0) this.battleCamera.panByPixels(this.camera, Math.round(hudWidth / 2) + 8, 0);

    this.selection = null;
    this.lastLoad = {
      ok: true, mapId: map.mapId, width: map.width, height: map.height,
      frames: this.mapRenderer.stats.frames, props: this.mapRenderer.stats.props,
      units: this.unitRenderer.stats.visible,
    };
    this.refreshHUD();
    return this.lastLoad;
  }

  clearBattle() {
    if (this.interaction) { this.interaction.unbind(); this.interaction = null; }
    if (this.mapRenderer) { this.mapRenderer.dispose(); this.mapRenderer = null; }
    if (this.unitRenderer) { this.unitRenderer.dispose(); this.unitRenderer = null; }
    if (this.rangeRenderer) { this.rangeRenderer.dispose(); this.rangeRenderer = null; }
    if (this.groundPick) {
      if (this.groundPick.parent) this.groundPick.parent.remove(this.groundPick);
      this.groundPick.geometry.dispose();
      this.groundPick.material.dispose();
      this.groundPick = null;
    }
    this.selection = null;
  }

  // ------------------------------------------------------------------ 选中
  selectUnit(unitId, { source = 'api' } = {}) {
    if (!this.unitRenderer) return { ok: false, reason: '战斗场景未加载' };
    const unit = this.adapter.getBattleUnit(unitId);
    this.unitRenderer.setSelected(unitId);
    let selectable = false;
    let move = null;
    let attack = null;
    if (unit.present) {
      selectable = this.adapter.canSelectUnit(unitId);
      if (selectable) {
        move = this.adapter.getMovementRange(unitId);
        attack = this.adapter.getAttackRange(unitId);
        this.rangeRenderer.showMove(move.available ? move.cells : []);
        this.rangeRenderer.showAttack(attack.available ? attack.cells : []);
      } else {
        this.rangeRenderer.clear();
      }
    } else {
      this.rangeRenderer.clear();
    }
    this.selection = {
      kind: 'unit', unitId, selectable, source,
      moveCount: move && move.available ? move.cellCount : 0,
      attackCount: attack && attack.available ? attack.cellCount : 0,
      moveReason: move && !move.available ? move.reason : null,
      attackReason: attack && !attack.available ? attack.reason : null,
      _move: move && move.available ? move.cells : [],
      _attack: attack && attack.available ? attack.cells : [],
    };
    if (unit.present) this.setCursor({ x: unit.x, y: unit.y });
    this.refreshHUD();
    this.events.emit(EVENTS.UNIT_SELECTED, {
      unitId, selectable, source: 'presentation(P4)',
      moveCells: this.selection.moveCount, attackCells: this.selection.attackCount,
    }, { dedupeKey: `p4unit:${unitId}:${source}` });
    return this.selection;
  }

  selectCell(cell) {
    if (!this.rangeRenderer) return { ok: false, reason: '战斗场景未加载' };
    this.setCursor(cell);
    this.cellSelection = cell ? { x: cell.x, y: cell.y } : null;
    this.refreshHUD();
    return { ok: true, cell: this.cellSelection };
  }

  setCursor(cell) {
    if (!this.rangeRenderer) return false;
    this.cursor = cell || null;
    return this.rangeRenderer.setCursor(cell);
  }

  // -------------------------------------------------------------- 状态同步
  refreshFromAdapter(reason) {
    if (!this.unitRenderer) return false;
    this.unitRenderer.syncAll();
    // 选中部队的位置/兵力可能已变：重新取一次信息（不重算规则以外的任何东西）
    if (this.selection && this.selection.kind === 'unit') {
      const u = this.adapter.getBattleUnit(this.selection.unitId);
      if (!u.present || u.state === 8) {
        this.unitRenderer.setSelected(null);
        this.rangeRenderer.clear();
        this.selection = null;
      } else {
        this.selectUnit(this.selection.unitId, { source: 'sync' });
      }
    }
    this.refreshHUD(reason);
    return true;
  }

  refreshHUD(reason) {
    if (!this.hud) return;
    this.hud.update(this.getSnapshot(reason));
  }

  /** HUD/调试面板的唯一数据入口：全部字段来自 GameAdapter + 本场景渲染统计。 */
  getSnapshot(reason) {
    const b = this.adapter.getBattleState();
    let unit = null;
    if (this.selection && this.selection.kind === 'unit') {
      const u = this.adapter.getBattleUnit(this.selection.unitId);
      let factionName = '';
      if (u.belong > 0) {
        try { factionName = this.adapter.getOfficer(u.belong - 1).name; } catch (_) { factionName = `#${u.belong}`; }
      }
      unit = {
        ...u,
        factionName,
        selectable: !!this.selection.selectable,
      };
    }
    let cell = null;
    if (this.cursor) {
      const info = this.adapter.getBattleCell(this.cursor.x, this.cursor.y);
      const inMove = !!(this.selection && this.selection._move
        && this.selection._move.some((c) => c.x === this.cursor.x && c.y === this.cursor.y));
      const inAttack = !!(this.selection && this.selection._attack
        && this.selection._attack.some((c) => c.x === this.cursor.x && c.y === this.cursor.y));
      cell = { ...info, inMove, inAttack };
    }
    return {
      reason: reason || 'manual',
      battle: b,
      unit,
      cell,
      counts: {
        move: this.selection ? this.selection.moveCount : 0,
        attack: this.selection ? this.selection.attackCount : 0,
      },
      stats: this.getDiagnostics(),
    };
  }

  // -------------------------------------------------------------- 生命周期
  update(dt) {
    this.elapsed += dt;
    this.frameCount++;
    if (this.unitRenderer) this.unitRenderer.update(dt);
  }

  onResize(aspect) {
    if (this.camera && this.lastLoad && this.lastLoad.ok) {
      this.battleCamera.setViewportHeight(this.getViewportHeight());
      this.battleCamera.fit(this.camera, aspect, {
        cols: this.lastLoad.width, rows: this.lastLoad.height,
      });
    }
  }

  getUnitPickables() {
    return this.unitRenderer ? this.unitRenderer.getPickables() : [];
  }

  /** BattleInteraction 用：世界 -> 战斗格（避免它去碰 P1 的 12x9 配置）。 */
  worldToGrid(x, z) {
    return this.battleCoord.worldToGrid(x, z);
  }

  getDiagnostics() {
    return {
      sceneId: this.id,
      loaded: !!(this.lastLoad && this.lastLoad.ok),
      map: this.lastLoad,
      tiles: this.mapRenderer ? { ...this.mapRenderer.stats, histogram: this.mapRenderer.getTerrainHistogram() } : null,
      units: this.unitRenderer ? { ...this.unitRenderer.stats } : null,
      ranges: this.rangeRenderer ? { ...this.rangeRenderer.stats } : null,
      interaction: this.interaction ? this.interaction.getStats() : null,
      camera: this.battleCamera.getState(this.camera),
      selection: this.selection
        ? { unitId: this.selection.unitId, selectable: this.selection.selectable,
          moveCount: this.selection.moveCount, attackCount: this.selection.attackCount }
        : null,
      cursor: this.cursor,
      subscriptions: this._subs.length,
    };
  }

  dispose() {
    if (this._disposed) return;
    this.clearBattle();
    if (this.hud) { this.hud.dispose(); this.hud = null; }
    super.dispose();
  }
}
