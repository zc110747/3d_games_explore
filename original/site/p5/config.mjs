/**
 * P5 战斗交互 / 动画配置 —— 只有表现层参数与「原版事实」常量，不含任何游戏规则。
 *
 * 所有判定（能否选、能否走、能否打、伤害多少、是否死亡、谁胜谁负）
 * 一律由原版 ko()/vo()/xo()/Ao()/Fo() 完成；本文件里的数字只影响「看起来怎么样」。
 *
 * 依据真实源码（还原副本 sgby.pretty.js 行号）：
 *  - L5834 bo()  战斗地图输入循环，唯一 await l.input.waitMsgTimeout(200) 的地方
 *  - L5946 ko()  选部队；L5962 vo() 移动；L5977 xo() 选目标
 *  - L6000 Ao()  行动菜单（$r + vi(8)）；L6024 Fo() 结算
 *  - L6191 Io()/L6218 Eo()/L6240 So()/L6253 Uo() 回合与阶段
 *  - L6394 Go()  战斗菜单（$r + vi(9)）：回合结束/敌军移动/战斗动画/移动速度/全军撤退
 *  - L5618 Ji()/Vi() 像素 = (格 - 视口原点) << 4；L2353 Pe=Ce=16, pe=15, be=17
 */

export const P5_VERSION = '5.0.0-p5';

/**
 * 战斗交互状态机（P5 §3）。
 *
 * 与「原版协程当前位置」一一对应，不是另一套规则：
 *   IDLE              原版不在可操作输入中（初始化 / 敌方阶段 / 结算中）
 *   SELECT            原版 ko() 选中循环（bo() 已开，点格子=移动焦点/选部队）
 *   UNIT_SELECTED     ko() 已返回部队下标，vo() 正在等移动目标
 *   MOVEMENT_PENDING  移动消息已投递出去，等原版 bo()/Mo() 判定结果
 *   MOVEMENT_ANIMATING 原版已确认移动，3D 正在播放路程动画
 *   ACTION_MENU       原版 Ao() 的 $r() 行动菜单打开中
 *   ATTACK_PREVIEW    xo() 正在选目标（攻击/计谋范围已由原版 Vo() 给出）
 *   ATTACK_PENDING    目标消息已投递，等原版 xo() 判定
 *   ATTACK_ANIMATING  Fo() 执行中，3D 播放攻击/受击表现
 *   ACTION_COMPLETED  Fo() 已返回，正在显示原版真实战果
 *   TURN_ENDING       原版 Go() 菜单/回合收尾
 *   ENEMY_PHASE       原版 So()（AI）执行中，表现层只做跟随
 *   BATTLE_FINISHED   Dn.g_FgtOver != 0 或 Uo() 已退出
 */
export const PHASES = Object.freeze({
  IDLE: 'IDLE',
  SELECT: 'SELECT',
  UNIT_SELECTED: 'UNIT_SELECTED',
  MOVEMENT_PENDING: 'MOVEMENT_PENDING',
  MOVEMENT_ANIMATING: 'MOVEMENT_ANIMATING',
  ACTION_MENU: 'ACTION_MENU',
  ATTACK_PREVIEW: 'ATTACK_PREVIEW',
  ATTACK_PENDING: 'ATTACK_PENDING',
  ATTACK_ANIMATING: 'ATTACK_ANIMATING',
  ACTION_COMPLETED: 'ACTION_COMPLETED',
  TURN_ENDING: 'TURN_ENDING',
  ENEMY_PHASE: 'ENEMY_PHASE',
  BATTLE_FINISHED: 'BATTLE_FINISHED',
});

/** 每个状态下是否接受「点击地图」，以及这次点击在原版语义里代表什么。 */
export const PHASE_INPUT = Object.freeze({
  [PHASES.IDLE]: Object.freeze({ click: null, cancel: false }),
  [PHASES.SELECT]: Object.freeze({ click: 'selectUnit', cancel: true }),   // 取消 = 开 Go() 战斗菜单
  [PHASES.UNIT_SELECTED]: Object.freeze({ click: 'moveCell', cancel: true }),
  [PHASES.MOVEMENT_PENDING]: Object.freeze({ click: null, cancel: false }),
  [PHASES.MOVEMENT_ANIMATING]: Object.freeze({ click: null, cancel: false }),
  [PHASES.ACTION_MENU]: Object.freeze({ click: null, cancel: false }),     // 菜单自己处理输入
  [PHASES.ATTACK_PREVIEW]: Object.freeze({ click: 'targetUnit', cancel: true }),
  [PHASES.ATTACK_PENDING]: Object.freeze({ click: null, cancel: false }),
  [PHASES.ATTACK_ANIMATING]: Object.freeze({ click: null, cancel: false }),
  [PHASES.ACTION_COMPLETED]: Object.freeze({ click: null, cancel: false }),
  [PHASES.TURN_ENDING]: Object.freeze({ click: null, cancel: false }),
  [PHASES.ENEMY_PHASE]: Object.freeze({ click: null, cancel: false }),
  [PHASES.BATTLE_FINISHED]: Object.freeze({ click: null, cancel: false }),
});

/**
 * 动画时长（毫秒）。P5 §11.3：时长属于表现层参数，
 * 不得因为动画时长改变回合与操作结果；所有等待都有硬超时兜底。
 */
export const ANIM = Object.freeze({
  /** 单格移动时长（秒/格），并受 minSegment/maxTotal 约束 */
  moveSecPerCell: 0.13,
  moveSecMinSegment: 0.055,
  moveTotalTimeoutMs: 3200,
  moveHopHeight: 0.16,          // 每格抬起的视觉高度（不参与任何判定）
  moveBobHz: 6.2,

  attackLungeSec: 0.22,         // 冲向目标的时长
  attackHoldSec: 0.10,
  attackReturnSec: 0.20,
  attackProjectileSec: 0.26,    // 弓兵/术法：抛射体飞行时间
  attackTimeoutMs: 2600,

  hitFlashSec: 0.34,            // 受击闪白/泛红的持续时间
  hitShakeAmp: 0.16,

  deathSec: 0.9,                // 沉入地面 + 缩小的时长
  deathSink: 1.15,
  deathSpin: 0.5,

  turnBannerSec: 1.1,           // 回合/阶段提示横幅
  resultPanelDelayMs: 350,      // 战果面板相对 Uo() 退出稍晚出现，避免与场景切换抢帧

  /** 敌方 AI 阶段的「跟随动画」在玩家阶段开始后最多再补播这么久 */
  catchUpGraceMs: 900,
});

/** 单位视觉：命中闪色 / 死亡下沉等，全部是材质替换，不克隆共享材质。 */
export const FX_STYLE = Object.freeze({
  hitColor: 0xff5a3c,
  healColor: 0x62d08a,
  damageColor: '#ff8a6a',
  damageProvColor: '#ffd166',
  expColor: '#9ad0ff',
  pathColor: 0xffd76a,
  pathOpacity: 0.85,
  pathDash: 0.34,
  targetRingColor: 0xff4b3a,
  floatLayerMax: 24,
});

/** 原版行动菜单（vi(8)）与战斗菜单（vi(9)）的语义下标 —— 来自 Ao()/Go() 的 case 分支。 */
export const ACTION_MENU_INDEX = Object.freeze({
  attack: 0,     // Ao() case 0 -> Fo type 0 -> Bo() 普通攻击
  skill: 1,      // Ao() case 1 -> Ro() 选计谋 -> Fo type 1
  info: 2,       // Ao() case 2 -> Oo() 部队情报面板
  wait: 3,       // Ao() case 3 -> return（保留位置，结束该部队行动）
});

export const BATTLE_MENU_INDEX = Object.freeze({
  endTurn: 0,    // Go() case 0 -> return 255 -> Eo() 结束我方阶段
  lookEnemy: 1,  // g_LookEnemy（敌军移动 不看/观看）
  lookMovie: 2,  // g_LookMovie（战斗动画）
  moveSpeed: 3,  // g_MoveSpeed（移动速度）
  retreat: 4,    // 全军撤退 -> 二次确认 -> Dn.g_FgtOver = 2
});

/** 原版 `$r` 菜单里「取消」的返回值（ye，源码 L2353 同域常量）。 */
export const MENU_CANCEL = 255;

/** 提示语完全是表现层文案（原版没有对应句子时不得冒充原版文本）。 */
export const HINTS = Object.freeze({
  [PHASES.IDLE]: '等待原版战斗协程…',
  [PHASES.SELECT]: '点击我方部队选择；点「战斗菜单」= 原版 Esc（回合结束 / 全军撤退）',
  [PHASES.UNIT_SELECTED]: '点击蓝色格子移动；「取消」= 原版 Esc（放弃本次移动）',
  [PHASES.MOVEMENT_PENDING]: '等待原版判定移动…',
  [PHASES.MOVEMENT_ANIMATING]: '移动中…',
  [PHASES.ACTION_MENU]: '选择行动（菜单项与原版 Ao() 完全一致）',
  [PHASES.ATTACK_PREVIEW]: '点击红色范围内的敌方部队作为目标；「取消」= 原版 Esc',
  [PHASES.ATTACK_PENDING]: '等待原版判定目标…',
  [PHASES.ATTACK_ANIMATING]: '交战中…',
  [PHASES.ACTION_COMPLETED]: '行动结束',
  [PHASES.TURN_ENDING]: '回合结束中…',
  [PHASES.ENEMY_PHASE]: '敌军行动中（原版 So() 自动流程）',
  [PHASES.BATTLE_FINISHED]: '战斗已结束',
});
