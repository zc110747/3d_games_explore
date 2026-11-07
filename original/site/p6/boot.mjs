/**
 * P6 装配入口 —— 全局整合：统一 UI / 场景编排 / 状态同步 / 存档 / 异常。
 *
 * 装配顺序（依赖方向决定）：
 *   AppLifecycle（已由 main 使用）
 *     -> UIManager + UIStack（弹窗与输入阻断的唯一出口）
 *     -> PresentationStore（3D 表现配置，独立于存档）
 *     -> SceneDirector（场景切换唯一入口）
 *     -> StateSync（刷新器登记 + 一致性检查）
 *     -> ErrorHub（异常上报 / 恢复动作）
 *     -> SaveManager（原版 ac/oc 的封装）
 *
 * 本模块只做「接线 + 决策」，不含任何游戏规则：
 * 战斗/城市/回合的判定依然全部在原版协程里。
 */

import { P6_VERSION, RUNTIME } from './config.mjs';
import { UIManager } from './UIManager.mjs';
import { PresentationStore } from './PresentationStore.mjs';
import { SceneDirector } from './SceneDirector.mjs';
import { StateSync } from './StateSync.mjs';
import { SaveManager } from './SaveManager.mjs';
import { ErrorHub } from './ErrorHub.mjs';
import { EVENTS } from '../p1/core/EventManager.mjs';

export function createIntegration({
  core, adapter, events, scenes, input, uiHost = null,
  renderManager = null, cameraManager = null, worldCamera = null,
  lifecycle = null, log = () => {},
  getWorldScene = () => null, getCityManager = () => null,
  getBattleManager = () => null, getBattleOps = () => null,
  getInteraction = () => null, onPresentation = null,
}) {
  if (!core || !adapter || !events || !scenes) throw new TypeError('createIntegration 依赖不完整');

  const ui = new UIManager({ host: uiHost, input, log: (m) => log(`[P6] ${m}`) });
  ui.mount();

  const presentation = new PresentationStore({ log: (m) => log(`[P6] ${m}`) });

  const director = new SceneDirector({
    scenes, adapter, events,
    uiStack: ui.stack, presentation,
    getWorldScene, getCamera: () => (getWorldScene() || {}).camera || null,
    cameraManager, worldCamera,
    getCitySession: () => (getCityManager() ? getCityManager().session : null),
    log: (m) => log(`[P6] ${m}`),
  });

  const sync = new StateSync({
    adapter, events,
    getWorldScene, getCityManager, getBattleManager, getRenderManager: () => renderManager,
    getScenes: () => scenes, getCameraManager: () => cameraManager,
    log: (m) => log(`[P6] ${m}`),
  });

  const errors = new ErrorHub({ ui, log: (m) => log(`[P6] ${m}`) });

  const saves = new SaveManager({
    core, adapter, events, ui,
    onAfterLoad: (info) => director.afterLoad(info),
    isBattleActive: () => {
      const b = getBattleManager();
      return !!(b && b.getStatus().active);
    },
    log: (m) => log(`[P6] ${m}`),
  });

  // ------------------------------------------------------------ 刷新器登记
  // 顺序固定：数据 -> 世界表现 -> 城市面板 -> 战斗 HUD。任一失败只影响自己。
  sync.register('world', () => director.resyncWorld('state'));
  sync.register('cityPanel', () => {
    const cm = getCityManager();
    if (!cm || !cm.ui.isOpen) return;
    try { cm.ui.refresh(); } catch (e) { log(`[P6] 城市面板刷新失败：${e.message}`); }
  });
  sync.register('battleHud', () => {
    const bm = getBattleManager();
    const scene = bm && bm.scene;
    if (!scene || !scene.lastLoad || !scene.lastLoad.ok) return;
    scene.refreshHUD('p6-sync');
  });
  sync.register('presentation', () => savePresentation('state'));

  // ------------------------------------------------------------ 事件订阅
  const offs = [];
  offs.push(events.on(EVENTS.SCENE_CHANGED, ({ from, to, context }) => {
    director.noteSceneChange(from, to, (context && context.reason) || '');
    applySceneUi(to);
    if (to === 'world') savePresentation('scene');
  }));

  // 状态变化只打脏标，由低频批处理统一 flush（不在渲染循环里读游戏数据）
  offs.push(events.on(EVENTS.GAME_STATE_UPDATED, () => scheduleFlush('state')));
  offs.push(events.on(EVENTS.CITY_OWNER_CHANGED, () => scheduleFlush('owner')));
  offs.push(events.on(EVENTS.CITY_UPDATED, () => scheduleFlush('city')));
  offs.push(events.on(EVENTS.TURN_CHANGED, () => {
    scheduleFlush('turn');
    savePresentation('turn');
  }));

  // 战斗结束：P4 已把场景切回 world；这里做全量重建（城市归属可能已变）
  offs.push(events.on(EVENTS.BATTLE_FINISHED, () => {
    const bm = getBattleManager();
    if (bm && bm.getStatus().active) return;      // 原版仍在收尾，等 P4 的 exit
    if (scenes.currentId !== 'world') return;
    try {
      const r = director.resyncWorld('战斗结束(事件)');
      log(`[P6] 战斗结束重建：城市 ${r.cities} 座 / 旗帜 ${r.flags} 面`);
    } catch (e) {
      errors.report('battle:afterExit', e, { context: { scene: scenes.currentId } });
    }
  }));

  // ------------------------------------------------------------ 低频批处理
  let flushTimer = null;
  let pendingFlush = null;
  function scheduleFlush(source) {
    if (pendingFlush) return;
    pendingFlush = source;
    if (flushTimer) return;
    const run = () => {
      flushTimer = null;
      const why = pendingFlush;
      pendingFlush = null;
      sync.flush(`event:${why}`).catch((e) => errors.report('sync:flush', e));
    };
    // 用 setTimeout 合并同一帧内的多条事件（不是轮询：没有变化就不会有后续调用）
    flushTimer = setTimeout(run, 16);
  }

  // ------------------------------------------------------------ 覆盖层跟踪
  // P3 的城市界面由原版 ka()/ei() 驱动，没有对外事件；这里低频比对开关状态，
  // 只登记「何时开着」以便场景切换与读档时正确收起，不参与任何业务判断。
  let lastCityOpen = false;
  let lastCityId = null;
  let watchTimer = null;
  function watchCityOverlay() {
    const cm = getCityManager();
    if (!cm) return;
    const st = cm.getStatus();
    if (st.open && (!lastCityOpen || st.cityId !== lastCityId)) {
      lastCityOpen = true;
      lastCityId = st.cityId;
      director.openCityOverlay(st.cityId);
    } else if (!st.open && lastCityOpen) {
      lastCityOpen = false;
      director.closeCityOverlay('原版 ei() 结束');
      savePresentation('city');
    }
  }

  // ------------------------------------------------------------ 表现配置
  /** 把当前相机/面板状态写进表现配置（与存档无关，随时可失败）。 */
  function savePresentation(reason = 'auto') {
    if (typeof document === 'undefined') return { ok: false, reason: 'no-dom' };
    const scene = getWorldScene();
    const cam = (scene && scene.camera) || null;
    const cs = cam && cameraManager ? cameraManager.getState(cam) : null;
    const panelState = {
      p1Panel: !!(document.getElementById('p1-panel') && !document.getElementById('p1-panel').classList.contains('hidden')),
      p2Panel: !!(document.getElementById('p2-panel') && !document.getElementById('p2-panel').classList.contains('hidden')),
      legacy: !!(document.getElementById('p1-legacy') && !document.getElementById('p1-legacy').classList.contains('hidden')),
    };
    const r = presentation.save({
      camera: cs ? { x: cs.target[0], z: cs.target[2], zoom: cs.zoom } : null,
      ui: panelState,
      selection: scene && Number.isInteger(scene.selection) ? scene.selection : null,
    });
    if (!r.ok && reason !== 'state') log('[P6] 表现配置写入失败（不影响游戏）');
    return r;
  }

  /** 开局把上次的表现配置应用回来（只动相机与面板，不动任何游戏数据）。 */
  function applyPresentation() {
    const data = presentation.load();
    const scene = getWorldScene();
    if (scene && scene.camera && data.camera && cameraManager) {
      cameraManager.setView(scene.camera, {
        target: [data.camera.x, 0, data.camera.z], zoom: data.camera.zoom,
      });
    }
    if (typeof document !== 'undefined') {
      const toggle = (id, want) => {
        const node = document.getElementById(id);
        if (!node) return;
        node.classList.toggle('hidden', !want);
      };
      toggle('p1-panel', data.ui.p1Panel);
      toggle('p2-panel', data.ui.p2Panel);
      toggle('p1-legacy', data.ui.legacy);
    }
    if (typeof onPresentation === 'function') onPresentation(data);
    return data;
  }

  /** 各阶段的全局 UI 显隐（只处理 P6 自己的层；P2/P3/P4/P5 各自的显隐仍由它们负责）。 */
  function applySceneUi(sceneId) {
    if (sceneId !== 'battle') ui.dismissAll(`切换到 ${sceneId}`);
    const hint = document.getElementById('p6-hint');
    if (hint) {
      hint.textContent = sceneId === 'battle'
        ? '战斗场景 · 操作条在左侧 · 空格/Esc 由原版输入协议解释'
        : '战略地图 · 点击城市进入管理 · 「存档」面板使用原版 ac()/oc()';
    }
  }

  // ------------------------------------------------------------ 生命周期
  function start() {
    sync.attach();
    sync.captureBaseline();
    // 统一由 AppLifecycle 登记计时器，dispose 时一定被清掉（避免场景反复切换后残留）
    watchTimer = lifecycle && typeof lifecycle.interval === 'function'
      ? lifecycle.interval(watchCityOverlay, RUNTIME.diagnosticsIntervalMs, 'p6-city-watch')
      : setInterval(watchCityOverlay, RUNTIME.diagnosticsIntervalMs);
    applyPresentation();
    applySceneUi(scenes.currentId || 'world');
    log(`[P6] 全局整合已装配：UI 栈 + 场景编排 + 状态同步 + 存档（${saves.slots().length} 槽）`);
    return api;
  }

  // ------------------------------------------------------------ 恢复动作
  errors.registerRecovery('world', () => {
    ui.dismissAll('错误恢复');
    const r = scenes.currentId === 'world'
      ? { ok: true, already: true }
      : director.switchTo('world', { reason: '错误恢复' });
    const resync = director.resyncWorld('错误恢复');
    return { scene: r, resync };
  });
  errors.registerRecovery('reload', () => {
    if (typeof location !== 'undefined' && location.reload) location.reload();
    return { reloaded: true };
  });
  errors.registerRecovery('save', () => ({ slots: saves.inspectAll() }));

  const api = {
    version: P6_VERSION,
    ui, director, sync, saves, errors, presentation,
    applyPresentation, savePresentation, applySceneUi,
    start,
    getStatus: () => ({
      version: P6_VERSION,
      scene: scenes.currentId,
      ui: ui.getStatus(),
      director: director.getStatus(),
      sync: sync.getStatus(),
      saves: saves.getStatus(),
      errors: errors.getStatus(),
      presentation: presentation.get(),
      presentationStats: { ...presentation.stats },
      lifecycle: lifecycle ? lifecycle.summary() : null,
      timers: lifecycle ? lifecycle.timerLabels : ['p6-city-watch'],
    }),
    getSnapshot: () => {
      const scene = getWorldScene();
      const bm = getBattleManager();
      const ops = getBattleOps();
      const cm = getCityManager();
      const inter = getInteraction();
      return {
        scene: scenes.currentId,
        turn: adapter.getGameState(),
        phase: adapter.getInputPhase(),
        consistency: sync.consistency(),
        city: cm ? cm.getStatus() : null,
        battle: bm ? bm.getStatus() : null,
        ops: ops ? ops.getStatus() : null,
        selection: inter ? inter.selectedCityId : (scene ? scene.selection : null),
        slots: saves.inspectAll(),
      };
    },
    dispose() {
      for (const off of offs.splice(0)) off();
      if (watchTimer) clearInterval(watchTimer);
      watchTimer = null;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      sync.dispose();
      ui.dispose();
    },
  };
  return api;
}
