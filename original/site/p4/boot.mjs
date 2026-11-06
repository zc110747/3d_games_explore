/**
 * P4 装配入口 —— 把「原版战斗协程」与「3D 战斗场景」接起来。
 *
 * 内核侧（tools/make_core.mjs 生成）在三个时刻回调 window.__SGBY_P4_HOST__：
 *   enter  —— Uo() 进入（整场战斗开始，此时地图还没初始化）
 *   ready  —— yo() 返回（地图宽高/编成/位置/移动力全部就绪）
 *   exit   —— Uo() 返回（战斗结束，finally 保证异常也会通知）
 *
 * 本模块只做三件事：切场景、把真实战况灌进 3D、把面板显隐。
 * 它**不驱动**战斗：移动/攻击/待机/回合结束仍由原版协程在原版 2D 画面执行，
 * 用户可通过「原版画面」按钮查看与操作（P5 才会做 3D 侧的操作接管）。
 */
import { BattleCoordinateSystem } from './BattleCoordinateSystem.mjs';
import { BattleCamera } from './BattleCamera.mjs';
import { BattleMapScene } from './BattleMapScene.mjs';
import { BattleHUD } from './BattleHUD.mjs';
import { P4_VERSION } from './config.mjs';
import { EVENTS } from '../p1/core/EventManager.mjs';

export function createBattleManager({
  THREE, adapter, events, scenes, cameraManager, coordinate, renderManager, input, assets,
  uiHost = null, log = () => {},
}) {
  if (!THREE || !adapter || !events || !scenes || !cameraManager || !coordinate || !assets) {
    throw new TypeError('createBattleManager 依赖不完整');
  }
  const deps = {
    THREE, adapter, events, coordinate, cameraManager, renderManager, input, assets,
    battleCamera: new BattleCamera({ THREE, cameraManager }),
    battleCoord: new BattleCoordinateSystem(coordinate),
  };
  scenes.register('battle', () => new BattleMapScene(deps));

  const hud = new BattleHUD({ host: uiHost || document.getElementById('p1-ui') || document.body });
  hud.mount();
  hud.hide();

  const state = {
    active: false,
    phase: 'idle',      // idle | entering | ready | exiting
    lastError: null,
    kernelEvents: 0,
    enters: 0,
    exits: 0,
    loads: 0,
    failures: 0,
  };

  function currentScene() {
    const s = scenes.current;
    return s && s.id === 'battle' ? s : null;
  }

  function attachHud(scene) {
    if (scene && scene.hud !== hud) scene.hud = hud;
  }

  // 战斗期间把战略地图的调试面板/提示条收起，避免与战斗 HUD 叠在一起（退出时原样还原）
  const hiddenPanels = [];
  function hideStrategicUI() {
    hiddenPanels.length = 0;
    for (const id of ['p2-panel', 'p2-hint']) {
      const node = document.getElementById(id);
      if (!node) continue;
      hiddenPanels.push([node, node.style.display]);
      node.style.display = 'none';
    }
  }
  function restoreStrategicUI() {
    for (const [node, display] of hiddenPanels.splice(0)) node.style.display = display || '';
  }

  function onEnter() {
    state.kernelEvents++;
    if (state.active) { log('收到重复的战斗 enter 通知，已忽略'); return; }
    state.active = true;
    state.phase = 'entering';
    state.enters++;
    try {
      hideStrategicUI();
      const scene = scenes.currentId === 'battle' ? currentScene()
        : scenes.switchTo('battle', { phase: 'entering', reason: '原版 Uo() 进入战斗' });
      attachHud(scene);
      hud.show();
      hud.setChip('战斗初始化中…');
      hud.update({ battle: adapter.getBattleState(), unit: null, cell: null, counts: { move: 0, attack: 0 } });
      log(`原版进入战斗：MapId=${adapter.getBattleState().mapId}（等待 yo() 初始化地图）`);
    } catch (e) {
      state.failures++;
      state.lastError = e.message;
      log(`战斗场景切换失败（原版战斗继续在 2D 进行）：${e.message}`);
      restoreStrategicUI();
      state.active = false;
      state.phase = 'idle';
    }
  }

  function onReady() {
    if (!state.active) return;
    state.kernelEvents++;
    const scene = currentScene();
    if (!scene) { log('战斗就绪但场景不在 battle，已跳过 3D 装载'); return; }
    attachHud(scene);
    try {
      const r = scene.loadBattle();
      if (!r.ok) throw new Error(r.reason);
      state.loads++;
      state.phase = 'ready';
      hud.show();
      scene.refreshHUD('kernel-ready');
      events.emit(EVENTS.BATTLE_STARTED, {
        mapId: r.mapId, width: r.width, height: r.height,
        units: r.units, source: 'kernel yo()',
      }, { dedupeKey: `p4battle:${state.enters}:${r.mapId}` });
      log(`战斗地图就绪：${r.width}x${r.height} 图块 ${r.frames} 帧，部队 ${r.units}，装饰 ${r.props}`);
    } catch (e) {
      state.failures++;
      state.lastError = e.message;
      log(`战斗 3D 装载失败（原版战斗继续在 2D 进行）：${e.message}`);
      hud.setChip('3D 装载失败，见日志');
    }
  }

  function onExit() {
    state.kernelEvents++;
    if (!state.active) return;
    state.active = false;
    state.phase = 'exiting';
    state.exits++;
    const scene = currentScene();
    try {
      if (scene) scene.setCursor(null);
      hud.hide();
      if (scenes.currentId === 'battle') {
        scenes.switchTo('world', { reason: '原版 Uo() 结束战斗' });
      }
      restoreStrategicUI();
      adapter.invalidateBattleMap();
      events.emit(EVENTS.BATTLE_FINISHED, {
        result: adapter.getBattleState().over, source: 'kernel Uo() 返回',
      }, { dedupeKey: `p4battle-exit:${state.exits}` });
      log('战斗结束：已返回战略地图');
    } catch (e) {
      state.failures++;
      state.lastError = e.message;
      log(`返回战略地图失败：${e.message}`);
    } finally {
      state.phase = 'idle';
    }
  }

  const host = {
    onKernel(kind) {
      if (kind === 'enter') onEnter();
      else if (kind === 'ready') onReady();
      else if (kind === 'exit') onExit();
      else log(`未知内核通知：${kind}`);
    },
    // 供内核兜底/诊断：当前是否处于战斗
    get active() { return state.active; },
  };
  window.__SGBY_P4_HOST__ = host;

  function dispose() {
    if (window.__SGBY_P4_HOST__ === host) window.__SGBY_P4_HOST__ = null;
    restoreStrategicUI();
    hud.dispose();
    const s = currentScene();
    if (s) s.clearBattle();
  }

  return {
    version: P4_VERSION,
    hud,
    host,
    deps,
    get scene() { return currentScene(); },
    getStatus: () => ({
      ...state,
      hudOpen: hud.isOpen,
      sceneId: scenes.currentId,
      loaded: !!(currentScene() && currentScene().lastLoad && currentScene().lastLoad.ok),
      diagnostics: currentScene() ? currentScene().getDiagnostics() : null,
    }),
    dispose,
  };
}
