/**
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
