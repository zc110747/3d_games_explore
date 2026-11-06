/**
 * P3 装配入口 —— 把城市管理 UI 接到「原版内核 + GameAdapter + 3D 战略地图」上。
 *
 * 只做连线，不含规则：
 *   core(sgby.core.js 的 7 个 shim) <-> CitySession <-> CityManagementUI / 对话框
 *                                              \-> CityUIAdapter（只读投影）
 * 会话窗口严格由原版 ka() 划定（beginCityLoop / endCityLoop），
 * 主菜单、回合菜单、战斗流程完全不经过本模块，行为与 P2 一致。
 */
import { EVENTS } from '../p1/core/EventManager.mjs';
import { UI_IDS, P3_VERSION } from './config.mjs';
import { CityUIAdapter } from './CityUIAdapter.mjs';
import { CityManagementUI } from './CityManagementUI.mjs';
import { CitySession } from './CitySession.mjs';
import { DialogHost, el } from './Dialogs.mjs';
import { OfficerSelectDialog } from './OfficerSelectDialog.mjs';

/**
 * @param {object} deps
 * @param {object} deps.core         window.__SGBY_CORE__
 * @param {object} deps.adapter      GameAdapter
 * @param {object} deps.events       EventManager
 * @param {object} [deps.input]      InputManager（弹窗期间阻断 3D 输入）
 * @param {object} [deps.interaction] MapInteraction（城市循环内 intent=select）
 * @param {Element} [deps.host]      UI 挂载点，默认 #p1-ui
 * @param {Function} [deps.log]
 */
export function createCityManager({
  core, adapter, events, input = null, interaction = null,
  host = null, log = () => {},
}) {
  if (!core || !adapter || !events) throw new TypeError('createCityManager 依赖不完整');
  const uiHost = host || document.getElementById('p1-ui') || document.body;

  // 对话框层独立于城市主框：敌方城池提示等发生在城市界面打开之前。
  const layer = el('div', 'p3-overlay-layer');
  layer.id = UI_IDS.dialogLayer;
  layer.hidden = true;
  layer.setAttribute('data-p1-ui-block', '');
  uiHost.append(layer);

  const dialogHost = new DialogHost(layer);
  const cityUI = new CityUIAdapter({ core, adapter });
  const ui = new CityManagementUI({ host: uiHost, dialogHost, cityUI, cityAdapter: adapter });
  ui.mount();
  const officerDialog = new OfficerSelectDialog({ host: dialogHost, cityUI });
  const session = new CitySession({
    core, adapter, cityUI, ui, dialogs: dialogHost, officerDialog, input, interaction, log,
  });
  session.attach();

  // 状态变化 -> 局部刷新（只重画当前城市的字段，不重建 3D 地图）
  const offs = [];
  offs.push(events.on(EVENTS.CITY_UPDATED, ({ cityId }) => {
    if (ui.isOpen && ui.cityId === cityId) { try { ui.refresh(); } catch (_) { /* 忽略瞬时错误 */ } }
  }));
  offs.push(events.on(EVENTS.CITY_OWNER_CHANGED, ({ cityId }) => {
    if (ui.isOpen && ui.cityId === cityId) { try { ui.refresh(); } catch (_) { /* 忽略 */ } }
  }));
  offs.push(events.on(EVENTS.OFFICER_UPDATED, () => {
    if (ui.isOpen) { try { ui.refresh(); } catch (_) { /* 忽略 */ } }
  }));
  offs.push(events.on(EVENTS.TURN_CHANGED, () => {
    if (ui.isOpen) { try { ui.refresh(); } catch (_) { /* 忽略 */ } }
  }));

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const off of offs.splice(0)) off();
    session.detach();
    dialogHost.dispose();
    ui.close();
    if (ui.dom && ui.dom.root) ui.dom.root.remove();
    layer.remove();
    if (window.__SGBY_P3_HOST__ === session) window.__SGBY_P3_HOST__ = null;
  }

  return {
    version: P3_VERSION,
    session, ui, cityUI, dialogHost, officerDialog, dispose,
    getStatus: () => ({
      cityLoop: session.cityLoop,
      cityId: session.cityId,
      open: ui.isOpen,
      tab: ui.tab,
      group: ui.activeGroup ?? null,
      stats: { ...session.stats },
      dialogs: { ...dialogHost.stats, open: dialogHost.openCount },
      officers: { ...officerDialog.stats },
      widgets: core.p3 ? core.p3.widgetNames.slice() : [],
      actionIds: core.p3 ? core.p3.actionIds.slice() : [],
      degraded: cityUI.stats.degradedCalls,
    }),
  };
}
