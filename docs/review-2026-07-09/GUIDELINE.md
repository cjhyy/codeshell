# Review Guideline — Core 引擎 + 桌面流架构审查

> 日期：2026-07-09
> 编排者：卡密sama（本会话产出本 guideline）
> 执行者：**codex**（通过 DriveAgent 驱动，串行、独立会话）
> 目标产物落盘位置：`docs/review-2026-07-09/`

---

## 0. 这份文档是什么

这是一份**给 codex 的任务契约**。它规定：

1. **审查什么**——只覆盖 **core 引擎（engine / tool-system / protocol）** 与 **desktop 消费这条流**；tui、cdp 本轮不碰。
2. **怎么审**——两阶段：先把架构讲清楚（结构 / 设计 / 为什么这么做），再基于讲清楚的架构反过来挑不合理点。
3. **结果去哪**——每个模块一篇结构说明，桌面流一篇端到端步骤说明，最后一篇优化点清单。全部落在 `docs/review-2026-07-09/`。

卡密sama 读完这些文档，能回答「每一块怎么设计的、为什么、问题在哪」，从而定位问题。

**可视化视频 HTML（把桌面流每一步像视频一样逐帧演示）本轮不实现**，只在 §5 写清规格，后续用 rednote / mimi-video skill + codex 单独做。

---

## 1. 审查哲学（codex 必须遵守）

对**每一个模块**，都要回答三层，缺一不可：

| 层 | 问题 | 反面教材（不合格） |
|---|---|---|
| **结构 What** | 这个模块由哪些文件/类/函数组成，各自职责边界在哪 | 只贴文件列表 |
| **设计 How** | 数据怎么流进流出、状态存哪、和谁交互、用了什么模式 | 复述代码逐行 |
| **动机 Why** | 为什么这么切分？解决了什么问题？当时的约束是什么？换一种设计会怎样 | 编造理由 |

**Why 层是本次审查的核心**——它是后续「挑不合理点」的判据。Why 必须**有依据**：优先从代码注释、`docs/architecture/*`、`docs/core-deep-dive/v2-*`、`docs/superpowers/specs/*`、git log、以及本仓 `CODESHELL.md` 的「Architecture Gotchas / Known Architecture Debt」里找证据。**找不到确凿依据的 Why，必须显式标注「推测」，不许当事实写**。

约束（来自 `CODESHELL.md`，codex 必须内化）：
- 包管理器是 **bun**，不是 npm/yarn/pnpm。
- 核心包在 `packages/core/`，**没有** `src/core`。
- 两条硬性 ESLint 边界：`packages/core/**` 不得 import tui；`packages/desktop/src/renderer/**` 不得运行时 import 任何 codeshell 包（只能走 `window.codeshell.*`，type-only import 例外）。
- `bun run typecheck` 有历史存量错误，**不是干净门禁**，不要拿它当阻塞判据。
- 已知债务（**当作背景，不是让你现在修**）：`engine ↔ tool-system` 循环依赖；`engine.ts` 3300+ 行待拆；arena 纠缠在 core 里；plugin SessionStart hook 缺口。

---

## 2. 审查范围与模块清单

### 2A. Core 引擎

按下面的分组逐个产出结构说明。括号内是**真实文件锚点**（codex 应据此展开，不要只看这几个文件）。

**引擎核心 `packages/core/src/engine/`**
- `engine.ts`（163KB，主编排；关注它对外暴露什么、内部还耦合了哪些职责——这是拆分债务的现场）
- `turn-loop.ts`（62KB，turn/agent 循环；**StreamEvent 的产地**，关注工具调用如何 dispatch、事件如何 emit）
- `types.ts`（EngineConfig 等类型落点）、`runtime.ts`、`model-facade.ts`、`model-connections-pool.ts`
- `steer-queue.ts`、`streaming-tool-queue.ts`、`patch-orphaned-tools.ts`（运行中注入 / 流式工具 / 孤儿工具补丁——都是踩过坑的地方）
- `goal.ts`、`session-usage.ts`、`token-budget.ts`、`image-policy.ts`

**工具系统 `packages/core/src/tool-system/`**
- `registry.ts`（工具注册）、`executor.ts`（26KB，执行器）、`context.ts`（18KB，ToolRuntimeHost / 运行上下文——**打断循环依赖的窄接口就在这附近**）
- `permission.ts`（39KB，权限门禁）、`path-policy.ts`（27KB，路径策略）、`investigation-guard.ts`、`plan-mode-allowlist.ts`
- `builtin/index.ts`（26KB，内建工具装配）+ `builtin/` 下的工具族（读它们**分类**即可：文件类 read/write/edit/apply-patch、执行类 bash/powershell、编排类 agent/task/drive-claude-code/background-*、生成类 generate-image/video、检索类 grep/glob/web-*、其它 cron/sleep/skill/arena…）——不必逐个工具写满，按**族**归纳职责与注册模式。
- `mcp-manager.ts`（29KB，MCP 接入）、`sandbox/`（seatbelt/bwrap/off 三实现）

**协议层 `packages/core/src/protocol/`**
- `server.ts`（92KB，协议服务端——desktop 对话的对端；关注它承载哪些 request/response、如何管理 session）
- `types.ts`（**StreamEvent 全部形状**在这里，务必枚举清楚）、`chat-session.ts`、`chat-session-manager.ts`
- `transport.ts` / `tcp-transport.ts`（传输面）、`client.ts`、`factories.ts` / `helpers.ts` / `redact.ts`

### 2B. 桌面消费流（desktop stream）

只覆盖「一个 token 从 core 产出 → 到屏幕上出现/折叠」这一条流经的文件。**mobile 那套（`packages/desktop/src/mobile/`）本轮不展开**，桌面 renderer 为主。

- 主进程侧：`packages/desktop/src/main/parseStreamLine.ts`、`SessionSnapshotStore.ts`
- 渲染进程侧：`streamRouting.ts` → `streamCoalescer.ts` → `lib/streamReducer.ts`（19KB，归约成 UI 状态）
- 分组与折叠：`messages/streamGroups.ts`（27KB，**turn 分组 / 折叠逻辑的核心**）
- 渲染组件：`MessageStream.tsx`（14KB，含自动滚动）、`messages/TurnProcessGroupCard.tsx`、`messages/StreamingMarkdown.tsx`、`markdown/splitStreamingMarkdown.ts`

---

## 3. codex 的执行流程（两阶段，串行）

> 卡密sama 通过 DriveAgent（cli:codex）驱动。**一次一个任务，独立会话，跑完复核再派下一个**。不要一口气 fan-out 一堆 codex。

### 阶段一：讲清架构（先做架构）

**任务 A1 — Core 引擎结构说明**
- 读：`docs/architecture/01-engine-and-turn-loop.md`、`docs/architecture/02-tool-system.md`、`docs/architecture/03-llm-and-model-layer.md`、`docs/architecture/04-protocol-and-sessions.md`、`docs/core-deep-dive/v2-02/03/05`、以及 §2A 的源码锚点。
- 写：`docs/archive/review-2026-07-09/01-core-engine-structure.md`
- 内容：按 engine / tool-system / protocol 三大块，每块给出 §1 的三层（结构 / 设计 / 为什么）。每个子模块配真实 `文件路径:行号` 锚点。Why 无据处标「推测」。

**任务 A2 — 桌面流端到端步骤说明**
- 读：`docs/architecture/10-desktop-and-mobile.md`、`docs/archive/todo/desktop-streaming-markdown-autoscroll-plan.md`、§2B 的源码锚点。
- 写：`docs/archive/review-2026-07-09/02-desktop-stream-walkthrough.md`
- 内容：**一条有编号的端到端步骤链**，从「turn-loop.ts 产出一个 token/StreamEvent」到「屏幕上出现并最终折叠进 TurnProcessGroupCard」，每一步标注：这一步在哪个文件做、输入是什么、输出是什么、为什么需要这一步（例如为什么要 coalesce、为什么要 snapshot store、折叠判定的规则）。这份文档同时是 §5 可视化视频的**分镜脚本源**。

> 阶段一两篇写完，卡密sama 先读一遍确认「架构讲对了」，再放行阶段二。

### 阶段二：挑不合理点（通过架构找问题）

**任务 B1 — 优化点清单**
- 前置：A1 + A2 已被确认。
- 读：A1/A2 两篇 + `CODESHELL.md`「Known Architecture Debt」+ `docs/todo/architecture-debt.md` + `docs/todo/engine-split-plan.md`。
- 写：`docs/archive/review-2026-07-09/03-optimization-findings.md`
- 内容：**只挑本轮范围内（core 引擎 + 桌面流）的不合理点**。每条 finding 用统一结构：

```
### F-NN 标题
- 位置：file:line
- 现状：现在怎么做的
- 为什么不合理：违反了哪条设计意图 / 造成什么后果（耦合/性能/可测性/正确性）
- 影响面：谁受影响，改动半径多大
- 建议方向：怎么改（只给方向，不在本轮动代码）
- 严重度：P0 / P1 / P2
- 证据：代码 or 文档依据（无据标「推测」）
```
- 规则：**不重复已知债务的泛泛描述**，要落到本轮读代码新发现的具体点；已知债务只在与新发现相关时引用。**本阶段只输出文档，不改任何源码。**

---

## 4. 硬性护栏（codex 不得违反）

- **只读 + 写文档**，不改 `packages/**` 源码，不跑构建改动，不 commit。产物只在 `docs/review-2026-07-09/`。
- 所有 Why / 结论必须**可溯源**；无据即标「推测」，禁止编造设计动机。
- 用**真实文件路径 + 行号**做锚点（`file:line`），方便卡密sama 跳转。
- 不碰 tui / cdp / mobile（除非桌面流步骤确实流经，才最小提及）。
- 中文输出。
- typecheck 存量错误不作为判据。

---

## 5. 可视化视频 HTML —— 规格（本轮不实现）

> 目的：做一个能「像视频一样逐帧播放桌面流每一步」的可视化，让人直观看到一个 token 如何从 core 走到屏幕。后续用 **rednote / mimi-video skill + codex** 单独实现，本轮只定规格。分镜脚本直接取自 `../archive/review-2026-07-09/02-desktop-stream-walkthrough.md` 的编号步骤。

**形态**：单文件 `visualization-flow.html`（内联 CSS/JS，可离线双击打开），纯数据流端到端 51 步；或轻量 canvas/SVG 动画。不引重框架。

**内容**：把 §3-A2 的每一个编号步骤做成一「帧/节点」，用有向流水线展示数据在文件间流动：
- 节点 = 一个处理阶段（标模块名 + 文件路径）。
- 边 = 数据流向（标传递的数据形状，如 `StreamEvent{delta}`）。
- 有播放控制：播放 / 暂停 / 单步 / 进度条；当前帧高亮，侧栏显示该步的「做什么 / 为什么」。

**交互**：点节点看该步详情；可切「快放 / 单步」两种节奏，模拟真实 streaming 逐 token 的观感。

**数据源**：动画脚本（steps 数组）由 `../archive/review-2026-07-09/02-desktop-stream-walkthrough.md` 生成，保证可视化与文字说明单源一致。

**后续落地方式**：卡密sama 另起会话，用 mimi-video 相关 skill 编排 + DriveAgent(cli:codex) 实现；codex 读本节 §5 + `../archive/review-2026-07-09/02-desktop-stream-walkthrough.md` 即可动工。

---

## 6. 交付物一览

| 文件 | 阶段 | 内容 |
|---|---|---|
| `docs/review-2026-07-09/GUIDELINE.md` | — | 本文件（任务契约） |
| `docs/archive/review-2026-07-09/01-core-engine-structure.md` | A1 | core 引擎结构/设计/为什么 |
| `docs/archive/review-2026-07-09/02-desktop-stream-walkthrough.md` | A2 | 桌面流端到端编号步骤 + 视频分镜源 |
| `docs/archive/review-2026-07-09/03-optimization-findings.md` | B1 | 范围内优化点清单（P0/P1/P2） |
| `docs/review-2026-07-09/visualization-flow.html` | 后续 | 纯数据流端到端 51 步可视化 |

---

## 7. 给 codex 的一句话派活模板（卡密sama 直接用）

阶段一 A1：
> 读 `docs/review-2026-07-09/GUIDELINE.md`，执行其中「任务 A1」，只做 A1，产出 `../archive/review-2026-07-09/01-core-engine-structure.md`。严格遵守 §1 三层结构和 §4 护栏，Why 无据标「推测」，只写文档不改源码。完成后自查每个子模块是否都有 file:line 锚点，再返回。

阶段一 A2：
> 读 GUIDELINE + 已完成的 01。执行「任务 A2」，产出 `../archive/review-2026-07-09/02-desktop-stream-walkthrough.md`，一条编号端到端步骤链，每步标文件/输入/输出/为什么。只写文档不改源码。

阶段二 B1（A1/A2 确认后）：
> 读 GUIDELINE + 01 + 02。执行「任务 B1」，产出 `../archive/review-2026-07-09/03-optimization-findings.md`，按 §3-B1 的 finding 结构，只挑 core 引擎 + 桌面流范围内的具体不合理点，带严重度和证据，只写文档不改源码。
