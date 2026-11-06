/**
 * P1 AssetManager —— 纹理 / 材质 / 几何体 / GLTF(glb) 的统一加载、缓存与释放。
 *
 * - 相同 URL / key 只加载一次（_entries 单例缓存）。
 * - 引用计数 retain/release：多场景共享的资源，只有最后一个使用者释放后才销毁。
 * - 场景自有的临时对象走 disposeLocal()，不误删共享缓存里的对象。
 * - GLTFLoader 按需动态 import（importmap: three/addons/ -> p1/vendor/addons/）。
 * - 本模块不 import three 裸名，THREE 由构造注入，因此 Node 端可独立测试缓存/引用计数。
 */
import { ASSET_CONFIG } from './config.mjs';

export class AssetManager {
  constructor({ THREE, loaderFactory = null, maxCacheEntries = ASSET_CONFIG.maxCacheEntries } = {}) {
    if (!THREE) throw new TypeError('AssetManager 需要注入 THREE 命名空间');
    this.THREE = THREE;
    this._loaderFactory = loaderFactory;
    this._entries = new Map();          // key -> {kind, value, refs, dispose}
    this._materials = new Map();
    this._geometries = new Map();
    this._max = maxCacheEntries;
    this.stats = { loads: 0, cacheHits: 0, failures: 0, released: 0 };
  }

  _key(kind, url) { return `${kind}:${url}`; }

  _get(key) {
    const e = this._entries.get(key);
    if (e) this.stats.cacheHits++;
    return e || null;
  }

  _put(key, kind, value, dispose) {
    if (this._entries.size >= this._max) throw new Error(`资源缓存已满 (${this._max})`);
    const e = { kind, value, refs: 0, dispose };
    this._entries.set(key, e);
    this.stats.loads++;
    return e;
  }

  // ------------------------------------------------------------- 纹理
  async loadTexture(url, { colorSpace = 'srgb' } = {}) {
    const key = this._key('texture', url);
    const hit = this._get(key);
    if (hit) return hit.value;
    try {
      const loader = new this.THREE.TextureLoader();
      const texture = await loader.loadAsync(url);
      if (colorSpace === 'srgb' && this.THREE.SRGBColorSpace) texture.colorSpace = this.THREE.SRGBColorSpace;
      this._put(key, 'texture', texture, () => texture.dispose());
      return texture;
    } catch (e) {
      this.stats.failures++;
      throw new Error(`纹理加载失败 ${url}: ${e.message}`);
    }
  }

  // ------------------------------------------------------------- 模型
  async loadModel(url) {
    const key = this._key('model', url);
    const hit = this._get(key);
    if (hit) return hit.value;
    try {
      let factory = this._loaderFactory;
      if (!factory) {
        const mod = await import('three/addons/loaders/GLTFLoader.js');
        factory = () => new mod.GLTFLoader();
      }
      const gltf = await factory().loadAsync(url);
      const scene = gltf.scene;
      this._put(key, 'model', scene, () => this.disposeLocal(scene));
      return scene;
    } catch (e) {
      this.stats.failures++;
      throw new Error(`GLTF/GLB 加载失败 ${url}: ${e.message}`);
    }
  }

  // --------------------------------------------------------- 材质 / 几何体
  /** 按 key 缓存材质；factory 只在首次调用。 */
  material(key, factory) {
    if (this._materials.has(key)) { this.stats.cacheHits++; return this._materials.get(key); }
    const m = factory(this.THREE);
    this._materials.set(key, m);
    this.stats.loads++;
    return m;
  }

  geometry(key, factory) {
    if (this._geometries.has(key)) { this.stats.cacheHits++; return this._geometries.get(key); }
    const g = factory(this.THREE);
    this._geometries.set(key, g);
    this.stats.loads++;
    return g;
  }

  // ------------------------------------------------------------ 引用计数
  retain(key) {
    const e = this._entries.get(key) || this._entries.get(this._key('texture', key))
      || this._entries.get(this._key('model', key));
    if (!e) throw new Error(`资源未加载，无法 retain: ${key}`);
    e.refs++;
    return e.refs;
  }

  release(key) {
    const e = this._entries.get(key) || this._entries.get(this._key('texture', key))
      || this._entries.get(this._key('model', key));
    if (!e) return false;
    e.refs = Math.max(0, e.refs - 1);
    if (e.refs === 0) {
      try { e.dispose(); } catch (err) { console.warn('[P1] 资源释放异常:', err.message); }
      for (const [k, v] of this._entries) if (v === e) this._entries.delete(k);
      this.stats.released++;
    }
    return true;
  }

  /** 释放场景自建的 Object3D 树，跳过仍由缓存持有的共享对象。 */
  disposeLocal(root) {
    if (!root || typeof root.traverse !== 'function') return 0;
    const shared = new Set();
    for (const e of this._entries.values()) shared.add(e.value);
    for (const m of this._materials.values()) shared.add(m);
    for (const g of this._geometries.values()) shared.add(g);
    let n = 0;
    root.traverse((o) => {
      if (o.geometry && !shared.has(o.geometry)) { o.geometry.dispose(); n++; }
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        if (!m || shared.has(m)) continue;
        for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'emissiveMap']) {
          const tex = m[slot];
          if (tex && !shared.has(tex) && typeof tex.dispose === 'function') { tex.dispose(); n++; }
        }
        if (typeof m.dispose === 'function') { m.dispose(); n++; }
      }
    });
    return n;
  }

  getStats() {
    return {
      ...this.stats,
      entries: this._entries.size,
      materials: this._materials.size,
      geometries: this._geometries.size,
      refs: [...this._entries.values()].map((e) => ({ kind: e.kind, refs: e.refs })),
    };
  }

  dispose() {
    for (const e of this._entries.values()) { try { e.dispose(); } catch (_) { /* ignore */ } }
    this._entries.clear();
    for (const m of this._materials.values()) { try { m.dispose(); } catch (_) { /* ignore */ } }
    this._materials.clear();
    for (const g of this._geometries.values()) { try { g.dispose(); } catch (_) { /* ignore */ } }
    this._geometries.clear();
  }
}
