/**
 * P1 架构入口 —— 只负责装配，不含任何游戏规则。
 *
 * 依赖链：sgby.core.js（原版内核 + 只读导出） -> GameAdapter -> EventManager
 *         -> SceneManager / UI -> Three.js 场景；渲染循环不读游戏数据。
 */
import * as THREE from 'three';
import { EventManager, EVENTS } from './core/EventManager.mjs';
import { CoordinateSystem } from './core/CoordinateSystem.mjs';
import { GameAdapter, UnsupportedError } from './core/GameAdapter.mjs';
import { AssetManager } from './core/AssetManager.mjs';
import { RenderManager } from './core/RenderManager.mjs';
import { CameraManager } from './core/CameraManager.mjs';
import { SceneManager } from './core/SceneManager.mjs';
import { InputManager } from './core/InputManager.mjs';
import { WorldMapScene } from './scenes/WorldMapScene.mjs';
import { CityScene } from './scenes/CityScene.mjs';
import { BattleScene } from './scenes/BattleScene.mjs';
import { THREE_VERSION, SCENE_IDS, INPUT_CONFIG } from './core/config.mjs';

const $ = (id) => document.getElementById(id);
const logEl = $('p1-log');
const logs = [];
function log(...parts) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${parts.join(' ')}`;
  logs.push(line);
  if (logs.length > 120) logs.shift();
  if (logEl) logEl.textContent = logs.join('\n');
  console.log('[P1]', ...parts);
}

/** 简易断言收集器：返回 PASS/FAIL 计数，不吞异常信息。 */
function makeSuite(name) {
  const results = [];
  return {
    name,
    check(label, fn) {
      try {
        const detail = fn();
        const pass = detail !== false && detail !== null && detail !== undefined;
        results.push({ label, pass: !!pass, detail: detail === true ? '' : String(detail) });
      } catch (e) {
        results.push({ label, pass: false, detail: `${e.name}: ${e.message}` });
      }
    },
    async checkAsync(label, fn) {
      try {
        const detail = await fn();
        const pass = detail !== false && detail !== null && detail !== undefined;
        results.push({ label, pass: !!pass, detail: detail === true ? '' : String(detail) });
      } catch (e) {
        results.push({ label, pass: false, detail: `${e.name}: ${e.message}` });
      }
    },
    summary() {
      const pass = results.filter((r) => r.pass).length;
      return { name, pass, fail: results.length - pass, total: results.length, results };
    },
  };
}

async function boot() {
  const stage = $('p1-stage');
  const uiRoot = $('p1-ui');
  const legacy = $('p1-legacy');
  const panel = $('p1-panel');
  const phaseEl = $('p1-phase');
  const statusList = $('p1-status-list');
  const modal = $('p1-modal-overlay');

  const events = new EventManager();
  const coordinate = new CoordinateSystem();
  const cameraManager = new CameraManager({ THREE });
  const assets = new AssetManager({ THREE });
  const renderManager = new RenderManager({
    THREE, container: stage, events,
    onResize: (aspect) => cameraManager.onResize(aspect),
  });
  const input = new InputManager({ container: stage });
  const core = window.__SGBY_CORE__;
  if (!core) throw new Error('未检测到 window.__SGBY_CORE__；请确认 index3d.html 加载的是 sgby.core.js');
  const adapter = new GameAdapter({ core, events });
  const scenes = new SceneManager({ events, adapter });

  const deps = { THREE, assets, events, coordinate, cameraManager, adapter, uiContainer: uiRoot };
  scenes.register(SCENE_IDS.WORLD, () => new WorldMapScene(deps));
  scenes.register(SCENE_IDS.CITY, () => new CityScene(deps));
  scenes.register(SCENE_IDS.BATTLE, () => new BattleScene(deps));

  // ---------------------------------------------------------- 输入 -> 相机
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  input.on('drag', ({ dx, dy }) => {
    const cam = scenes.current && scenes.current.camera;
    if (cam) cameraManager.pan(cam, -dx * INPUT_CONFIG.panPixelsToWorld, -dy * INPUT_CONFIG.panPixelsToWorld);
  });
  input.on('wheel', ({ deltaY }) => {
    const cam = scenes.current && scenes.current.camera;
    if (cam) cameraManager.zoom(cam, 1 - deltaY * INPUT_CONFIG.wheelZoomScale);
  });
  input.on('click', (p) => {
    const s = scenes.current;
    if (!s || s.id !== SCENE_IDS.WORLD || !s.camera) return;
    ndc.set(p.ndcX, p.ndcY);
    raycaster.setFromCamera(ndc, s.camera);
    const hits = raycaster.intersectObjects(s.scene.children, true);
    const hit = hits.find((h) => h.object.userData && Number.isInteger(h.object.userData.cityId));
    if (hit) {
      const cityId = hit.object.userData.cityId;
      // 表现层选中事件：不写 Dn、不代表原版选城结果
      adapter.notifyCitySelected(cityId);
      log(`3D 拾取命中占位城 #${cityId} ${hit.object.userData.name}（表现层事件，非原版操作）`);
    }
  });
  input.on('keydown', ({ key }) => {
    if (key === 'r' || key === 'R') {
      const cam = scenes.current && scenes.current.camera;
      if (cam) { cameraManager.reset(cam); log('相机复位'); }
    }
  });

  // ---------------------------------------------------------- 渲染循环
  let lastStatusAt = 0;
  renderManager.setFrameCallback((dt) => {
    scenes.update(dt);
    scenes.render(renderManager);
    const now = performance.now();
    if (now - lastStatusAt > 300) { lastStatusAt = now; renderStatus(); }
  });
  renderManager.start();

  // ---------------------------------------------------------- 状态面板
  function renderStatus() {
    const coreReady = !!(core && core.Dn && core.lib);
    const gs = coreReady ? adapter.getGameState() : null;
    const info = renderManager.getInfo();
    const ev = events.getStats();
    const inp = input.getStats();
    const rows = [
      ['Three.js 版本', THREE_VERSION],
      ['内核桥接', core ? `${core.version} / ${core.source}` : '未就绪'],
      ['原版 Dn / lib', coreReady ? '已连接' : '等待资源包…'],
      ['真实城市数', gs ? String(gs.cityCount) : '—'],
      ['真实武将数', gs ? String(gs.officerCount) : '—'],
      ['技能数(资源10/34)', gs ? String(gs.skillCount) : '—'],
      ['游戏年月', gs ? (gs.year ? `${gs.year} 年 ${gs.month} 月` : '未进入剧本（原版主菜单）') : '—'],
      ['当前场景', `${scenes.currentId || '无'}（${adapter.getCurrentScene().source}）`],
      ['WebGLRenderer', info.failed ? '失败' : '正常'],
      ['帧 / DrawCall', info.failed ? '—' : `${info.frames} / ${info.drawCalls}`],
      ['像素比 / 尺寸', info.failed ? '—' : `${info.pixelRatio} / ${info.size.map(Math.round).join('×')}`],
      ['事件 派发/去重/异常', `${ev.emitted} / ${ev.deduped} / ${ev.handlerErrors}`],
      ['输入 点击/拖动/滚轮', `${inp.clicks} / ${inp.drags} / ${inp.wheels}（阻断 ${inp.blocked}）`],
      ['场景切换/拒绝', `${scenes.stats.switches} / ${scenes.stats.rejected}`],
      ['资源 缓存/命中/释放', `${assets.getStats().entries} / ${assets.getStats().cacheHits} / ${assets.getStats().released}`],
      ['状态同步次数', `${adapter.stats.syncCount}（来源 ${adapter.stats.lastSource || '—'}）`],
    ];
    if (statusList) {
      statusList.replaceChildren();
      for (const [k, v] of rows) {
        const dt = document.createElement('dt'); dt.textContent = k;
        const dd = document.createElement('dd'); dd.textContent = v;
        if (k === 'WebGLRenderer') dd.className = info.failed ? 'bad' : 'ok';
        if (k === '原版 Dn / lib' && coreReady) dd.className = 'ok';
        statusList.append(dt, dd);
      }
    }
    if (phaseEl) phaseEl.textContent = coreReady ? `运行中 · ${scenes.currentId}` : '等待原版资源包';
  }

  // ---------------------------------------------------------- 自检套件
  async function runSmoke({ verbose = true } = {}) {
    const suites = [];
    const coord = makeSuite('坐标转换');
    const cities = adapter.getCities();
    coord.check('38 城真实坐标往返（误差 0）', () => {
      if (cities.length !== 38) throw new Error(`实际读取 ${cities.length} 城，内核可能尚未初始化`);
      const bad = cities.filter((c) => {
        const w = coordinate.mapToWorld(c.position.x, c.position.y);
        const m = coordinate.worldToMap(w.x, w.z);
        return m.col !== c.position.x || m.row !== c.position.y || m.error > 1e-9;
      });
      if (bad.length) throw new Error(`失败城市 ${bad.map((c) => c.id).join(',')}`);
      return `${cities.length}/${cities.length}`;
    });
    coord.check('城市布局值 == 城市ID+1', () => {
      if (cities.length !== 38) throw new Error(`实际读取 ${cities.length} 城`);
      const bad = cities.filter((c) => c.layoutValue !== c.id + 1);
      if (bad.length) throw new Error(`不一致 ${bad.length} 项`);
      return `${cities.length}/${cities.length}`;
    });
    coord.check('战斗格子 32×32 往返', () => {
      const samples = [[0, 0], [31, 31], [15, 8], [7, 23], [16, 16]];
      for (const [col, row] of samples) {
        const w = coordinate.gridToWorld(col, row);
        const g = coordinate.worldToGrid(w.x, w.z);
        if (g.col !== col || g.row !== row || g.error > 1e-9) {
          throw new Error(`(${col},${row}) -> ${JSON.stringify(g)}`);
        }
      }
      return `${samples.length}/${samples.length}`;
    });
    coord.check('整体缩放后仍可逆', () => {
      const old = coordinate.getConfig().world.tileSize;
      coordinate.setWorldTileSize(2.5);
      const w = coordinate.mapToWorld(11, 7);
      const m = coordinate.worldToMap(w.x, w.z);
      const battleW = coordinate.gridToWorld(31, 31);
      coordinate.setWorldTileSize(old);
      return m.col === 11 && m.row === 7 && m.error < 1e-9 && Number.isFinite(battleW.x);
    });
    coord.check('屏幕缩放不改逻辑坐标', () => {
      const cam = scenes.current && scenes.current.camera;
      if (!cam) return false;
      const v = new THREE.Vector3();
      const projector = (world) => { v.set(world.x, world.y, world.z).project(cam); return { x: v.x, y: v.y, z: v.z }; };
      const w = coordinate.mapToWorld(5, 4);
      const a = coordinate.worldToScreen(w, projector, { left: 0, top: 0, width: 800, height: 600 });
      const b = coordinate.worldToScreen(w, projector, { left: 0, top: 0, width: 1600, height: 1200 });
      const back = coordinate.worldToMap(w.x, w.z);
      return Number.isFinite(a.x) && a.x !== b.x && back.col === 5 && back.row === 4;
    });
    suites.push(coord.summary());

    const adp = makeSuite('适配层');
    adp.check('读取真实城市数据 38 座', () => adapter.getCities().length === 38);
    adp.check('城市名来自资源 58', () => adapter.getCity(0).name === '西凉');
    adp.check('城市连接 8 方向', () => adapter.getCityConnections(0).length === 8);
    adp.check('连接值含有效目标', () => adapter.getCities().some((c) => adapter.getCityConnections(c.id).some((x) => x.cityId !== null)));
    adp.check('菜单 4 类 / 14+5+5 项', () => {
      const a = adapter.getCityActions(0);
      return a.main.length === 4 && a.groups[0].items.length === 14
        && a.groups[1].items.length === 5 && a.groups[2].items.length === 5;
    });
    adp.check('指令消耗来自 getItem(2,10/11)', () => {
      const a = adapter.getCityActions(0);
      return a.groups[0].items[0].costThew === 8 && a.groups[0].items[0].costMoney === 50;
    });
    adp.check('武将名来自原版 $n() / 资源 62', () => {
      const n = adapter.getOfficer(0).name;
      if (n !== '董卓') throw new Error(`实际 ${n}`);
      return n;
    });
    adp.check('武将队列一致性（按原版阶段）', () => {
      // 原版 Oa() 只创建空对象；pa(period) 在 Ba() 选剧本之后才载入武将队列。
      // 未进剧本时所有城 officerCount=0，此时验证空集合契约，不伪造数据。
      const cs = adapter.getCities();
      const withPeople = cs.filter((c) => c.officerCount > 0);
      if (!withPeople.length) {
        const ok = cs.every((c) => adapter.getOfficers(c.id).length === 0);
        if (!ok) throw new Error('未进剧本但读到了武将');
        return '未进剧本（pa 未执行），空集合契约正确';
      }
      const bad = withPeople.filter((c) => adapter.getOfficers(c.id).length !== c.officerCount);
      if (bad.length) throw new Error(`不一致城市 ${bad.map((c) => c.id).join(',')}`);
      return `${withPeople.length} 城一致`;
    });
    adp.check('战斗状态字段来自 Dn', () => {
      const b = adapter.getBattleState();
      return Number.isInteger(b.round) && Number.isInteger(b.width) && b.viewport.cols === 15;
    });
    adp.check('不可用接口抛 UnsupportedError', () => {
      try { adapter.endTurn(); return false; }
      catch (e) { return e instanceof UnsupportedError && !!e.reason; }
    });
    adp.check('capabilities 如实标注', () => {
      const c = adapter.getCapabilities();
      return c.getCities.status === 'read' && c.endTurn.status === 'unavailable' && c.sendInput.status === 'write';
    });
    suites.push(adp.summary());

    const evt = makeSuite('事件与状态同步');
    evt.check('订阅 / 取消', () => {
      let n = 0;
      const off = events.on(EVENTS.CITY_SELECTED, () => { n++; });
      events.emit(EVENTS.CITY_SELECTED, { cityId: 0 });
      off();
      events.emit(EVENTS.CITY_SELECTED, { cityId: 0 });
      return n === 1;
    });
    evt.check('同一状态变化去重', () => {
      let n = 0;
      const off = events.on(EVENTS.GAME_STATE_UPDATED, () => { n++; });
      events.emit(EVENTS.GAME_STATE_UPDATED, { signature: 'x' }, { dedupeKey: 'dup-test' });
      events.emit(EVENTS.GAME_STATE_UPDATED, { signature: 'x' }, { dedupeKey: 'dup-test' });
      off();
      return n === 1;
    });
    evt.check('releaseOwner 批量取消', () => {
      const owner = {};
      let n = 0;
      events.on(EVENTS.CITY_UPDATED, () => { n++; }, { owner });
      events.emit(EVENTS.CITY_UPDATED, { cityId: 0 });
      events.releaseOwner(owner);
      events.emit(EVENTS.CITY_UPDATED, { cityId: 0 });
      return n === 1;
    });
    evt.check('sync 无变化时不重复派发', () => {
      const before = events.getStats().emitted;
      const r = adapter.sync({ source: 'smoke' });
      return r.changed === false && events.getStats().emitted === before;
    });
    suites.push(evt.summary());

    const ast = makeSuite('资源与场景');
    // 1×1 PNG data URL：只验证真实纹理加载管线，不涉及任何游戏数据
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    await ast.checkAsync('纹理真实加载 + 缓存命中', async () => {
      const t1 = await assets.loadTexture(PNG);
      const t2 = await assets.loadTexture(PNG);
      return t1 === t2 && assets.getStats().cacheHits >= 1;
    });
    ast.check('引用计数不误释放共享资源', () => {
      const key = `texture:${PNG}`;
      assets.retain(key); assets.retain(key);
      assets.release(key);
      const still = assets.getStats().entries;
      assets.release(key);
      return still >= 1;
    });
    ast.check('场景切换路径合法', () => scenes.canSwitch('city').ok === true);
    ast.check('渲染器唯一且循环未重复', () => {
      const before = renderManager.stats.frames;
      renderManager.start();       // 重复 start 应被忽略
      return renderManager.isRunning && renderManager.stats.frames >= before;
    });
    ast.check('WebGLRenderer 可用', () => {
      if (renderManager.failed) throw new Error(renderManager.error?.message || '未知 WebGL 错误');
      return true;
    });
    suites.push(ast.summary());

    const pass = suites.reduce((n, s) => n + s.pass, 0);
    const fail = suites.reduce((n, s) => n + s.fail, 0);
    if (verbose) {
      for (const s of suites) {
        log(`【${s.name}】${s.pass} PASS / ${s.fail} FAIL`);
        for (const r of s.results) log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.label}${r.detail ? ' — ' + r.detail : ''}`);
      }
      log(`自检汇总：${pass} PASS / ${fail} FAIL`);
    }
    if (statusList) statusList.dataset.smoke = `${pass}/${pass + fail}`;
    document.body.dataset.p1Status = fail ? 'error' : 'ready';
    return { pass, fail, suites };
  }

  /** 场景切换（测试入口，明确不伪造游戏操作结果）。 */
  function switchScene(id) {
    try {
      if (id === SCENE_IDS.CITY) {
        const gs = adapter.getGameState();
        const mine = adapter.getCities().find((c) => c.ownerId === gs.playerKing + 1);
        scenes.switchTo(id, { cityId: mine ? mine.id : 0, reason: 'P1 测试入口' });
      } else if (id === SCENE_IDS.BATTLE) {
        scenes.switchTo(id, { reason: 'P1 测试入口' });
      } else {
        scenes.switchTo(id, { reason: 'P1 测试入口' });
      }
      log(`场景切换 -> ${id}（测试入口，未执行任何原版游戏操作）`);
    } catch (e) { log(`场景切换被拒绝：${e.message}`); }
    renderStatus();
  }

  // ---------------------------------------------------------- UI 绑定
  $('p1-toggle-panel').addEventListener('click', () => panel.classList.toggle('hidden'));
  $('p1-toggle-legacy').addEventListener('click', () => {
    legacy.classList.toggle('hidden');
    log(`原版 2D 画面：${legacy.classList.contains('hidden') ? '隐藏' : '显示'}`);
  });
  for (const btn of document.querySelectorAll('[data-scene]')) {
    btn.addEventListener('click', () => switchScene(btn.dataset.scene));
  }
  $('p1-test-coords').addEventListener('click', async () => { const r = await runSmoke(); log(`坐标测试重跑：${r.pass}/${r.pass + r.fail}`); });
  $('p1-test-adapter').addEventListener('click', async () => { const r = await runSmoke(); log(`适配层测试重跑：${r.pass}/${r.pass + r.fail}`); });
  $('p1-test-events').addEventListener('click', async () => { const r = await runSmoke(); log(`事件测试重跑：${r.pass}/${r.pass + r.fail}`); });
  $('p1-test-assets').addEventListener('click', async () => { const r = await runSmoke(); log(`资源测试重跑：${r.pass}/${r.pass + r.fail}`); });
  $('p1-sync').addEventListener('click', () => { log('手动同步：' + JSON.stringify(adapter.sync({ source: 'manual' }))); renderStatus(); });
  $('p1-modal').addEventListener('click', () => {
    modal.hidden = false;
    input.setUIOpen(true);
    log('弹窗打开：3D 输入已阻断');
  });
  $('p1-modal-close').addEventListener('click', () => {
    modal.hidden = true;
    input.setUIOpen(false);
    log('弹窗关闭：3D 输入恢复，阻断计数 ' + input.getStats().blocked);
  });

  events.on(EVENTS.CITY_SELECTED, ({ cityId }) => log(`事件 CITY_SELECTED cityId=${cityId}（表现层）`));
  events.on(EVENTS.SCENE_CHANGED, ({ from, to }) => log(`事件 SCENE_CHANGED ${from || '(none)'} -> ${to}`));
  events.on(EVENTS.TURN_CHANGED, ({ year, month }) => log(`事件 TURN_CHANGED ${year}年${month}月（原版 Dn）`));
  events.on(EVENTS.CITY_OWNER_CHANGED, ({ cityId, oldOwnerId, newOwnerId }) =>
    log(`事件 CITY_OWNER_CHANGED #${cityId} ${oldOwnerId} -> ${newOwnerId}（原版 Dn）`));

  // ---------------------------------------------------------- 启动顺序
  document.body.dataset.p1Status = 'connecting';
  log(`P1 启动；Three.js ${THREE_VERSION}；等待原版内核…`);
  await adapter.connect();
  log(`内核已连接：城市 ${core.Dn.g_Cities.length}、武将 ${core.Dn.g_Persons.length}、资源库 ${!!core.lib}`);
  scenes.switchTo(SCENE_IDS.WORLD, { reason: 'P1 启动' });
  renderStatus();

  const smoke = await runSmoke();
  log(`启动自检完成：${smoke.pass} PASS / ${smoke.fail} FAIL`);

  window.__P1__ = Object.freeze({
    version: '1.0.0-p1',
    threeVersion: THREE_VERSION,
    events, coordinate, adapter, assets, renderManager,
    cameraManager, input, scenes,
    getSmoke: () => smoke,
    runSmoke,
    switchScene,
    getStatus: () => ({
      bodyStatus: document.body.dataset.p1Status,
      core: core ? { version: core.version, connected: adapter.connected } : null,
      renderer: renderManager.getInfo(),
      events: events.getStats(),
      input: input.getStats(),
      scenes: { current: scenes.currentId, ...scenes.stats },
      assets: assets.getStats(),
      adapter: { connected: adapter.connected, syncCount: adapter.stats.syncCount },
    }),
  });
  return window.__P1__;
}

boot().catch((e) => {
  document.body.dataset.p1Status = 'error';
  log(`启动失败：${e.stack || e.message}`);
  console.error('[P1] 启动失败', e);
});
