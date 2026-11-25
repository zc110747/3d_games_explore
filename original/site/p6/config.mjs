/**
 * P6 表现层配置 —— 视图模式与 3D 主界面操作条。
 *
 * 本文件只含「表现层/协议映射」参数，不含任何游戏规则：
 *   - 视图模式判据来自 GameAdapter.getInputPhase().kind（只读诊断）；
 *   - 按钮只映射到原版已有键码（见 p1/core/config.mjs ORIGINAL_INPUT.keys）；
 *   - 光标高亮是新增的可视标记，不参与命中/判定。
 */
import { ORIGINAL_INPUT } from '../p1/core/config.mjs';

export const P6_VERSION = '6.0.0-p6';

export const VIEW_MODE = Object.freeze({ MENU: 'menu', GAME: 'game' });

/**
 * 视图切换判据（对应需求 1）。
 *
 * kind 的取值来自 GameAdapter 对 waitMsg 调用栈的只读识别：
 *   zs     = 原版战略地图选城循环（真正"进入主界面"）
 *   ei     = 城市菜单（P3 已接管成 HTML）
 *   battle = 战斗主循环 Uo（P4/P5 已 3D 化）
 *   menu   = 主菜单 / 回合菜单 / 开场 / 选剧本 / 选君主 / 难度（保持原版 2D）
 *   unknown= 无法判定，保持当前视图，避免画面来回跳
 */
export const VIEW_CONFIG = Object.freeze({
  pollMs: 180,
  /** 出现这些 kind 时显示 3D（已进入剧本内的 3D 化界面）。 */
  gameKinds: Object.freeze(['zs', 'ei', 'battle']),
  /** 出现这些 kind 时显示原版 2D（菜单/选择阶段，不做 3D 化）。 */
  menuKinds: Object.freeze(['menu']),
  source: 'GameAdapter.getInputPhase().kind（waitMsg 调用栈识别）',
});

/** 光标格高亮：仅在 3D 里标出原版 Dn.g_CityPos 所在格（纯表现层）。 */
export const CURSOR_STYLE = Object.freeze({
  size: 0.94,             // 略小于 1 格，避免压住相邻格边界
  color: 0xffd76a,
  opacity: 0.95,
  fillOpacity: 0.14,
  y: 0.17,                // 高于地形(<=0.09)/道路(0.115)/城市底座(0.02)
});

/**
 * 3D 主界面底部操作条。
 * key 一律是 ORIGINAL_INPUT.keys 里的原版键码，不新增自定义动作。
 */
const K = ORIGINAL_INPUT.keys;
export const OPS_LAYOUT = Object.freeze([
  Object.freeze({
    id: 'util',
    buttons: Object.freeze([
      Object.freeze({ key: K.help, label: '信息', hint: '原版 Tab / h：帮助' }),
      Object.freeze({ key: K.chart, label: '查找', hint: '原版 M：形势图' }),
    ]),
  }),
  Object.freeze({
    id: 'dpad',
    buttons: Object.freeze([
      Object.freeze({ key: K.up, label: '▲' }),
      Object.freeze({ key: K.left, label: '◀' }),
      Object.freeze({ key: K.down, label: '▼' }),
      Object.freeze({ key: K.right, label: '▶' }),
    ]),
  }),
  Object.freeze({
    id: 'confirm',
    buttons: Object.freeze([
      Object.freeze({ key: K.confirm, label: '确认', variant: 'primary', hint: '原版 E / Enter' }),
      Object.freeze({ key: K.cancel, label: '返回', variant: 'cancel', hint: '原版 Q / Esc' }),
    ]),
  }),
]);

export const KEY_CODES = K;
