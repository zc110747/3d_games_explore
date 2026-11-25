/**
<<<<<<< HEAD
 * P6 统一配置 —— 全局整合阶段的常量与「事实来源」标注。
 *
 * 本文件只放**已核实的原版事实**与表现层自己的决策，不放任何推测值：
 *   - 存档格式：sgby.min.js L60329 `Rn=[83,71,66,51]`（"SGB3"）+ 版本字节 4
 *     - 槽位 key：`jn(slot)` -> [`${prefix}${2*slot}.sav`, `${prefix}${2*slot+1}.sav`]
 *     - 默认前缀：`Xn="sgby.sango"`，可被 URL `?save=<id>` 改成 `sgby.sango.<id>`
 *     - 头部信息：`Hn(slot)` -> { king: t[6]|t[7]<<8, year: t[8]|t[9]<<8 }
 *   - 存档两片：base（静态：时期/君主/年月/光标/难度/校验/武将/武将队列/道具队列）
 *                dyn（动态：g_FightersIdx / g_Fighters / g_OrderQueue / g_Cities）
 *     长度公式见 baseBytes()/dynBytes()，容量来自内核导出的 p6.capacity。
 *   - 存档**不含战斗态**（g_FgtOver/g_MapWid/g_GenPos 等都不在 ac()/oc() 的字段表里）。
 *
 * 表现层决策（不是原版事实，显式标注）：
 *   - 城市管理沿用 P3 的 HTML 覆盖层，**不**新建 Three.js 场景（P6 文档允许）。
 *   - 3D 表现配置存独立 localStorage 键，与原版存档完全分离。
 */

export const P6_VERSION = '6.0.0-p6';

/** UI 层级：全部由 P6 统一登记，避免各阶段自建 z-index 互相压盖。 */
export const UI_LAYERS = Object.freeze({
  SCENE: 10,        // 场景内浮层（P2 hint 等，归 P2 所有，仅登记）
  HUD: 20,          // P4 战斗 HUD / P5 操作条
  TOOLBAR: 30,
  PANEL: 40,        // 调试面板
  DIALOG: 60,       // P3 对话框 / P6 普通弹窗
  MODAL: 70,        // 阻断式弹窗
  ERROR: 90,        // 致命错误面板（最高）
});

/**
 * 3D 表现配置：与游戏存档分离的独立存储。
 * 键名刻意不用 `sgby.sango` 前缀，结构上不可能与原版存档混在一起。
 */
export const PRESENTATION = Object.freeze({
  key: 'sgby3d.presentation.v1',
  version: 1,
  /** 只有这些字段会被持久化（白名单，写死在代码里）。 */
  fields: Object.freeze(['camera', 'ui', 'selection']),
});

/** 原版存档事实（全部来自源码，不是猜测）。 */
export const SAVE = Object.freeze({
  header: Object.freeze([83, 71, 66, 51]),   // "SGB3"
  version: 4,
  format: 'sgby-save',
  slots: 3,
  defaultPrefix: 'sgby.sango',
  /** 单槽两片：base（静态）/ dyn（动态）。 */
  parts: Object.freeze(['base', 'dyn']),
  source: 'sgby.min.js L60329(Wn/Kn) L60352(jn) L178000(oc) L180411(ac)',
  /** 原版 oc() 是逐字段写入，不是原子操作 —— 失败时可能留下部分字段。 */
  atomic: false,
});

/**
 * 存档字节数（与 ac()/oc() 的 Uint8Array 尺寸逐项同源）。
 *   base = 35 + 19*persons + 2*persons + 2*goods
 *   dyn  = 2035 + 37*cities
 */
export function savePartBytes({ persons, cities, goods }) {
  if (![persons, cities, goods].every((n) => Number.isInteger(n) && n >= 0)) {
    throw new TypeError('savePartBytes 需要整数容量');
  }
  return Object.freeze({
    base: 35 + 19 * persons + 2 * persons + 2 * goods,
    dyn: 2035 + 37 * cities,
  });
}

/** 场景语义 ID。注意 CITY 是「world + HTML 覆盖层」，不是独立 Three 场景。 */
export const RUNTIME = Object.freeze({
  states: Object.freeze(['booting', 'connecting', 'ready', 'running', 'failed']),
  /** 城市管理是覆盖层：真正的 Three 场景始终是 world。 */
  cityIsOverlay: true,
  /** 防「无限循环切换场景」：1 秒内同一目标切换超过该次数即拒绝。 */
  maxSameTargetSwitches: 4,
  switchWindowMs: 1000,
  /** 一致性检查/诊断的最小间隔（避免面板刷新打满帧）。 */
  diagnosticsIntervalMs: 400,
});

/** 统一错误分类：可恢复 / 不可恢复。 */
export const ERROR_KIND = Object.freeze({
  RECOVERABLE: 'recoverable',
  FATAL: 'fatal',
});
=======
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
>>>>>>> 398c3b1abf079205e39970d0b07db81b84d61f19
