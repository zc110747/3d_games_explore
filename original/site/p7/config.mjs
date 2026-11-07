/**
 * P7 配置 —— 全部数值都是「实测后定的阈值」或「明确的测量口径」。
 *
 * 不在这里放任何游戏规则数值；游戏规则一律来自原版。
 */

export const P7_VERSION = '7.0.0-p7';

/**
 * 帧时间采样口径。
 * - windowSize：环形缓冲长度（240 帧 ≈ 4s@60fps，足够算 p95/p99）。
 * - dropThresholdMs：超过这个间隔算「掉帧」（60fps 一帧 16.7ms，20ms 已明显掉）。
 */
export const PERF_CONFIG = Object.freeze({
  windowSize: 240,
  dropThresholdMs: 20,
  slowFrameMs: 25,
  heapSampleMs: 1000,
  /** renderer.info 每帧刷新；JS 堆读 performance.memory（Chromium 才有）。 */
  heapAvailable: typeof performance !== 'undefined' && !!performance.memory,
});

/**
 * 自适应分辨率：填充率受限时降像素比，恢复后升回。
 *
 * 依据：P7 基线实测（无头 Edge + SwiftShader 软件光栅化）
 *   1600x900 @dpr1 -> 59.7 FPS / mean 16.76ms
 *   1600x900 @dpr2 -> 24.2 FPS / mean 41.32ms（像素量 4 倍，帧时间 2.5 倍）
 * 说明瓶颈在填充率而非 draw call（88 calls / 13k 三角形）。
 * 因此按帧时间反馈调 dpr，是这里唯一有数据支撑的优化方向。
 */
export const ADAPTIVE_CONFIG = Object.freeze({
  enabled: true,
  steps: Object.freeze([0.75, 1, 1.25, 1.5, 1.75, 2]),
  startAtDevicePixelRatio: true,   // 初始 cap = min(devicePixelRatio, maxPixelRatio)
  downAboveP95Ms: 22,              // 超过 -> 立即降档（约 <45fps）；超 2 倍一次降两档
  upBelowMeanMs: 18,               // 稳定跑满 vsync（60Hz 一帧 16.7ms）才试探升档
  upBelowP95Ms: 18,                // 且不能有掉帧（p95 也必须贴住 vsync）
  windowMs: 1200,                  // 评估窗口
  consecutiveWindows: 2,           // 升档需连续 2 个窗口达标（降档立即生效，保护优先）
  cooldownMs: 1800,                // 改变后冷却
  ceilingMs: 60000,                // 降档后该档位 60s 内不再尝试（防来回抖）
  /** 启动前几个窗口不参与决策：加载/首帧抖动不是填充率问题。 */
  warmupWindows: 3,
  /**
   * 有效下限：不低于 1 与设备像素比中的较小者。
   * 原因：dpr=1 的屏幕上再降到 0.75 只会明显变糊而省不下多少（本来就只有一个屏幕像素），
   * 自适应分辨率只用于「高 DPI 屏幕填充率不足」这一种情况。
   */
  minCap: 0.75,
  maxCap: 2,
});

/**
 * 上下文丢失后等待恢复的时间。
 * 超过则给用户明确提示（不自动重建业务状态，只建议刷新渲染层）。
 */
export const CONTEXT_LOST_CONFIG = Object.freeze({
  restoreGraceMs: 6000,
  promptTitle: '3D 渲染已中断',
  promptBody: '浏览器回收了 WebGL 上下文。页面会自动尝试恢复；'
    + '若长时间没有画面，请点「重新加载页面」（存档与回合状态不会因此丢失）。',
});
