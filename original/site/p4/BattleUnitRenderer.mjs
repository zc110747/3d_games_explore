/**
 * P4 BattleUnitRenderer —— 战斗部队的 3D 表现。
 *
 * 一支「部队」= 原版 g_GenPos[i]（i<10 我方 / i>=10 敌方），编制来自
 * g_FgtParam.GenArray[i]（值 = 武将编号+1），因此：
 *   名称   -> 原版 $n()（GameAdapter 已投影）
 *   兵种   -> person.ArmsType（0..5，名称见界面字符串 [12]）
 *   势力   -> person.Belong（= 君主武将 index+1，颜色沿用 P2 的 factionColor）
 *   状态   -> g_GenPos[i].state（名称见界面字符串 [28+state]）
 *   已行动 -> g_GenPos[i].active（原版 Io() 每回合清零，行动后置 1）
 *
 * 这里不保存任何「权威单位数据」：每次刷新都从 GameAdapter 读。
 * 20 支部队规模很小，逐单位 Group 比 InstancedMesh 更好维护；
 * 几何体/材质全部走 AssetManager 缓存，重复进入战斗不会重复创建。
 */
import { UNIT_STYLE } from './config.mjs';
import { factionColor } from '../p2/config.mjs';
import { createUnitLabelTexture, createUnitBadgeTexture } from './BattleTexture.mjs';

export class BattleUnitRenderer {
  constructor({ THREE, assets, coordinate, adapter }) {
    if (!THREE || !assets || !coordinate || !adapter) {
      throw new TypeError('BattleUnitRenderer 依赖不完整');
    }
    this.THREE = THREE;
    this.assets = assets;
    this.coordinate = coordinate;
    this.adapter = adapter;
    this.group = null;
    this.units = new Map();       // unitId -> { root, banner, stateCap, actedMark, picker, rec }
    this._selected = null;
    this._ring = null;
    this._label = null;
    this._labelTexture = null;
    this._elapsed = 0;
    this._badgeTextures = new Map();   // `${glyph}|${color}` -> CanvasTexture
    this.stats = { built: 0, visible: 0, updates: 0, ownerChanges: 0, badges: 0 };
  }

  build() {
    const THREE = this.THREE;
    const group = new THREE.Group();
    group.name = 'p4-battle-units';
    this.group = group;

    const units = this.adapter.getBattleUnits();
    for (const u of units) this._createUnit(u);
    this._createRing();
    this._createLabel();
    this.stats.built = this.units.size;
    this.syncAll();
    return group;
  }

  // ---------------------------------------------------------------- 单支部队
  _materialForUnit(unit) {
    const S = UNIT_STYLE;
    const playerOwner = this.adapter.getGameState().playerKing + 1;
    const baseColor = unit.side === 'mine' ? S.mineColor : S.enemyColor;
    const base = this.assets.material(`p4:unit-base-${unit.side}`, (T) => new T.MeshLambertMaterial({
      color: baseColor,
    }));
    const arms = unit.armsType === null ? 0 : Math.max(0, Math.min(S.armsColors.length - 1, unit.armsType));
    const body = this.assets.material(`p4:unit-body-${arms}`, (T) => new T.MeshLambertMaterial({
      color: S.armsColors[arms],
    }));
    // 旗布颜色只由原版 ownerId 决定（与 P2 战略地图同一套映射，不反向推断势力）
    const flagColor = factionColor(unit.belong, playerOwner);
    const flag = this.assets.material(`p4:unit-flag-${unit.belong}`, (T) => new T.MeshLambertMaterial({
      color: flagColor, side: T.DoubleSide,
    }));
    return { base, body, flag };
  }

  _createUnit(unit) {
    const THREE = this.THREE;
    const S = UNIT_STYLE;
    const mats = this._materialForUnit(unit);

    const baseGeo = this.assets.geometry('p4:unit-base', (T) => new T.CylinderGeometry(
      S.baseRadius, S.baseRadius * 1.08, S.baseHeight, 8));
    const bodyGeo = this.assets.geometry('p4:unit-body', (T) => new T.BoxGeometry(
      S.bodySize, S.bodyHeight, S.bodySize));
    const poleGeo = this.assets.geometry('p4:unit-pole', (T) => new T.CylinderGeometry(
      S.poleRadius, S.poleRadius, S.poleHeight, 5));
    const bannerGeo = this.assets.geometry('p4:unit-banner', (T) => new T.PlaneGeometry(
      S.bannerWidth, S.bannerHeight));
    const capGeo = this.assets.geometry('p4:unit-cap', (T) => new T.ConeGeometry(0.16, 0.22, 5));
    const markGeo = this.assets.geometry('p4:unit-acted', (T) => new T.TorusGeometry(0.3, 0.045, 6, 16));
    const factionGeo = this.assets.geometry('p4:unit-faction-ring', (T) => new T.RingGeometry(
      S.factionRingInner, S.factionRingOuter, 24));
    const factionMat = this.assets.material(`p4:unit-faction-${unit.side}`, (T) => new T.MeshBasicMaterial({
      color: unit.side === 'mine' ? S.mineColor : S.enemyColor,
      transparent: true, opacity: S.factionRingOpacity, side: T.DoubleSide,
    }));

    const root = new THREE.Group();
    root.name = `p4-unit-${unit.index}`;
    root.userData = { unitId: unit.index };

    const base = new THREE.Mesh(baseGeo, mats.base);
    base.position.y = S.baseHeight / 2;
    base.userData = { unitId: unit.index };

    const factionRing = new THREE.Mesh(factionGeo, factionMat);
    factionRing.rotation.x = -Math.PI / 2;
    factionRing.position.y = 0.02;
    factionRing.renderOrder = 2;

    const body = new THREE.Mesh(bodyGeo, mats.body);
    body.position.y = S.baseHeight + S.bodyHeight / 2;
    body.userData = { unitId: unit.index };

    const pole = new THREE.Mesh(poleGeo, this.assets.material('p4:unit-pole-mat',
      (T) => new T.MeshLambertMaterial({ color: 0x6b543a })));
    pole.position.set(S.bodySize * 0.62, S.baseHeight + S.poleHeight / 2 + 0.08, 0);

    const banner = new THREE.Mesh(bannerGeo, mats.flag);
    banner.position.set(S.bodySize * 0.62 + S.bannerWidth / 2, S.baseHeight + S.poleHeight + 0.02, 0);

    const stateCap = new THREE.Mesh(capGeo, this.assets.material('p4:unit-state-0',
      (T) => new T.MeshLambertMaterial({ color: S.stateColors[0] })));
    stateCap.position.y = S.baseHeight + S.bodyHeight + 0.18;
    stateCap.visible = false;

    const actedMark = new THREE.Mesh(markGeo, this.assets.material('p4:unit-acted-mat',
      (T) => new T.MeshBasicMaterial({ color: 0x9aa3ad })));
    actedMark.rotation.x = -Math.PI / 2;
    actedMark.position.y = S.baseHeight + S.bodyHeight + 0.24;
    actedMark.visible = false;

    // 独立拾取体：不渲染但可被 Raycaster 命中，避免建筑细节影响点击
    const pickGeo = this.assets.geometry('p4:unit-pick', (T) => new T.CylinderGeometry(
      S.pickRadius, S.pickRadius, S.pickHeight, 8));
    const picker = new THREE.Mesh(pickGeo, this.assets.material('p4:unit-pick-mat',
      (T) => new T.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, opacity: 0 })));
    picker.position.y = S.pickHeight / 2;
    picker.userData = { unitId: unit.index, pick: true };

    // 兵种徽章（billboard）：始终朝向相机，整图视角下也能一眼看出敌我/兵种
    const badge = new THREE.Sprite(new THREE.SpriteMaterial({
      transparent: true, depthWrite: false, depthTest: true,
    }));
    badge.scale.set(S.badgeSize, S.badgeSize, 1);
    badge.position.y = S.badgeY;
    badge.renderOrder = 12;
    badge.userData = { unitId: unit.index };

    root.add(base, factionRing, body, pole, banner, stateCap, actedMark, badge, picker);
    this.group.add(root);

    this.units.set(unit.index, {
      root, base, factionRing, body, banner, stateCap, actedMark, badge, picker, rec: unit, mats,
    });
  }

  _createRing() {
    const THREE = this.THREE;
    const S = UNIT_STYLE;
    const geo = this.assets.geometry('p4:unit-ring', (T) => new T.RingGeometry(S.ringInner, S.ringOuter, 24));
    const mat = this.assets.material('p4:unit-ring-mat', (T) => new T.MeshBasicMaterial({
      color: S.ringColor, transparent: true, opacity: 0.85, side: T.DoubleSide,
    }));
    const ring = new THREE.Mesh(geo, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    ring.visible = false;
    ring.renderOrder = 5;
    this._ring = ring;
    this.group.add(ring);
  }

  _createLabel() {
    const THREE = this.THREE;
    this._label = new THREE.Sprite(new THREE.SpriteMaterial({
      transparent: true, depthWrite: false, depthTest: false,
    }));
    this._label.visible = false;
    this._label.scale.set(UNIT_STYLE.labelWidth, UNIT_STYLE.labelHeight, 1);
    this._label.renderOrder = 20;
    this.group.add(this._label);
  }

  // ------------------------------------------------------------------ 同步
  syncAll() {
    for (const u of this.adapter.getBattleUnits()) this._apply(u);
    this.stats.updates++;
    this._refreshVisibleCount();
  }

  refreshUnit(unitId) {
    const rec = this.units.get(unitId);
    if (!rec) return false;
    this._apply(this.adapter.getBattleUnit(unitId));
    return true;
  }

  _apply(unit) {
    const rec = this.units.get(unit.index);
    if (!rec) return;
    const w = this.coordinate.gridToWorld(unit.x, unit.y);
    rec.root.position.set(w.x, 0, w.z);
    rec.rec = unit;

    const alive = unit.present && unit.state !== 8;
    rec.root.visible = alive;
    if (!alive) return;

    // 材质按 (阵营/兵种/势力) 缓存：这里只切换引用，绝不修改共享材质本身
    const playerOwner = this.adapter.getGameState().playerKing + 1;
    rec.base.material = this.assets.material(`p4:unit-base-${unit.side}`, (T) => new T.MeshLambertMaterial({
      color: unit.side === 'mine' ? UNIT_STYLE.mineColor : UNIT_STYLE.enemyColor,
    }));
    const arms = unit.armsType === null ? 0
      : Math.max(0, Math.min(UNIT_STYLE.armsColors.length - 1, unit.armsType));
    rec.body.material = this.assets.material(`p4:unit-body-${arms}`, (T) => new T.MeshLambertMaterial({
      color: UNIT_STYLE.armsColors[arms],
    }));
    rec.banner.material = this.assets.material(`p4:unit-flag-${unit.belong}`, (T) => new T.MeshLambertMaterial({
      color: factionColor(unit.belong, playerOwner), side: T.DoubleSide,
    }));

    rec.stateCap.visible = unit.state !== 0;
    if (unit.state !== 0) {
      const s = Math.min(UNIT_STYLE.stateColors.length - 1, unit.state);
      rec.stateCap.material = this.assets.material(`p4:unit-state-${s}`, (T) => new T.MeshLambertMaterial({
        color: UNIT_STYLE.stateColors[s],
      }));
    }
    rec.actedMark.visible = unit.active === 1;

    // 徽章内容只随「兵种 + 势力」变化；同组合复用同一张纹理（最多 6x势力数种）
    const glyph = String(unit.armsTypeName || '').charAt(0) || '?';
    const badgeColor = factionColor(unit.belong, playerOwner);
    const badgeKey = `${glyph}|${badgeColor}`;
    if (rec.badge.userData.key !== badgeKey) {
      let tex = this._badgeTextures.get(badgeKey);
      if (!tex) {
        tex = createUnitBadgeTexture(this.THREE, { glyph, color: badgeColor });
        this._badgeTextures.set(badgeKey, tex);
        this.stats.badges = this._badgeTextures.size;
      }
      rec.badge.material.map = tex;
      rec.badge.material.needsUpdate = true;
      rec.badge.userData.key = badgeKey;
    }
  }

  _refreshVisibleCount() {
    let n = 0;
    for (const { root } of this.units.values()) if (root.visible) n++;
    this.stats.visible = n;
  }

  // ------------------------------------------------------------------ 选中
  setSelected(unitId) {
    this._selected = Number.isInteger(unitId) ? unitId : null;
    const rec = this._selected === null ? null : this.units.get(this._selected);
    const alive = !!(rec && rec.root.visible);
    this._ring.visible = alive;
    this._label.visible = alive;
    if (alive) {
      this._ring.position.set(rec.root.position.x, 0.09, rec.root.position.z);
      this._label.position.set(rec.root.position.x, UNIT_STYLE.labelY, rec.root.position.z);
      this._setLabel(rec.rec.name || '');
    }
    return this._selected;
  }

  _setLabel(text) {
    if (this._labelTexture) { this._labelTexture.dispose(); this._labelTexture = null; }
    if (!text) { this._label.visible = false; return; }
    // 文字来自原版 $n()（GameAdapter 投影），不是本层编造
    this._labelTexture = createUnitLabelTexture(this.THREE, text);
    this._label.material.map = this._labelTexture;
    this._label.material.needsUpdate = true;
    this._label.visible = true;
  }

  // ------------------------------------------------------------------ 帧更新
  update(dt) {
    this._elapsed += dt;
    const rec = this._selected === null ? null : this.units.get(this._selected);
    if (this._ring && this._ring.visible) {
      const pulse = 1 + Math.sin(this._elapsed * 3.4) * 0.06;
      this._ring.scale.set(pulse, pulse, 1);
    }
    // 旗布轻微飘动（纯视觉，用相位错开）
    for (const { banner, root } of this.units.values()) {
      if (!root.visible) continue;
      banner.rotation.y = Math.sin(this._elapsed * 1.8 + root.position.x * 0.7) * 0.16;
    }
    void rec;
  }

  // ------------------------------------------------------------------ 查询
  getPickables() {
    const out = [];
    for (const { picker, root } of this.units.values()) if (root.visible) out.push(picker);
    return out;
  }

  getUnitWorldPosition(unitId) {
    const rec = this.units.get(unitId);
    return rec ? { x: rec.root.position.x, y: rec.root.position.y, z: rec.root.position.z } : null;
  }

  getUnitRecord(unitId) {
    const rec = this.units.get(unitId);
    return rec ? rec.rec : null;
  }

  dispose() {
    if (this._labelTexture) { this._labelTexture.dispose(); this._labelTexture = null; }
    for (const tex of this._badgeTextures.values()) { try { tex.dispose(); } catch (_) { /* ignore */ } }
    this._badgeTextures.clear();
    if (this.group && this.group.parent) this.group.parent.remove(this.group);
    this.units.clear();
    this.group = null;
    this._ring = null;
    this._label = null;
  }
}
