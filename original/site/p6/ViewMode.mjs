/**
 * P6 ViewMode —— 「原版 2D 菜单」与「3D 游戏界面」的视图切换。
 *
 * 需求（用户裁决）：
 *   1) 启动后先进入原版主界面（主菜单 → 选剧本 → 选君主 → 难度 …），
 *      这一步**不做 3D 化**，菜单与操作完全沿用原版；
 *   2) 只有真正进入剧本主界面（原版 zs() 显示 12x9 战略地图）才切到 3D。
 *
 * 判据全部来自只读诊断：GameAdapter.getInputPhase().kind。
 * 本模块不写任何游戏状态，也不改变原版协程流程；它只切 DOM 显示与 3D 渲染开关。
 */
import { VIEW_MODE, VIEW_CONFIG } from './config.mjs';

export class ViewMode {
  /**
   * @param {object} deps
   * @param {object} deps.adapter   GameAdapter（只读）
   * @param {(mode:string, info:object)=>void} [deps.onChange]
   * @param {number} [deps.pollMs]
   */
  constructor({ adapter, onChange = null, pollMs = VIEW_CONFIG.pollMs, guardGame = null }) {
    if (!adapter) throw new TypeError('ViewMode 需要 GameAdapter');
    this.adapter = adapter;
    this.onChange = onChange;
    this.pollMs = pollMs;
    // 兜底：战斗/P4 已接管时，任何 kind 都不能把画面切回 2D（否则战斗看不见）
    this.guardGame = typeof guardGame === 'function' ? guardGame : null;
    this.mode = VIEW_MODE.MENU;       // 启动默认：原版主界面
    this.lastPhase = null;
    this._timer = null;
    this._started = false;
    this._hold = false;
    this.stats = { switches: 0, menu: 1, game: 0, unknown: 0, lastKind: 'unknown', forced: 0 };
  }

  start() {
    if (this._started) return this;
    this._started = true;
    this._apply(this.mode, { kind: 'boot', reason: '启动默认进入原版主界面' }, { force: true });
    this._timer = setInterval(() => this.poll(), this.pollMs);
    return this;
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._started = false;
  }

  /** 轮询一次；只有判据明确时才切换，unknown 保持原状避免画面抖动。 */
  poll() {
    if (this._hold) return this.mode;    // 人工钉住（调试"原版画面"按钮）
    let phase;
    try { phase = this.adapter.getInputPhase(); } catch (_) { return this.mode; }
    this.lastPhase = phase;
    this.stats.lastKind = phase.kind;
    let next = this.mode;
    if (VIEW_CONFIG.gameKinds.includes(phase.kind)) next = VIEW_MODE.GAME;
    else if (VIEW_CONFIG.menuKinds.includes(phase.kind)) {
      // 战斗中绝不切回 2D：原版战斗循环里的等待协程可能落到 menu 规则上，
      // 这里用"原版战斗是否真的在进行"做兜底，判定优先级高于 kind。
      const inBattle = this.guardGame ? !!this.guardGame() : false;
      next = inBattle ? VIEW_MODE.GAME : VIEW_MODE.MENU;
    } else { this.stats.unknown++; return this.mode; }
    if (next === this.mode) return this.mode;
    this._apply(next, phase);
    return this.mode;
  }

  /** 暂停自动判定，保持当前视图（调试对照用）。 */
  setHold(hold) {
    this._hold = !!hold;
    return this._hold;
  }

  get held() { return !!this._hold; }

  /** 调试/测试用：显式切换（不改变原版流程，只改视图）。 */
  force(mode) {
    if (mode !== VIEW_MODE.MENU && mode !== VIEW_MODE.GAME) {
      throw new RangeError(`未知视图模式: ${mode}`);
    }
    this.stats.forced++;
    this._apply(mode, { kind: 'forced', reason: '显式切换（调试入口）' });
    return this.mode;
  }

  _apply(mode, phase, { force = false } = {}) {
    const prev = this.mode;
    if (mode === prev && !force) return;
    this.mode = mode;
    this.stats.switches++;
    this.stats[mode]++;
    if (typeof document !== 'undefined') document.body.dataset.sangoView = mode;
    if (this.onChange) {
      try { this.onChange(mode, { from: prev, phase, force }); }
      catch (e) { console.error('[P6] 视图切换回调异常:', e); }
    }
  }
}
