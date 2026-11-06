/**
 * P5 装配入口 —— 把「原版战斗协程」与「3D 战棋操作」接起来。
 *
 * 它与 P4 的分工：
 *   P4 boot：负责 enter/ready/exit 三时刻的「场景装载 / 数据灌入 / 场景退出」。
 *   P5 boot：在 P4 装载成功之后才注册 window.__SGBY_P5_HOST__，接管**操作与表现**。
 *
 * 为什么必须在装载成功后才注册：
 *   宿主未注册时，内核里的 bo()/$r() shim 会**原样调用 *Orig**，
 *   也就是完全回到原版 2D 输入。这样「3D 装载失败」时战斗仍然可以在 2D 里打完，
 *   绝不会出现「3D 没画面、输入又被 3D 吃掉」的死局。
 */
import { BattleActionUI } from './BattleActionUI.mjs';
import { BattleAnimationManager } from './BattleAnimationManager.mjs';
import { BattleFlowController } from './BattleFlowController.mjs';
import { P5_VERSION, PHASES } from './config.mjs';
import { EVENTS } from '../p1/core/EventManager.mjs';

export function createBattleOps({
  THREE, adapter, events, scenes, renderManager, battleManager, uiHost = null, log = () => {},
}) {
  if (!THREE || !adapter || !events || !battleManager) throw new TypeError('createBattleOps 依赖不完整');

  const ui = new BattleActionUI({ host: uiHost || document.getElementById('p1-ui') || document.body, log });
  ui.mount();
  ui.hide();

  const state = {
    active: false,
    phase: PHASES.IDLE,
    starts: 0,
    ends: 0,
    failures: 0,
    lastError: null,
  };
  let flow = null;
  let anim = null;

  function stageRect() {
    const node = document.getElementById('p1-stage');
    return node ? node.getBoundingClientRect() : null;
  }

  // 内核宿主：始终存在，但只有 state.active 为真时才接管（inBattle）
  const host = {
    get inBattle() { return state.active && !!flow; },
    onPhase(kind, a, b) {
      state.phase = flow ? flow.phase : PHASES.IDLE;
      return flow ? flow.onPhase(kind, a, b) : undefined;
    },
    beginInput(info) { return flow ? flow.beginInput(info) : null; },
    pullInput(token) { return flow ? flow.pullInput(token) : null; },
    endInput(token) { if (flow) flow.endInput(token); },
    list(rect, start, items) { return flow ? flow.list(rect, start, items) : null; },
  };
  window.__SGBY_P5_HOST__ = host;

  // ------------------------------------------------------------ 战斗开始
  function onBattleStarted(detail) {
    // 事件有两个来源：
    //   1) P4 boot 在 yo() 结束时派发，带 width/height/units —— 这是权威的「3D 可装载」信号；
    //   2) GameAdapter.sync() 在 g_FgtBoutCnt 0->1 时派发（只有 mapId）—— 那是状态同步，
    //      不是装载信号，若在这里重建操作层会把已经建立的 flow 顶掉，导致输入 token 失效。
    if (state.active) return;
    if (!detail || !Number.isFinite(detail.width) || !Number.isFinite(detail.height)) return;
    state.starts++;
    const scene = battleManager.scene;
    if (!scene || !scene.lastLoad || !scene.lastLoad.ok || !scene.unitRenderer) {
      state.failures++;
      state.lastError = '3D 战斗场景未装载，操作仍由原版 2D 画面负责';
      log('P5：3D 战斗场景未装载，不接管操作（原版 2D 输入仍可用）');
      return;
    }
    try {
      anim = new BattleAnimationManager({
        THREE,
        unitRenderer: scene.unitRenderer,
        rangeRenderer: scene.rangeRenderer,
        coordinate: scene.battleCoord,
        ui,
        getCamera: () => scene.camera,
        getViewport: stageRect,
        log,
      });
      flow = new BattleFlowController({
        adapter, scene, anim, ui,
        log,
        getArmsType: (unitId) => {
          try {
            const u = adapter.getBattleUnit(unitId);
            return u.armsType === null ? 1 : u.armsType;
          } catch (_) { return 1; }
        },
      });
      scene.attachFlow(flow, anim);
      ui.bind({
        onCancel: () => { const r = flow.cancel(); if (!r.accepted) ui.pushLog(r.reason, 'warn'); },
        onMenu: () => { const r = flow.openBattleMenu(); if (!r.accepted) ui.pushLog(r.reason, 'warn'); },
      });
      ui.setPostBattle(false);
      ui.show();
      flow.beginBattle();
      flow.round = adapter.getBattleState().round;
      ui.setPhase(PHASES.IDLE);
      state.active = true;
      state.phase = flow.phase;
      ui.pushLog(`3D 战斗操作已接管（地图 ${detail.width}×${detail.height}，部队 ${detail.units}）`, 'info');
      ui.pushLog('点击我方部队 = 选择；蓝色格 = 原版 qi() 移动范围；红色格 = 原版 Vo() 攻击范围', 'info');
      log(`P5：3D 战斗操作已接管（${detail.width}x${detail.height}）`);
    } catch (e) {
      state.failures++;
      state.lastError = e.message;
      log(`P5：操作层装配失败，回退到原版 2D 输入 —— ${e.message}`);
      detach();
    }
  }

  function detach() {
    const scene = battleManager.scene;
    if (scene) scene.attachFlow(null, null);
    flow = null;
    anim = null;
    state.active = false;
  }

  // ------------------------------------------------------------ 战斗结束
  function onBattleFinished() {
    // 同 BATTLE_STARTED：GameAdapter.sync() 会在 g_FgtOver 变化时也派发一次，
    // 那时原版 Uo() 可能还在收尾。只有 P4 的 exit（场景已退回战略地图）才代表真正结束。
    if (!state.active) return;
    if (battleManager.getStatus().active) return;
    state.ends++;
    const scene = battleManager.scene;
    let lines = [];
    let meaning = 'none';
    try {
      const out = adapter.getBattleOutcome();
      meaning = out.meaning;
      const units = adapter.getBattleUnitStates();
      const alive = { mine: 0, enemy: 0 };
      for (const key of Object.keys(units)) {
        const id = Number(key);
        const u = units[id];
        if (u.state === 8) continue;
        if (id < 10) alive.mine++; else alive.enemy++;
      }
      const b = adapter.getBattleState();
      lines = [
        `结束标志 Dn.g_FgtOver = ${out.over}（1=我军胜 / 2=我军败）`,
        `回合数 ${b.round} · 地图 #${b.mapId} · 模式 ${b.mode}`,
        `剩余部队：我方 ${alive.mine} 支 / 敌方 ${alive.enemy} 支`,
        `粮草：我方 ${b.provender.mine} / 敌方 ${b.provender.enemy}`,
      ];
      if (flow && flow.lastResult) {
        const r = flow.lastResult;
        lines.push(`最后一次交战：${r.attacker.name} → ${r.target.name}`);
      }
    } catch (e) {
      state.failures++;
      state.lastError = e.message;
      lines = [`读取战果失败：${e.message}`];
    }
    // 先把操作层收掉，再展示战果（战果面板不依赖任何战斗逻辑）
    if (flow) flow.endBattle();
    detach();
    ui.closeMenu(255, 'battle-end');
    ui.setPostBattle(true);
    ui.show();
    ui.showResult({ meaning, lines, onClose: () => ui.hide() });
    log(`P5：战斗结束（${meaning}），已切换回战略地图`);
    void scene;
  }

  const offStarted = events.on(EVENTS.BATTLE_STARTED, onBattleStarted);
  const offFinished = events.on(EVENTS.BATTLE_FINISHED, onBattleFinished);

  function getStatus() {
    return {
      ...state,
      phase: flow ? flow.phase : state.phase,
      active: state.active,
      uiOpen: ui.isMounted,
      menuOpen: ui.menuOpen,
      hostRegistered: window.__SGBY_P5_HOST__ === host,
    };
  }

  return {
    version: P5_VERSION,
    ui,
    host,
    get flow() { return flow; },
    get anim() { return anim; },
    getStatus,
    getSnapshot: () => ({
      status: getStatus(),
      phase: flow ? flow.getSnapshot() : null,
      anim: anim ? anim.getDiagnostics() : null,
      logs: ui.logs.slice(-12),
    }),
    dispose() {
      offStarted();
      offFinished();
      if (window.__SGBY_P5_HOST__ === host) window.__SGBY_P5_HOST__ = null;
      detach();
      ui.dispose();
    },
  };
}
