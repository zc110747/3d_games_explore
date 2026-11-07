/**
 * P6 ErrorHub —— 统一异常上报与恢复。
 *
 * P6 文档「十一、异常处理与恢复」要求：错误信息明确、不允许黑屏、不允许无限重试、
 * 不允许状态永久不一致、能恢复的给恢复路径、不能恢复的明确提示。
 *
 * 这里把「上报」与「恢复」分开：
 *   report() 只记录 + 决定级别（可恢复 / 致命），不吞异常信息；
 *   recover() 执行显式登记的恢复动作（回到战略地图 / 重建表现层 / 重载页面）。
 *
 * 反复失败会自动升级：同一 scope 连续 3 次可恢复错误 -> 视为致命，
 * 避免「报错 -> 恢复 -> 又报错」的死循环被当成正常。
 */

import { ERROR_KIND } from './config.mjs';

const MAX_RECENT = 20;
const ESCALATE_COUNT = 3;

export class ErrorHub {
  constructor({ ui = null, log = () => {}, onStateChange = null } = {}) {
    this.ui = ui;
    this.log = log;
    this.onStateChange = onStateChange;
    this.recent = [];
    this.counts = new Map();      // scope -> 连续可恢复错误次数
    this.recoveries = new Map();  // name -> fn
    this.stats = { reports: 0, recoverable: 0, fatal: 0, escalated: 0, recovered: 0, recoveryFailures: 0 };
  }

  registerRecovery(name, fn) {
    if (typeof fn !== 'function') throw new TypeError(`恢复动作 ${name} 必须是函数`);
    this.recoveries.set(name, fn);
    return this;
  }

  /**
   * @param {string} scope 出错位置（'scene:switch' / 'battle:init' / 'save:load' …）
   * @param {Error|string} error
   * @param {object} [opts] { kind, context, fatal, actions }
   */
  report(scope, error, { kind = ERROR_KIND.RECOVERABLE, context = {}, fatal = false, actions = null } = {}) {
    this.stats.reports++;
    const message = error && error.message ? error.message : String(error);
    const n = (this.counts.get(scope) || 0) + 1;
    this.counts.set(scope, n);
    let level = kind;
    if (n >= ESCALATE_COUNT && level !== ERROR_KIND.FATAL) {
      level = ERROR_KIND.FATAL;
      this.stats.escalated++;
    }
    if (fatal) level = ERROR_KIND.FATAL;
    if (level === ERROR_KIND.FATAL) this.stats.fatal++; else this.stats.recoverable++;

    const entry = {
      scope, message, level, at: Date.now(), attempts: n,
      stack: error && error.stack ? String(error.stack).split('\n').slice(0, 4).join('\n') : '',
      context,
    };
    this.recent.push(entry);
    if (this.recent.length > MAX_RECENT) this.recent.shift();
    this.log(`[${level}] ${scope}: ${message}${n > 1 ? `（第 ${n} 次）` : ''}`);

    if (level === ERROR_KIND.FATAL && this.ui) {
      this.ui.showFatal({
        title: `运行错误 · ${scope}`,
        message: `${message}\n\n上下文：${JSON.stringify(context)}\n\n恢复建议：先点「回到战略地图」；若仍失败请重新加载页面（原版存档不会丢失）。`,
        actions: actions || [
          { label: '回到战略地图', onClick: () => this.recover('world') },
          { label: '重新加载页面', onClick: () => this.recover('reload') },
        ],
      });
    }
    if (typeof this.onStateChange === 'function') {
      try { this.onStateChange(entry); } catch (_) { /* 展示失败不影响运行 */ }
    }
    return entry;
  }

  /** 某 scope 成功后清零连续失败计数（避免历史错误永远影响升级判定）。 */
  clear(scope) { this.counts.delete(scope); }

  recover(name) {
    const fn = this.recoveries.get(name);
    if (!fn) return { ok: false, reason: `未登记恢复动作 ${name}` };
    try {
      const r = fn();
      this.stats.recovered++;
      for (const k of this.counts.keys()) this.counts.delete(k);
      if (this.ui) this.ui.hideFatal();
      return { ok: true, result: r };
    } catch (e) {
      this.stats.recoveryFailures++;
      this.log(`恢复动作 ${name} 失败：${e.message}`);
      return { ok: false, reason: e.message };
    }
  }

  /** 把同步/异步调用包起来，统一上报（保留原始异常信息，不静默）。 */
  async guard(scope, fn, opts = {}) {
    try {
      const r = await fn();
      this.clear(scope);
      return { ok: true, value: r };
    } catch (e) {
      const entry = this.report(scope, e, opts);
      return { ok: false, error: e, entry };
    }
  }

  getStatus() {
    return {
      ...this.stats,
      recent: this.recent.slice(-8),
      scopes: [...this.counts.entries()].map(([scope, n]) => ({ scope, n })),
      recoveries: [...this.recoveries.keys()],
    };
  }
}
