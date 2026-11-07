# 三国霸业 3D 重制 —— 工程长期记忆

## 定位与铁律
- 3D 层是**表现层重制**，不是重写游戏：原版 `original/site/sgby.min.js` 及其 14 个原版文件**零改动**。
- 桥接：`sgby.core.js` = `sgby.min.js` + 桥接尾注（18 处改名可逆），校验项保证「反向还原后逐字节相同」。
  `tools/make_core.mjs` 生成，导出 `window.__SGBY_CORE__`（`Dn` + `fns`）。
- **无打包器**（设计选择）：原生 ES 模块 + importmap（`three` → `p1/vendor/three.module.js`），
  「正式构建」= 静态文件直出 + `tools/verify_build.mjs` 校验。必须经 HTTP 访问（`file://` 不行）。
- 唯一 `RenderManager`（唯一 WebGLRenderer、唯一自续 rAF）、唯一事件总线、唯一场景切换入口
  `SceneDirector`、唯一数据源 `Dn`。不要去建第二个循环/第二个 renderer。
- 三层坐标：逻辑格（战略 12×9 / 战斗 32×32）→ Three 世界坐标 → 屏幕像素；另有原版 240×320
  虚拟屏命中坐标（`zs()` = `floor((x+a)/32)`）。拾取用 Raycaster 反查，不用屏幕坐标猜。

## 规则零复制
城市指令走原版 `mi()/Ls()/$r()` 协程控件；战斗走 `ko/vo/xo/Ao/Fo/Io/Eo/So`；范围用 `qi()/Vo()`；
存档用 `jn/ac/oc`。3D 层只做「投递输入 + 读结果」，任何"自己算一遍"的实现都是错的方向。

## 验收口径（写报告时的规矩）
- 所有数字必须来自真实运行；**不可测就写不可测**（GPU 帧时间、显存浏览器不暴露）。
- 测试环境是 SwiftShader 软件光栅化 → FPS 绝对值不代表真实显卡，只做同环境前后对比。
- 本机只有 Edge 156（无 Chrome），Chrome 只能标「未实测」。
- 「代码已实现」不能作为验收依据；每项要写实测依据（读了哪个字段、多少数量、什么值）。

## 怎么跑
```bash
node tools/verify_build.mjs        # 11 项构建/资源/架构校验
for f in tests/*.test.mjs; do node "$f"; done    # Node 161 项（不能 node --test tests/ 传目录）
node tests/smoke.mjs               # 浏览器端到端 152 项（自起服务 + 无头 Edge + 真实点击）
node tests/perf.mjs final          # 性能基准，写 tests/.perf/<label>.json
start.bat                          # 一键起服务并开浏览器（纯 ASCII，勿加中文）
```

## 关键陷阱（踩过的）
1. 上下文丢失后 `gl.getExtension()` 返回 **null** → `WEBGL_lose_context` 必须**丢失前**缓存。
2. 帧时间统计不能用钳位后的 `dt`（`Math.min(0.1,…)` 只给模拟用）→ 用帧钩子的 `rawMs`。
3. 致命面板容器 mount 时就常驻 DOM，判可见性用 `ui.getStatus().fatal`，别用 `getElementById`。
4. `renderer.getSize()` 是 **CSS 逻辑尺寸**；验证高 DPI 看 `canvas.width/height`。
5. 状态指纹里不能混 `fps/drawCalls`；长跑基线要在场景装配**之后**取（否则把装配当泄漏）。
6. `getInputPhase().kind==='zs'` 不等于玩家在城市阶段，还要 `__P3__.getStatus().cityLoop===true`。
7. 探针里 `if (!x) continue` 必须有「跳过计数」，否则会静默变成假通过。

## 当前状态
P1~P7 全部完成，P7 为最终质量验收阶段（commit 62ae442）。交付报告 `docs/P7-最终验收报告.md`。
验收 A~F 通过，2 项有条件通过（战略整回合未单独驱动、无真实旧档样本）。**P7 之后不自动进入新阶段**。
