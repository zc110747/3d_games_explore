/**
 * P3 配置 —— 只放表现层参数与「已核实的原版事实索引」，不放任何游戏规则。
 *
 * 所有游戏数据、菜单文本、消耗、武将属性一律在运行时由
 * CityUIAdapter 调原版函数（getConst / $n / ss / Bs / Ys / Is）取得。
 *
 * 关键源码坐标（指 P0 还原副本 sgby.pretty.js，行号为该副本行号）：
 *   ei()  L4450  城市菜单外层循环：ni() 取大类 -> ri()/si()/ii() 取子项
 *   ni()  L4474  $r(..., lib.getConst(37))         4 项：内政 外交 军备 状况
 *   ri()  L4481  $r(..., lib.getConst(38)) 14 项 -> 指令 1..14
 *   si()  L4488  $r(..., lib.getConst(39))  5 项 -> 指令 15..19
 *   ii()  L4495  $r(..., lib.getConst(40))  5 项 -> 指令 23..27
 *   mi()  L4609  指令实现：case 1..12 / Ke(13) / Ne(14) / qe(15) / ze(16) /
 *                He(17) / Je(19) / Ve(23) / Ze(24) / 25 / 26 / tn(27)
 *                常量原句 L2355: Ke=13,Ne=14,qe=15,ze=16,He=17,Je=19,Ve=23,Ze=24,tn=27
 *   Ls()  L3686  武将选择窗口（persons 数组由 ss() 过滤，返回下标或 255）
 *   Ms()  L3482  单条提示（参数是 getConst 下标）
 *   vs()  L3486  带武将头像的提示
 *   Hs()  L4350  数值选择：min/max/kind(41 粮 42 钱 43 兵) -> 数值 或 65535
 *   Gs()  L3775  城市状况报告（Ys() 11 行）-> 1 确定 / 0 取消
 *   ka()  L7426  玩家城市操作循环，Ua() L7651 每回合调用
 */
export const P3_VERSION = '3.0.0-p3';

/** 原版常量（源码 L2351 / L2355，均已在上方索引）。 */
export const ORIGINAL = Object.freeze({
  cancelCode: 255,        // ye
  valueCancel: 65535,     // Hs 取消
  cityCount: 38,          // Fe
  keyType: 5,             // 键盘消息类型 _
  pointerType: 16,
  keys: Object.freeze({ up: 34, down: 35, left: 36, right: 37, confirm: 39, cancel: 40 }),
});

/** 城市菜单三个子菜单在 getConst 里的下标（ei()/ri()/si()/ii() 实参）。 */
export const MENU_CONST = Object.freeze({
  main: 37,
  sub: Object.freeze([38, 39, 40]),   // 内政 / 外交 / 军备
  infoCategoryIndex: 3,               // 状况：ei() case 3 -> 254 -> Gs()
  infoActionId: 254,
});

/** UI 结构标识（index3d.html / style.css 共用）。 */
export const UI_IDS = Object.freeze({
  root: 'p3-city',
  infoBar: 'p3-info-bar',
  rail: 'p3-rail',
  list: 'p3-list',
  panel: 'p3-detail',
  dialogLayer: 'p3-dialog-layer',
  log: 'p3-log',
  hint: 'p3-hint',
});

export const CITY_UI_CONFIG = Object.freeze({
  /** 执行记录保留条数（仅表现层日志，不参与游戏状态）。 */
  logLimit: 40,
  /** 武将表列宽（px），13 列与原版 Bs() 语义一一对应。 */
  officerColumnWidths: Object.freeze([88, 72, 84, 48, 48, 48, 48, 48, 48, 56, 48, 44, 88, 88]),
  /** 打开城市界面时给 3D 地图加的暗化强度（纯视觉）。 */
  dimOpacity: 0.45,
});
