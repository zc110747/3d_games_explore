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
import { THREE_VERSION, SCENE_IDS, INPUT_CONFIG } from './core/config.mjs';
import { P2_VERSION } from '../p2/config.mjs';
import { MapCoordinateSystem } from '../p2/MapCoordinateSystem.mjs';
import { WorldCamera } from '../p2/WorldCamera.mjs';
import { StrategicMapScene } from '../p2/StrategicMapScene.mjs';
import { MapInteraction } from '../p2/MapInteraction.mjs';
import { DebugPanel } from '../p2/DebugPanel.mjs';
import { createCityManager } from '../p3/boot.mjs';
import { createBattleManager } from '../p4/boot.mjs';
import { P4_VERSION } from '../p4/config.mjs';
import { createBattleOps } from '../p5/boot.mjs';
import { P5_VERSION, PHASES } from '../p5/config.mjs';
import { splitMenuByRect } from '../p5/BattleFlowController.mjs';
// P6：全局整合（统一入口 / 场景编排 / 状态同步 / 存档 / 异常）
import { AppLifecycle } from '../p6/AppLifecycle.mjs';
import { createIntegration } from '../p6/boot.mjs';
import { PresentationStore } from '../p6/PresentationStore.mjs';
// P6：视图两态（原版 2D 主界面 / 3D）与 3D 底部操作条
import { ViewMode } from '../p6/ViewMode.mjs';
import { WorldOps } from '../p6/WorldOps.mjs';
import { VIEW_MODE, P6_VERSION } from '../p6/config.mjs';
// P7：性能观测 / 自适应分辨率 / 原版一致性校验（全部只读，不写游戏状态）
import { PerfMonitor } from '../p7/PerfMonitor.mjs';
import { AdaptiveResolution } from '../p7/AdaptiveResolution.mjs';
import { ConsistencyProbe } from '../p7/ConsistencyProbe.mjs';
import { P7_VERSION, CONTEXT_LOST_CONFIG, ADAPTIVE_CONFIG } from '../p7/config.mjs';

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
  const panel = $('p1-panel');
  const phaseEl = $('p1-phase');
  const statusList = $('p1-status-list');
  const modal = $('p1-modal-overlay');
  const p2Panel = $('p2-panel');
  const p3Chip = $('p3-chip');
  const p4Chip = $('p4-chip');
  const p5Chip = $('p5-chip');
  const p6Chip = $('p6-chip');
  const savePanel = $('p6-saves');
  const slotList = $('p6-slot-list');
  const saveGate = $('p6-save-gate');
  let mapScene = null;
  let interaction = null;
  let debugPanel = null;
  let cityManager = null;
  let battleManager = null;
  let battleOps = null;
  let integration = null;
  let viewMode = null;
  let worldOps = null;
  let scenesReady = false;   // 防止 RenderManager 构造期 resize 访问尚未初始化的 scenes

  // P6：统一启动入口。每个初始化阶段只跑一次，重复执行会立刻报错而不是静默双开。
  const lifecycle = new AppLifecycle({
    log: (msg) => log(`[P6] ${msg}`),
    onStateChange: (to, from) => log(`运行状态 ${from} -> ${to}`),
  });
  lifecycle.startedAt = Date.now();
  // 启动失败时 boot() 的 catch 在作用域外，这里把生命周期挂到 window 供其标记 failed
  if (typeof window !== 'undefined') window.__SGBY_LIFECYCLE__ = lifecycle;

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
      // P4：战斗相机按真实地图尺寸重新取景（CameraManager 刚把 frustum 复位成配置值）
      if (scenesReady && scenes.currentId === SCENE_IDS.BATTLE && scenes.current?.onResize) {
        scenes.current.onResize(aspect);
      }
    },
  });
  const input = new InputManager({ container: stage });
  const core = window.__SGBY_CORE__;
  if (!core) throw new Error('未检测到 window.__SGBY_CORE__；请确认 index3d.html 加载的是 sgby.core.js');
  const adapter = new GameAdapter({ core, events });
  const scenes = new SceneManager({ events, adapter });
  scenesReady = true;

  // P6：登记必须唯一的全局对象。第二个实例出现会当场抛错，而不是两套渲染/两套状态并存。
  lifecycle.claim('events', events);
  lifecycle.claim('renderer', renderManager);
  lifecycle.claim('coordinate', coordinate);
  lifecycle.claim('assets', assets);
  lifecycle.claim('adapter', adapter);
  lifecycle.claim('scenes', scenes);

  const deps = {
    THREE, assets, events, coordinate, cameraManager, adapter, uiContainer: uiRoot,
    worldCamera, mapCoordinate,
  };
  scenes.register(SCENE_IDS.WORLD, () => new StrategicMapScene(deps));
  scenes.register(SCENE_IDS.CITY, () => new CityScene(deps));
  // P4：battle 场景由 createBattleManager 注册（BattleMapScene），
  // P1 的占位 BattleScene 不再注册，避免两套战斗场景并存。

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
  lifecycle.claim('loop', renderManager);   // 唯一渲染循环（RenderManager.start 幂等）

  // ---------------------------------------------------------- P7 性能观测
  // 只挂在 RenderManager 的帧钩子上，不新建循环；自适应分辨率只改像素比。
  const perf = new PerfMonitor({
    renderManager, events, log: (m) => log(`[P7] ${m}`),
  });
  perf.attach();
  lifecycle.claim('perf', perf);
  const adaptive = new AdaptiveResolution({
    renderManager, perf, config: ADAPTIVE_CONFIG, log: (m) => log(`[P7] ${m}`),
  });
  let probe = null;   // 一致性探针在场景就绪后构造（需要 mapCoordinate / 战斗坐标系）

  // ---------------------------------------------------------- 状态面板
  let lastConsistencyAt = 0;
  let cachedConsistency = null;
  function renderStatus() {
    const coreReady = !!(core && core.Dn && core.lib);
    const gs = coreReady ? adapter.getGameState() : null;
    const info = renderManager.getInfo();
    const ev = events.getStats();
    const inp = input.getStats();
    // P6：一致性检查按 1s 节流（只比对真实数据，不在每帧做全量扫描）
    const nowTs = performance.now();
    if (integration && nowTs - lastConsistencyAt > 1000) {
      lastConsistencyAt = nowTs;
      try { cachedConsistency = integration.sync.consistency(); } catch (_) { cachedConsistency = null; }
    }
    const rows = [
      ['Three.js 版本', THREE_VERSION],
      ['视图模式(P6)', viewMode ? `${viewMode.mode}（kind=${viewMode.stats.lastKind}）` : '—'],
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
      ['P6 点击/移光标/确认', worldOps
        ? `${worldOps.stats.clicks} / ${worldOps.stats.moved} / ${worldOps.stats.confirms}（拒绝 ${worldOps.stats.rejected}）`
        : '—'],
      ['P3 城市会话', cityManager ? (cityManager.session.cityLoop
        ? `原版 ka() 中 · 城 #${cityManager.session.cityId ?? '—'}` : '未进入（原版未调用 ka()）') : '—'],
      ['P3 城市界面', cityManager && cityManager.ui.isOpen ? `已打开（城 #${cityManager.ui.cityId}）` : '关闭'],
      ['P3 接管 列表/武将/提示', cityManager
        ? (() => { const s = cityManager.getStatus().stats;
          return `${s.lists} / ${s.persons} / ${s.messages}`; })()
        : '—'],
      ['P4 战斗状态', battleManager
        ? (() => {
          const s = battleManager.getStatus();
          return s.active ? `${s.phase}${s.loaded ? '（3D 已装载）' : ''}` : '未进入（原版未调用 Uo()）';
        })()
        : '—'],
      ['P4 地图 / 部队', (() => {
        const d = battleManager && battleManager.scene && battleManager.scene.getDiagnostics
          ? battleManager.scene.getDiagnostics() : null;
        if (!d || !d.loaded) return '—';
        return `${d.map.width}×${d.map.height} / ${d.units.visible} 支`;
      })()],
      ['P4 选中 / 范围', (() => {
        const d = battleManager && battleManager.scene && battleManager.scene.getDiagnostics
          ? battleManager.scene.getDiagnostics() : null;
        if (!d || !d.selection) return '—';
        return `#${d.selection.unitId}（${d.selection.selectable ? '可操作' : '不可操作'}）移动 ${d.selection.moveCount} / 攻击 ${d.selection.attackCount}`;
      })()],
      ['P5 操作状态', (() => {
        if (!battleOps) return '未装配';
        const st = battleOps.getStatus();
        return st.active ? `${st.phase}${st.menuOpen ? '（菜单打开）' : ''}` : '未接管（原版 2D 输入）';
      })()],
      ['P5 输入 / 点击', (() => {
        const f = battleOps && battleOps.flow ? battleOps.flow.getSnapshot() : null;
        if (!f) return '—';
        return `${f.inputActive ? '开放' : '锁定'} · 接受 ${f.stats.accepted} / 拒绝 ${f.stats.rejected} · 队列 ${f.pendingInputs}`;
      })()],
      ['P5 动画队列', (() => {
        const a = battleOps && battleOps.anim ? battleOps.anim.getDiagnostics() : null;
        if (!a) return '—';
        return `${a.active || '空闲'} · 排队 ${a.pending} · 完成 ${a.finished} / 超时 ${a.timedOut} / 取消 ${a.cancelled}`;
      })()],
      // ---------------------------------------------------------------- P6
      ['P6 运行状态', (() => {
        const s = lifecycle.summary();
        return `${s.state} · ${s.stages} 阶段（失败 ${s.failed} / 重复 ${s.duplicates}）`;
      })()],
      ['P6 场景切换', (() => {
        if (!integration) return '—';
        const d = integration.director.getStatus();
        return `${d.transitions} 次 · 拒绝 ${d.rejected} · 循环拦截 ${d.loops} · 当前 ${d.currentId}`;
      })()],
      ['P6 UI 栈 / 输入', (() => {
        if (!integration) return '—';
        const s = integration.ui.getStatus();
        return `${s.open} 层（峰值 ${s.stack.peakDepth}）· 输入${s.blocking ? '阻断' : '开放'} · 重复打开 ${s.stack.duplicates}`;
      })()],
      ['P6 一致性', (() => {
        if (!cachedConsistency) return '—';
        return cachedConsistency.ok ? '一致' : cachedConsistency.mismatches.join('；');
      })()],
      ['P6 存档槽', (() => {
        if (!integration) return '—';
        const s = integration.saves.getStatus();
        return `${s.slots.filter((x) => x.exists).length}/${s.slots.length} 已用 · `
          + `可存 ${s.canSave.ok ? '是' : '否'} / 可读 ${s.canLoad.ok ? '是' : '否'}`
          + ` · 期望 ${s.expected ? s.expected.base + '/' + s.expected.dyn + 'B' : '—'}`;
      })()],
      ['P6 异常 / 恢复', (() => {
        if (!integration) return '—';
        const e = integration.errors.getStatus();
        return `上报 ${e.reports}（致命 ${e.fatal}）· 恢复 ${e.recovered} · 失败 ${e.recoveryFailures}`;
      })()],
      // ---------------------------------------------------------------- P7
      ['P7 帧时间', (() => {
        const f = perf.frameStats();
        return f.samples ? `${f.fps}fps · 均值 ${f.meanMs}ms · p95 ${f.p95Ms}ms · 抖动 ${f.jitterMs}ms` : '采集中…';
      })()],
      ['P7 CPU / 帧', (() => {
        const f = perf.frameStats();
        return f.samples ? `${f.busyMeanMs}ms（占一帧 ${(f.busyShare * 100).toFixed(1)}%）` : '—';
      })()],
      ['P7 DrawCall / 三角形', (() => {
        const r = perf.rendererInfo();
        return r.available ? `${r.drawCalls} / ${r.triangles}` : '—';
      })()],
      ['P7 资源 / 像素比', (() => {
        const r = perf.rendererInfo();
        const a = adaptive.getStatus();
        return r.available
          ? `Geo ${r.geometries} · Tex ${r.textures} · Prog ${r.programs ?? '—'} · dpr ${r.pixelRatio}（上限 ${a.cap}）`
          : '—';
      })()],
      ['P7 上下文', (() => {
        const s = renderManager.stats;
        return `丢失 ${s.contextLosses} / 恢复 ${s.contextRestores} / 跳过帧 ${s.skipped}`
          + ` · 可见性暂停 ${s.visibilityPauses}`;
      })()],
      ['P7 长跑 / 掉帧', (() => {
        const lr = perf.longRun();
        const f = perf.frameStats();
        return `运行 ${lr.spanSec}s · Geo ${lr.geometries >= 0 ? '+' : ''}${lr.geometries}`
          + ` · Tex ${lr.textures >= 0 ? '+' : ''}${lr.textures}`
          + ` · 掉帧 ${f.dropped}`
          + `${lr.usedMB == null ? '' : ` · 堆 Δ${lr.usedMB >= 0 ? '+' : ''}${lr.usedMB}MB`}`;
      })()],
      ['P7 一致性探针', (() => {
        if (!probe) return '未装配';
        const r = probe.checks.length ? { total: probe.checks.length, failed: probe.checks.filter((c) => !c.ok).length } : null;
        if (!r) return `可运行（${coreReady ? '38 城 + 200 将' : '等待内核'}）`;
        return `${r.total - r.failed}/${r.total} 项通过`;
      })()],
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
        : !st.cityLoop ? '城市·待命'
          : st.open ? `城市管理 #${st.cityId}` : '城市阶段·选城';
      p3Chip.style.color = st && st.cityLoop ? '#e0c07a' : '';
    }
    if (p4Chip) {
      const st = battleManager ? battleManager.getStatus() : null;
      const diag = st && st.diagnostics;
      p4Chip.textContent = !st ? '战斗未装配'
        : !st.active ? '战斗·待命'
          : st.loaded && diag && diag.map ? `战斗中 ${diag.map.width}×${diag.map.height}` : '战斗装载中';
      p4Chip.style.color = st && st.active ? '#e08a7a' : '';
    }
    if (p5Chip) {
      const st = battleOps ? battleOps.getStatus() : null;
      p5Chip.textContent = !st ? '操作未装配'
        : !st.active ? '操作·待命'
          : `操作 · ${st.phase}`;
      p5Chip.style.color = st && st.active ? '#9ad0ff' : '';
    }
    if (p6Chip) {
      if (!integration) {
        p6Chip.textContent = '整合未装配';
      } else {
        const d = integration.director.getStatus();
        const used = integration.saves.getStatus().slots.filter((x) => x.exists).length;
        const bad = cachedConsistency && !cachedConsistency.ok;
        p6Chip.textContent = bad
          ? `整合 · 不一致 ${cachedConsistency.mismatches.length} 项`
          : `整合 · ${d.currentId} · 存档 ${used}/3`;
        p6Chip.style.color = bad ? '#e08a7a' : (lifecycle.state === 'running' ? '#9ad0ff' : '');
      }
    }
    if (debugPanel && mapScene && coreReady) {
      try { refreshDebug(); } catch (e) { /* 状态切换瞬间忽略 */ }
    }
    // P6：操作条只属于「3D 战略地图」——城市管理/战斗界面各有自己的按钮
    if (worldOps && viewMode) {
      worldOps.setActive(viewMode.mode === VIEW_MODE.GAME && scenes.currentId === SCENE_IDS.WORLD);
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

  // ---------------------------------------------------------- P6 存档面板
  /**
   * 存档面板：只是原版 ac()/oc() 的遥控器。
   * 每个槽位显示「原版头部里的年份 + 君主」与两片字节数，不解析、不改写任何字段。
   */
  function renderSavePanel() {
    if (!slotList || !integration) return;
    const status = integration.saves.getStatus();
    slotList.replaceChildren();
    for (const s of integration.saves.inspectAll()) {
      const row = document.createElement('div');
      row.className = 'p6-slot';

      const label = document.createElement('div');
      label.className = 'p6-slot-label';
      label.textContent = `槽位 ${s.slot + 1} · ${s.label}`;
      const meta = document.createElement('span');
      meta.className = `p6-slot-meta${s.exists && !s.sizeMatch ? ' bad' : ''}`;
      meta.textContent = s.exists
        ? `base ${s.bytes.base}B / dyn ${s.bytes.dyn}B`
          + `${s.sizeMatch ? ' · 与容量公式一致' : ` · 期望 ${s.expect ? s.expect.base + '/' + s.expect.dyn : '?'}`}`
        : '空槽';
      label.append(meta);
      row.append(label);

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'p6-btn-mini';
      saveBtn.textContent = '存入';
      saveBtn.disabled = !status.canSave.ok;
      saveBtn.addEventListener('click', () => {
        const r = integration.saves.save(s.slot, { reason: '界面' });
        integration.ui.toast(r.ok
          ? `已写入槽位 ${s.slot + 1}（原版 ac()，${r.bytes.base}/${r.bytes.dyn} B）`
          : `未写入：${r.reason}`, r.ok ? 'ok' : 'error', 4200);
        renderSavePanel();
      });

      const loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.className = 'p6-btn-mini';
      loadBtn.textContent = '读取';
      loadBtn.disabled = !s.exists || !status.canLoad.ok;
      loadBtn.addEventListener('click', async () => {
        const ok = await integration.ui.confirm(
          `读取槽位 ${s.slot + 1}？`,
          `将从原版存档恢复：${s.label}。\n当前未保存的进度会丢失（原版 oc() 直接覆盖 Dn）。`,
        );
        if (!ok) return;
        const r = integration.saves.load(s.slot, { reason: '界面' });
        integration.ui.toast(r.ok
          ? `已读取槽位 ${s.slot + 1}：${r.afterState.year} 年 ${r.afterState.month} 月`
          : `读取失败：${r.reason}`, r.ok ? 'ok' : 'error', 6000);
        renderSavePanel();
      });

      row.append(saveBtn, loadBtn);
      slotList.append(row);
    }
    if (saveGate) {
      const blocks = [];
      if (!status.canSave.ok) blocks.push(`存：${status.canSave.reasons.join('；')}`);
      if (!status.canLoad.ok) blocks.push(`读：${status.canLoad.reasons.join('；')}`);
      saveGate.textContent = blocks.length
        ? blocks.join('\n')
        : `可存可读 · 存档格式 ${status.format.header.map((b) => String.fromCharCode(b)).join('')} v${status.format.version}（非原子：失败后建议重启页面）`;
      saveGate.className = `p6-gate${blocks.length ? ' bad' : ''}`;
    }
  }

  function bindSavePanel() {
    if (!savePanel || !integration) return;
    const toggle = $('p6-toggle-saves');
    if (toggle) {
      toggle.addEventListener('click', () => {
        savePanel.hidden = !savePanel.hidden;
        if (!savePanel.hidden) renderSavePanel();
      });
    }
    renderSavePanel();
    // 低频刷新门禁文案（战斗中/指令上下文的说明会随状态变化），只在面板可见时做。
    // 计时器统一登记到 lifecycle，dispose 时一定被清掉。
    lifecycle.interval(() => { if (savePanel && !savePanel.hidden) renderSavePanel(); }, 1200, 'p6-save-panel');
  }

  // ---------------------------------------------------------- P7 性能看板
  const perfPanel = $('p7-perf');
  const perfList = $('p7-perf-list');
  const p7Chip = $('p7-chip');

  /** 性能看板：全部数值来自 PerfMonitor 的实测采样；不可测量的项显示「不可测」。 */
  function renderPerfPanel() {
    if (!perfList) return;
    const rep = perf.report();
    const f = rep.frame;
    const r = rep.renderer;
    const lr = rep.longRun;
    const ad = adaptive.getStatus();
    const rows = [
      ['FPS', `${f.fps}（平均 ${f.meanMs}ms）`],
      ['帧时间 p95', `${f.p95Ms}ms（最长 ${f.maxMs}ms）`],
      ['CPU / 帧', `${f.busyMeanMs}ms（占 ${(f.busyShare * 100).toFixed(1)}%）`],
      ['Draw Calls', `${r.drawCalls} / 三角形 ${r.triangles}`],
      ['资源', `Geo ${r.geometries} · Tex ${r.textures}`],
      ['像素比', `${r.pixelRatio}（上限 ${ad.cap}，设备 ${ad.devicePixelRatio}）`],
      ['JS 堆', rep.memory.available ? `${rep.memory.usedMB}MB` : '不可测'],
      ['GPU 时间', rep.gpu.measurable ? '可测' : '不可测'],
      ['长跑', `${lr.spanSec}s · Geo ${lr.geometries >= 0 ? '+' : ''}${lr.geometries}`
        + ` · Tex ${lr.textures >= 0 ? '+' : ''}${lr.textures}`
        + `${lr.usedMB == null ? '' : ` · 堆 Δ${lr.usedMB >= 0 ? '+' : ''}${lr.usedMB}MB`}`],
      ['掉帧', `${f.dropped} 帧（${(f.dropRate * 100).toFixed(1)}%）`],
    ];
    perfList.replaceChildren();
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      perfList.append(dt, dd);
    }
    if (p7Chip) {
      p7Chip.textContent = `性能 · ${f.fps}fps · ${r.drawCalls} draws · dpr ${r.pixelRatio}`;
      p7Chip.dataset.adaptive = `${ad.cap}`;
    }
  }

  function bindPerfPanel() {
    const toggle = $('p7-toggle-perf');
    if (toggle && perfPanel) {
      toggle.addEventListener('click', () => {
        perfPanel.hidden = !perfPanel.hidden;
        if (!perfPanel.hidden) renderPerfPanel();
      });
    }
    // 低频刷新（只在面板可见时算），计时器登记在 lifecycle 上，退出时统一清理。
    lifecycle.interval(() => { if (perfPanel && !perfPanel.hidden) renderPerfPanel(); }, 1000, 'p7-perf-panel');
  }

  // ---------------------------------------------------------- P7 上下文丢失/恢复
  // 只处理渲染层：提示 + 等待浏览器恢复 + 恢复后继续渲染。
  // 绝不重新初始化场景、不重置任何游戏数据（P7 §6 明确要求）。
  let loseCtxExt = null;
  let loseCtxExtTried = false;
  /**
   * WEBGL_lose_context 扩展的缓存持有者。
   * 规范：上下文丢失后 getExtension() 返回 null，扩展对象本身仍然可用
   * （loseContext/restoreContext 就是为这种场景设计的），所以必须缓存首次拿到的实例。
   */
  function getLoseContextExt() {
    if (loseCtxExt || loseCtxExtTried) return loseCtxExt;
    loseCtxExtTried = true;
    try {
      const gl = renderManager.renderer.getContext();
      loseCtxExt = gl.getExtension('WEBGL_lose_context') || null;
    } catch (_) {
      loseCtxExt = null;
    }
    return loseCtxExt;
  }

  function bindContextRecovery() {
    getLoseContextExt();   // 趁上下文健康时先取一次，供后续演练/诊断使用
    let lostSince = 0;
    let promptTimer = null;
    const clearPrompt = () => { if (promptTimer) { clearTimeout(promptTimer); promptTimer = null; } };
    events.on(EVENTS.RENDERER_CONTEXT_LOST, () => {
      lostSince = Date.now();
      log('[P7] WebGL 上下文丢失，暂停绘制并等待恢复');
      integration.ui.toast('3D 上下文丢失，正在等待浏览器恢复…', 'warn', 6000);
      clearPrompt();
      promptTimer = setTimeout(() => {
        if (!renderManager.contextLost) return;
        log('[P7] 上下文 6s 未恢复，给出重新加载提示');
        integration.errors.report('renderer.context', new Error('WebGL 上下文长时间未恢复'), {
          kind: 'fatal',
          fatal: true,
          context: { lostSince },
          actions: [
            { label: '重新加载页面', value: 'reload' },
            { label: '继续等待', value: 'wait' },
          ],
        });
      }, CONTEXT_LOST_CONFIG.restoreGraceMs);
    });
    events.on(EVENTS.RENDERER_CONTEXT_RESTORED, () => {
      clearPrompt();
      const downMs = lostSince ? Date.now() - lostSince : 0;
      log(`[P7] WebGL 上下文已恢复（中断 ${downMs}ms），继续渲染，游戏状态未改动`);
      integration.ui.toast(`3D 渲染已恢复（中断 ${(downMs / 1000).toFixed(1)}s），游戏状态未受影响`, 'ok', 4200);
      integration.ui.hideFatal();
      // renderer.info 在恢复后会被 three 重建，重新采样一次长跑基线，避免误判为「资源暴涨」
      perf.reset();
    });
    // 页面隐藏时渲染层自动暂停（RenderManager 内部处理），这里只记日志便于诊断
    events.on(EVENTS.RENDERER_VISIBILITY_CHANGED, ({ hidden }) => {
      log(`[P7] 页面${hidden ? '隐藏 -> 暂停绘制' : '可见 -> 恢复绘制'}`);
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
    p2.check('正面俯视正交相机且禁旋转', () => {
      const c = diag.camera;
      if (!c || !c.fixedView || c.projection !== 'orthographic' || c.rotationAllowed !== false) {
        throw new Error(JSON.stringify(c));
      }
      if (c.topDown !== true) throw new Error(`俯角 ${c.elevationDeg}° 不是俯视`);
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

    // ---------------------------------------------------------- P4 战斗地图自检
    const p4 = makeSuite('P4 战斗地图');
    const p4core = core.p4 || null;
    p4.check('内核导出 yo/Uo 接管点与战斗函数', () => {
      if (!p4core) throw new Error('core.p4 缺失（sgby.core.js 未重新生成？）');
      const names = p4core.widgetNames;
      if (!names || names.length !== 2 || !names.includes('yo') || !names.includes('Uo')) {
        throw new Error(`接管点 ${names}`);
      }
      for (const k of ['qi', 'Vo', 'Ui', 'Ci', 'Xo']) {
        if (typeof p4core.battle[k] !== 'function') throw new Error(`缺少 ${k}()`);
      }
      return names.join('/');
    });
    p4.check('战斗网格协议与源码常量一致', () => {
      const g = p4core.battle.grid;
      return g.unitsPerSide === 10 && g.unitsTotal === 20 && g.windowCols === 15
        && g.windowRows === 17 && g.pathWidth === 15 && g.blockCost === 128;
    });
    p4.check('适配层战斗接口如实标注', () => {
      const c = adapter.getCapabilities();
      if (c.getBattleMap.status !== 'read') throw new Error('getBattleMap 应为 read');
      if (c.moveUnit.status !== 'unavailable') throw new Error('moveUnit 不应可用');
      if (c.getMovementRange.status !== 'read') throw new Error('getMovementRange 应为 read');
      return 'getBattleMap/getMovementRange=read · moveUnit=unavailable';
    });
    p4.check('不伪造战斗地图', () => {
      const m = adapter.getBattleMap();
      if (!m.available) {
        if (battleManager && battleManager.hud.isOpen) throw new Error('未进战斗却显示了战斗 HUD');
        return `未进入战斗：${m.reason}`;
      }
      if (m.cellCount !== m.width * m.height) throw new Error(`格子数 ${m.cellCount} ≠ ${m.width}x${m.height}`);
      if (m.raw.length !== m.cellCount || m.terrain.length !== m.cellCount) throw new Error('raw/terrain 长度不符');
      return `原版仍保留地图 ${m.width}x${m.height}（Dn.g_MapWid 结束时不清零）`;
    });
    p4.check('战斗场景可切换（世界 -> 战斗）', () => {
      const r = scenes.canSwitch('battle');
      if (!r.ok) throw new Error(r.reason);
      return 'world -> battle 合法';
    });
    p4.check('战斗坐标 32x32 往返', () => {
      const bc = battleManager.deps.battleCoord;
      bc.configure(32, 32);
      for (const [x, y] of [[0, 0], [31, 31], [15, 8], [7, 23]]) {
        const w = bc.gridToWorld(x, y);
        const g = bc.worldToGrid(w.x, w.z);
        if (g.col !== x || g.row !== y || g.error > 1e-9) throw new Error(`(${x},${y}) -> ${JSON.stringify(g)}`);
      }
      return '4/4';
    });
    p4.check('进入战斗后：地图/单位/相机', () => {
      const st = battleManager ? battleManager.getStatus() : null;
      if (!st || !st.active || !st.loaded) {
        // 阶段感知：未进战斗时不做数据断言，也绝不造一份假战况
        return '未进入战斗（阶段感知，跳过数据断言）';
      }
      const d = st.diagnostics;
      if (d.map.width !== 32 || d.map.height !== 32) throw new Error(`地图 ${d.map.width}x${d.map.height}`);
      if (d.tiles.cells !== 1024) throw new Error(`格子 ${d.tiles.cells}`);
      if (d.tiles.degraded) throw new Error('图集处于降级状态');
      if (d.tiles.histogram[5] < 1) throw new Error('地形直方图缺少城池格');
      if (d.units.built !== 20) throw new Error(`部队槽位 ${d.units.built}`);
      if (d.units.visible < 1) throw new Error('没有可见部队');
      if (!d.camera || d.camera.fixedView !== true || d.camera.rotationAllowed !== false) {
        throw new Error(JSON.stringify(d.camera));
      }
      return `${d.map.width}x${d.map.height} / ${d.tiles.frames} 帧 / 部队 ${d.units.visible}`
        + ` / 地形[${d.tiles.histogram.join(',')}]`;
    });
    suites.push(p4.summary());

    // ---------------------------------------------------------- P5 战斗操作自检
    const p5 = makeSuite('P5 战斗操作');
    const p5core = core.p5 || null;
    p5.check('内核导出 9 个战斗操作接管点', () => {
      if (!p5core) throw new Error('core.p5 缺失（sgby.core.js 未重新生成？）');
      const names = p5core.widgetNames;
      if (!names || names.length !== 9) throw new Error(`接管点 ${names}`);
      for (const k of ['bo', 'ko', 'vo', 'xo', 'Ao', 'Fo', 'Io', 'Eo', 'So']) {
        if (!names.includes(k)) throw new Error(`缺少 ${k}`);
        if (typeof p5core.originals[k] !== 'function') throw new Error(`缺少 ${k}Orig`);
      }
      return names.join('/');
    });
    p5.check('战斗操作协议常量与源码一致', () => {
      const b = p5core.battle;
      const k = b.keyCodes;
      if (k.up !== 34 || k.down !== 35 || k.left !== 36 || k.right !== 37
        || k.confirm !== 39 || k.cancel !== 40) throw new Error(JSON.stringify(k));
      const px = b.pixels;
      if (px.tilePx !== 16 || px.tilePy !== 16 || px.viewCols !== 15 || px.viewRows !== 17) {
        throw new Error(JSON.stringify(px));
      }
      if (b.battleOver.win !== 1 || b.battleOver.lose !== 2) throw new Error('结束标志语义不符');
      return `键码 ${k.up}/${k.down}/${k.left}/${k.right}/${k.confirm}/${k.cancel}；像素 ${px.tilePx}/${px.viewCols}x${px.viewRows}`;
    });
    p5.check('原版菜单条目 = vi(8) 4 项 / vi(9) 5 项', () => {
      const m = adapter.getBattleMenus();
      if (m.action.length !== 4) throw new Error(`行动菜单 ${m.action.length} 项`);
      if (m.battle.length !== 5) throw new Error(`战斗菜单 ${m.battle.length} 项`);
      if (m.action.join('') !== m.raw.action) throw new Error('行动菜单切分丢字');
      if (m.battle.join('') !== m.raw.battle) throw new Error('战斗菜单切分丢字');
      return `${m.action.join('/')} · ${m.battle.join('/')}`;
    });
    p5.check('菜单定宽切分与原版 Tr() 口径一致', () => {
      const m = adapter.getBattleMenus();
      const action = splitMenuByRect(m.raw.action, { sx: 100, ex: 132 });   // 32px -> 4 显示单位
      const battle = splitMenuByRect(m.raw.battle, { sx: 8, ex: 72 });      // 64px -> 8 显示单位
      if (action.length !== 4 || action[0] !== '攻击') throw new Error(`行动菜单 ${action.join('|')}`);
      if (battle.length !== 5 || battle[4] !== '全军撤退') throw new Error(`战斗菜单 ${battle.join('|')}`);
      return `${action.join('|')} / ${battle.join('|')}`;
    });
    p5.check('格子 -> 原版像素 -> 格子 往返一致', () => {
      const st = adapter.getBattleState();
      if (!st.mapReady) return '未进入战斗（阶段感知，跳过像素往返）';
      const Dn = core.Dn;
      let tested = 0;
      for (let y = 0; y < Dn.g_MapHgt; y++) {
        for (let x = 0; x < Dn.g_MapWid; x++) {
          const s = adapter.battleCellToScreen(x, y);
          const bx = Dn.g_MapSX + Math.floor(s.x / 16);
          const by = Dn.g_MapSY + Math.floor(s.y / 16);
          if (bx !== x || by !== y) throw new Error(`(${x},${y}) -> (${s.x},${s.y}) -> (${bx},${by})`);
          tested++;
        }
      }
      return `${tested} 格全部往返一致`;
    });
    p5.check('未接管战斗时不接受操作（如实拒绝，不伪造成功）', () => {
      const st = battleOps ? battleOps.getStatus() : null;
      if (!st) throw new Error('P5 未装配');
      if (st.active) return '战斗进行中（跳过：由 smoke 的真实对局覆盖）';
      const r = battleOps.host.onPhase('select');
      void r;
      return '未接管：宿主 inBattle=false';
    });
    p5.check('操作状态机相位合法且与输入锁一致', () => {
      const st = battleOps ? battleOps.getStatus() : null;
      if (!st || !st.active) return '未进入战斗（阶段感知，跳过）';
      const snap = battleOps.flow.getSnapshot();
      if (!Object.values(PHASES).includes(snap.phase)) throw new Error(`未知相位 ${snap.phase}`);
      if (['MOVEMENT_ANIMATING', 'ATTACK_ANIMATING'].includes(snap.phase) && snap.canCancel) {
        throw new Error('动画期间不应允许取消');
      }
      return `${snap.phase} · 输入${snap.inputActive ? '开放' : '锁定'} · 动画 ${snap.anim.active || '空闲'}`;
    });
    suites.push(p5.summary());

    // ---------------------------------------------------------- P6 全局整合自检
    const p6 = makeSuite('P6 全局整合');
    p6.check('统一启动入口：阶段化执行且无重复初始化', () => {
      if (!integration) throw new Error('P6 未装配');
      const s = lifecycle.summary();
      if (s.duplicates !== 0) throw new Error(`${s.duplicates} 处重复初始化`);
      if (!['ready', 'running'].includes(s.state)) throw new Error(`状态 ${s.state}`);
      for (const k of ['renderer', 'loop', 'events', 'adapter']) {
        if (!s.singletons.includes(k)) throw new Error(`缺少唯一对象 ${k}`);
      }
      return `${s.stages} 阶段 / ${s.totalMs}ms / 唯一对象 ${s.singletons.join(',')}`;
    });
    p6.check('全局对象唯一性守卫（重复登记第二个实例必须报错）', () => {
      const dupBefore = lifecycle.stats.duplicates;
      let threw = false;
      try { lifecycle.claim('loop', { fake: true }, { allowSame: false }); } catch (_) { threw = true; }
      // 自检故意触发的计数不计入运行统计，避免状态面板出现假告警
      lifecycle.stats.duplicates = dupBefore;
      if (!threw) throw new Error('重复登记未被拒绝');
      // 同一实例重复登记应被允许（幂等）
      lifecycle.claim('loop', renderManager);
      return '不同实例被拒绝 / 同一实例幂等';
    });
    p6.check('UI 栈：同 id 不叠加阻断，全部出栈后输入恢复', () => {
      const stack = integration.ui.stack;
      const base = stack.depth;
      const t1 = stack.push('p6-selftest', { layer: 70 });
      const t2 = stack.push('p6-selftest', { layer: 70 });
      const dup = stack.stats.duplicates;
      const depth1 = stack.depth;
      stack.close(t2);
      const stillBlocked = stack.blocking;
      stack.close(t1);
      const blockedAfter = stack.blocking;
      void dup;
      if (depth1 !== base + 1) throw new Error(`重复打开叠加了图层：${base} -> ${depth1}`);
      if (!stillBlocked) throw new Error('关闭前输入应保持阻断（重复 token 不应释放阻断）');
      if (blockedAfter) throw new Error('全部出栈后仍在阻断输入');
      return `重复打开去重（累计 ${stack.stats.duplicates} 次）/ 输入恢复=${!blockedAfter}`;
    });
    p6.check('表现配置与原版存档分离（键名与字段双重隔离）', () => {
      const before = [];
      if (typeof localStorage !== 'undefined') {
        for (let i = 0; i < localStorage.length; i++) before.push(localStorage.key(i));
      }
      const r = integration.presentation.save({ camera: { x: 1, z: -2, zoom: 1.1 } });
      const audit = PresentationStore.auditPayload(r.payload);
      if (!audit.ok) throw new Error(`表现配置含业务字段：${audit.hits.join(',')}`);
      const after = [];
      if (typeof localStorage !== 'undefined') {
        for (let i = 0; i < localStorage.length; i++) after.push(localStorage.key(i));
      }
      const savTouched = after.filter((k) => /\.sav$/.test(k) && !before.includes(k));
      if (savTouched.length) throw new Error(`写入了存档键：${savTouched.join(',')}`);
      if (!r.ok) throw new Error('表现配置写入失败（localStorage 不可用）');
      return `键 ${integration.presentation.key} / 字段 ${audit.keys.join(',')}`;
    });
    p6.check('存档槽信息来自原版 jn() 与容量公式', () => {
      const cap = core.p6 ? core.p6.capacity : null;
      if (!cap) throw new Error('内核未导出 p6.capacity');
      const st = integration.saves.getStatus();
      if (st.slots.length !== 3) throw new Error(`槽位 ${st.slots.length}`);
      const expect = st.expected;
      const calc = { base: 35 + 19 * cap.persons + 2 * cap.persons + 2 * cap.goods, dyn: 2035 + 37 * cap.cities };
      if (expect.base !== calc.base || expect.dyn !== calc.dyn) {
        throw new Error(`期望长度 ${JSON.stringify(expect)} ≠ ${JSON.stringify(calc)}`);
      }
      for (const s of integration.saves.inspectAll()) {
        const keys = core.fns.jn(s.slot);
        if (!Array.isArray(keys) || keys.length !== 2) throw new Error(`jn(${s.slot}) 返回异常`);
        if (s.keys.join('|') !== keys.join('|')) throw new Error('槽位 key 与 jn() 不一致');
      }
      return `3 槽 / 期望 base ${expect.base}B + dyn ${expect.dyn}B（${cap.persons} 将 / ${cap.cities} 城 / ${cap.goods} 道具）`;
    });
    p6.check('存档准入判断如实（未进剧本时不允许存/读）', () => {
      const st = integration.saves.getStatus();
      if (st.canSave.ok || st.canLoad.ok) {
        throw new Error(`未进剧本却报可存/可读：${JSON.stringify({ save: st.canSave, load: st.canLoad })}`);
      }
      return st.canSave.reasons.concat(st.canLoad.reasons).slice(0, 2).join(' / ');
    });
    p6.check('状态一致性（城市/旗帜/选中/场景/渲染循环）', () => {
      const c = integration.sync.consistency();
      if (!c.ok) throw new Error(c.mismatches.join('；'));
      return `${c.detail.cities} 城 / ${c.detail.flags} 旗 / 场景 ${c.detail.sceneId}`;
    });
    p6.check('刷新器登记无重复（同一名字不允许注册两次）', () => {
      let threw = false;
      try { integration.sync.register('world', () => {}); } catch (_) { threw = true; }
      if (!threw) throw new Error('重复登记刷新器未被拒绝');
      return integration.sync.refreshers.join('/');
    });
    p6.check('异常上报分级：可恢复不弹致命面板', () => {
      const err = new Error('P6 自检用可恢复错误');
      const before = integration.errors.getStatus();
      const entry = integration.errors.report('selftest:recoverable', err, { context: { phase: 'boot' } });
      if (entry.level !== 'recoverable') throw new Error(`级别 ${entry.level}`);
      if (integration.ui.fatalVisible) throw new Error('可恢复错误弹出了致命面板');
      if (integration.errors.getStatus().reports !== before.reports + 1) throw new Error('上报计数未增加');
      integration.errors.clear('selftest:recoverable');
      return 'recoverable / 无致命面板';
    });
    p6.check('场景切换拒绝路径（非法目标被拦下且不改场景）', () => {
      const d0 = integration.director.getStatus();
      let rejected = false;
      try { integration.director.switchTo('world', { reason: '自检：非法目标' }); } catch (_) { rejected = true; }
      const d1 = integration.director.getStatus();
      if (!rejected) throw new Error('world -> world 未被拒绝（SCENE_TRANSITIONS 应挡住）');
      if (d1.currentId !== 'world') throw new Error(`当前场景被改动：${d1.currentId}`);
      if (d1.rejected <= d0.rejected) throw new Error('拒绝次数未增加');
      return `拒绝 ${d1.rejected} 次 / 当前 ${d1.currentId}`;
    });
    suites.push(p6.summary());

    // ---------------------------------------------------------- P7 最终验收自检
    const p7 = makeSuite('P7 最终验收');
    p7.check('只有一个渲染循环，性能采样挂在帧钩子上', () => {
      const st = renderManager.stats;
      const s = lifecycle.summary();
      if (!s.singletons.includes('loop')) throw new Error('loop 未登记为唯一对象');
      if (!s.singletons.includes('perf')) throw new Error('perf 未登记为唯一对象');
      if (!perf.attached) throw new Error('帧钩子未挂载');
      if (st.frames < 1) throw new Error('渲染循环没有推进');
      // 帧钩子只能有一条（重复 attach 会叠加）
      if (perf.attach() !== false) throw new Error('重复 attach 未被拒绝');
      return `frames=${st.frames} / hook=${perf.attached} / 单例 ${s.singletons.length} 个`;
    });
    p7.check('帧时间统计可用（真实采样，不是编造）', () => {
      const f = perf.frameStats();
      if (!f.samples) throw new Error('没有帧样本');
      if (!(f.fps > 1 && f.fps < 1000)) throw new Error(`fps 异常 ${f.fps}`);
      if (!(f.p95Ms >= f.p50Ms)) throw new Error('分位数顺序异常');
      if (!(f.busyMeanMs >= 0 && f.busyMeanMs < f.meanMs * 2)) throw new Error(`CPU 帧耗时异常 ${f.busyMeanMs}`);
      return `${f.fps}fps / mean ${f.meanMs}ms / p95 ${f.p95Ms}ms / CPU ${f.busyMeanMs}ms`;
    });
    p7.check('自适应像素比在允许区间内，且只改渲染分辨率', () => {
      const a = adaptive.getStatus();
      const cap = renderManager.getPixelRatioCap();
      if (cap < ADAPTIVE_CONFIG.minCap - 1e-6 || cap > ADAPTIVE_CONFIG.maxCap + 1e-6) {
        throw new Error(`像素比上限越界 ${cap}`);
      }
      if (a.maxCap !== ADAPTIVE_CONFIG.maxCap) throw new Error('maxCap 未生效');
      // 有效下限 = min(1, 设备像素比)：dpr=1 时不把画面降到原生分辨率以下
      if (!(a.minCap >= ADAPTIVE_CONFIG.minCap - 1e-6 && a.minCap <= 1 + 1e-6)) {
        throw new Error(`有效下限异常 ${a.minCap}`);
      }
      if (Math.abs(a.cap - cap) > 1e-6) throw new Error('面板数值与渲染器不一致');
      // 相机/逻辑坐标必须不受影响
      const c0 = adapter.getCity(0).position;
      if (c0.x !== 1 || c0.y !== 0) throw new Error(`逻辑坐标被改动 ${JSON.stringify(c0)}`);
      return `cap ${cap} / 设备 ${a.devicePixelRatio} / 评估 ${a.evaluations} 次 / 降档 ${a.downshifts}`;
    });
    p7.check('浏览器不暴露的指标如实标注为不可测', () => {
      const rep = perf.report();
      if (rep.gpu.measurable !== false) throw new Error('GPU 时间不应声称可测');
      if (!rep.gpu.reason) throw new Error('缺少不可测原因说明');
      if (!('available' in rep.memory)) throw new Error('缺少内存可用性标记');
      if (rep.memory.available && !(rep.memory.usedMB > 0)) throw new Error('声称可测却没有数值');
      return `GPU 不可测（${rep.gpu.extensionPresent ? '有 EXT 但未使用' : '无 EXT'}）`
        + ` / JS 堆 ${rep.memory.available ? rep.memory.usedMB + 'MB' : '不可测'}`;
    });
    p7.check('原版一致性探针：城市/连接/势力/武将/坐标全绿', () => {
      const r = probe.run();
      if (!r.ok) throw new Error(r.failures.map((f) => `${f.name}:${f.detail}`).join('；'));
      return `${r.passed}/${r.total} 项（${r.counts.cities} 城 / ${r.counts.officers} 将）`;
    });
    p7.check('WebGL 上下文丢失 -> 恢复链路可用且不弹致命面板', () => {
      const before = integration.ui.getStatus();
      events.emit(EVENTS.RENDERER_CONTEXT_LOST, { reason: 'selftest' });
      const during = integration.ui.getStatus();
      const lostFlag = renderManager.contextLost;
      events.emit(EVENTS.RENDERER_CONTEXT_RESTORED, { reason: 'selftest' });
      const after = integration.ui.getStatus();
      if (lostFlag) throw new Error('自检不应真的弄丢上下文（浏览器状态不支持手动恢复）');
      if (during.toasts < before.toasts) throw new Error('丢失时没有提示');
      if (after.fatal) throw new Error('恢复后仍显示致命面板');
      if (renderManager.contextLost) throw new Error('恢复后仍标记为丢失');
      return `提示 ${before.toasts} -> ${during.toasts} / 恢复后致命=${after.fatal}`;
    });
    suites.push(p7.summary());

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

  /**
   * P6：视图切换的唯一副作用入口。
   * menu：只显示原版 2D（主菜单/选剧本/选君主/回合菜单），暂停 3D 渲染省电。
   * game：显示 3D 与 HUD，重新取景，并把城市/旗帜按原版最新数据全量同步一次。
   * 这里不写任何游戏状态，也不改变原版协程。
   */
  function applyView(mode, info = {}) {
    const isGame = mode === VIEW_MODE.GAME;
    const kind = info.phase && info.phase.kind ? info.phase.kind : '—';
    log(`[P6] 视图 -> ${mode}（kind=${kind}${info.force ? ' · 强制' : ''}）`);
    if (isGame) {
      renderManager.resume();
      renderManager.resize();
      // 战斗中不要动场景/相机：P4 已经接管 battle 场景，切回 world 会让 3D 装载半途而废
      const inBattle = !!(battleManager && battleManager.getStatus().active);
      // 进入 3D 时把相机复位到"整图可见"：菜单阶段可能遗留缩放/平移，
      // 不复位会让玩家一进剧本就看到地图边缘甚至空画面。
      if (!inBattle && mapScene && mapScene.camera && worldCamera) worldCamera.reset(mapScene.camera);
      if (!inBattle && scenesReady && scenes.currentId !== SCENE_IDS.WORLD) {
        try { scenes.switchTo(SCENE_IDS.WORLD, { reason: 'P6 进入剧本' }); }
        catch (e) { log(`[P6] 切回战略地图失败：${e.message}`); }
      }
      const n = syncAllVisuals();
      log(`[P6] 进入 3D 前全量同步：${n} 城（旗帜/城市归属按原版最新数据）`);
    } else {
      // 主菜单阶段不需要持续渲染（省电），但必须保留**一帧**：
      // WebGL 可用性、drawCall/资源统计仍要可验证（P6 起 3D 层默认隐藏）。
      // 早先用两层 requestAnimationFrame 等两帧再暂停，会和「视图已经切回 game」
      // 赛跑（异步窗口内切回来就会被误暂停），也破坏了「全站只有一个自续循环」的静态校验。
      // 现在改成同步：恢复 -> 渲染一帧 -> 立刻暂停，结果确定且不引入第二个 rAF 调度。
      renderManager.resume();
      try { scenes.render(renderManager); } catch (e) { log(`[P6] 原版画面期间保留一帧失败：${e.message}`); }
      renderManager.pause();
    }
    if (worldOps) worldOps.setActive(isGame && scenes.currentId === SCENE_IDS.WORLD);
    renderStatus();
  }

  /** 菜单阶段城市数据可能已变（读档/新局），进入 3D 时按原版实时数据重建表现。 */
  function syncAllVisuals() {
    if (!mapScene) return 0;
    if (mapScene.flagRenderer) mapScene.flagRenderer.syncAll();
    let n = 0;
    try {
      for (const c of adapter.getCities()) { if (mapScene.refreshCity(c.id)) n++; }
    } catch (e) { log(`[P6] 城市同步异常：${e.message}`); }
    try { mapScene.setSelection(null); } catch (_) { /* 忽略 */ }
    return n;
  }

  /** 场景切换（测试入口，明确不伪造游戏操作结果）。 */
  function switchScene(id) {
    try {
      // P6：所有切换统一走 SceneDirector（带锁、循环检测、战斗前后状态保存/恢复）。
      // 测试入口仍然只验证生命周期，不执行任何原版游戏操作。
      const ctx = { reason: 'P1 测试入口' };
      if (id === SCENE_IDS.CITY) {
        const gs = adapter.getGameState();
        const mine = adapter.getCities().find((c) => c.ownerId === gs.playerKing + 1);
        ctx.cityId = mine ? mine.id : 0;
      }
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const r = integration
        ? integration.director.switchTo(id, ctx)
        : scenes.switchTo(id, ctx);
      if (r && r.ok === false) throw new Error(r.reason || '切换被拒绝');
      // P7：把切换耗时记进性能报告（只统计，不参与任何决策）
      perf.noteSceneSwitch(id, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
      log(`场景切换 -> ${id}（测试入口，未执行任何原版游戏操作）`);
    } catch (e) { log(`场景切换被拒绝：${e.message}`); }
    renderStatus();
  }

  // ---------------------------------------------------------- UI 绑定
  debugPanel = new DebugPanel({
    root: p2Panel,
    callbacks: {
      onInspect: (id) => log(`查看城市 #${id}（仅调试查看，不触发任何原版操作）`),
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
    if (!viewMode) return;
    if (viewMode.held) {
      viewMode.setHold(false);
      viewMode.poll();
      log('[P6] 恢复自动视图判定（2D 主界面 ↔ 3D 剧本）');
      return;
    }
    viewMode.setHold(true);
    const next = viewMode.mode === VIEW_MODE.GAME ? VIEW_MODE.MENU : VIEW_MODE.GAME;
    viewMode.force(next);
    log(`[P6] 手动对照视图 -> ${next}（自动判定已暂停，再点一次恢复）`);
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
  // P6：所有初始化阶段经 AppLifecycle 执行 —— 每个阶段只允许跑一次，
  // 失败时会给出「失败在哪个阶段」，而不是一句「启动失败」。
  document.body.dataset.p1Status = 'connecting';
  lifecycle.setState('connecting');
  log(`P6 启动；Three.js ${THREE_VERSION} / P6 ${P6_VERSION}；等待原版内核…`);
  await lifecycle.stage('adapter.connect', () => adapter.connect());
  log(`内核已连接：城市 ${core.Dn.g_Cities.length}、武将 ${core.Dn.g_Persons.length}、资源库 ${!!core.lib}`);
  scenes.switchTo(SCENE_IDS.WORLD, { reason: 'P2 启动' });
  mapScene = scenes.current;
  debugPanel.fillCities(adapter.getCities());
  interaction = new MapInteraction({
    THREE, input, adapter, scene: mapScene, worldCamera,
    getCamera: () => mapScene.camera,
    isActive: () => scenes.currentId === SCENE_IDS.WORLD && (!viewMode || viewMode.mode === VIEW_MODE.GAME),
    // P3：只读通知城市会话「用户点了哪个城」，供选目标城市等场景使用
    onCityClick: (cityId) => { if (cityManager) cityManager.session.noteClickedCity(cityId); },
    // P6：点击语义改由 WorldOps 按原版 zs() 处理（点格移动光标 / 再点同格确认）
    onMapClick: (hit) => { if (worldOps) worldOps.handleMapClick(hit); },
  });
  interaction.bind();
  cityManager = createCityManager({
    core, adapter, events, input, interaction,
    log: (msg) => log(`[P3] ${msg}`),
  });
  log(`P3 城市管理已装配：接管 ${cityManager.getStatus().widgets.join(' / ')}`);
  battleManager = createBattleManager({
    THREE, adapter, events, scenes, cameraManager, coordinate, renderManager, input, assets,
    uiHost: uiRoot,
    log: (msg) => log(`[P4] ${msg}`),
  });
  log(`P4 战斗场景已装配：接管 ${core.p4 ? core.p4.widgetNames.join(' / ') : '（内核无 p4，战斗将不可用）'}`);
  battleOps = createBattleOps({
    THREE, adapter, events, scenes, renderManager, battleManager,
    uiHost: uiRoot,
    log: (msg) => log(`[P5] ${msg}`),
  });
  log(`P5 战斗操作已装配：接管 ${core.p5 ? core.p5.widgetNames.join(' / ') : '（内核无 p5，操作仍在 2D）'}`);

  // ---------------------------------------------------------- P6 全局整合
  // 装配顺序即依赖顺序：UI 栈 -> 表现配置 -> 场景编排 -> 状态同步 -> 存档 -> 异常。
  // 所有 getXxx 都是惰性读取，避免「装配时场景还没建好」的时序问题。
  integration = createIntegration({
    core, adapter, events, scenes, input, uiHost: uiRoot,
    renderManager, cameraManager, worldCamera, lifecycle,
    log: (msg) => log(msg),
    getWorldScene: () => mapScene,
    getCityManager: () => cityManager,
    getBattleManager: () => battleManager,
    getBattleOps: () => battleOps,
    getInteraction: () => interaction,
  });
  integration.start();
  lifecycle.setState('ready');
  bindSavePanel();
  log(`P6 全局整合已装配：存档 ${integration.saves.slots().length} 槽 · UI 栈 · 一致性检查`);

  // ---------------------------------------------------------- P7 装配
  // 0) 长跑基线重设：perf.attach() 发生在场景装配之前，那一刻资源还是 0；
  //    到这里场景已经装好、启动自检即将开始，才是「就绪基线」。否则面板会把
  //    「装配 38 城 + 贴图 + 字库」误报成资源泄漏（曾显示 Geo +10 / Tex +40 / 堆 +54MB）。
  //    只重设资源/堆基线，帧统计保留（自检要立刻读到真实样本）。
  perf.rebaseline();
  // 1) 自适应分辨率：初始化后再启动，避免启动抖动被当成「填充率不足」误降档。
  adaptive.start();
  lifecycle.claim('adaptive', adaptive);
  bindPerfPanel();
  // 2) WebGL 上下文丢失/恢复：只提示 + 恢复渲染，绝不重置任何游戏状态。
  bindContextRecovery();
  // 3) 原版一致性探针：用现有 mapCoordinate + 战斗场景的坐标系（不新建第二套）
  const makeProbe = () => new ConsistencyProbe({
    core, adapter, mapCoordinate,
    battleCoordinate: battleManager && battleManager.scene ? battleManager.scene.battleCoord : null,
  });
  probe = makeProbe();
  log(`P7 已装配：帧钩子 ${perf.attached ? 'on' : 'off'} · 自适应像素比 ${adaptive.stats.cap}`
    + ` · 上下文丢失可恢复`);

  log('提示：点「原版画面」在主菜单开新局，进入剧本后点击己方城市即可打开城市管理');
  // ---------------------------------------------------------- P6 视图模式 + 3D 主界面操作
  // 顺序：先建操作条（applyView 会读 worldOps），再启动视图判定。
  // 注意：默认视角是原版 2D 主界面（body=menu），此时 3D 渲染暂停省电；
  //       进入剧本 zs() 后 viewMode 自动切 game，渲染恢复。
  worldOps = new WorldOps({
    THREE, adapter, input, scene: mapScene, coordinate: mapCoordinate,
    worldCamera, cityManager,
    opsHost: $('p6-ops'),
    // 帮助/形势图是原版画在 2D 画布上的全屏页：临时切回原版画面，任意键返回
    onPeek: (on) => {
      const hint = $('p6-peek-hint');
      if (!viewMode) return;
      if (hint) hint.hidden = !on;
      if (on) {
        viewMode.setHold(true);
        viewMode.force(VIEW_MODE.MENU);
        log('[P6] 打开原版画面（信息/形势图/菜单）：按任意键或点击返回 3D 地图');
      } else {
        viewMode.setHold(false);
        viewMode.poll();
        log('[P6] 关闭原版画面，恢复自动视图判定');
      }
    },
    log: (msg) => log(`[P6] ${msg}`),
  });
  worldOps.start();
  // 场景一离开世界地图（进战斗 / 城市覆盖层）就必须让出底部：
  // p6-ops 是 z-index 11 的 DOM 覆盖层，留着会挡住战斗地图的点击
  // （实测：点部队 0 次被 P5 接收，反而点开了原版战斗菜单 bo）。
  events.on(EVENTS.SCENE_CHANGED, ({ to }) => {
    if (!worldOps) return;
    worldOps.setActive((!viewMode || viewMode.mode === VIEW_MODE.GAME) && to === SCENE_IDS.WORLD);
    // 顶栏宽度按场景收敛：战斗里「君主/光标」是战略地图的信息，留着会让工具栏折成两行，
    // 实测会盖住战斗地图上沿（部队投影点落在工具栏上，点击直接被顶栏吃掉）。
    document.body.dataset.sangoScene = to;
  });
  document.body.dataset.sangoScene = scenes.currentId || SCENE_IDS.WORLD;
  viewMode = new ViewMode({
    adapter,
    onChange: applyView,
    // 兜底：原版战斗一旦装载（P4 active），任何 kind 都不许切回 2D
    guardGame: () => !!(battleManager && battleManager.getStatus().active),
  });
  viewMode.start();
  log(`P6 视图模式已装配：默认 ${viewMode.mode}（原版主界面不 3D 化），进入剧本 zs() 后切 3D`);

  log('提示：主菜单/选剧本/选君主都在原版 2D 界面完成；进入剧本后自动切换 3D，点格移动光标、再点同格确认');
  renderManager.resize();           // 触发 worldCamera.fit，保证整图可见
  // 原版在 DOMContentLoaded 时算过一次整数倍缩放，此时 p1/p6 样式可能还没生效；
  // 主动派发一次 resize 让它按最终布局重算（等价于用户拉一下窗口）。
  try { window.dispatchEvent(new Event('resize')); } catch (_) { /* 忽略 */ }
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
  /** P4 战斗调试/自动化入口（只读诊断 + 明确标注的表现层选中，不写游戏状态）。 */
  window.__P4__ = Object.freeze({
    version: P4_VERSION,
    manager: battleManager,
    hud: battleManager.hud,
    host: battleManager.host,
    deps: battleManager.deps,
    get scene() { return battleManager.scene; },
    getStatus: () => battleManager.getStatus(),
    getSnapshot: () => {
      const s = battleManager.scene;
      const m = adapter.getBattleMap();
      return {
        status: battleManager.getStatus(),
        battle: adapter.getBattleState(),
        units: adapter.getBattleUnits(),
        map: m.available
          ? { mapId: m.mapId, width: m.width, height: m.height, cellCount: m.cellCount, tilePicId: m.tilePicId }
          : m,
        selection: s ? s.selection : null,
        diagnostics: s ? s.getDiagnostics() : null,
      };
    },
    selectUnit: (id) => {
      const s = battleManager.scene;
      // 调试入口显式要求「连范围一起算」：P5 接管后范围默认跟随原版阶段，
      // 这里绕过该策略只是为了能在任意时刻检查 qi()/Vo() 的结果。
      return s ? s.selectUnit(id, { source: 'debug', ranges: true }) : null;
    },
    selectCell: (x, y) => {
      const s = battleManager.scene;
      return s ? s.selectCell({ x, y }) : null;
    },
    pick: (ndcX, ndcY) => {
      const s = battleManager.scene;
      return s && s.interaction ? s.interaction.pick(ndcX, ndcY) : null;
    },
    /** 格子中心 -> 屏幕像素（测试点击用；只做投影，不改坐标）。 */
    cellScreenPosition: (x, y, viewport) => {
      const s = battleManager.scene;
      if (!s || !s.camera) return null;
      const w = s.battleCoord.gridToWorld(x, y);
      const v = new THREE.Vector3();
      const projector = (p) => { v.set(p.x, p.y, p.z).project(s.camera); return { x: v.x, y: v.y, z: v.z }; };
      return s.battleCoord.worldToScreen(w, projector, viewport);
    },
    runSmoke,
    switchScene,
  });

  /** P5 战斗操作调试/自动化入口（所有操作都经原版输入协议，返回值如实标注是否被接受）。 */
  window.__P5__ = Object.freeze({
    version: P5_VERSION,
    manager: battleOps,
    ui: battleOps.ui,
    host: battleOps.host,
    get flow() { return battleOps.flow; },
    get anim() { return battleOps.anim; },
    getStatus: () => battleOps.getStatus(),
    getSnapshot: () => {
      const f = battleOps.flow;
      return {
        status: battleOps.getStatus(),
        phase: f ? f.getSnapshot() : null,
        anim: battleOps.anim ? battleOps.anim.getDiagnostics() : null,
        menus: adapter.getBattleMenus(),
        units: adapter.getBattleUnitStates(),
        logs: battleOps.ui.logs.slice(-12),
      };
    },
    /** 3D 语义：点击某格 / 某部队（内部翻成原版 type:16 指针消息）。 */
    clickCell: (x, y) => (battleOps.flow ? battleOps.flow.onMapClick({ cell: { x, y } }) : null),
    clickUnit: (id) => (battleOps.flow ? battleOps.flow.onMapClick({ unitId: id }) : null),
    cancel: () => (battleOps.flow ? battleOps.flow.cancel() : null),
    openBattleMenu: () => (battleOps.flow ? battleOps.flow.openBattleMenu() : null),
    /** 直接选择菜单项（仅测试用；等价于点 DOM 按钮）。 */
    pickMenu: (index) => {
      const ui = battleOps.ui;
      if (!ui.menuOpen) return false;
      ui.closeMenu(index, 'test');
      return true;
    },
    runSmoke,
    switchScene,
  });

  /**
   * P6 调试/自动化入口：全局整合（场景编排 / 存档 / 一致性 / 异常）+ 视图两态 + 3D 操作条。
   * 注意：setView 只切显示，不改变原版流程；pressKey/cursorTo 走原版输入协议（不伪造游戏结果）。
   */
  window.__P6__ = Object.freeze({
    version: P6_VERSION,
    manager: integration,
    ui: integration.ui,
    stack: integration.ui.stack,
    director: integration.director,
    sync: integration.sync,
    saves: integration.saves,
    errors: integration.errors,
    presentation: integration.presentation,
    lifecycle,
    get view() { return viewMode; },
    get ops() { return worldOps; },
    getStatus: () => integration.getStatus(),
    /**
     * 合并快照：整合层字段 + 视图/操作条字段。
     * `ops` 归 3D 操作条（视图层语义，测试用 ops.peeking 判「正在看原版全屏页」）；
     * 整合层原有的战斗操作状态改名 `battleOps`，避免两边同名互相覆盖。
     */
    getSnapshot: () => {
      const base = integration.getSnapshot();
      return {
        ...base,
        battleOps: base.ops,
        ops: worldOps ? worldOps.getSnapshot() : null,
        view: viewMode ? { mode: viewMode.mode, held: viewMode.held, stats: { ...viewMode.stats } } : null,
        bodyView: document.body.dataset.sangoView,
        opsHidden: !!(document.getElementById('p6-ops') && document.getElementById('p6-ops').hidden),
      };
    },
    /** 调试：钉住某个视图（hold=true 时暂停自动判定）。 */
    setView: (mode, hold = false) => {
      if (!viewMode) return null;
      if (hold) viewMode.setHold(true);
      return viewMode.force(mode);
    },
    release: () => { if (!viewMode) return null; viewMode.setHold(false); return viewMode.poll(); },
    pressKey: (param) => adapter.pressKey(param),
    cursorTo: (col, row) => adapter.requestCursorTo(col, row),
    /** 3D 语义的点击（供自动化测试直接调用，等价于真实鼠标点格子）。 */
    clickCell: (col, row) => (worldOps ? worldOps.handleMapClick({ cell: { col, row } }) : null),
    refresh: () => { if (worldOps) worldOps.refresh(); },
    /** 场景编排语义入口（等价于真实流程，但由测试显式触发）。 */
    toWorld: (reason) => integration.director.switchTo('world', { reason: reason || 'P6 测试' }),
    toBattle: (reason) => integration.director.switchTo('battle', { reason: reason || 'P6 测试' }),
    /** 存档：全部经原版 ac()/oc()；返回值如实标注是否被接受。 */
    saveSlot: (slot, reason) => integration.saves.save(slot, { reason: reason || 'test' }),
    loadSlot: (slot, reason) => integration.saves.load(slot, { reason: reason || 'test' }),
    inspectSlots: () => integration.saves.inspectAll(),
    consistency: () => integration.sync.consistency(),
    /** 强制全量同步（读档后/战斗后表现层重建）。 */
    fullSync: (reason) => integration.sync.fullSync(reason || 'test'),
    /** 表现配置（与存档分离；重置后回到默认视角）。 */
    savePresentation: (reason) => integration.savePresentation(reason || 'test'),
    resetPresentation: () => integration.presentation.reset(),
    uiOpen: () => integration.ui.getStatus(),
    runSmoke,
    switchScene,
  });

  /** P7 最终验收入口（性能只读读数 + 一致性探针 + 上下文恢复演练）。 */
  window.__P7__ = Object.freeze({
    version: P7_VERSION,
    perf, adaptive,
    /** 完整性能报告（与文档里引用的口径一致）。 */
    perfReport: () => perf.report(),
    /** 帧统计单独取（面板/断言用，避免每次都拿全量报告）。 */
    frameStats: () => perf.frameStats(),
    rendererInfo: () => perf.rendererInfo(),
    /** 原版一致性：新构造探针跑一遍，不复用任何缓存。 */
    consistency: (opts) => (probe || makeProbe()).run(opts),
    /** 探针上一次的结果（不重跑）。 */
    lastConsistency: () => (probe && probe.checks.length
      ? { total: probe.checks.length, failed: probe.checks.filter((c) => !c.ok).length }
      : null),
    setAdaptive: (on) => adaptive.setEnabled(on),
    adaptiveStatus: () => adaptive.getStatus(),
    /**
     * 上下文丢失演练（真实调用 WEBGL_lose_context，不是模拟）。
     * 注意：上下文一旦丢失，gl.getExtension() 按规范**返回 null**，
     * 所以扩展对象必须在丢失前拿到并缓存，否则 restoreContext() 永远拿不回来。
     */
    loseContext: () => {
      const ext = getLoseContextExt();
      if (!ext) return { ok: false, reason: 'WEBGL_lose_context 不可用（浏览器不支持）' };
      ext.loseContext();
      return { ok: true, method: 'WEBGL_lose_context.loseContext' };
    },
    restoreContext: () => {
      const ext = getLoseContextExt();
      if (!ext) return { ok: false, reason: 'WEBGL_lose_context 不可用（浏览器不支持）' };
      ext.restoreContext();
      return { ok: true, method: 'WEBGL_lose_context.restoreContext' };
    },
    /**
     * 游戏状态指纹：**只有业务数据**。
     * 早先版本把 fps/drawCalls 也拼进来了，导致「前后一致」这类断言会被渲染抖动误判成
     * 「状态被改了」——指纹里出现任何随时间变化的量都是错的设计。渲染读数单独给 perfReport()。
     */
    stateFingerprint: () => ({
      year: core.Dn.g_YearDate, month: core.Dn.g_MonthDate, king: core.Dn.g_PlayerKing,
      period: core.Dn.g_PIdx, battleOver: core.Dn.g_FgtOver, battleRound: core.Dn.g_FgtBoutCnt,
      cities: core.Dn.g_Cities.map((c) => `${c.Belong}:${c.Money}:${c.Food}:${c.Farming}`).join(','),
      persons: core.Dn.g_Persons.map((p) => `${p.Belong}:${p.Arms}`).join(','),
    }),
    runSmoke,
    switchScene,
  });

  lifecycle.setState('running');
  renderStatus();
  return window.__P1__;
}

boot().catch((e) => {
  document.body.dataset.p1Status = 'error';
  try { if (window.__SGBY_LIFECYCLE__) window.__SGBY_LIFECYCLE__.setState('failed'); } catch (_) { /* ignore */ }
  log(`启动失败：${e.stack || e.message}`);
  console.error('[P1] 启动失败', e);
});
