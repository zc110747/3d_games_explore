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
import { P2_VERSION } from '../p2/config.mjs';
import { MapCoordinateSystem } from '../p2/MapCoordinateSystem.mjs';
import { WorldCamera } from '../p2/WorldCamera.mjs';
import { StrategicMapScene } from '../p2/StrategicMapScene.mjs';
import { MapInteraction } from '../p2/MapInteraction.mjs';
import { DebugPanel } from '../p2/DebugPanel.mjs';
import { createCityManager } from '../p3/boot.mjs';

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
  const p2Panel = $('p2-panel');
  const p3Chip = $('p3-chip');
  let mapScene = null;
  let interaction = null;
  let debugPanel = null;
  let cityManager = null;

  const events = new EventManager();
  const coordinate = new CoordinateSystem();
  const mapCoordinate = new MapCoordinateSystem(coordinate);
  const cameraManager = new CameraManager({ THREE });
  const worldCamera = new WorldCamera({ THREE, cameraManager });
  const assets = new AssetManager({ THREE });
  const renderManager = new RenderManager({
    THREE, container: stage, events,
    onResize: (aspect) => {
      cameraManager.onResize(aspect);
      worldCamera.fitAll(aspect);   // P2：保证 12x9 地图完整显示
    },
  });
  const input = new InputManager({ container: stage });
  const core = window.__SGBY_CORE__;
  if (!core) throw new Error('未检测到 window.__SGBY_CORE__；请确认 index3d.html 加载的是 sgby.core.js');
  const adapter = new GameAdapter({ core, events });
  const scenes = new SceneManager({ events, adapter });

  const deps = {
    THREE, assets, events, coordinate, cameraManager, adapter, uiContainer: uiRoot,
    worldCamera, mapCoordinate,
  };
  scenes.register(SCENE_IDS.WORLD, () => new StrategicMapScene(deps));
  scenes.register(SCENE_IDS.CITY, () => new CityScene(deps));
  scenes.register(SCENE_IDS.BATTLE, () => new BattleScene(deps));

  // ---------------------------------------------------------- 输入 -> P2 交互
  // P1 的占位拾取/平移绑定已移除；统一由 MapInteraction（复用同一 InputManager）
  // 在战略地图场景创建后绑定，避免重复监听与双重平移。
  // interaction / mapScene 在 connect() 之后赋值（见启动顺序）。

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
      ['P2 城市 / 道路 / 旗帜', mapScene?.getDiagnostics()
        ? `${mapScene.getDiagnostics().cities.cityCount} / ${mapScene.getDiagnostics().roads.edges} / ${mapScene.getDiagnostics().flags.flags}`
        : '—'],
      ['P2 地形', mapScene?.getDiagnostics()?.terrain?.degraded ? '降级占位' : '原版 108 帧图块'],
      ['P2 选中城市', interaction?.selectedCityId === null || !interaction
        ? '未选中' : `#${interaction.selectedCityId}`],
      ['P2 原版联动', interaction ? interaction.intent : '—'],
      ['P3 城市会话', cityManager ? (cityManager.session.cityLoop
        ? `原版 ka() 中 · 城 #${cityManager.session.cityId ?? '—'}` : '未进入（原版未调用 ka()）') : '—'],
      ['P3 城市界面', cityManager && cityManager.ui.isOpen ? `已打开（城 #${cityManager.ui.cityId}）` : '关闭'],
      ['P3 接管 列表/武将/提示', cityManager
        ? (() => { const s = cityManager.getStatus().stats;
          return `${s.lists} / ${s.persons} / ${s.messages}`; })()
        : '—'],
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
    if (p3Chip) {
      const st = cityManager ? cityManager.getStatus() : null;
      p3Chip.textContent = !st ? '城市 UI 未装配'
        : !st.cityLoop ? '城市 UI 待命（点击己方城）'
          : st.open ? `城市管理 · ${st.cityId}` : '原版城市阶段 · 等待选城';
      p3Chip.style.color = st && st.cityLoop ? '#e0c07a' : '';
    }
    if (debugPanel && mapScene && coreReady) {
      try { refreshDebug(); } catch (e) { /* 状态切换瞬间忽略 */ }
    }
  }

  /** P2 调试面板快照：全部字段来自真实数据与渲染器诊断。 */
  function refreshDebug() {
    if (!debugPanel || !mapScene || !adapter.connected) return;
    const city = adapter.getCity(debugPanel.inspectId);
    const connections = adapter.getCityConnections(city.id);
    const diag = mapScene.getDiagnostics();
    debugPanel.update({
      inspect: {
        id: city.id, name: city.name, logical: { ...city.position },
        world: mapScene.cityRenderer?.getCityWorldPosition(city.id) || null,
        ownerId: city.ownerId,
        faction: mapScene.flagRenderer?.getFactionStyle(city.ownerId) || null,
        state: city.state,
        connectionCount: connections.filter((c) => c.cityId !== null).length,
        connections: connections.map((c) => ({ dir: c.dir, cityId: c.cityId, distance: c.distance })),
      },
      selection: interaction?.getSelectionInfo() || null,
      diagnostics: diag,
      highlighted: diag.roads?.highlighted ?? 0,
      input: interaction?.getStats() || null,
      intent: interaction?.intent || 'cursor',
    });
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

    // ---------------------------------------------------------- P2 战略地图自检
    const p2 = makeSuite('P2 战略地图');
    const citiesReal = adapter.getCities();
    const diag = mapScene ? mapScene.getDiagnostics() : null;
    p2.check('38 城完整且 ID 唯一', () => {
      if (!diag) throw new Error('战略地图场景未创建');
      const ids = mapScene.cityRenderer.cities.map((c) => c.id);
      if (ids.length !== citiesReal.length || new Set(ids).size !== ids.length) {
        throw new Error(`渲染 ${ids.length} 城 / 唯一 ${new Set(ids).size}`);
      }
      if (ids.some((id, i) => id !== citiesReal[i].id)) throw new Error('ID 顺序不一致');
      return `${ids.length}/${citiesReal.length}`;
    });
    p2.check('城市名称/逻辑坐标来自原版', () => {
      const bad = mapScene.cityRenderer.cities.filter((c, i) =>
        c.name !== citiesReal[i].name
        || c.position.x !== citiesReal[i].position.x
        || c.position.y !== citiesReal[i].position.y);
      if (bad.length) throw new Error(`不一致 ${bad.length} 城`);
      return `${citiesReal.length}/${citiesReal.length}`;
    });
    p2.check('每城世界坐标 = 统一坐标转换', () => {
      const bad = citiesReal.filter((c) => {
        const w = coordinate.mapToWorld(c.position.x, c.position.y);
        const p = mapScene.cityRenderer.getCityWorldPosition(c.id);
        return !p || Math.abs(p.x - w.x) > 1e-9 || Math.abs(p.z - w.z) > 1e-9;
      });
      if (bad.length) throw new Error(`坐标异常 ${bad.map((c) => c.id).join(',')}`);
      return `${citiesReal.length}/${citiesReal.length}`;
    });
    p2.check('道路 = 原版 54 条无向边', () => {
      const links = adapter.getCityLinks();
      if (links.length !== 54) throw new Error(`实际 ${links.length} 条`);
      if (!mapScene.roadRenderer.links.every((e, i) => e.from === links[i].from && e.to === links[i].to)) {
        throw new Error('端点与 getCityLinks() 不一致');
      }
      return `${links.length} 条 / ${diag.roads.directedRecords} 有向记录`;
    });
    p2.check('无额外/遗漏连接（8 方向逐城核对）', () => {
      const expect = new Set();
      for (const c of citiesReal) {
        for (const l of adapter.getCityConnections(c.id)) {
          if (l.cityId === null) continue;
          expect.add(`${Math.min(c.id, l.cityId)}-${Math.max(c.id, l.cityId)}`);
        }
      }
      const actual = new Set(mapScene.roadRenderer.links.map((e) => `${e.from}-${e.to}`));
      if (expect.size !== actual.size || [...expect].some((k) => !actual.has(k))) {
        throw new Error(`期望 ${expect.size} / 实际 ${actual.size}`);
      }
      return `${actual.size}/${expect.size}`;
    });
    p2.check('旗帜按原版 ownerId 分类', () => {
      const bad = citiesReal.filter((c) => mapScene.flagRenderer._owner.get(c.id) !== c.ownerId);
      if (bad.length) throw new Error(`归属不一致 ${bad.length} 城`);
      const styles = mapScene.flagRenderer.getDiagnostics().styles;
      const kinds = new Set(styles.map((s) => s.kind));
      if (!kinds.has('empty')) throw new Error('缺少空城旗帜分类');
      return `${styles.length} 种旗帜 / 分类 ${[...kinds].join(',')}`;
    });
    p2.check('地形来自原版 108 帧图块', () => {
      if (diag.terrain.degraded) throw new Error(diag.terrain.source);
      if (diag.terrain.frames !== 108) throw new Error(`实际 ${diag.terrain.frames} 帧`);
      return `108 帧 / ${diag.terrain.props} 装饰体`;
    });
    p2.check('固定斜 45° 正交相机且禁旋转', () => {
      const c = diag.camera;
      if (!c || !c.fixed45 || c.projection !== 'orthographic' || c.rotationAllowed !== false) {
        throw new Error(JSON.stringify(c));
      }
      return `${c.azimuthDeg}°/${c.elevationDeg}° zoom=${c.zoom.toFixed(2)}`;
    });
    p2.check('逻辑坐标 → 原版虚拟屏坐标可逆', () => {
      let tested = 0, skipped = 0;
      for (const c of citiesReal) {
        const s = mapCoordinate.logicalToOriginalScreen(c.position.x, c.position.y, { x: 0, y: 0 });
        if (!s) { skipped++; continue; }
        const back = mapCoordinate.originalScreenToLogical(s.x, s.y, { x: 0, y: 0 });
        if (back.col !== c.position.x || back.row !== c.position.y) {
          throw new Error(`城 #${c.id} (${c.position.x},${c.position.y}) -> ${JSON.stringify(back)}`);
        }
        tested++;
      }
      if (!tested) throw new Error('无可用样本');
      return `往返 ${tested} 城（原版视口外跳过 ${skipped}）`;
    });
    p2.check('战斗格坐标独立且可逆 32×32', () => {
      for (const [col, row] of [[0, 0], [31, 31], [7, 23]]) {
        const w = mapCoordinate.gridToWorld(col, row);
        const g = mapCoordinate.worldToGrid(w.x, w.z);
        if (g.col !== col || g.row !== row || g.error > 1e-9) throw new Error(`(${col},${row})`);
      }
      return '3/3';
    });
    p2.check('操作类接口仍如实标注不可用', () => {
      const caps = adapter.getCapabilities();
      if (caps.selectCity.status !== 'unavailable') throw new Error('selectCity 不应可用');
      if (caps.requestCitySelection.status !== 'write') throw new Error('缺少原版输入联动');
      return 'selectCity=unavailable / requestCitySelection=write';
    });
    suites.push(p2.summary());

    // ---------------------------------------------------------- P3 城市管理自检
    const p3 = makeSuite('P3 城市管理');
    const p3st = cityManager ? cityManager.getStatus() : null;
    p3.check('内核 7 个 UI 控件接管点已导出', () => {
      const names = core.p3 ? core.p3.widgetNames : null;
      if (!names || names.length !== 7) throw new Error(`实际 ${names ? names.length : 0} 个`);
      return names.join('/');
    });
    p3.check('原版菜单 4 类 / 14+5+5 项', () => {
      const g = cityManager.cityUI.getActionGroups();
      if (g.groups.length !== 4) throw new Error(`大类 ${g.groups.length}`);
      const counts = g.groups.slice(0, 3).map((x) => x.items.length);
      if (counts.join(',') !== '14,5,5') throw new Error(`条目 ${counts.join(',')}`);
      return `${g.main.join('/')} · ${counts.join('+')} · 第 4 类=${g.groups[3].name}`;
    });
    p3.check('指令分支集合来自内核扫描（23/24，缺 18 反间）', () => {
      const ids = core.p3.actionIds;
      if (ids.length !== 23) throw new Error(`实际 ${ids.length} 个`);
      if (ids.includes(18)) throw new Error('18 反间 不应出现在 mi() 分支中');
      const miss = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 23, 24, 25, 26, 27]
        .filter((id) => !ids.includes(id));
      if (miss.length) throw new Error(`缺少 ${miss.join(',')}`);
      return `${ids.length} 个，缺 18`;
    });
    p3.check('原版查询函数可用（ss/Bs/Ys/Is/$n）', () => {
      if (!cityManager.cityUI.available) throw new Error('原版函数缺失，UI 将进入降级模式');
      return 'ss/Bs/Ys/Is/$n 全部可用';
    });
    p3.check('未进入城市会话时界面不显示', () => !cityManager.ui.isOpen && !p3st.cityLoop);
    p3.check('对话框宿主初始无残留', () => cityManager.dialogHost.openCount === 0);
    p3.check('阻断标记只挂在可见部件上（frame / 遮罩 / 弹窗）', () => {
      const root = document.getElementById('p3-city');
      if (!root) throw new Error('城市界面未挂载');
      if (root.hasAttribute('data-p1-ui-block')) throw new Error('根容器不应带阻断标记（会吞掉整屏点击）');
      const frame = root.querySelector('.p3-frame');
      if (!frame || !frame.hasAttribute('data-p1-ui-block')) throw new Error('frame 缺少阻断标记');
      return 'root 无标记 / frame 有标记';
    });
    suites.push(p3.summary());

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
  debugPanel = new DebugPanel({
    root: p2Panel,
    callbacks: {
      onInspect: (id) => log(`查看城市 #${id}（仅调试查看，不触发任何原版操作）`),
      onToggleIntent: () => {
        if (!interaction) return;
        const next = interaction.setIntent(interaction.intent === 'cursor' ? 'select' : 'cursor');
        log(`原版联动模式 -> ${next}${next === 'select' ? '（确认选城会进入原版菜单）' : ''}`);
        refreshDebug();
      },
      onResetCamera: () => {
        if (mapScene?.camera) worldCamera.reset(mapScene.camera);
        log('相机复位');
      },
      onRunTests: async () => {
        const r = await runSmoke();
        log(`P2 自检重跑：${r.pass}/${r.pass + r.fail}`);
        debugPanel.log(`自检 ${r.pass} PASS / ${r.fail} FAIL`);
      },
      onSync: () => {
        if (!mapScene) return;
        mapScene.flagRenderer.syncAll();
        for (const c of adapter.getCities()) mapScene.refreshCity(c.id);
        refreshDebug();
        log('地图按原版实时数据全量同步（未写回任何游戏状态）');
      },
    },
  });
  $('p2-toggle-panel').addEventListener('click', () => p2Panel.classList.toggle('hidden'));
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
  log(`P2 启动；Three.js ${THREE_VERSION} / P2 ${P2_VERSION}；等待原版内核…`);
  await adapter.connect();
  log(`内核已连接：城市 ${core.Dn.g_Cities.length}、武将 ${core.Dn.g_Persons.length}、资源库 ${!!core.lib}`);
  scenes.switchTo(SCENE_IDS.WORLD, { reason: 'P2 启动' });
  mapScene = scenes.current;
  debugPanel.fillCities(adapter.getCities());
  interaction = new MapInteraction({
    THREE, input, adapter, scene: mapScene, worldCamera,
    getCamera: () => mapScene.camera,
    isActive: () => scenes.currentId === SCENE_IDS.WORLD,
    // P3：只读通知城市会话「用户点了哪个城」，供选目标城市等场景使用
    onCityClick: (cityId) => { if (cityManager) cityManager.session.noteClickedCity(cityId); },
  });
  interaction.bind();
  cityManager = createCityManager({
    core, adapter, events, input, interaction,
    log: (msg) => log(`[P3] ${msg}`),
  });
  log(`P3 城市管理已装配：接管 ${cityManager.getStatus().widgets.join(' / ')}`);
  log('提示：点「原版画面」在主菜单开新局，进入剧本后点击己方城市即可打开城市管理');
  renderManager.resize();           // 触发 worldCamera.fit，保证整图可见
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
      p2: mapScene ? mapScene.getDiagnostics() : null,
    }),
  });

  /** P2 调试/自动化入口（只读诊断 + 明确标注的表现层操作）。 */
  window.__P2__ = Object.freeze({
    version: P2_VERSION,
    threeVersion: THREE_VERSION,
    mapScene, interaction, worldCamera, mapCoordinate, debugPanel,
    adapter, events, scenes, input, renderManager, cameraManager, assets,
    getDiagnostics: () => mapScene.getDiagnostics(),
    getSnapshot: () => ({
      diagnostics: mapScene.getDiagnostics(),
      selection: interaction.getSelectionInfo(),
      input: interaction.getStats(),
      renderer: renderManager.getInfo(),
      phase: adapter.getInputPhase(),
      cursor: adapter.getCityCursor(),
    }),
    pickCityAt: (ndcX, ndcY) => interaction.pick(ndcX, ndcY),
    selectCity: (cityId, opts) => interaction.handleCityClick(cityId, opts),
    setSelection: (cityId) => { adapter.notifyCitySelected(cityId); return mapScene.setSelection(cityId); },
    cityScreenPosition: (cityId, viewport) => mapScene.cityScreenPosition(cityId, viewport),
    runSmoke,
    switchScene,
  });
  /** P3 城市管理调试/自动化入口（只读诊断 + 明确标注的表现层开关）。 */
  window.__P3__ = Object.freeze({
    version: cityManager.version,
    core, adapter, events, input,
    session: cityManager.session,
    ui: cityManager.ui,
    cityUI: cityManager.cityUI,
    dialogHost: cityManager.dialogHost,
    officerDialog: cityManager.officerDialog,
    getStatus: () => cityManager.getStatus(),
    getSnapshot: () => {
      const st = cityManager.getStatus();
      const cityId = st.cityId;
      return {
        status: st,
        phase: adapter.getInputPhase(),
        cursor: adapter.getCityCursor(),
        city: Number.isInteger(cityId) ? adapter.getCity(cityId) : null,
        report: Number.isInteger(cityId) ? cityManager.cityUI.getCityReport(cityId).lines : [],
        officers: Number.isInteger(cityId) ? cityManager.cityUI.getCityOfficers(cityId).rows.length : 0,
        log: cityManager.ui.logs.slice(-8),
      };
    },
    getActionGroups: () => cityManager.cityUI.getActionGroups(),
    runSmoke,
    switchScene,
  });

  return window.__P1__;
}

boot().catch((e) => {
  document.body.dataset.p1Status = 'error';
  log(`启动失败：${e.stack || e.message}`);
  console.error('[P1] 启动失败', e);
});
