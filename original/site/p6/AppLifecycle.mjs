/**
 * P6 AppLifecycle —— 统一启动入口与运行状态机。
 *
 * 为什么需要它：P1~P5 各自在自己的 boot 里做初始化，启动顺序只靠 main.mjs 的
 * 书写顺序隐式保证，一旦有人插错位置（例如在 RenderManager 之前建场景）就只能靠
 * 白屏排查。这里把「初始化步骤」变成可登记、可校验、可诊断的序列：
 *
 *   booting -> connecting -> ready -> running
 *                                  \-> failed
 *
 * 它**不重复初始化**任何东西，只负责：
 *   1) 每个阶段只允许执行一次（重复初始化立刻报错，而不是静默双开）；
 *   2) 记录每步耗时与结果，失败时给出明确阶段名（不是「启动失败」四个字）；
 *   3) 登记「必须唯一」的全局对象（Renderer / 渲染循环 / 事件总线 / 存档管理器），
 *      供 P6 自检断言「不存在多个渲染循环 / 多个权威状态源」。
 */

import { RUNTIME } from './config.mjs';

export class AppLifecycle {
  constructor({ log = () => {}, onStateChange = null } = {}) {
    this.log = log;
    this.onStateChange = onStateChange;
    this.state = 'booting';
    this.stages = [];
    this._ran = new Set();
    this._singletons = new Map();
    this._timers = new Set();
    this.startedAt = 0;
    this.stats = { stages: 0, failures: 0, duplicates: 0, singletons: 0 };
  }

  setState(next) {
    if (!RUNTIME.states.includes(next)) throw new RangeError(`未知运行状态: ${next}`);
    if (this.state === next) return this.state;
    const from = this.state;
    this.state = next;
    if (typeof this.onStateChange === 'function') {
      try { this.onStateChange(next, from); } catch (_) { /* 状态展示失败不影响启动 */ }
    }
    return next;
  }

  /**
   * 执行一个初始化阶段。stage 重复执行会被拒绝（这是「重复初始化」的第一道闸）。
   * @param {string} name 阶段名（诊断里会原样显示）
   * @param {Function} fn 同步或异步
   */
  async stage(name, fn) {
    if (this._ran.has(name)) {
      this.stats.duplicates++;
      throw new Error(`初始化阶段「${name}」被重复执行（统一入口只允许初始化一次）`);
    }
    this._ran.add(name);
    this.stats.stages++;
    const t0 = Date.now();
    try {
      const result = await fn();
      this.stages.push({ name, ok: true, ms: Date.now() - t0, error: null });
      return result;
    } catch (e) {
      this.stats.failures++;
      this.stages.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
      this.log(`初始化阶段「${name}」失败：${e.message}`);
      throw new Error(`初始化失败于「${name}」：${e.message}`);
    }
  }

  /**
   * 登记一个必须唯一的全局对象。
   * 重复登记不同实例 = 真的出现了双份（第二个渲染器/第二个循环），必须拒绝。
   */
  claim(kind, instance, { allowSame = true } = {}) {
    const prev = this._singletons.get(kind);
    if (prev !== undefined) {
      if (allowSame && prev === instance) return prev;
      this.stats.duplicates++;
      throw new Error(`全局对象「${kind}」重复登记（已存在，说明有第二个实例在跑）`);
    }
    this._singletons.set(kind, instance);
    this.stats.singletons++;
    return instance;
  }

  has(kind) { return this._singletons.has(kind); }
  get(kind) { return this._singletons.get(kind); }
  get singletonKinds() { return [...this._singletons.keys()]; }

  /** 统一登记 setInterval/setTimeout，dispose 时全部清理（防止场景切换后残留计时器）。 */
  interval(fn, ms, label = 'timer') {
    const id = setInterval(fn, ms);
    this._timers.add({ id, kind: 'interval', label });
    return id;
  }

  clearInterval(id) {
    for (const t of this._timers) if (t.id === id) { this._timers.delete(t); break; }
    clearInterval(id);
  }

  get timerCount() { return this._timers.size; }
  get timerLabels() { return [...this._timers].map((t) => t.label); }

  get bootMs() { return this.startedAt ? Date.now() - this.startedAt : 0; }

  /** 单行启动摘要（状态面板与报告都用它，避免两处口径不一致）。 */
  summary() {
    const ok = this.stages.filter((s) => s.ok).length;
    return {
      state: this.state,
      stages: this.stages.length,
      ok,
      failed: this.stages.length - ok,
      duplicates: this.stats.duplicates,
      totalMs: this.stages.reduce((n, s) => n + s.ms, 0),
      singletons: this.singletonKinds,
      timers: this.timerCount,
      steps: this.stages.map((s) => ({ name: s.name, ok: s.ok, ms: s.ms, error: s.error })),
    };
  }

  dispose() {
    for (const t of this._timers) {
      if (t.kind === 'interval') clearInterval(t.id);
      else clearTimeout(t.id);
    }
    this._timers.clear();
    this._singletons.clear();
    this._ran.clear();
  }
}
