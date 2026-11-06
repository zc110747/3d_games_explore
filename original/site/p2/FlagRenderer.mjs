/**
 * P2 FlagRenderer —— 势力旗帜系统。
 *
 * 势力 ID 唯一来源：原版 city.Belong（0 空城；>0 君主武将 index+1）。
 * 玩家判定：原版 Dn.g_PlayerKing + 1（不是从颜色反推）。
 * 势力名：原版君主武将名（GameAdapter.getFactions() -> $n() / getStr(62)）。
 * 颜色/纹样/飘动都是表现层资源，绝不写回原版势力数据。
 *
 * 归属变化：CITY_OWNER_CHANGED -> updateOwner(cityId, newOwnerId)，只换材质，
 * 不重建旗杆/旗布对象，也不会只在启动时初始化一次（P2 §7.4）。
 */
import { FLAG_CONFIG as F, classifyFaction, factionColor, stableHash } from './config.mjs';
import { createFlagTexture } from './TextureFactory.mjs';

export class FlagRenderer {
  constructor({ THREE, assets, adapter, coordinate }) {
    if (!THREE || !assets || !adapter || !coordinate) throw new TypeError('FlagRenderer 依赖不完整');
    this.THREE = THREE;
    this.assets = assets;
    this.adapter = adapter;
    this.coordinate = coordinate;
    this.group = new THREE.Group();
    this.group.name = 'p2-flags';
    this._cloths = new Map();       // cityId -> Mesh
    this._owner = new Map();        // cityId -> 当前旗帜使用的 ownerId
    this._factionNames = new Map();
    this._elapsed = 0;
    this._built = false;
  }

  _playerOwnerId() {
    try { return this.adapter.getGameState().playerKing + 1; }
    catch (_) { return 1; }
  }

  /** 势力名一律来自原版数据（getFactions 内部走 $n()/getStr(62)）。 */
  syncFactions() {
    this._factionNames.clear();
    for (const f of this.adapter.getFactions()) this._factionNames.set(f.id, f.name);
    return this._factionNames.size;
  }

  /** 单一映射入口：factionId -> {color, label, kind, name}。 */
  getFactionStyle(ownerId) {
    const player = this._playerOwnerId();
    const name = this._factionNames.get(ownerId) || '';
    return Object.freeze({
      id: ownerId,
      name,
      kind: classifyFaction(ownerId, player),
      color: factionColor(ownerId, player),
      label: ownerId === 0 ? '·' : (name ? name.slice(0, 1) : `#${ownerId}`),
      source: 'city.Belong + getFactions() + 表现层 factionColor()',
    });
  }

  _material(ownerId, player) {
    const key = `p2:flag:${ownerId}:${player}`;
    return this.assets.material(key, (THREE) => {
      const style = this.getFactionStyle(ownerId);
      const tex = createFlagTexture(THREE, {
        color: style.color, label: style.label,
        empty: ownerId === 0, factionId: ownerId,
      });
      return new THREE.MeshBasicMaterial({
        map: tex, transparent: false, side: THREE.DoubleSide, depthWrite: true,
      });
    });
  }

  build() {
    if (this._built) return this.group;
    const THREE = this.THREE;
    const cities = this.adapter.getCities();
    this.syncFactions();
    const player = this._playerOwnerId();

    const poleGeo = this.assets.geometry('p2:flag-pole', (T) => {
      const g = new T.CylinderGeometry(F.poleRadius, F.poleRadius * 1.3, F.poleHeight, 6);
      g.translate(0, F.poleHeight / 2, 0);
      return g;
    });
    const poleMat = this.assets.material('p2:flag-pole-mat', (T) => new T.MeshLambertMaterial({ color: 0x6f5940 }));
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, cities.length);
    poles.name = 'p2-flag-poles';

    const clothGeo = this.assets.geometry('p2:flag-cloth', (T) => {
      const g = new T.PlaneGeometry(F.clothWidth, F.clothHeight, 4, 2);
      g.translate(F.clothWidth / 2, 0, 0);   // 以旗杆为轴
      return g;
    });

    const dummy = new THREE.Object3D();
    for (let i = 0; i < cities.length; i++) {
      const city = cities[i];
      const p = this.coordinate.mapToWorld(city.position.x, city.position.y, { height: 0.02 });
      const px = p.x + 0.17, pz = p.z - 0.12;
      dummy.position.set(px, p.y, pz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      poles.setMatrixAt(i, dummy.matrix);

      const cloth = new THREE.Mesh(clothGeo, this._material(city.ownerId, player));
      cloth.name = `p2-flag-${city.id}`;
      cloth.position.set(px, p.y + F.poleHeight * 0.78, pz);
      cloth.userData = {
        cityId: city.id, kind: 'flag', ownerId: city.ownerId,
        phase: (stableHash(`flagPhase:${city.id}`) % 628) / 100,
      };
      this.group.add(cloth);
      this._cloths.set(city.id, cloth);
      this._owner.set(city.id, city.ownerId);
    }
    poles.instanceMatrix.needsUpdate = true;
    this.group.add(poles);
    this._poles = poles;
    this._built = true;
    return this.group;
  }

  /** 归属变化后的增量更新：只换材质，不重建对象。 */
  updateOwner(cityId, ownerId) {
    const cloth = this._cloths.get(cityId);
    if (!cloth) return false;
    const player = this._playerOwnerId();
    if (this._owner.get(cityId) === ownerId && cloth.userData.player === player) return true;
    cloth.material = this._material(ownerId, player);
    cloth.userData.ownerId = ownerId;
    cloth.userData.player = player;
    this._owner.set(cityId, ownerId);
    return true;
  }

  /** 全部旗帜按原版实时数据重同步（例如读档、玩家君主变化）。 */
  syncAll() {
    this.syncFactions();
    for (const city of this.adapter.getCities()) this.updateOwner(city.id, city.ownerId);
    return this._cloths.size;
  }

  /** 简单飘动：绕旗杆摆动，共享几何体，不每帧重建。 */
  update(dt, cameraZoom = 1) {
    this._elapsed += dt;
    const amp = F.waveAmplitude * Math.max(0.5, Math.min(2, cameraZoom));
    for (const cloth of this._cloths.values()) {
      cloth.rotation.y = Math.sin(this._elapsed * F.waveSpeed + cloth.userData.phase) * amp * 12;
    }
  }

  getFlagCount() { return this._cloths.size; }

  getDiagnostics() {
    const byFaction = {};
    for (const ownerId of this._owner.values()) byFaction[ownerId] = (byFaction[ownerId] || 0) + 1;
    return {
      flags: this._cloths.size,
      factionCount: this._factionNames.size,
      byFaction,
      styles: [...new Set(this._owner.values())].map((id) => this.getFactionStyle(id)),
    };
  }

  dispose() {
    this._cloths.clear();
    this._owner.clear();
    this._factionNames.clear();
    this.group.clear();
    this._built = false;
  }
}
