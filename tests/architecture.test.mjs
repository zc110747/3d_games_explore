/**
 * P1 架构测试：SceneManager 生命周期/切换路径/订阅释放、AssetManager 缓存与引用计数。
 * 使用最小 THREE 替身验证「管线逻辑」；不涉及任何游戏数据，也不代替浏览器端真实渲染验证。
 * 运行： node --test tests/architecture.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventManager, EVENTS } from '../original/site/p1/core/EventManager.mjs';
import { SceneManager } from '../original/site/p1/core/SceneManager.mjs';
import { SCENE_IDS } from '../original/site/p1/core/config.mjs';
import { AssetManager } from '../original/site/p1/core/AssetManager.mjs';

class StubScene {
  constructor(id, events) {
    this.id = id; this.events = events;
    this.scene = { clear() { this.cleared = true; } };
    this.camera = {};
    this.enterCount = 0; this.exitCount = 0; this.updateCount = 0;
    this.renderCount = 0; this.disposed = false; this.hits = 0;
    this.lastContext = null;
  }
  enter(ctx) {
    this.enterCount++; this.lastContext = ctx;
    this.events.on(EVENTS.CITY_UPDATED, () => { this.hits++; }, { owner: this });
  }
  update() { this.updateCount++; }
  render() { this.renderCount++; return true; }
  exit() { this.exitCount++; this.events.releaseOwner(this); }
  dispose() { this.disposed = true; this.exit(); }
}

function makeScenes() {
  const events = new EventManager();
  const sm = new SceneManager({ events });
  const made = new Map();
  for (const id of Object.values(SCENE_IDS)) {
    sm.register(id, () => {
      const s = new StubScene(id, events);
      made.set(id, s);
      return s;
    });
  }
  return { events, sm, made };
}

test('场景注册与首次切换：enter 被调用、上下文传入、adapter 场景同步', () => {
  const { sm, made } = makeScenes();
  let current = null;
  sm.adapter = { setCurrentScene: (id) => { current = id; } };
  assert.equal(sm.canSwitch('battle').ok, true, '首次进入允许任意场景');
  sm.switchTo('world', { reason: 'test' });
  assert.equal(made.get('world').enterCount, 1);
  assert.deepEqual(made.get('world').lastContext, { reason: 'test' });
  assert.equal(current, 'world');
  assert.equal(sm.currentId, 'world');
});

test('生命周期：切换时旧场景 exit，新场景 enter；update/render 只作用于当前场景', () => {
  const { sm, made } = makeScenes();
  sm.switchTo('world');
  sm.switchTo('city', { cityId: 3 });
  assert.equal(made.get('world').exitCount, 1);
  assert.equal(made.get('city').enterCount, 1);
  assert.equal(made.get('city').lastContext.cityId, 3);
  sm.update(0.016); sm.render({});
  assert.equal(made.get('city').updateCount, 1);
  assert.equal(made.get('city').renderCount, 1);
  assert.equal(made.get('world').updateCount, 0);
});

test('切换路径限制：city -> battle 被拒绝，world -> battle 允许', () => {
  const { sm } = makeScenes();
  sm.switchTo('world');
  sm.switchTo('city');
  assert.equal(sm.canSwitch('battle').ok, false);
  assert.throws(() => sm.switchTo('battle'), /不允许 city -> battle/);
  assert.equal(sm.stats.rejected, 1);
  sm.switchTo('world');
  assert.equal(sm.canSwitch('battle').ok, true);
  assert.doesNotThrow(() => sm.switchTo('battle'));
  assert.equal(sm.currentId, 'battle');
});

test('exit 取消场景订阅，dispose 释放全部场景', () => {
  const { events, sm, made } = makeScenes();
  sm.switchTo('world');
  const world = made.get('world');
  events.emit(EVENTS.CITY_UPDATED, { cityId: 0 });
  assert.equal(world.hits, 1);
  sm.switchTo('city');
  events.emit(EVENTS.CITY_UPDATED, { cityId: 0 });
  assert.equal(world.hits, 1, '退出后不应再收到事件');
  sm.dispose();
  assert.equal(world.disposed, true);
  assert.equal(made.get('city').disposed, true);
  assert.equal(sm.current, null);
});

test('AssetManager：相同资源不重复加载，retain/release 不误释放共享资源', async () => {
  let loads = 0, disposed = 0;
  const THREE = {
    SRGBColorSpace: 'srgb',
    TextureLoader: class {
      async loadAsync() { loads++; return { dispose() { disposed++; } }; }
    },
    BoxGeometry: class { constructor() { this.disposed = false; } dispose() { this.disposed = true; } },
    MeshBasicMaterial: class { constructor() { this.disposed = false; } dispose() { this.disposed = true; } },
  };
  const assets = new AssetManager({ THREE });
  const a = await assets.loadTexture('tex-a.png');
  const b = await assets.loadTexture('tex-a.png');
  assert.equal(a, b);
  assert.equal(loads, 1);
  const key = 'texture:tex-a.png';
  assets.retain(key); assets.retain(key);
  assets.release(key);
  assert.equal(disposed, 0, '仍有引用时不得释放');
  assert.equal(assets.getStats().entries, 1);
  assets.release(key);
  assert.equal(disposed, 1, '最后一个引用释放后才销毁');
  assert.equal(assets.getStats().entries, 0);
  assets.dispose();
});

test('AssetManager：material/geometry 缓存与 disposeLocal 跳过共享对象', () => {
  const THREE = {
    BoxGeometry: class { constructor() { this.disposed = false; } dispose() { this.disposed = true; } },
    MeshBasicMaterial: class { constructor() { this.disposed = false; } dispose() { this.disposed = true; } },
  };
  const assets = new AssetManager({ THREE });
  const g1 = assets.geometry('box', (T) => new T.BoxGeometry());
  const g2 = assets.geometry('box', (T) => new T.BoxGeometry());
  assert.equal(g1, g2);
  const sharedGeo = g1;
  const localGeo = new THREE.BoxGeometry();
  const root = {
    traverse(fn) {
      fn({ geometry: sharedGeo });
      fn({ geometry: localGeo });
    },
  };
  const n = assets.disposeLocal(root);
  assert.equal(sharedGeo.disposed, false, '共享几何体不得提前释放');
  assert.equal(localGeo.disposed, true);
  assert.equal(n, 1);
  assets.dispose();
  assert.equal(sharedGeo.disposed, true);
});

test('AssetManager：加载失败如实抛出并计数，不缓存失败项', async () => {
  const THREE = {
    TextureLoader: class { async loadAsync() { throw new Error('404'); } },
  };
  const assets = new AssetManager({ THREE });
  await assert.rejects(() => assets.loadTexture('missing.png'), /纹理加载失败 missing.png: 404/);
  assert.equal(assets.stats.failures, 1);
  assert.equal(assets.getStats().entries, 0);
});
