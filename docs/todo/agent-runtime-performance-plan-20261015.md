# CodeShell 运行时等待与交互延迟优化方案

状态：技术方案，待分阶段实施。日期：2026-10-15，时区 UTC+08:00。源码基线：`origin/main` 的 `156f2fad111e7e5cd1dc37f761074107a3a40345`。

目标是让 Agent 在后台进程运行时继续推进独立工作，减少没有产出必要证据的模型往返，并让用户能及时看到真实执行状态。采用 Codex 可验证的句柄、显式等待、工具合批和事件流设计；以 CodeShell 自己的合成任务评测验收效果。

推荐顺序是：**建立耗时基线 → 集成已有窄范围修复 → 补齐指定对象的等待 → 合批与执行状态展示 → 辅助请求治理 → 上下文和缓存实验**。首批保留当前 provider、模型和安全策略，避免同时改变多个变量。

## 1 现有证据与交付状态

### 1.1 本次会话的耗时分解

以下是截至 2026-10-15 16:30 的本机诊断汇总。原始会话、请求正文和凭据不进入仓库；这里只保留统计值。排除会话闲置、外部委派等待和服务等待挂起后，有效执行时间为 1,122.62 秒，约 18 分 43 秒。

| 指标                           | 结果                                       | 含义                                                           |
| ------------------------------ | ------------------------------------------ | -------------------------------------------------------------- |
| 主模型请求                     | 128 次，其中 127 次有完整响应，另 1 次中止 | 主要优化对象是往返次数与单次输入负担                           |
| 可配对的主请求开始至响应完成   | 127 次合计 877.64 秒，约占有效执行的 78%   | 事件时间线估算，含本地准备，不能全部算作远端推理               |
| 工具批次关键路径               | 155.15 秒，约 14%                          | 含约 20.95 秒等待用户回答；并行工具不能按各自时间直接求和      |
| 工具结果至下一模型请求         | 112 个转换合计约 57 秒，中位数约 483 毫秒  | 是调度开销的一部分                                             |
| 请求开始至 before-fetch 审计点 | 合计约 9.92 秒，中位数约 69 毫秒           | 近似准备耗时，不代表实际 socket 派发时刻；已包含在主请求时间内 |
| 单工具轮次                     | 127 个可统计轮次中有 103 个                | 合批有明显改进空间，但依赖关系仍需保留                         |
| 仅更新待办的轮次               | 25 个，模型响应合计约 169.7 秒             | 实际待办工具执行合计约 3 秒                                    |
| 仅发现工具或读取 Skill         | 17 个轮次，模型响应合计约 86.1 秒          | 应区分必要发现和重复发现                                       |
| 单次上下文                     | 从约 29.6k 增至 152.6k token               | 未观察到该样本触发压缩；不能据此认定压缩功能缺失               |
| 缓存骤降告警                   | 12 次，其中 11 次归因工具前缀变化          | 要继续区分必要能力变化和无意义抖动                             |
| 辅助调用                       | 171 次，其中 155 次返回确定性 402 错误     | 失败请求累计约 94.5 秒，多与主流程重叠，不能加成等量前台等待   |

此外，常驻测试窗口启动后曾等待退出约 7 分 10 秒；这是错误等待语义造成的停滞。约 22 分 54 秒的外部 Codex 委派另算，不能用来推导原生引擎的单轮速度。

上述样本不能证明 CodeShell 与 Codex 的固定速度倍数。后续对比必须固定模型、推理设置、服务档位、任务、权限和缓存冷暖状态，并同时报告正确性与耗时。

### 1.2 已有基础

| 能力                      | 当前状态                                                                     | 本方案的增量                                                |
| ------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 后台 Shell 管理与退出通知 | 已有 Session 隔离、进程组回收、日志环、自然退出通知和协议唤醒                | 把进程启动与 Run 等待分开，增加明确等待目标                 |
| 工具发现                  | 已有任务初始路由、按需选择、Run 内粘性名称和每步骤冻结快照                   | 减少重复发现和无意义 schema 变化，评估有界的跨 Run 选择提示 |
| 工具并发                  | Read 等安全工具已可在完整模型响应后并发；Bash 串行                           | 改善调用合批和有界调度，不把任意 Shell 改成可并发           |
| 输出流                    | 已有先持久化再发布、游标恢复、8 毫秒和数量字节上限批处理、固定水位 sidecar   | 增加可归因指标与逐工具状态；有数据后再调批处理              |
| 上下文                    | 已有 summary、notes、SaveContextNote、NewContext、SearchHistory 和硬限制兜底 | 增加可选性能预算及质量评测，不另建一套历史系统              |
| 缓存                      | 已有 provider 策略、前缀指纹、骤降归因和成功边界跟踪                         | 增加工具代次归因、长程实验和预算估算校准                    |
| Host                      | 已有 HostRuntime 注册和生命周期骨架；平台方案规划统一 ExecutionService       | 通过既有资源所有者接入，不新增平行进程注册中心              |

相关既有方案：[可靠性与上下文](agent-reliability-and-context-optimization.md)、[notes 策略](context-notes-strategy.md)、[缓存优化](prompt-cache-optimization.md)、[Harness 评测](codeshell-harness-evals.md)、[平台层收敛](../architecture/16-platform-consolidation.md)。

### 1.3 窄范围修复与集成状态

本地分支 `codex/core/background-continuation-latency-20261015` 的提交 `37b390787` 包含：

- `background_behavior: "continue" | "wait_for_exit"`，显式 continue 后可在进程存活时执行下一步工具；省略参数仍保留旧等待语义。
- 常见工具的元数据摘要在本地生成；专用工具保留原异步摘要路径。
- TodoWrite 在实际状态变化时更新，并与独立动作合批的指引。

该提交已有守护回归、Core 类型检查和定向 lint 结果；它未进入上述源码基线，也没有安装版交付证据。集成前需刷新目标 main、审查最终 diff 并验证组合后的契约；不继承旧提交的发行结论。

2026-10-19 收敛检查点：上述窄修复已从当前 `main` 基线 `bfc23abf0` 适配到 `codex/core/release-latency-convergence-20261019`，代码提交 `33e07092d`。28 项定向守护测试（77 个断言）通过，覆盖实际 Engine 在服务存活时执行下一工具、省略参数和显式退出等待兼容、无辅助请求的本地摘要、摘要观察者失败和取消、跨会话输出隔离及进程清理。此处只记录任务分支上的源码验证；最终主线组合验证、正式安装包和真实模型性能对照仍未完成。A 批的元数据计时与合成基线，以及 B–F 的其余规划未因收敛而视为已实现。

## 2 Codex 参考范围与设计决策

| 参考机制                           | 可验证的依据                                                                                                                                                      | CodeShell 的选择                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 长命令返回句柄，后续显式读取或等待 | 当前工具契约中的 exec_command、session_id、write_stdin；[官方工具说明](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide#shell_command) | 引入显式 WaitBackground，后台启动默认行为通过版本化迁移处理                |
| 独立调用合批                       | [官方 Codex 提示指南](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide#recommended-starter-prompt)                                     | 先改工具指引与评测；后续增加受约束的批量调度，不依靠命令文本猜安全性       |
| Item 生命周期与输出增量            | [App Server 协议](https://learn.chatgpt.com/docs/app-server)                                                                                                      | 复用 StreamEvent 和 output journal，逐步补齐工具状态                       |
| 模型上下文压缩                     | [官方 compaction 说明](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide#compaction)                                                    | 在现有 notes 和 summary 上增加性能预算；原生 Responses compaction 单独评估 |

这些依据支持机制设计，不等同于完整的 Codex 产品实现。App Server 的 `command/exec` 是线程外命令 API，不能直接当作模型工具内部实现；本方案也不复制其 API 名称或协议对象。

本轮决策：

1. 进程存活、服务就绪、工具结果可用和模型回合完成是不同状态。
2. 只有明确登记了等待条件，Run 才能停泊；有后台进程不自动等于应该停止工作。
3. 执行权限与资源所有权保持热更新；缓存稳定性不能延迟撤权。
4. 可丢弃的进度辅助工作与正确性必需的压缩、裁判及结果交接分开治理。
5. 交互反馈延迟与任务完成时间分别验收，不能用动画或状态刷新冒充执行提速。

## 3 可归因的耗时与评测基线

### 3.1 时间线

复用现有 logical request、attempt、Run、toolCall 与 output cursor 身份，增加元数据时间点：

```ts
type RequestTiming = {
  logicalRequestId: string;
  attemptId: string;
  preparedAt: number;
  dispatchAt: number;
  headersAt?: number;
  firstActivityAt?: number; // 首个 reasoning、text 或 tool 活动
  firstTextAt?: number;
  completedAt?: number;
  purpose: UsagePurpose;
};

type ToolTiming = {
  toolCallId: string;
  enqueuedAt: number;
  approvalStartedAt?: number;
  approvalResolvedAt?: number;
  executionStartedAt?: number;
  executionSettledAt?: number;
  settledAt?: number; // 调用结算，包含拒绝和跳过
  outcome: "completed" | "failed" | "denied" | "skipped" | "cancelled";
  resultCommittedAt?: number;
  publishedAt?: number;
};
```

字段是目标契约，具体 purpose 值复用现有 UsagePurpose，不另建费用分类。拒绝审批、参数无效、边界跳过和执行前取消不产生 executionStartedAt；不能把工具声明事件当成真正开始执行。持续时间用单调时钟计算；墙钟用于跨日志定位。Host 发布、客户端收到、实际绘制分别记录，不能把已发送等同于已显示。

目前 OpenAI 的 first-byte 计时在取得 stream 后才开始，且只看文本，工具专用回复会漏记。新指标从真正出站前开始，保留旧字段的历史含义并新增字段，不静默重解释旧日志。

### 3.2 指标口径

- 主模型：准备、连接响应、首活动、首文本、完整响应，分别报告 p50 和 p95。
- 编排：每任务逻辑模型轮数、物理 attempt 数、单工具比例、纯待办和重复发现轮数。
- 工具：排队、审批、执行、等待、结果提交和发布；并发批次按关键路径计算。
- 上下文：system、tools、history、notes、最近结果的估算 token，以及 provider 返回的实际 input/cache token。
- 辅助：排队、执行、跳过、失败、超时、费用与归属；异步开销不能直接与前台耗时求和。
- 输出：journal 提交耗时、fsync 次数、事件循环延迟、传输和绘制延迟。

默认诊断不记录正文、Shell 参数、密钥、完整 endpoint 或用户搜索词。合成 eval 的完整内容捕获继续使用独立的显式模式。

### 3.3 评测方法

扩展现有 `evals/harness` 与隔离运行器。先用本地受控 provider 和进程 gate 验证因果顺序、请求数及权限；固定回复只能证明 harness 契约，不能证明真实模型更聪明或更快。

真实模型阶段使用同任务的 baseline 与 candidate 配对运行，固定模型版本、推理、服务档位、工具、权限、fixture、预算和冷暖缓存。正确性先过硬门槛，再比较成功任务的效率，同时列出失败样本的总开销。当前工作只产出方案，不发起付费评测。

## 4 进程启动与显式等待

### 4.1 等待服务的边界

第一版在 Core 增加编排用的 `BackgroundWaitCoordinator`，通过注入 adapter 查询既有 shell manager、async agent registry 和 background job registry。它保存等待意图，不接管进程、日志或任务的资源所有权。

Panel 的进程、回执和后台工具任务仍归现有 ProcessService 与 PanelToolJobService；仅通过已授权 Host 接口适配。统一进程执行层按平台方案 W3 的同一个 ExecutionService 迁移，不再建立第二个 Host 进程中心。Desktop 的窗口就绪验证属于其 adapter，Panel 业务完成条件属于对应 Panel。

### 4.2 建议工具接口

以下为待实现接口，不能当作当前已有工具调用：

```ts
type WorkRef = string; // 既有 owner 生成，绑定资源种类、ID、作用域和启动代次

type WaitTarget = {
  work_ref: WorkRef;
  until: "terminal" | "ready";
  readiness_ref?: string;
};

type WaitBackgroundInput = {
  targets: WaitTarget[];
  match: "all" | "any";
  mode: "bounded" | "park";
  timeout_ms: number;
};
```

- 启动回执增加绑定启动代次的 work_ref，并保留 shell_id 等旧字段。Session、workspace、owner 和权限由宿主绑定，不接受模型自报所有权。
- bounded 只做有上限的短等待，返回当前快照，Run 可继续；park 先持久化指定目标和条件，再以 background_wait 让出。
- 首期只支持 shell、agent、job 的 terminal 等待。terminal 包含完成、失败或取消，不能把非零退出当成功。返回各目标的权威状态与回执，等待 satisfied 不等于任务成功。ready 后置，只有相应 adapter 广告支持且该目标 readiness_ref 有效时才允许。
- targets 的数量、短等待时长与持久等待时长均由 Host policy 限制。初版可取目标最多 16 个、bounded 最多 10 秒、park 最多 1 小时作为配置起点；超限明确拒绝，不偷偷变成无限等待。具体值在实现 PR 固定并验证。
- 超时返回结构化 timed_out 和各目标快照；不默认杀进程。有效 park claim 的超时允许一次结果续跑，失去续跑权时只显示待处理状态；不周期性唤醒、创建 Cron 或重复调用付费模型。
- 不支持某种条件时返回 typed unsupported。headless 或没有续跑能力的宿主不得接受 park；它可用 bounded 或由调用方继续等待。

模型的正常顺序为：启动并取得句柄 → 做独立工作 → 必要时显式等待 → 取得新证据后继续。并非每次启动都必须紧接着等待。

### 4.3 就绪与退出

服务的 ready 是独立里程碑，服务达到 ready 后仍在运行。日志里出现 URL 或端口仅是提示，不能生成可信 ready 结果。

就绪验证优先使用资源所有者提供的检查：已有本地服务健康接口、实际连接成功或 Desktop 的窗口可交互检查。检查复用既有网络、浏览器、路径和进程授权；不开放任意 Shell 健康命令或无约束 URL 探测。验证结果绑定 work_ref、启动代次与 verifier revision，并且可在稍后登记等待时回看。

ready 不能写成 completed 的进程终态通知。结算前必须重查服务仍存活及 verifier revision 有效；已退出服务的历史 ready 不代表当前可用。服务就绪后退出应生成独立的退出事实；只有当前有效等待或既有允许的结果投递策略决定是否驱动模型。

终态必须读取 owner 的实际回执。现有 shell 的 killed 可早于进程组停止，exited 可早于管道 close；adapter 不能把这些展示字段直接当作回收完成。取消请求仍为 pending，按该 owner 契约确认进程树、IO 与资源交接后才结算。服务在 ready 前退出时立即返回 condition_unreachable，不等到超时。

### 4.4 持久等待与竞态

等待记录至少包含 waitId、Session incarnation、origin user message、work refs、条件、all/any、创建时间、绝对截止时间与 claim revision。状态依次为 armed、satisfied 或 timed_out、claimed、consumed；用户新输入可将旧续跑 claim 标为 superseded，用户 Stop 标为 cancelled。底层任务不会仅因取消等待而被终止。

Session incarnation 在普通冷恢复和 Host 重启时保持，删除后重建才改变。它与每次 worker 重启的 runtime epoch、每个进程启动的 execution generation、用户 Stop/接管的 control generation 以及等待 claim revision 分开，避免拒绝合法的冷恢复或接受旧活回调。

必须满足以下约束：

1. 先登记订阅再重查目标快照，或由 owner 原子完成两步，覆盖 ready/exit 先于 wait 的情况。
2. 目标代次、Session incarnation 和 claim revision 全部匹配，旧事件不能唤醒同名的新进程或重建会话。
3. CAS claim 与稳定 deliveryId 去重；claim 带可恢复租约。领取后、入队前或确认前崩溃时，用持久结果与已消费水位恢复，不让 claimed 永久悬空。外部副作用的未知终态仍保留 unknown，不自动重跑。
4. 复用现有唤醒路径的权限复查、排队、恢复失败回填和 Stop 优先机制。用户新输入优先处理，旧等待不得并行重驱动上一轮。
5. KillShell 的有意取消通过等待 adapter 结束相关等待，不伪造自然完成通知；Stop 后不因该结果自动恢复模型。
6. 重启后重新查询 owner；不能仅凭历史 PID 恢复所有权。无法证明进程归属时返回 orphaned 或 unavailable，并保留诊断。
7. 到期使用宿主定时器和持久 deadline 结算；重启恢复后已到期的等待只结算一次。
8. 登记至批次停泊之间目标已经结束时，先注入已存在结果或确保一次有效续跑已入队，再让出。结果已消费就不能随后停进无人唤醒的状态。runYield 的新结构携带 waitId，旧无目标原因只走兼容路径。

新契约启动的工作采用 observe_only 投递：事件可进入 UI/邮箱，只有有效匹配等待才驱动模型。旧调用保留 resume_on_terminal。现有服务器收到任意 result 就唤醒、drainAll 的路径必须按这两类策略适配；等待 A 时 B 完成只观察并保留，不能解除 A。any 已结束后，其余目标后续退出也不能不断重启空闲 Agent。

旧 wire 的 reason=completed 与 completionKind=background_wait 保留兼容。客户端必须以明确等待记录区分“本轮让出”和“任务完成”，新字段未知时维持保守显示。

### 4.5 迁移

先集成 `37b390787` 的显式 continue。新增 WaitBackground 后，让新版第一方工具指引采用“启动继续，依赖时显式等”。旧 Bash 省略 background_behavior 的调用暂留 wait_for_exit，并记录不含命令内容的兼容命中指标。

默认值切换必须版本化并通过能力协商：新契约明确默认 continue，旧契约继续原语义。禁止从命令名、端口或运行时长猜是否常驻。新旧客户端、工具 schema 与实际执行器必须同一契约；不能只换提示词而执行器仍强制停泊。

Run 使用的 continuation contract revision 由宿主绑定，同步决定 schema、执行器和启动回执的投递策略；模型不能自报版本或 owner 来改变行为。`37b390787` 的 continue 仍属于旧终态自动投递路径，不能因为参数同名就直接视为 observe_only 新契约。

新契约还要适配 Goal 的 waiting 裁决：没有有效 wait claim 时，不能仅凭“后台还有工作”允许停靠。应返回可执行提示，由模型选择真实依赖并登记 WaitBackground；不把全部后台对象自动变成依赖。普通 Run 结束与任务完成投影继续分开，UI/收件箱读取等待事实，Goal 完成检查保留真实未完成依赖。

## 5 工具合批与执行状态展示

### 5.1 先减少模型往返

复用同一回复的多工具调用，把没有依赖的读取、搜索、状态查询和 TodoWrite 合批。任务路由按已知能力减少重复 ToolSearch；发现新能力、读取必要 Skill 或根据结果决定下一个目标仍保留模型边界。

先通过指引和合成任务观察轮次，再决定是否增加批量工具。当前 Read 等已可并发，Bash 保持串行。后续若增加调用级并发，必须是具有资源范围与效果声明、经过 policy 审核的结构化操作；模型声明 independent 不能使任意 Shell 自动变安全。依赖相同文件、同一交互终端或可变状态的动作保持有序。

第一版不执行模型仍在流式生成的工具参数。要探索完整响应前的工具执行，需先设计明确的参数完成事件、可见性和授权检查、输出截断及 stream fallback 的执行防重复边界。

### 5.2 先发布状态，再评估完整结果提前提交

目前工具结果在整个批次 drain 后展示。先增加元数据事件 tool_execution_settled，只含 Session/Run、agentId、批次身份、toolCallId、状态和计时，经现有 output journal 持久化后发布。它说明执行已结束，结果正文仍在原批次提交点交付，不宣称模型已消费结果。

Desktop、Web/Mobile、TUI 都在正确 Session/Run/agent 范围内按 toolCallId 更新对应工具；provider 的调用 ID 不视作全局唯一。不能因一个工具结束清掉同一 agent 的全部运行状态。慢工具尚未完成时，快工具的状态仍应可见。未知事件按协议能力协商降级，不破坏旧恢复游标。

完整结果提前展示作为独立后续项：脱敏 canonical result append → transcript.sync 或有界 group commit → journal 持久化与水位提交 → transport。任一提交失败都不能发布成功终态，也不能启动后续未开始的副作用工具。

最终 model-facing 结果仍按 assistant tool-call 顺序排列。冷恢复的 Transcript.toMessages 与 eventsToMessages 必须采用相同的批次归一顺序；原始事件、哈希与证据顺序不改写。每个 toolCallId 只能有一个 canonical 结果，敏感正文仅留既有允许的运行内存路径，不能泄入 journal、摘要或回放。

先做状态事件能改善反馈，但不减少模型等待整批结果的关键路径；完整结果提前提交也需评测新增 fsync 开销。

## 6 辅助请求和失败控制

### 6.1 可丢弃辅助工作

将本地工具标签作为常见操作默认路径，先覆盖 `37b390787` 中的工具集合。特殊工具若保留模型摘要，进入有界辅助调度器：建议每连接并发上限 1、队列有上限、短超时；只替换同一 Session incarnation、Run identity、job kind 下尚未派发且已被更新覆盖的标签，标题采用独立键。不同会话不能互相覆盖。被丢弃项明确记为 skipped，不伪造 usage。

调度时捕获原 UsageOwner、Session incarnation 和 Run identity，延后派发仍通过原 owner 计费。Runtime 管连接共享的并发与故障元数据；Run 管取消及旧标签是否还能展示。迟到结果不能更新下一轮进度或挤占下一轮费用归属。

第一批只治理可丢弃的进度标签和标题。压缩、Goal judge、外部结果交接不经过这个软熔断。记忆提取、dream 等有持久写语义的任务须另做快照、新鲜度和写入归属设计，不能当成标签随意合并或丢弃。

### 6.2 连接故障熔断

错误分类复用已有规范。在可丢弃辅助链路，对确定的认证或配额拒绝按配置连接 ID 与 revision 熔断；不记录密钥和原始 endpoint，不跨不同连接或权限范围传播错误。

建议以 60 秒冷却、重复失败逐步延至最多 5 分钟作为实验起点。冷却期不发送同类可选请求；设置变更或显式重试可重置。半开验证由下一次真实且仍有必要的请求承担，不用定时器发付费探针。界面在首次失败和状态变化时提示，正常未变化期间保持安静。

主模型及正确性必需链路继续返回结构化失败，不能因为辅助连接熔断就静默省略工作，也不能自动切到更贵模型。成功恢复后清除对应 revision 的故障状态。

### 6.3 一个逻辑请求只有一个重试预算

先记录现有 SDK 内部重试、Core withRetry 和 streaming fallback 的真实物理 attempt。再由 Core 统一管理可观测的重试，支持的 SDK 设置 maxRetries=0；无法控制的自定义 fetch 明确标记覆盖范围。

一次 logical request 共用绝对 deadline 与剩余 attempt 预算，fallback 不能重新拿一份预算。首版保留现有配置的总尝试上限，并验证退出条件；确定性 4xx 不换 streaming/nonstream 重试，429/5xx/网络错误按类别、Retry-After 和剩余时间处理。

现有缓存字段降级、token-limit 字段和 reasoning 兼容修正属于有界的请求形状协商，继续保留。协商也计入同一物理请求上限和 deadline，单独标注原因，通常不做普通网络退避；不能因统一重试而移除既有网关兼容能力。

已经输出可见内容或开始工具执行后，禁止盲目重放整次请求。计费沿用现有 attempt ledger，失败或未收到完整 usage 不等于免费。

## 7 上下文预算与缓存稳定

### 7.1 可选的性能预算

模型最大上下文是合法性上限，不必同时充当交互性能目标。在现有 context 配置上增加可选的 performanceInputBudget 与 compactTargetTokens，并保留原 modelWindow、输出预留和安全余量。

有效硬上限按 provider 能力计算；软预算必须小于硬上限且 target 低于 trigger，形成滞回。触发判断使用 provider usage 校准后的估算值，同时记录各部分预算；不能把估算称为实际计费 token。

在完整工具批次后的安全边界执行现有 notes 接续或 summary。保留最新用户约束、有效工作区、任务与等待引用、未配对调用和必要近期结果；完整历史继续可检索。notes 不可用时沿用已有摘要兜底。

首轮仅在合成任务中比较不同比例或绝对预算，不立即给所有模型设置统一 60k/80k 默认值。若固定指令加受保护近期内容已超过目标，报告 budget_unsatisfiable 并回到硬限制策略；同一证据版本禁止反复压缩而没有净减量。

schema 或上下文布局代次变化时，重置或修正已有 usage anchor，避免继续使用旧工具集的估算基准。notes 更新和压缩调用本身也计入轮次与费用，不能以更多记账调用换取表面的输入减少。

### 7.2 工具代次与跨 Run 提示

保留每步骤冻结快照、Run 内粘性 selected names 和即时撤权。区分 catalogGeneration 与 activeSurfaceGeneration：前者在授权目录、schema、可用性或策略变化时更新，后者还覆盖 ToolSearch 选择、warm hints 加载与撤权。请求指纹和预算绑定实际活动快照，相同定义重用稳定摘要和顺序。进程状态、Session 标题、账号健康数据不塞进原生 schema。

跨 Run 只评估有界 warm selection hints：保存在本 Session/incarnation 命名空间，带有效期；不同聊天默认不共享。内容只有有序工具名称与 schema digest，不保存 schema 正文或权限。作用域指纹覆盖工作区 revision、preset/profile、路由版本、配置作用域、allowlist、plan/permission、MCP policy 与授权目录代次。

新 Run 必须重新解析当前 eligible catalog，未过期且指纹吻合才将 hints 与当前授权求交；名称数量和 schema token 预算约束初始工具与 hints 的合计，必要 Goal、notes 和发现工具不能被挤掉。指纹变化就丢弃提示。显式 allowlist、eager preset 和无发现工具的兼容路径不改。提示只是选择建议，永远不是权限证明。

不能为了缓存冻结整场会话的工具或安全配置。必要的撤权、Plan、Goal、模型和能力变化在下一请求生效，执行器在实际执行前及审批后继续复核。

### 7.3 缓存实验

扩展现有骤降归因，记录 tools generation、变更原因、逻辑请求和冷暖阶段。先消除无意义目录抖动，再比较不同初始工具集合与跨 Run 提示；必要的新能力加载造成失效应作为正常代价单列。

既有 GPT-5.6 短样本证据不能推广到 GPT-6.1 长会话或全部网关。不能仅延长模型名正则就认定支持某种显式缓存。Responses API、previous_response_id、原生 compaction 和不同 provider 的缓存字段各自做能力与回退实验，不与等待改造一起替换主请求协议。

## 8 模块归属和协议兼容

| 范围           | 实施入口                                                                        | 约束                                                                                                |
| -------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 请求和工具计时 | `core/engine/model-facade.ts`、`llm/providers/*`、`tool-system/executor.ts`     | 复用请求边界、费用归属和脱敏，不新增默认正文采集                                                    |
| 等待编排       | 新增小型 Core wait 模块，接 `context.ts`、`run-tooling.ts`、`turn-loop.ts`      | orchestrator 只接线，不继续扩张 engine.ts                                                           |
| 资源生命周期   | 既有 `runtime/background-shell.ts`、agent/job registry、Panel owner             | 通过 adapter 适配；底层 spawn、IO、取消和回执后续接 W3 ExecutionService，任务与业务状态仍归原 owner |
| 结果与通知     | `protocol/background-result-wakeup.ts`、`agent-notifications.ts`、session state | 保留 Stop、ownership、CAS 与恢复失败回填                                                            |
| 状态发布和恢复 | `engine/run-stream.ts`、`session/output-journal.ts`、`session/transcript.ts`    | 先持久后发布；完整提前结果须统一冷暖投影                                                            |
| 客户端         | Desktop reducer/panel、`packages/web`、TUI                                      | 用同一身份和状态，兼容未知字段与旧事件                                                              |
| 辅助治理       | `engine/auxiliary-pipeline.ts`、`run-accounting.ts`、LLM client 边界            | 可丢弃工作与必需工作分流，计费 owner 随排队保持                                                     |
| 上下文与目录   | `context/manager.ts`、`run-context.ts`、`tool-system/run-tool-surface.ts`       | 复用 notes、summary、权限与现有 snapshot                                                            |

新增能力通过现有 contracts/capability 协商公布。Protocol v2 的 Session/Turn/Item 迁移仍归平台专项；本方案先在已有协议中增量接入，不把 v2 全量迁移设成所有优化的前置条件，也不创造第二套版本常量。

## 9 实施批次与验收门槛

| 批次 | 范围与体量                                                       | 依赖                     | 完成条件                                                                       |
| ---- | ---------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| A    | 元数据计时、合成基线、审查集成 37b390787，M                      | 当前 main 与构建身份固定 | 能分辨模型、工具、等待与发布；服务启动后实际下一步执行；常见工具零辅助摘要请求 |
| B    | 等待 adapter、结构化 claim、bounded/park、deadline，L            | A                        | 目标匹配、竞态、Stop、失败、重启等契约通过；不依赖周期模型轮询                 |
| C    | 合批指引与评测、逐工具 metadata 状态、三类客户端适配，M          | A，状态可独立于 B        | 快工具状态在慢工具结束前可见；最终模型结果顺序与原行为一致                     |
| D    | 可选辅助调度、熔断与单一重试预算，M/L                            | A                        | 并发有界、失败不反复出站、计费准确、重要工作不被丢弃                           |
| E    | 性能上下文预算、代次诊断、warm hints 实验，L                     | A/C，独立质量门槛        | 用户纠正与任务引用保持；预算无压缩空转；撤权即时生效；缓存收益有配对证据       |
| F    | 完整结果提前持久化、早期安全工具执行、MCP 懒连接、输出批处理实验 | 各自基线证明收益后再细分 | 逐项独立方案与回滚；不捆绑进入首批                                             |

每批独立任务分支和 worktree，提交必须可单独审查和回退。体量是拆分参考，不代表工期承诺。若 W3 ExecutionService 同期落地，B 的 adapter 接入其正式 seam，避免两路迁移。

### 9.1 确定性契约矩阵

| 场景                        | 硬断言                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------- |
| 常驻服务启动                | 后续实际工具执行时服务仍存活，Run 没有隐式停泊                                         |
| 有限任务与显式等待          | 等待期间零重复模型轮询；匹配退出后只生成一个逻辑等待结果                               |
| ready/exit 先于等待         | 立即返回已有事实，不遗失事件                                                           |
| 多目标与重复通知            | any/all 正确；失败与 deadline 竞争去重；无错误会话续跑                                 |
| 不同目标条件                | 各目标分别绑定 terminal 或受支持的 ready 与验证器，不能错用全局条件                    |
| 满足与停泊同时发生          | 批次结束前已有结果不能在消费后又进入无人唤醒的 park                                    |
| claim 交付中崩溃            | 租约、deliveryId 与消费水位可恢复；不会永久停留 claimed 或重复推进                     |
| 用户 Stop、新输入、删除重用 | Stop 后无自动驱动；新输入优先；旧代次不能复活会话                                      |
| Goal waiting 和完成投影     | observe_only 工作没有有效 claim 时不允许无唤醒来源的停靠；常驻服务不自动成为完成阻塞项 |
| KillShell、超时、重启       | 取消等待与终止进程语义分开；unknown 不转成功；历史 PID 不自动认领                      |
| 终止尚未确认、ready 前退出  | 未完成进程组和 IO 交接时不报完成；就绪不可达及时返回                                   |
| 快慢工具同批                | 慢 gate 未释放前，快工具元数据经 journal 到达客户端；正文仍按约定提交                  |
| 完整结果提前提交后续项      | 注入 transcript sync、journal 或水位故障时不发布成功；冷暖模型投影一致，敏感哨兵零泄露 |
| 可选辅助连接返回 402        | 同一冷却窗口内其余标签不再出站；重要工作仍按自身错误策略处理；恢复只用真实请求探测     |
| SDK、Core 与 fallback       | attempt 与 deadline 总预算不可相乘；已有输出和已启动工具不盲目重放                     |
| 压缩与 notes 接续           | 工具配对、最新纠正、workspace 和等待引用保留；净减量不足时不循环                       |
| 工具提示与撤权              | hint 不能重授权限；同批 inactive 工具在 hook、审批和 handler 前拒绝                    |

守护测试必须使用隔离 HOME 和凭据。真实进程用合成 gate、私有工作区和明确 owner；网络 fixture 在导入 Core 前限定 exact origin。OS/实际安装包与真实设备结果分开记录。

### 9.2 初始性能目标

这些是候选验收目标，需要 A 批建立可重复基线后固定：

- 常见工具批次生成进度标签的额外模型请求为 0。
- 显式等待挂起期间，零周期性付费模型调用；就绪、失败与 deadline 都有可解释终态。
- 本地受控 fixture 中，工具执行结束到状态发布 p95 目标不超过 200 毫秒；GUI 绘制另测，不用 Host 发送时间代替。
- 真实模型配对的独立读取与状态更新任务集中，模型往返中位数相对旧 baseline 目标减少至少 25%，正确性不回退；含真实依赖的任务不套该指标。本地固定回复 fixture 只验证契约与调用数，不证明指引改变了模型行为。
- 长会话真实模型评测先探索输入预算与质量曲线，再设有效输入与 p95 完成时间目标，不预先承诺通用加速倍数。
- 输出 batching 保留现有 paced smoke 门槛；只有 event-loop 和提交耗时证明确为瓶颈时，才比较 8 毫秒与其他有界批处理。终态、审批、取消和错误仍立即 flush。

结果报告同时列出任务完成率、失败数、总费用、冷暖缓存、等待时间及 installed build identity。不能用减少测试、跳过审批、漏传历史或提前声明完成换取更短时间。

## 10 原始方案产物与后续入口

2026-10-15 的原始方案只新增本技术方案与根 TODO 索引，不改变运行逻辑，不自动合并前面的代码提交，也不修改本机模型或服务档位。2026-10-19 的窄修复收敛状态见 §1.3。

下一实施入口仍是 A 批：完成窄修复在最终主线上的组合验收，并建立元数据时间线和合成评测。B 至 E 按各自接口与验收门槛推进；F 在数据证明收益后拆成独立方案。
