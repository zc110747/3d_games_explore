/**
 * P5 BattleAnimationManager —— 战斗动画的唯一入口与队列。
 *
 * 设计约束（P5 §2/§11）：
 *   1. 动画**只表现原版已经确认的结果**：先由原版 vo()/Fo() 改写 g_GenPos，
 *      再由本模块把模型从旧位置补间到新位置；动画失败/超时只影响表现，
 *      不回滚、不重放、不重复提交任何操作。
 *   2. 所有位置都以 unitRenderer.getBaseWorld()（= 原版格子的世界坐标）为基准，
 *      动画只叠加偏移量，因此「动画中的临时位置」永远不会被当成逻辑位置。
 *   3. 单一队列串行执行会互相冲突的动作（移动/攻击/横幅）；
 *      受击闪光、伤害飘字、死亡下沉属于「并发放映」，不占队列。
 *   4. 每个任务都有硬超时；场景退出时 cancelAll() 立即结算所有 await，
 *      不会让原版协程卡在 await 上。
 */
import { ANIM, FX_STYLE } from './config.mjs';

export class BattleAnimationManager {
  constructor({ THREE, unitRenderer, rangeRenderer, coordinate, ui = null, getCamera = null, getViewport = null, log = () => {} }) {
    if (!THREE || !unitRenderer || !coordinate) throw new TypeError('BattleAnimationManager 依赖不完整');
    this.THREE = THREE;
    this.unitRenderer = unitRenderer;
    this.rangeRenderer = rangeRenderer;
    this.coordinate = coordinate;
    this.ui = ui;
    this._getCamera = getCamera;
    this._getViewport = getViewport;
    this.log = log;

    this._queue = [];
    this._active = null;
    this._effects = [];
    this._projectiles = [];
    this._elapsed = 0;
    this._projectilePool = [];
    this.stats = {
      queued: 0, started: 0, finished: 0, cancelled: 0, timedOut: 0,
      moves: 0, attacks: 0, hits: 0, deaths: 0, banners: 0, maxQueue: 0,
    };
  }

  get busy() { return !!this._active; }
  get pending() { return this._queue.length + (this._active ? 1 : 0); }
  get activeKind() { return this._active ? this._active.kind : null; }

  // -------------------------------------------------------------- 队列
  /**
   * 入队一个动画任务。返回的 Promise 在任务结束（或被取消/超时）时 resolve，
   * 永远不会 reject —— 调用方是原版协程的 shim，不能因为表现层异常中断游戏。
   */
  _enqueue(job) {
    this.stats.queued++;
    this.stats.maxQueue = Math.max(this.stats.maxQueue, this._queue.length + 1);
    return new Promise((resolve) => {
      job.awaiter = resolve;
      job.t = 0;
      this._queue.push(job);
      this._pump();
    });
  }

  _pump() {
    if (this._active || !this._queue.length) return;
    const job = this._queue.shift();
    this._active = job;
    job.t = 0;
    this.stats.started++;
    try { if (job.begin) job.begin(); } catch (e) { this.log(`动画开始失败：${e.message}`); }
  }

  _finish(job, reason) {
    if (!job || job === null) return;
    try { if (job.end) job.end(); } catch (e) { this.log(`动画收尾失败：${e.message}`); }
    if (reason === 'timeout') this.stats.timedOut++;
    if (reason === 'cancelled') this.stats.cancelled++;
    else this.stats.finished++;
    if (this._active === job) this._active = null;
    job.awaiter({ kind: job.kind, reason: reason || 'done', elapsed: job.t });
    job.awaiter = null;
    this._pump();
  }

  /** 场景退出 / 战斗结束时调用：立刻结算所有等待，清空视觉偏移。 */
  cancelAll(reason = 'cancelled') {
    const jobs = this._active ? [this._active, ...this._queue] : [...this._queue];
    this._queue.length = 0;
    this._active = null;
    for (const job of jobs) {
      try { if (job.end) job.end(); } catch (_) { /* ignore */ }
      this.stats.cancelled++;
      if (job.awaiter) { job.awaiter({ kind: job.kind, reason, elapsed: job.t }); job.awaiter = null; }
    }
    this._effects.length = 0;
    this._releaseProjectiles();
    if (this.unitRenderer) {
      for (const id of [...this._visIds()]) this.unitRenderer.clearVisual(id);
      for (const id of this.unitRenderer._held ? [...this.unitRenderer._held] : []) {
        this.unitRenderer.holdUnit(id, false);
      }
    }
    return jobs.length;
  }

  _visIds() {
    const out = [];
    if (this.unitRenderer && this.unitRenderer._vis) for (const k of this.unitRenderer._vis.keys()) out.push(k);
    return out;
  }

  // -------------------------------------------------------------- 移动
  /**
   * 沿路径把模型从起点补间到终点。
   * @param {{unitId:number, cells:Array<{x:number,y:number}>, timeoutMs?:number}} opts
   */
  move({ unitId, cells, timeoutMs = ANIM.moveTotalTimeoutMs }) {
    const pts = (cells || []).map((c) => {
      const w = this.coordinate.gridToWorld(c.x, c.y);
      return { x: w.x, z: w.z };
    });
    if (pts.length < 2) return Promise.resolve({ kind: 'move', reason: 'no-path' });
    this.stats.moves++;
    const segs = pts.length - 1;
    const per = Math.max(ANIM.moveSecMinSegment,
      Math.min(ANIM.moveSecPerCell, timeoutMs / 1000 / Math.max(1, segs)));
    const dur = segs * per * 1000;          // job.t 以毫秒累加
    return this._enqueue({
      kind: 'move', unitId, dur, timeoutMs,
      tick: (job, dt) => {
        const p = Math.min(1, job.t / dur);
        const f = p * segs;
        const i = Math.min(segs - 1, Math.floor(f));
        const k = f - i;
        const a = pts[i], b = pts[i + 1];
        const wx = a.x + (b.x - a.x) * k;
        const wz = a.z + (b.z - a.z) * k;
        const base = this.unitRenderer.getBaseWorld(unitId);
        if (!base) return true;                       // 部队已不在场：直接结束
        // 抬脚弧度：每格中点最高，起落为 0（绝不穿地）
        const hop = Math.sin(Math.PI * k) * ANIM.moveHopHeight;
        const rotY = Math.atan2(b.x - a.x, b.z - a.z);
        this.unitRenderer.setVisual(unitId, {
          dx: wx - base.x, dz: wz - base.z, dy: hop, rotY,
        });
        return p >= 1;
      },
      end: () => this.unitRenderer.clearVisual(unitId),
    });
  }

  // -------------------------------------------------------------- 攻击
  /**
   * 攻击动作。`onImpact` 在「动作命中瞬间」被调用一次 —— 由调用方在此刻
   * 用**原版真实数据**触发受击/伤亡表现（本模块不计算伤害）。
   *
   * 动作按原版兵种（ArmsType 0..5，名称见界面字符串 [12]）分三类：
   *   0 骑兵：冲锋（快速前冲）
   *   1 步兵：前踏挥击
   *   2 弓兵：拉弓 + 抛射体
   *   3 水军：浪涌（原地前压）
   *   4 极兵 / 5 玄兵：术法（原地蓄力 + 光弹）
   */
  attack({ attackerId, targetId, armsType = 1, onImpact = null, timeoutMs = ANIM.attackTimeoutMs }) {
    const from = this.unitRenderer.getBaseWorld(attackerId);
    const to = this.unitRenderer.getBaseWorld(targetId);
    if (!from || !to) return Promise.resolve({ kind: 'attack', reason: 'missing-unit' });
    this.stats.attacks++;

    const dx = to.x - from.x, dz = to.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    const rotY = Math.atan2(ux, uz);
    const ranged = armsType === 2 || armsType === 4 || armsType === 5;
    const lungeDist = ranged ? 0.16 : Math.min(0.42, len * 0.30);

    const MS = 1000;                        // job.t 以毫秒累加
    const t0 = ANIM.attackLungeSec * MS;
    const t1 = t0 + ANIM.attackHoldSec * MS;
    const t2 = t1 + ANIM.attackReturnSec * MS;
    const dur = ranged ? (ANIM.attackProjectileSec * MS + ANIM.attackReturnSec * MS) : t2;
    let impacted = false;
    const fire = () => {
      if (impacted) return;
      impacted = true;
      if (ranged) this._spawnProjectile(from, to, armsType, onImpact);
      else if (onImpact) { try { onImpact(); } catch (e) { this.log(`命中回调失败：${e.message}`); } }
    };
    return this._enqueue({
      kind: 'attack', attackerId, targetId, dur, timeoutMs,
      begin: () => this.unitRenderer.setVisual(attackerId, { rotY }),
      tick: (job) => {
        const t = job.t;
        const base = this.unitRenderer.getBaseWorld(attackerId);
        if (!base) return true;
        let k;
        if (ranged) {
          k = t < ANIM.attackProjectileSec * MS * 0.45 ? -0.25 : 0;   // 拉弓后坐
        } else if (t < t0) {
          k = easeOut(t / t0);
        } else if (t < t1) {
          k = 1;
        } else {
          k = 1 - easeIn((t - t1) / (ANIM.attackReturnSec * MS));
        }
        this.unitRenderer.setVisual(attackerId, {
          dx: ux * lungeDist * k, dz: uz * lungeDist * k, dy: 0, rotY,
        });
        const impactAt = ranged ? ANIM.attackProjectileSec * MS * 0.5 : t0;
        if (!impacted && t >= impactAt) fire();
        return t >= dur;
      },
      end: () => {
        if (!impacted) fire();
        this.unitRenderer.clearVisual(attackerId);
      },
    });
  }

  _spawnProjectile(from, to, armsType, onImpact) {
    const THREE = this.THREE;
    const geo = this._projectilePool.pop() || new THREE.SphereGeometry(armsType === 2 ? 0.09 : 0.14, 8, 6);
    const color = armsType === 2 ? 0xffe0a0 : armsType === 4 ? 0x9ad0ff : 0xc9a3ff;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(from.x, 0.9, from.z);
    mesh.renderOrder = 10;
    if (this.unitRenderer.group) this.unitRenderer.group.add(mesh);
    this._projectiles.push({
      mesh, mat, geo, from, to, t: 0, dur: ANIM.attackProjectileSec,
      arc: 0.9 + Math.min(1.4, Math.hypot(to.x - from.x, to.z - from.z) * 0.12),
      onImpact,
    });
  }

  _releaseProjectiles() {
    for (const p of this._projectiles) {
      if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
      try { p.mat.dispose(); } catch (_) { /* ignore */ }
      this._projectilePool.push(p.geo);
    }
    this._projectiles.length = 0;
  }

  // -------------------------------------------------------------- 反馈
  /** 受击：闪色 + 抖动 + 伤害飘字（数值来自原版状态差，不在此计算）。 */
  hit(unitId, { text = '', tone = 'damage' } = {}) {
    this.stats.hits++;
    this.unitRenderer.setFlash(unitId, ANIM.hitFlashSec);
    const base = this.unitRenderer.getBaseWorld(unitId);
    const amp = ANIM.hitShakeAmp;
    const dir = Math.random() > 0.5 ? 1 : -1;
    this._effects.push({
      t: 0, dur: ANIM.hitFlashSec * 1000,
      tick: (e) => {
        const k = 1 - e.t / e.dur;
        const sway = Math.sin(e.t * 46) * amp * k;
        const b = this.unitRenderer.getBaseWorld(unitId);
        if (!b) return true;
        this.unitRenderer.setVisual(unitId, { dx: sway * dir, dz: sway * 0.4, dy: 0 });
        return e.t >= e.dur;
      },
      end: () => this.unitRenderer.clearVisual(unitId),
    });
    if (text && base) this.floatText(base, text, tone);
  }

  /** 死亡：原版已把 state 置 8，这里保持可见播完下沉/缩小，再交还给原版状态。 */
  die(unitId) {
    this.stats.deaths++;
    this.unitRenderer.holdUnit(unitId, true);
    this._effects.push({
      t: 0, dur: ANIM.deathSec * 1000,
      tick: (e) => {
        const p = Math.min(1, e.t / (ANIM.deathSec * 1000));
        this.unitRenderer.setVisual(unitId, {
          dy: -ANIM.deathSink * p,
          scale: Math.max(0.15, 1 - 0.85 * p),
          rotY: ANIM.deathSpin * p,
          badgeOpacity: Math.max(0, 1 - p * 1.6),
        });
        return p >= 1;
      },
      end: () => {
        this.unitRenderer.clearVisual(unitId);
        this.unitRenderer.holdUnit(unitId, false);
      },
    });
  }

  /** 横幅（回合/阶段/战果提示）。属于「辅助动画」，同样走队列但不阻塞输入判定。 */
  banner({ title, subtitle = '', tone = 'info', seconds = ANIM.turnBannerSec }) {
    this.stats.banners++;
    if (this.ui) this.ui.showBanner({ title, subtitle, tone, seconds });
    return Promise.resolve({ kind: 'banner', reason: 'shown' });
  }

  // -------------------------------------------------------------- 飘字
  /** 世界坐标 -> 屏幕像素飘字（DOM，不进 3D 场景）。 */
  floatText(world, text, tone = 'damage') {
    if (!this.ui || !this._getCamera || !this._getViewport) return false;
    const cam = this._getCamera();
    const vp = this._getViewport();
    if (!cam || !vp) return false;
    const v = new this.THREE.Vector3(world.x, 0.95, world.z).project(cam);
    const x = vp.left + (v.x + 1) * 0.5 * vp.width;
    const y = vp.top + (1 - v.y) * 0.5 * vp.height;
    this.ui.floatText(x, y, text, tone);
    return true;
  }

  // -------------------------------------------------------------- 帧更新
  update(dt) {
    this._elapsed += dt;
    // 队列
    const job = this._active;
    if (job) {
      job.t += dt * 1000;
      let done = false;
      try { done = job.tick ? job.tick(job, dt) : true; } catch (e) { this.log(`动画帧失败：${e.message}`); done = true; }
      if (job.t >= job.timeoutMs) { this._finish(job, 'timeout'); }
      else if (done) { this._finish(job, 'done'); }
    }
    // 并发特效
    for (let i = this._effects.length - 1; i >= 0; i--) {
      const e = this._effects[i];
      e.t += dt * 1000;
      let done = false;
      try { done = e.tick(e, dt); } catch (_) { done = true; }
      if (done) {
        try { if (e.end) e.end(); } catch (_) { /* ignore */ }
        this._effects.splice(i, 1);
      }
    }
    // 抛射体
    for (let i = this._projectiles.length - 1; i >= 0; i--) {
      const p = this._projectiles[i];
      p.t += dt;
      const k = Math.min(1, p.t / p.dur);
      const x = p.from.x + (p.to.x - p.from.x) * k;
      const z = p.from.z + (p.to.z - p.from.z) * k;
      const y = 0.9 + Math.sin(Math.PI * k) * p.arc;
      p.mesh.position.set(x, y, z);
      p.mat.opacity = 1 - Math.max(0, k - 0.85) * 5;
      if (k >= 1) {
        if (p.onImpact) { try { p.onImpact(); } catch (e) { this.log(`抛射命中回调失败：${e.message}`); } }
        if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
        try { p.mat.dispose(); } catch (_) { /* ignore */ }
        this._projectilePool.push(p.geo);
        this._projectiles.splice(i, 1);
      }
    }
  }

  getDiagnostics() {
    return {
      ...this.stats,
      active: this.activeKind,
      pending: this.pending,
      effects: this._effects.length,
      projectiles: this._projectiles.length,
      visOverrides: this._visIds().length,
    };
  }
}

function easeOut(x) { return 1 - (1 - x) * (1 - x); }
function easeIn(x) { return x * x; }

/** 飘字颜色（表现层参数）。 */
export const FLOAT_TONES = Object.freeze({
  damage: FX_STYLE.damageColor,
  provender: FX_STYLE.damageProvColor,
  exp: FX_STYLE.expColor,
  heal: '#62d08a',
});
