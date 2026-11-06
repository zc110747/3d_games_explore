/**
 * P5 BattleFlowController —— 3D 战棋交互状态机。
 *
 * 它做三件事，且只做这三件事：
 *   1. **听**：内核 shim 在 bo/ko/vo/xo/Ao/Fo/Io/Eo/So 前后通知「原版走到哪一步」，
 *      本模块据此切换自己的表现状态（P5 §3）。通知不含任何判定结果。
 *   2. **转**：把 3D 拾取到的格子翻译成原版指针消息（type:16），
 *      经 GameAdapter.clickBattleCell() -> class A.pushMsg 交给原版 bo() 自己解释。
 *   3. **等**：把原版已确认的结果（移动目的地、Fo 前后的真实状态差）交给动画与 HUD，
 *      并在关键动作播放期间阻塞表现层输入（绝不影响原版协程）。
 *
 * 明确不做的事：
 *   - 不判断某格能不能走、能不能打、伤害多少、谁死谁活、谁胜谁负；
 *   - 不因为动画没播完而重发操作；
 *   - 不在原版之外保存第二份战斗状态（唯一真值永远是 Dn）。
 */
import {
  PHASES, PHASE_INPUT, ANIM, MENU_CANCEL, ACTION_MENU_INDEX, BATTLE_MENU_INDEX, HINTS,
} from './config.mjs';
import { buildVisualPath } from './VisualPath.mjs';
import { diffUnitStates, diffProvender, describeChange } from './BattleDelta.mjs';

/** 把 $r() 的定宽菜单串切成条目：每项宽度 = floor((ex-sx)/8) 个显示单位（Tr 口径）。 */
export function splitMenuByRect(text, rect) {
  const s = String(text || '');
  if (!s) return [];
  const width = rect && Number.isFinite(rect.ex) && Number.isFinite(rect.sx)
    ? Math.floor((rect.ex - rect.sx) / 8) : 0;
  if (width <= 0) {
    const out = [];
    for (let i = 0; i + 1 < s.length; i += 2) out.push(s.slice(i, i + 2));
    return out;
  }
  const out = [];
  let buf = '', w = 0;
  for (const ch of s) {
    const cw = ch.charCodeAt(0) < 0x80 ? 1 : 2;
    if (w + cw > width) { out.push(buf); buf = ''; w = 0; }
    buf += ch; w += cw;
  }
  if (buf) out.push(buf);
  return out.map((x) => x.trimEnd());
}

export class BattleFlowController {
  constructor({
    adapter, scene, anim, ui, log = () => {}, getArmsType = () => 1,
  }) {
    if (!adapter || !scene || !anim || !ui) throw new TypeError('BattleFlowController 依赖不完整');
    this.adapter = adapter;
    this.scene = scene;
    this.anim = anim;
    this.ui = ui;
    this._getArmsType = getArmsType;
    this.log = log;

    this.phase = PHASES.IDLE;
    this.inBattle = false;
    this.inputActive = false;
    this.selectedUnit = null;
    this.lastResult = null;
    this.over = 0;
    this.round = 0;

    this._tokenSeq = 0;
    this._token = null;
    this._pending = [];          // 待投递的原版输入消息（只在 bo() 内部被拉取）
    this._pendingPhase = null;
    this._snapBefore = null;
    this._snapProvBefore = null;
    this._battle = null;         // 当前行动结算上下文
    this._impactDone = false;
    this._resultReady = false;
    this._lastStates = null;
    this._catchUpBudget = 0;
    this._menus = null;

    this.stats = {
      trace: [],
      phases: 0, clicks: 0, accepted: 0, rejected: 0, cancels: 0, resolves: 0,
      inputsOpened: 0, inputsClosed: 0, menuOpened: 0, moves: 0,
      animBlockedMs: 0, enemyCatchUps: 0, impactDeferred: 0, errors: 0,
    };
  }

  // ============================================================ 生命周期
  /**
   * 宿主对象由 p5/boot.mjs 统一注册（window.__SGBY_P5_HOST__），
   * 本类只提供被它转发的 5 个方法：onPhase / beginInput / pullInput / endInput / list。
   */
  beginBattle() {
    this.inBattle = true;
    this.over = 0;
    this.round = 0;
    this.phase = PHASES.IDLE;
    this.selectedUnit = null;
    this._pending.length = 0;
    this._lastStates = this.adapter.getBattleUnitStates();
  }

  endBattle() {
    this.inBattle = false;
    this.inputActive = false;
    this._pending.length = 0;
    this._token = null;
    this.phase = PHASES.BATTLE_FINISHED;
    this.anim.cancelAll('battle-end');
    this.ui.closeMenu(MENU_CANCEL, 'battle-end');
  }

  // ============================================================ 状态切换
  _setPhase(next, detail = {}) {
    if (this.phase === next) return;
    const prev = this.phase;
    this.phase = next;
    this.stats.phases++;
    this.stats.trace.push(`${prev}->${next}@${Math.round(performance.now())}${detail.kind ? `(${detail.kind})` : ''}`);
    if (this.stats.trace.length > 24) this.stats.trace.shift();
    this.ui.setPhase(next, { prev, ...detail });
    try {
      this.scene.onBattlePhaseChanged(next, { prev, ...detail });
    } catch (e) {
      this.stats.errors++;
      this.log(`场景状态切换失败：${e.message}`);
    }
  }

  /** 当前阶段允许的点击语义（null = 不接受点击）。 */
  get clickKind() {
    const conf = PHASE_INPUT[this.phase];
    return conf ? conf.click : null;
  }

  get canCancel() {
    const conf = PHASE_INPUT[this.phase];
    return !!(conf && conf.cancel && this.inputActive);
  }

  // ============================================================ 内核通知
  /**
   * 内核阶段通知。返回 Promise 时会**阻塞原版协程**（仅用于等动画播完），
   * 因此每个分支都必须有界：anim 有硬超时，异常一律吞掉。
   */
  async onPhase(kind, a, b) {
    try {
      switch (kind) {
        case 'select':
          this.selectedUnit = null;
          this.scene.clearBattleSelection?.();
          this._setPhase(PHASES.SELECT);
          return undefined;

        case 'selectDone':
          if (a === 255) {
            this._setPhase(this.over ? PHASES.BATTLE_FINISHED : PHASES.TURN_ENDING);
            return undefined;
          }
          this.selectedUnit = a;
          this.scene.selectUnit(a, { source: 'kernel-ko' });
          this._setPhase(PHASES.UNIT_SELECTED, { unitId: a });
          return undefined;

        case 'moveBegin':
          // vo() 刚开始：原版此刻是「等玩家点移动目标」，而不是「已提交、等判定」。
          // 所以保持 UNIT_SELECTED，只有我们真的把点击投递出去时才进 *_PENDING。
          this.selectedUnit = a;
          this._setPhase(PHASES.UNIT_SELECTED, { unitId: a, reopen: true });
          return undefined;

        case 'moveDone':
          return this._onMoveDone(a, b);

        case 'actionMenu':
          this._setPhase(PHASES.ACTION_MENU, { unitId: a });
          return undefined;

        case 'actionDone':
          if (a && (a.type === 3 || a.type === 255)) {
            // 待机 / 取消：该部队行动结束，原版会回到 ko()
            this.scene.rangeRenderer?.clear();
            this._setPhase(PHASES.ACTION_COMPLETED, { action: a });
          }
          return undefined;

        case 'targetBegin':
          this._onTargetBegin(a);
          return undefined;

        case 'targetDone':
          // 内核传的是 xo() 的返回值：被选中的部队下标，或 255（取消）
          if (a === 255 || a === undefined || a === null) {
            this._setPhase(PHASES.ACTION_MENU, { back: true, cancelled: true });
          } else {
            this._setPhase(PHASES.ATTACK_PENDING, { targetId: a });
          }
          return undefined;

        case 'resolveBegin':
          this._onResolveBegin(a);
          return undefined;

        case 'resolveDone':
          return this._onResolveDone(a, b);

        case 'turnBegin':
          // Io() 开始：回合数 +1、清 active、状态恢复，随后才进入我方阶段。
          // 这段期间原版不接受地图输入，所以只回到 IDLE —— 不能标成 TURN_ENDING，
          // 否则整个 Io() 期间 UI 会显示「回合结束」，属于误导。
          this._setPhase(PHASES.IDLE);
          return undefined;

        case 'turnStart':
          // 内核传的是 Io() 跑完后的真实回合数 Dn.g_FgtBoutCnt
          this.round = a;
          this.anim.banner({
            title: `第 ${a} 回合`,
            subtitle: '原版 Io() 已完成回合开始处理',
            tone: 'round',
          });
          return undefined;

        case 'playerPhase':
          this._onPlayerPhase();
          return undefined;

        case 'enemyPhase':
          // 以「进入敌方阶段的这一刻」为基线，避免把玩家刚才的移动误当成敌军移动
          this._lastStates = this.adapter.getBattleUnitStates();
          this._setPhase(PHASES.ENEMY_PHASE);
          this._catchUpBudget = 40;
          return undefined;

        case 'playerPhaseEnd':
        case 'enemyPhaseEnd':
          return undefined;

        default:
          return undefined;
      }
    } catch (e) {
      this.stats.errors++;
      this.log(`阶段 ${kind} 处理异常（已吞掉，不影响原版）：${e.message}`);
      return undefined;
    }
  }

  // ---------------------------------------------------------- 移动
  async _onMoveDone(unitId, result) {
    if (result !== 0) {
      // 原版 vo() 返回 1：不可移动或玩家取消 —— 没有任何位置变化
      this.scene.rangeRenderer?.clear();
      this._setPhase(PHASES.SELECT);
      return undefined;
    }
    const unit = this.adapter.getBattleUnit(unitId);
    const mv = this.adapter.getLastBattleMove();
    // vo() 成功时把「移动前位置」写进 g_BakUpX/Y，位置本身写进 g_GenPos（L5975）
    const from = mv.from;
    const to = { x: unit.x, y: unit.y };
    if (from.x === to.x && from.y === to.y) {
      this._setPhase(PHASES.ACTION_MENU, { unitId });
      return undefined;
    }
    const field = this.adapter.getBattlePathField();
    const path = buildVisualPath({
      field: field.raw, origin: field.origin, from, to,
      width: field.width, blockCost: field.blockCost,
    });
    this.stats.moves++;
    this.adapter.stats.battleMoves = this.stats.moves;
    this._setPhase(PHASES.MOVEMENT_ANIMATING, { unitId, from, to, steps: path.steps });
    this.ui.pushLog(`原版已确认移动：(${from.x},${from.y}) → (${to.x},${to.y})`
      + `，视觉路径 ${path.steps} 段${path.degraded ? '（距离场退化）' : ''}`, 'move');
    const t0 = performance.now();
    const r = await this.anim.move({ unitId, cells: path.cells });
    this.stats.animBlockedMs += Math.round(performance.now() - t0);
    // 动画结束：以原版最终位置为准重建一次（若期间有别的状态变化也一并收敛）
    this.scene.refreshFromAdapter?.('move-anim-done');
    this._setPhase(PHASES.ACTION_MENU, { unitId, anim: r.reason });
    return undefined;
  }

  // ---------------------------------------------------------- 目标
  _onTargetBegin(info) {
    if (!info) return;
    // Ao() 在 xo() 之前刚调用过 Vo(type,param,unitId)，此刻 g_FgtAtkRng 就是本次的合法范围。
    // 立即快照，避免之后被 zo()（敌方反击）覆盖。
    const live = this.adapter.getCurrentAttackRange();
    this.scene.showAttackPreview(live.cells, { kind: info.type, param: info.param });
    this._setPhase(PHASES.ATTACK_PREVIEW, info);
  }

  // ---------------------------------------------------------- 结算
  _onResolveBegin(d) {
    if (!d) return;
    this._battle = { ...d, attacker: d.sIdx, target: d.aIdx };
    this._snapBefore = this.adapter.getBattleUnitStates();
    this._snapProvBefore = this.adapter.getBattleState().provender;
    this._impactDone = false;
    this._resultReady = false;
    this._setPhase(PHASES.ATTACK_ANIMATING, d);
    const armsType = this._getArmsType(d.sIdx);
    this._attackJob = this.anim.attack({
      attackerId: d.sIdx,
      targetId: d.aIdx,
      armsType,
      onImpact: () => this._fireImpact(),
    });
    this.scene.rangeRenderer?.clearPath();
    this.scene.rangeRenderer?.setTarget(null);
  }

  /** 命中瞬间：如果原版结果还没算完，就等一帧后再放反馈（只延迟表现，不改逻辑）。 */
  _fireImpact() {
    if (this._impactDone) return;
    if (!this._resultReady) { this.stats.impactDeferred++; return; }
    this._impactDone = true;
    const res = this.lastResult;
    if (!res) return;
    for (const c of res.changes) {
      if (c.died) this.anim.die(c.id);
      else if (c.armsDelta > 0 || c.hpDelta > 0) {
        this.anim.hit(c.id, { text: c.armsDelta > 0 ? `-${c.armsDelta}` : `-${c.hpDelta}`, tone: 'damage' });
      } else if (c.mpDelta > 0) {
        this.anim.hit(c.id, { text: `技-${c.mpDelta}`, tone: 'exp' });
      }
    }
    if (res.provender && res.provender.totalDelta !== 0) {
      this.anim.floatText(this.anim.unitRenderer.getBaseWorld(res.target.id) || { x: 0, z: 0 },
        `${res.provender.totalDelta < 0 ? '-' : '+'}${Math.abs(res.provender.totalDelta)} 粮`, 'provender');
    }
  }

  async _onResolveDone(d, foReturn) {
    // 战果 = 原版操作前后的真实状态差（p5/BattleDelta.mjs 里是纯减法，不重算任何数值）
    const before = this._snapBefore || {};
    const after = this.adapter.getBattleUnitStates();
    const changes = diffUnitStates(before, after);
    const provAfter = this.adapter.getBattleState().provender;
    const provBefore = this._snapProvBefore || provAfter;
    const provDelta = diffProvender(provBefore, provAfter);
    const attacker = this.adapter.getBattleUnit((d && d.sIdx) | 0);
    const target = this.adapter.getBattleUnit((d && d.aIdx) | 0);
    this.lastResult = {
      kind: (d && d.type) === 1 ? 'skill' : 'attack',
      skillId: d ? d.param : 0,
      attacker: { id: d ? d.sIdx : -1, name: attacker.name, side: attacker.side },
      target: { id: d ? d.aIdx : -1, name: target.name, side: target.side },
      changes,
      provender: { ...provDelta, totalDelta: provDelta.mine + provDelta.enemy },
      foReturn,
      at: Date.now(),
    };
    this._resultReady = true;
    this.stats.resolves++;
    this.over = this.adapter.getBattleState().over;

    // 战报（全部来自原版状态差，不推算）
    const bits = [];
    for (const c of this.lastResult.changes) {
      let who = null;
      try { who = this.adapter.getBattleUnit(c.id); } catch (_) { who = null; }
      bits.push(describeChange(c, who ? who.name : ''));
    }
    if (provDelta.mine || provDelta.enemy) {
      bits.push(`粮草 我${provDelta.mine >= 0 ? '+' : ''}${provDelta.mine} / 敌${provDelta.enemy >= 0 ? '+' : ''}${provDelta.enemy}`);
    }
    const head = `${attacker.name || `#${d ? d.sIdx : '?'}`}`
      + `${this.lastResult.kind === 'skill' ? `（计谋 ${this.lastResult.skillId}）` : ''} → `
      + `${target.name || `#${d ? d.aIdx : '?'}`}`;
    this.ui.pushLog(`${head}：${bits.length ? bits.join('；') : '原版未产生数值变化'}`, 'battle');

    // 命中反馈：若动画还没到命中点，先记下，命中时再放
    if (!this._impactDone) {
      // 动画可能已经播完（本轮还没命中）—— 直接结算，不再等
      if (!this.anim.busy) this._fireImpact();
    }

    const job = this._attackJob;
    this._attackJob = null;
    if (job) {
      const t0 = performance.now();
      await job;
      this.stats.animBlockedMs += Math.round(performance.now() - t0);
    }
    this._fireImpact();            // 兜底：动画已结束时保证反馈一定出现过

    this._setPhase(PHASES.ACTION_COMPLETED, { result: this.lastResult });
    this.scene.refreshFromAdapter?.('resolve-done');
    if (this.over) {
      this._setPhase(PHASES.BATTLE_FINISHED);
    }
    return undefined;
  }

  _onPlayerPhase() {
    // 敌方阶段的「跟随动画」到此为止：直接对齐原版最终位置，避免和玩家操作抢模型
    if (this.anim.pending) this.anim.cancelAll('player-phase');
    this.scene.refreshFromAdapter?.('player-phase');
    this._lastStates = this.adapter.getBattleUnitStates();
    this._setPhase(PHASES.SELECT);
  }

  // ============================================================ 输入通道
  /** 内核 bo() 进入：之后的 waitMsgTimeout 会先向本对象拉取虚拟消息。 */
  beginInput({ hasCell } = {}) {
    if (!this.inBattle) return null;
    // 原版同一个子过程内可能多次进入 bo()（例如 xo() 判定无效后重新选目标）。
    // 此时 *_PENDING 是「上一次点击正在被判定」的瞬态，应退回对应的可交互相位，
    // 否则玩家会被自己的上一次点击永久锁住。
    if (this.phase === PHASES.MOVEMENT_PENDING) {
      this._setPhase(PHASES.UNIT_SELECTED, { unitId: this.selectedUnit, reopen: true });
    }
    else if (this.phase === PHASES.ATTACK_PENDING) this._setPhase(PHASES.ATTACK_PREVIEW, { reopen: true });
    this._token = { id: ++this._tokenSeq, hasCell: !!hasCell, at: Date.now() };
    this.inputActive = true;
    this._pending.length = 0;
    this.stats.inputsOpened++;
    this.stats.trace.push(`bo-open@${Math.round(performance.now())}#${this._token.id}`);
    if (this.stats.trace.length > 24) this.stats.trace.shift();
    this.ui.setInputOpen(true, { hasCell: !!hasCell, phase: this.phase });
    return this._token;
  }

  /** 内核 bo() 退出：清空未投递的消息，避免下个阶段被旧点击污染。 */
  endInput(token) {
    if (token && this._token && token.id !== this._token.id) return;
    this.inputActive = false;
    this._token = null;
    this._pending.length = 0;
    this._pendingPhase = null;
    this.stats.inputsClosed++;
    this.ui.setInputOpen(false, { phase: this.phase });
  }

  /** 只有原版 bo() 内部才会调用它 —— 这是「输入只可能在原版等待输入时生效」的保证。 */
  pullInput(token) {
    if (!token || !this._token || token.id !== this._token.id) return null;
    if (!this._pending.length) return null;
    if (this._pendingPhase !== this.phase) { this._pending.length = 0; return null; }
    return this._pending.shift();
  }

  /** 把一条消息排进「只由 bo() 消费」的队列。 */
  _queue(msg, phase) {
    if (this._pendingPhase !== phase) this._pending.length = 0;
    this._pendingPhase = phase;
    this._pending.push(msg);
  }

  // ------------------------------------------------------------ 地图点击
  /**
   * 3D 点击入口（scene -> controller）。
   * 返回体如实标注 accepted/reason，绝不宣称「移动/攻击已成功」。
   */
  onMapClick({ unitId = null, cell = null } = {}) {
    this.stats.clicks++;
    this.stats.trace.push(`click@${Math.round(performance.now())}(phase=${this.phase},in=${this.inputActive})`);
    if (this.stats.trace.length > 24) this.stats.trace.shift();
    const kind = this.clickKind;
    if (!kind || !this.inputActive) {
      const reason = !this.inBattle ? '不在战斗中'
        : !this.inputActive ? '原版当前不在战斗地图输入状态（bo() 未打开）'
          : `当前状态 ${this.phase} 不接受地图点击`;
      return this._reject(reason);
    }
    const target = cell || (unitId !== null ? this._unitCell(unitId) : null);
    if (!target) return this._reject('没有可映射的格子');
    const injected = this.adapter.clickBattleCell(target.x, target.y);
    if (!injected.injected) {
      return this._reject(injected.reason, { screen: injected.screen, cell: target });
    }
    this.stats.accepted++;
    const next = kind === 'moveCell' ? PHASES.MOVEMENT_PENDING
      : kind === 'targetUnit' ? PHASES.ATTACK_PENDING : this.phase;
    this._setPhase(next, { click: target, kind });
    // 消息必须带着**新相位**入队：pullInput 会用它判断「这条点击是否还属于当前阶段」
    for (const m of injected.messages) this._queue(m, this.phase);
    return {
      accepted: true, kind, cell: target, screen: injected.screen,
      view: injected.view, phase: this.phase,
      note: injected.note,
    };
  }

  /** 拒绝路径统一记录原因（诊断/自动化用；绝不假装成功）。 */
  _reject(reason, extra = {}) {
    this.stats.rejected++;
    this.stats.lastReject = reason;
    return { accepted: false, reason, phase: this.phase, ...extra };
  }

  _unitCell(unitId) {
    try {
      const u = this.adapter.getBattleUnit(unitId);
      return u.present ? { x: u.x, y: u.y } : null;
    } catch (_) { return null; }
  }

  /** 取消（等价于原版 Esc / 键码 40），只在原版允许 cancel 的阶段生效。 */
  cancel() {
    if (!this.canCancel) {
      this.stats.rejected++;
      return { accepted: false, reason: `当前状态 ${this.phase} 不接受取消`, phase: this.phase };
    }
    // 只投递到「仅由 bo() 消费」的虚拟队列：绝不污染原版真实输入队列
    this._queue({ type: 5, param: 40 }, this.phase);
    this.stats.cancels++;
    return { accepted: true, phase: this.phase, source: 'class A.pushMsg + 键码 40（M 映射表）' };
  }

  /** 打开原版战斗菜单（Go()）：投递 Esc 后由原版自己弹出 $r 菜单。 */
  openBattleMenu() {
    if (this.phase !== PHASES.SELECT || !this.inputActive) {
      return {
        accepted: false,
        reason: this.phase !== PHASES.SELECT
          ? `只有在「选部队」状态才能打开战斗菜单（当前 ${this.phase}）`
          : '原版当前不在战斗地图输入状态',
        phase: this.phase,
      };
    }
    this._queue({ type: 5, param: 40 }, this.phase);
    this.stats.cancels++;
    return { accepted: true, phase: this.phase, note: 'Esc 已投递，原版将打开 Go() 战斗菜单' };
  }

  // ============================================================ 菜单接管
  /**
   * 原版 $r() 的战斗菜单（Ao 行动菜单 / Ro 计谋列表 / Go 战斗菜单）。
   * 返回值必须落在原版取值域：0..n-1 或 255（取消）。
   */
  async list(rect, startIdx, items) {
    const text = String(items ?? '');
    const menus = this.adapter.getBattleMenus();
    const labels = splitMenuByRect(text, rect);
    if (!labels.length) return null;                    // 交给原版 2D 菜单
    const kind = text === menus.raw.action ? 'action'
      : text === menus.raw.battle ? 'battle' : 'generic';
    this.stats.menuOpened++;
    let title = '选择';
    let hints = null;
    if (kind === 'action') {
      title = '行动';
      hints = [
        `攻击（原版 Ao case ${ACTION_MENU_INDEX.attack}）`,
        `计谋（原版 Ao case ${ACTION_MENU_INDEX.skill}）`,
        `查看（原版 Ao case ${ACTION_MENU_INDEX.info} → Oo()）`,
        `待机（原版 Ao case ${ACTION_MENU_INDEX.wait}，保留位置）`,
      ];
    } else if (kind === 'battle') {
      title = '战斗菜单';
      hints = [
        `回合结束（原版 Go case ${BATTLE_MENU_INDEX.endTurn}）`,
        '敌军移动 不看/观看',
        '战斗动画 不看/观看',
        '移动速度 快速/慢速',
        '全军撤退（原版会二次确认，本军判负）',
      ];
    }
    const start = Number.isInteger(startIdx) && startIdx >= 0 && startIdx < labels.length
      ? startIdx : 0;
    const value = await this.ui.chooseMenu({
      kind, title, labels, hints, startIndex: start, allowCancel: true,
    });
    const picked = Number.isInteger(value) && value >= 0 && value < labels.length
      ? value : MENU_CANCEL;
    this.ui.pushLog(`菜单「${title}」选择：${picked === MENU_CANCEL ? '取消' : labels[picked]}`, 'menu');
    return { handled: true, value: picked };
  }

  // ============================================================ 敌方跟随
  /**
   * 敌方 AI 阶段的「跟随动画」。
   *
   * 原版 Qo()/Fo() 会直接在 Dn 里改写方位与兵力；表现层每帧对比上一帧快照：
   *   - 位置变了 -> 用当前 g_FightPath（Qo 刚为这支部队调用过 qi()）做视觉路径；
   *   - 部队消失 -> 死亡表现。
   * 这里只补播，不做任何判定；玩家阶段开始时统一 cancelAll 对齐原版。
   */
  trackEnemyPhase(dt) {
    if (this.phase !== PHASES.ENEMY_PHASE) return 0;
    if (this._catchUpBudget <= 0) return 0;
    const now = this.adapter.getBattleUnitStates();
    const prev = this._lastStates;
    this._lastStates = now;
    if (!prev) return 0;
    let played = 0;
    for (const key of Object.keys(now)) {
      const id = Number(key);
      const a = prev[id], b = now[id];
      if (!a || !b) continue;
      if (a.state === 8 && b.state === 8) continue;
      if (b.state === 8 && a.state !== 8) {
        this.anim.die(id);
        this._catchUpBudget--;
        continue;
      }
      if (a.x !== b.x || a.y !== b.y) {
        const field = this.adapter.getBattlePathField();
        const path = buildVisualPath({
          field: field.raw, origin: field.origin,
          from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y },
          width: field.width, blockCost: field.blockCost,
        });
        this.anim.move({ unitId: id, cells: path.cells, timeoutMs: 900 });
        this.stats.enemyCatchUps++;
        played++;
        this._catchUpBudget--;
      }
      if (this._catchUpBudget <= 0) break;
    }
    return played;
  }

  // ============================================================ 诊断
  getSnapshot() {
    return {
      phase: this.phase,
      inBattle: this.inBattle,
      inputActive: this.inputActive,
      selectedUnit: this.selectedUnit,
      round: this.round,
      over: this.over,
      clickKind: this.clickKind,
      canCancel: this.canCancel,
      pendingInputs: this._pending.length,
      lastResult: this.lastResult,
      anim: this.anim.getDiagnostics(),
      stats: { ...this.stats },
      hint: HINTS[this.phase] || '',
    };
  }
}
