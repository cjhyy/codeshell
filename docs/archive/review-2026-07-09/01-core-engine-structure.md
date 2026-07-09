# Core 引擎结构说明（A1）

本文件只覆盖 A1：`packages/core/src/engine/`、`packages/core/src/tool-system/`、`packages/core/src/protocol/`。桌面消费流、tui、cdp、mobile 不在本文件展开。阅读底料已复用 `docs/architecture/01-04`、`docs/core-deep-dive/v2-02/03/05`，但下面每个子模块都用源码 `file:line` 锚点落地。

一个重要校正：GUIDELINE 把 `protocol/types.ts` 标成“StreamEvent 全部形状”，但当前代码里 `protocol/types.ts` 只是从 `../types.js` 引入 `StreamEvent`；全部 union 形状实际定义在 `packages/core/src/types.ts:429`。

## 1. Engine

### 1.1 Engine 配置、运行时资源与主编排

**What**

`Engine` 是 core 的顶层编排对象：它持有 preset、工具注册表、hook registry、session manager、MCP manager、model pool、permission/plan 状态、上下文缓存、steer 队列、活动 TurnLoop 和活动 goal hook。主类字段集中在 `packages/core/src/engine/engine.ts:306`。`EngineConfig` 和 `EngineResult` 被拆到 `packages/core/src/engine/types.ts:1`，避免类型消费者导入 3000+ 行实现体。共享 worker 级资源被放进 `EngineRuntime`，包括 `modelPool`、`toolRegistry`、`settings`、`mcpPool`、`costTracker`，见 `packages/core/src/engine/runtime.ts:24`。

**How**

构造阶段会解析 preset，并基于全局启停列表和项目 `capabilityOverrides` 生成构造期冻结的 builtin tool set，见 `packages/core/src/engine/engine.ts:562`。如果传入 `runtime`，Engine 复用共享 `toolRegistry` / `modelPool`；否则自己创建并从 settings 填充模型池，见 `packages/core/src/engine/engine.ts:582`、`packages/core/src/engine/engine.ts:619`。模型池从 `settings.modelConnections[]` 转为 `ModelEntry`，并把 `defaults.text` 命中的模型同步回 `config.llm`，见 `packages/core/src/engine/engine.ts:637`、`packages/core/src/engine/model-connections-pool.ts:39`。跨模型的 `clientDefaults` 保持在 `llm` 之外，避免热切模型时丢掉 image detail / temperature 等旋钮，见 `packages/core/src/engine/types.ts:34`、`packages/core/src/engine/engine.ts:694`。

**Why**

`EngineConfig` 拆文件的理由在注释中写得很明确：让 protocol、factory、settings 等只需要类型的消费者不把完整 Engine 实现和传递依赖拉进来，见 `packages/core/src/engine/types.ts:4`。`EngineRuntime` 的切分是为了在 worker 内共享只读或连接型资源，而把可变 per-session 状态留在 Engine 实例上，见 `packages/core/src/engine/runtime.ts:24`。builtin tool set 构造期冻结是当前能力开关设计的约束：`off` 可以在每 turn 隐藏并执行期拒绝，但新 `on` 的 builtin 不在 frozen registry 时需要重启 session 才能出现，见 `packages/core/src/engine/engine.ts:569`。这也呼应 CODESHELL 的已知债务：`engine.ts` 过大、`core -> tool-system -> engine` 循环依赖仍需拆，见 `CODESHELL.md:67`。

### 1.2 Engine.run 装配一次会话运行

**What**

`Engine.run()` 是一次用户任务进入 core 的主要边界，签名和 per-run 选项在 `packages/core/src/engine/engine.ts:919`。它负责解析 cwd / session workspace、处理图片输入、恢复或创建 session、补 transcript、构建 ToolContext、权限分类器、ToolExecutor、PromptComposer、MCP 连接、tool defs、ContextManager、ModelFacade、TurnLoop。

**How**

run 开始时先基于已有 session workspace、显式 `cwd`、config cwd 和 `process.cwd()` 决定实际 cwd，见 `packages/core/src/engine/engine.ts:946`。它包装调用方的 `onStream`，拦截 `task_update` 给 TaskGuard 用，并把 `goal_progress` 持久化为展示事件，见 `packages/core/src/engine/engine.ts:993`。恢复已有 session 时会从 transcript 生成 messages，并调用 `patchOrphanedToolUses()` 修补 dangling tool_use，见 `packages/core/src/engine/engine.ts:1415`。在 session id 解析后立即发 `session_started`，再重放最后的 TodoWrite snapshot，见 `packages/core/src/engine/engine.ts:1621`、`packages/core/src/engine/engine.ts:1632`。

随后 Engine 并行/提前构建 LLM client、权限、ToolExecutor、PromptComposer 和 MCP。权限 backend 由 run 当前 mode/cwd 构建，interactive backend 会注入 cwd 和项目规则回写 callback，见 `packages/core/src/engine/engine.ts:1649`。ToolExecutor 收到 run signal 和 per-engine ToolContext，见 `packages/core/src/engine/engine.ts:1673`。MCP 优先使用 runtime 共享 manager，按当前 Engine 作为 owner 连接，见 `packages/core/src/engine/engine.ts:1710`。工具定义会经过 builtin override、MCP per-session visibility、tool guard、feature flag、动态 schema 和 plan-mode allowlist 多层过滤，见 `packages/core/src/engine/engine.ts:1802`、`packages/core/src/engine/engine.ts:1828`。

**Why**

`session_started` 提前发出的理由是让客户端在 run 未完成前就知道权威 sid，例如 `/sid` 中途可用，见 `packages/core/src/engine/engine.ts:1621`。恢复时修补孤儿工具调用是因为 OpenAI 严格要求每个 assistant tool_call 后有对应 tool result，否则下一次 API 调用直接 400，见 `packages/core/src/engine/patch-orphaned-tools.ts:5`。工具定义展示和执行都要读同一类 session 状态，是因为 registry 在 worker 内共享且构造期冻结，模型可能仍点名隐藏工具；所以 Engine 做可见性过滤，Executor 再执行期拒绝，见 `packages/core/src/engine/engine.ts:1802`、`packages/core/src/tool-system/executor.ts:139`。

### 1.3 TurnLoop 状态机与 StreamEvent 产地

**What**

`TurnLoop` 是多轮 agent loop：每轮做 abort 检查、steer 注入、hook、上下文管理、模型调用、流式事件、工具执行、goal stop hook、token/turn budget、turn boundary。它的 run 主循环从 `packages/core/src/engine/turn-loop.ts:529` 开始，运行中状态字段在 `packages/core/src/engine/turn-loop.ts:189`。

**How**

每轮开头递增 `turnCount`、重置 usage、检查 abort，并消费 step-gap steer 到 messages，见 `packages/core/src/engine/turn-loop.ts:556`、`packages/core/src/engine/turn-loop.ts:566`、`packages/core/src/engine/turn-loop.ts:581`。然后发 `stream_request_start`，执行 `on_turn_start` hook，注入 turn-limit 提醒，做 context management，并在非 micro compact 后触发 `post_compact` hook，见 `packages/core/src/engine/turn-loop.ts:603`、`packages/core/src/engine/turn-loop.ts:651`、`packages/core/src/engine/turn-loop.ts:668`。

模型调用由 `callModelWithFallback()` 处理 streaming fallback、ContextLimit recovery、tombstone 等；主路径在 `packages/core/src/engine/turn-loop.ts:688`。如果无工具调用，TurnLoop 发 `assistant_message`，触发 `on_stop`，goal hook 可用 `continueSession` 阻止结束并追加提醒，见 `packages/core/src/engine/turn-loop.ts:876`、`packages/core/src/engine/turn-loop.ts:892`。如果有工具调用，TurnLoop 记录 assistant tool_use、发缺失的 `tool_use_start`、通过 `StreamingToolQueue` 执行工具、记录 transcript、发 `tool_result`，见 `packages/core/src/engine/turn-loop.ts:980`、`packages/core/src/engine/turn-loop.ts:1014`、`packages/core/src/engine/turn-loop.ts:1021`。Engine 在 TurnLoop 返回后持久化状态并最终发 `turn_complete`，见 `packages/core/src/engine/engine.ts:2340`、`packages/core/src/engine/engine.ts:2362`。

**Why**

TurnLoop 的 `run()` 明确要求“must never reject”，否则 Engine 的后置 saveState / on_session_end 会跑不到，session 会停留在 active，见 `packages/core/src/engine/turn-loop.ts:548`。loop-top abort 是为了避免已取消的子 agent 继续跑 context compaction、模型调用和工具批次，见 `packages/core/src/engine/turn-loop.ts:566`。工具批次 cap 从 10 提到 25，是因为现代模型常一次并行读十几个文件；多余调用会被提醒而不是静默丢弃，见 `packages/core/src/engine/engine.ts:2135`、`packages/core/src/engine/turn-loop.ts:1065`。

### 1.4 ModelFacade、上下文与用量持久化

**What**

`ModelFacade` 是 LLM client 与 transcript / stream / usage 之间的适配层，见 `packages/core/src/engine/model-facade.ts:1`。`session-usage.ts` 管 session 累计 token/cache 计数，`token-budget.ts` 管单轮输出预算，ContextManager 由 Engine 组装并交给 TurnLoop。

**How**

`ModelFacade.call()` 记录脱敏后的 LLM request，streaming 时把模型 chunk 转成 `text_delta`、`tool_use_start`、`tool_use_args_delta`，再记录响应、usage 和 transcript，见 `packages/core/src/engine/model-facade.ts:55`、`packages/core/src/engine/model-facade.ts:73`、`packages/core/src/engine/model-facade.ts:230`。TurnLoop 在每次模型响应后把真实 usage 回灌 ContextManager，作为后续 compaction 的实际锚点，见 `packages/core/src/engine/turn-loop.ts:741`、`packages/core/src/engine/turn-loop.ts:747`。Engine 在 turn boundary 用 `foldRunUsage(baseline, current)` 写回 session state，并发 session-cumulative `usage_update`，见 `packages/core/src/engine/engine.ts:2146`。`foldRunUsage` 明确用 baseline + current，而不是累加写回值，见 `packages/core/src/engine/session-usage.ts:92`。

**Why**

模型调用封装成 facade 的理由是把“调用 provider、流式事件、日志、transcript、usage”收束在一个边界，不让 TurnLoop 直接知道各 provider 细节；这一点由文件头和 `recordResponse()` 的 transcript 集成体现，见 `packages/core/src/engine/model-facade.ts:1`、`packages/core/src/engine/model-facade.ts:230`。usage 用 baseline + current 是为了 turn-boundary heartbeat 多次触发时保持幂等，避免把同一 run 的 running total 重复累计，见 `packages/core/src/engine/session-usage.ts:101`。ContextManager 使用真实 usage 锚点，是为了避免纯 char/4 估算导致 compaction 决策失真，见 `packages/core/src/engine/turn-loop.ts:747`。

### 1.5 运行中控制与恢复：steer、streaming queue、orphan patch、headless 背景续跑

**What**

这一组是运行中控制和“踩坑修复”模块：`steer-queue.ts` 管不打断注入，`streaming-tool-queue.ts` 管流式工具并发，`patch-orphaned-tools.ts` 管恢复时的 dangling tool_use，Engine 还在 headless 场景特殊处理背景 sub-agent。

**How**

Engine 用 `steerQueueBySid` 保存 per-session in-memory steer 队列，只有当前 active TurnLoop 且 sid 匹配时接受注入，见 `packages/core/src/engine/engine.ts:384`、`packages/core/src/engine/engine.ts:820`。纯 helper 负责入队、消费、撤回，见 `packages/core/src/engine/steer-queue.ts:1`。TurnLoop 每个 step boundary 调 `consumeQueuedSteer()`，注入为 user message 并发 `steer_injected`，见 `packages/core/src/engine/turn-loop.ts:581`。

`StreamingToolQueue` 对 `isConcurrencySafe` 工具立即开始执行，对 unsafe 工具在 drain 时串行执行，并把 rejected promise 统一转成 error ToolResult，见 `packages/core/src/engine/streaming-tool-queue.ts:29`、`packages/core/src/engine/streaming-tool-queue.ts:49`。`patchOrphanedToolUses()` 扫描完整 messages，给缺 result 的 tool_use 插入 synthetic error tool_result，且幂等，见 `packages/core/src/engine/patch-orphaned-tools.ts:49`。headless run 会在 TurnLoop 返回后等待“自己的背景 sub-agent”完成并注入 summary，但不等待 shell/video，见 `packages/core/src/engine/engine.ts:2201`。

**Why**

steer 的动机是“不打断”：host 可把用户新消息排到下一步，而不 abort 当前模型或工具工作；队列不持久化，避免跨进程恢复时出现无法解释的 pending 草稿，见 `packages/core/src/engine/engine.ts:384`、`packages/core/src/engine/steer-queue.ts:2`。StreamingToolQueue 的 rejected-to-result 设计是为了一个工具 ask/permission 抛错时不丢失其它工具结果，也不让下游 `toolResultToBlock` 碰到 undefined，见 `packages/core/src/engine/streaming-tool-queue.ts:53`。headless 等待背景 sub-agent 是因为 one-shot 调用者拿 `result.text` 当最终答案，没有后续 server wakeup；但 shell 可能永不退出、video 很慢，不能一起阻塞，见 `packages/core/src/engine/engine.ts:2208`。

### 1.6 Goal、token budget 与图片策略

**What**

`goal.ts` 规范 goal mode 的内部形状、turn/stop/budget 上限和 mid-run extension；`token-budget.ts` 控制普通输出预算；`image-policy.ts` 控制图片附件大小、数量、历史污染防护。Goal run 的 EngineConfig 入口在 `packages/core/src/engine/types.ts:64`。

**How**

Goal 被 normalize 成 `GoalConfig`，在 run boundary 注册 `GoalStopHook`，TurnLoop 的 `on_stop` 让 judge 判断是否完成；未完成时发 `goal_progress:not_met` 并继续，完成或耗尽时发对应事件，见 `packages/core/src/engine/goal.ts:1`、`packages/core/src/engine/turn-loop.ts:892`、`packages/core/src/engine/turn-loop.ts:913`。Goal 的 token/time budget 是 run-scoped，跨 turn 累计，见 `packages/core/src/engine/goal.ts:9`、`packages/core/src/engine/turn-loop.ts:836`。普通 token budget 用 `checkTokenBudget()` 在接近 90% 时 nudge，之后停止或因收益递减停止，见 `packages/core/src/engine/token-budget.ts:21`。图片在 parse-task 之后、进入 provider 前执行 policy；超大单图可被 drop 为文本占位，避免污染历史，见 `packages/core/src/engine/image-policy.ts:1`、`packages/core/src/engine/image-policy.ts:133`、`packages/core/src/engine/image-policy.ts:151`。

**Why**

Goal 的预算 tracker 是 run-scoped，是为了无人值守目标不会无限烧 token 或时间，见 `packages/core/src/engine/goal.ts:9`。goal mode 抬高 maxTurns，是因为“直到完成”的目标可能远超一次交互 prompt，真正 backstop 是 token/time budget 和 maxStopBlocks，见 `packages/core/src/engine/engine.ts:2126`、`packages/core/src/engine/goal.ts:147`。图片策略的动机来自真实问题：4MB screenshot base64 导致 provider connection error；Engine 是发出昂贵 vision 调用前最后能便宜拒绝的位置，见 `packages/core/src/engine/image-policy.ts:5`、`packages/core/src/engine/image-policy.ts:25`。

## 2. Tool System

### 2.1 ToolRegistry、内建工具族与 preset 白名单

**What**

`ToolRegistry` 是 built-in tools 和 MCP tools 的统一注册/执行目录，见 `packages/core/src/tool-system/registry.ts:1`。`builtin/index.ts` 定义内建工具注册清单和 metadata；`preset/index.ts` 定义不同 agent preset 下哪些 builtin 暴露给模型，以及默认权限规则。

**How**

Registry 构造时按可选 builtin whitelist 注册 `BUILTIN_TOOLS`，未知 builtin 直接抛 ConfigError；注册时调用 `validateToolMetadata()` 检查 pathPolicy 与 schema 是否一致，见 `packages/core/src/tool-system/registry.ts:30`、`packages/core/src/tool-system/validate-tool-metadata.ts:1`。执行时先查 tool 和 executor，再应用 timeout、parent abort cascade、per-call child signal，最后把 string / contentBlocks / sandbox 统一归一成 `ToolResult`；普通执行错误转成 error ToolResult，不向 TurnLoop 抛，见 `packages/core/src/tool-system/registry.ts:85`。

内建工具按族可以归纳为：文件类 Read/Write/Edit/ApplyPatch/NotebookEdit，执行类 Bash/PowerShell/background shell，检索类 Glob/Grep/WebSearch/WebFetch，编排类 Agent/DriveAgent/Cron/Todo/Skill/MCP/Memory，生成类 GenerateImage/GenerateVideo，浏览器和凭证桥接类 browser_* / UseCredential / InjectCredential。注册 metadata 声明 `permissionDefault`、`isReadOnly`、`isConcurrencySafe`、`timeoutMs`、`pathPolicy`，例如 Read/Write/GenerateImage 见 `packages/core/src/tool-system/builtin/index.ts:159`、`packages/core/src/tool-system/builtin/index.ts:171`、`packages/core/src/tool-system/builtin/index.ts:192`。preset whitelist 把实际可见 builtin 集限定在 `GENERAL_BUILTIN_TOOLS` / `TERMINAL_CODING_EXTRA_TOOLS`，见 `packages/core/src/preset/index.ts:34`。

**Why**

Registry 统一 builtins 和 MCP，是为了 TurnLoop/Executor 只面对一个工具目录，见 `packages/core/src/tool-system/registry.ts:1`。registration-time metadata 校验是安全动机：`pathPolicy.arg` 拼错会让路径保护静默 no-op，所以要 fail loud，见 `packages/core/src/tool-system/validate-tool-metadata.ts:4`。preset 白名单的注释反复说明一个现实约束：工具即使在 `BUILTIN_TOOLS` 里注册，如果不在 preset whitelist 里，`registerBuiltins` 会过滤掉，模型会“找不到工具”，见 `packages/core/src/preset/index.ts:42`、`packages/core/src/preset/index.ts:106`、`packages/core/src/preset/index.ts:119`。

### 2.2 ToolExecutor、ToolContext 与 ToolRuntimeHost

**What**

`ToolExecutor` 编排一次工具调用的安全链路：capability gate、plan gate、schema validation、pre_tool_use、path policy、permission、investigation guard、registry execution、post hooks、file_changed。`ToolContext` 是 Engine 每次 run 注入到所有工具的上下文对象；`ToolRuntimeHost` 是工具能回调 Engine 的窄接口。

**How**

Executor 持有 Registry、PermissionClassifier、HookRegistry，并可设置 run signal、ToolContext、turn-scoped logger、InvestigationGuard、TaskGuard，见 `packages/core/src/tool-system/executor.ts:55`。`executeSingle()` 的顺序是：abort fast-path；拒绝 disabled builtins / goal-only / visibility guard / session 外 MCP；plan-mode gate；JSON schema validation；pre_tool_use hook 和参数重写复验；path policy；permission classify + hook clamp + ask；registry execute；post hooks 和 file_changed，见 `packages/core/src/tool-system/executor.ts:119`、`packages/core/src/tool-system/executor.ts:219`、`packages/core/src/tool-system/executor.ts:250`、`packages/core/src/tool-system/executor.ts:302`、`packages/core/src/tool-system/executor.ts:366`、`packages/core/src/tool-system/executor.ts:433`。

ToolContext 包含 cwd、llmConfig、modelPool、toolRegistry、askUser、subAgentSpawner、sandbox、signal、hooks、streamCallback、planMode、permissionMode、engine host、sessionId、disabled skills/plugins/builtins、allowedMcpServers、settingsScope、shellEnv、browser/workspace/credential bridges 等，见 `packages/core/src/tool-system/context.ts:189`。`ToolRuntimeHost` 放在 tool-system 里，只列工具需要的 Engine 能力，见 `packages/core/src/tool-system/context.ts:24`。

**Why**

ToolContext 替代模块级 singleton，是为了并发 Engine 实例安全：工具不能看到另一个 Engine 的 askUser handler 或 LLM 凭证，见 `packages/core/src/tool-system/context.ts:1`。`ToolRuntimeHost` 放在低层 tool-system 而不导入 concrete Engine，是为了避免重新引入 `tool-system <-> engine` 循环依赖，见 `packages/core/src/tool-system/context.ts:24`；这也对应 CODESHELL 已知债务 `core -> tool-system -> engine` 循环，见 `CODESHELL.md:69`。Executor 的 hook clamp 是 A1 permission hardening：hook 可以收紧，但不能把 classifier 的 ask/deny 升级成 allow，见 `packages/core/src/tool-system/executor.ts:36`。

### 2.3 权限、路径策略、plan mode、hooks 与运行时 guard

**What**

权限层由 `permission.ts` 的 ApprovalBackend / PermissionClassifier、`path-policy.ts` 的文件路径策略、`plan-mode-allowlist.ts` 的只读工具集合、`hooks/registry.ts` 的 hook 链、`investigation-guard.ts` 的读预算 guard 共同组成。

**How**

`PermissionClassifier.classify()` 先处理 `bypassPermissions`，再匹配规则，然后特殊分类 Bash，最后按 mode fallback；`acceptEdits` 只允许 Write/Edit/ApplyPatch/NotebookEdit/TodoWrite 自动通过，见 `packages/core/src/tool-system/permission.ts:926`、`packages/core/src/tool-system/permission.ts:884`。Interactive backend 维护 operation-scoped session rules、项目规则回写 callback，并串行化 prompt，见 `packages/core/src/tool-system/permission.ts:136`、`packages/core/src/tool-system/permission.ts:191`。Auto backend 对 high risk 无 delegate 时 fail closed，中风险未知操作也 fail closed，见 `packages/core/src/tool-system/permission.ts:47`。

PathPolicy 对每个目标路径做 home/realpath、敏感路径匹配、workspace 判断；敏感写 deny，敏感读 ask，workspace 内非敏感 allow，workspace 外 ask，见 `packages/core/src/tool-system/path-policy.ts:1`、`packages/core/src/tool-system/path-policy.ts:460`。`enforcePathPolicyWithApproval()` 允许 `bypassPermissions` 跳过路径层，plan write blocked，并串行化路径审批，见 `packages/core/src/tool-system/path-policy.ts:582`。plan mode 工具集合是 Engine 展示层和 Executor 执行层的单一事实来源，见 `packages/core/src/tool-system/plan-mode-allowlist.ts:1`。HookRegistry 按 priority 执行，permission decision 合并时 deny > ask > allow，见 `packages/core/src/hooks/registry.ts:10`、`packages/core/src/hooks/registry.ts:78`。InvestigationGuard 把 prompt 里的“不要重复读、读几次要换策略”变成运行时提醒/阻断，见 `packages/core/src/tool-system/investigation-guard.ts:1`。

**Why**

权限/路径分层的理由是两类风险不同：acceptEdits 或 Bash sandbox 不能保护 Write 指向 `~/.aws/credentials` 这类 host path，因此文件工具要有独立路径策略，见 `packages/core/src/tool-system/path-policy.ts:4`。plan-mode allowlist 要单源，是因为过去展示给模型和执行器允许的集合漂移，导致模型看到的工具会被 executor 拒绝或反过来，见 `packages/core/src/tool-system/plan-mode-allowlist.ts:4`。InvestigationGuard 是把模型经常违反的软提示变成 in-loop 反馈，尤其 headless 模式不能 hard block，需要软提醒，见 `packages/core/src/tool-system/investigation-guard.ts:4`、`packages/core/src/tool-system/investigation-guard.ts:50`。

### 2.4 MCP 接入

**What**

`mcp-manager.ts` 负责连接外部 MCP server、发现工具、注册到 ToolRegistry、转发调用、包装不可信输出、管理共享连接池。它支持 stdio 和 streamable-http，见 `packages/core/src/tool-system/mcp-manager.ts:1`。

**How**

stdio 环境变量采用 allowlist + 显式 `envVars` / `config.env`，HTTP header 可从 credentialRef / env var 解析，见 `packages/core/src/tool-system/mcp-manager.ts:35`、`packages/core/src/tool-system/mcp-manager.ts:50`、`packages/core/src/tool-system/mcp-manager.ts:94`。MCP tool metadata 默认 `permissionDefault:"ask"`，只有 `annotations.readOnlyHint === true` 才标记 read-only/concurrency-safe，见 `packages/core/src/tool-system/mcp-manager.ts:262`。共享 MCPManager 用 owner desired sets 管每个 Engine 想要的 server 集合，connectAll/reconcile 只断开没有任何 owner 需要的 server，见 `packages/core/src/tool-system/mcp-manager.ts:295`、`packages/core/src/tool-system/mcp-manager.ts:326`、`packages/core/src/tool-system/mcp-manager.ts:367`。connect 通过 `connecting` map 合并同名并发握手，15 秒超时并 best-effort close transport，见 `packages/core/src/tool-system/mcp-manager.ts:415`、`packages/core/src/tool-system/mcp-manager.ts:488`。工具返回的 image blob 会 spill 到 `~/.code-shell/mcp_images`，文本返回被 `<mcp-result trust="untrusted">` 包裹，见 `packages/core/src/tool-system/mcp-manager.ts:187`、`packages/core/src/tool-system/mcp-manager.ts:242`、`packages/core/src/tool-system/mcp-manager.ts:566`。

**Why**

stdio env 用 allowlist 而不是 blacklist，是为了配合“按名称引用 secret”的模型，避免自定义 secret key 泄露或误杀 benign token-like env，见 `packages/core/src/tool-system/mcp-manager.ts:50`。MCP 输出包不可信边界，是为了防 prompt injection：第三方 server 返回的“指令”只能当数据摘要，不应被模型当命令执行，见 `packages/core/src/tool-system/mcp-manager.ts:139`。共享池 owner 语义是因为 worker 内多个 session/项目可以启用不同 MCP server；如果按最后一次 reconcile 直接断连，会互相杀掉对方正在用的连接，见 `packages/core/src/tool-system/mcp-manager.ts:367`。

### 2.5 Sandbox 与 host bridge 类工具

**What**

Sandbox 只包裹 Bash/ shell 命令，不沙箱化 Engine 进程本身；浏览器、凭证注入、workspace 切换等 host bridge 通过 ToolContext 和 protocol server 的 approval-like 通道转给宿主实现。

**How**

Sandbox backend 有 `off`、`seatbelt`、`bwrap`，`auto` 按平台探测；默认 writable roots 包括 workspace 和临时目录，默认 denied reads 包括 `~/.ssh`、`~/.aws`、`~/.code-shell` 等，见 `packages/core/src/tool-system/sandbox/index.ts:1`、`packages/core/src/tool-system/sandbox/index.ts:164`。显式 seatbelt/bwrap 不可用时抛 `SandboxUnavailableError`，只有 auto 可降级到 off 并警告，见 `packages/core/src/tool-system/sandbox/index.ts:185`。浏览器工具在 builtin metadata 中串行、observe read-only、act 按动作走规则，见 `packages/core/src/tool-system/builtin/index.ts:765`。Credential 工具默认 allow，但真正审批在工具内部 CredentialUseGate，避免双重弹窗，见 `packages/core/src/tool-system/builtin/index.ts:805`。ToolContext 暴露 browser/workspace/injectCredentialToBrowser bridge 字段，见 `packages/core/src/tool-system/context.ts:348`、`packages/core/src/tool-system/context.ts:357`、`packages/core/src/tool-system/context.ts:364`。

**Why**

Sandbox 只覆盖 spawned shell 的边界是显式设计：Engine 不是沙箱，Write/Edit 仍走应用层权限和路径策略，见 `packages/core/src/tool-system/sandbox/index.ts:4`。显式 sandbox mode fail closed，是因为用户明确要求某个后端时静默降级会违反安全预期；`EngineRuntime.resolveSandbox()` 也强调 explicit modes 抛错不能被 Engine turn-time catch 吞掉，见 `packages/core/src/engine/runtime.ts:71`。浏览器/凭证 bridge 不在 tool handler 内直接访问桌面实现，是因为 core 保持 UI-agnostic，宿主通过 ToolContext 注入能力；core 不得 import tui、desktop renderer 也不得 runtime-import core 之外的 codeshell 包，这个边界见 `CODESHELL.md:51`。

## 3. Protocol

### 3.1 协议类型、方法与 StreamEvent 契约

**What**

`protocol/types.ts` 定义 JSON-RPC 风格 envelope、request/response/notification、error codes、Run/Approve/Cancel/Configure/Query/Inject/Steer/Goal/Background 等参数与方法名，见 `packages/core/src/protocol/types.ts:1`、`packages/core/src/protocol/types.ts:22`、`packages/core/src/protocol/types.ts:335`。StreamEvent 类型本身来自 `packages/core/src/types.ts:429`，protocol 用 `AgentStreamEventNotification` 给多会话事件加 `sessionId` envelope，见 `packages/core/src/protocol/types.ts:11`、`packages/core/src/protocol/types.ts:313`。

**How**

Client -> Server 方法包括 `agent/run`、`agent/approve`、`agent/cancel`、`agent/configure`、`agent/query`、`agent/inject`、`agent/steer`、`agent/unsteer`、`agent/closeSession`、`agent/releaseWorkspace`、`agent/goalExtend`、`agent/goalClear`、`agent/goalGet`、`agent/backgroundShells`、`agent/backgroundWork`，见 `packages/core/src/protocol/types.ts:335`。Server -> Client notification 包括 `agent/streamEvent`、`agent/approvalRequest`、`agent/approvalResolved`、`agent/status`，见 `packages/core/src/protocol/types.ts:365`。`RunParams` 要求 client-minted `sessionId`，并携带 cwd、permissionMode、model、projectTrusted、planMode、requireExisting、goal 等 per-run 控制，见 `packages/core/src/protocol/types.ts:72`。

StreamEvent 当前全部形状为：`session_started`、`session_title`、`stream_request_start`、`steer_injected`、`text_delta`、`tool_use_start`、`tool_use_args_delta`、`tool_result`、`assistant_message`、`turn_complete`、`goal_progress`、`goal_set`、`goal_cleared`、`error`、`tombstone`、`task_update`、`memory_recalled`、`thinking_delta`、`agent_start`、`agent_backgrounded`、`agent_end`、`agent_heartbeat`、`tool_summary`、`context_compact`、`usage_update`、`background_agent_completed`，见 `packages/core/src/types.ts:429`、`packages/core/src/types.ts:452`、`packages/core/src/types.ts:463`、`packages/core/src/types.ts:502`、`packages/core/src/types.ts:534`、`packages/core/src/types.ts:542`、`packages/core/src/types.ts:588`。

**Why**

协议层的首要动机是把 agent engine/server 与 UI/client 分离：client 发请求，server 发 stream/approval notification 和 request response，见 `packages/core/src/protocol/types.ts:1`。RunParams 的 `sessionId` client-minted 是多会话协议的核心约束，server 多会话路径会拒绝缺失 sid 的 run，见 `packages/core/src/protocol/server.ts:394`。`projectTrusted` 由 host 而非 renderer 断言，是为了不让项目 settings 自授权危险字段，见 `packages/core/src/protocol/types.ts:94`。

### 3.2 AgentServer：协议服务端、会话路由与审批桥

**What**

`AgentServer` 包装 `ChatSessionManager` 或 legacy single Engine，处理 RPC 请求、把 StreamEvent 包进 `{sessionId,event}` 发给 client、管理 per-session approval flow、后台任务完成唤醒，见 `packages/core/src/protocol/server.ts:1`。

**How**

`handleRequest()` 分发所有 Methods，见 `packages/core/src/protocol/server.ts:329`。多会话 `handleRunMulti()` 校验 sessionId/task，`getOrCreate()` session，处理 `requireExisting`、per-run model、planMode，并把 askUser/browser/credential/workspace bridge 绑定到该 session engine，最后 `session.enqueueTurn()`，stream 统一转 `agent/streamEvent`，见 `packages/core/src/protocol/server.ts:394`、`packages/core/src/protocol/server.ts:424`、`packages/core/src/protocol/server.ts:440`、`packages/core/src/protocol/server.ts:463`、`packages/core/src/protocol/server.ts:490`。legacy path 用单个 abortController 和 running flag 保护重入，见 `packages/core/src/protocol/server.ts:528`。

Approval 在多会话路径按 `(sessionId, requestId)` 查 `ChatSession.pendingApprovals`，不回退到 legacy 全局 map，见 `packages/core/src/protocol/server.ts:652`。Cancel 会 abort session、drain queued turns，并主动 resolve pending approval/ask 为 cancelled，见 `packages/core/src/protocol/server.ts:713`。GoalExtend/Clear/Get、BackgroundShells/BackgroundWork、CloseSession/ReleaseWorkspace、Configure/Query/Inject/Steer/Unsteer 都在 server 内显式处理，见 `packages/core/src/protocol/server.ts:771`、`packages/core/src/protocol/server.ts:895`、`packages/core/src/protocol/server.ts:966`、`packages/core/src/protocol/server.ts:1030`、`packages/core/src/protocol/server.ts:1227`、`packages/core/src/protocol/server.ts:1788`、`packages/core/src/protocol/server.ts:1834`。

**Why**

多会话审批不能回退到 legacy map，是 fail-closed 的隔离要求：错 session 的 UI response 不能解开另一个 session 的 pending prompt，见 `packages/core/src/protocol/server.ts:655`。`requireExisting` 是为 cron “继续这个会话” 场景设计：目标 session 被用户删除时必须显式失败，避免在空白上下文里静默执行，见 `packages/core/src/protocol/server.ts:424`。Background work 的 auto-wakeup 是为了 interactive session 不再由 Engine 长时间 park，而是在后台完成事件到达时唤醒 idle session 继续总结/判断 goal，见 `packages/core/src/protocol/server.ts:220`、`packages/core/src/protocol/server.ts:512`。

### 3.3 AgentClient：UI/SDK 侧请求封装与事件分发

**What**

`AgentClient` 是 UI/SDK 侧面向业务的 client，替代直接使用 Engine；它通过 Transport 与 AgentServer 通信，并把 notification 转成 EventEmitter 事件，见 `packages/core/src/protocol/client.ts:1`。

**How**

Client 维护 `pendingRequests` map，请求用 `createRequest()` 发出，响应按 id resolve/reject，见 `packages/core/src/protocol/client.ts:63`、`packages/core/src/protocol/client.ts:349`、`packages/core/src/protocol/client.ts:357`。`run()` 支持新 object form 和 legacy string form，带 sessionId 时会提前给 logger stamp sid，见 `packages/core/src/protocol/client.ts:99`。`approve()` 同时支持多会话和 legacy overload，见 `packages/core/src/protocol/client.ts:143`。`steer()` / `unsteer()` 暴露不打断注入和撤回，见 `packages/core/src/protocol/client.ts:201`。`handleNotification()` 将 `agent/streamEvent` 包成 `{sessionId,event}`，approval/status 也转发给订阅者，见 `packages/core/src/protocol/client.ts:375`。

**Why**

Client 文件头明确说明它替代 UI 直接使用 Engine，从而让 UI 面对协议而不是进程内实现，见 `packages/core/src/protocol/client.ts:1`。`run()` 保留 legacy string form 是为了兼容 `createInProcessClient` 调用者，同时新 object form 满足 multi-session server 的必需 sessionId，见 `packages/core/src/protocol/client.ts:103`。`steer()` 方法注释说明它补齐 SDK 到 server steer method 的通路，否则 protocol merge 后会出现桌面 preload 有能力而 SDK 不能调的非对称，见 `packages/core/src/protocol/client.ts:201`。

### 3.4 ChatSession 与 ChatSessionManager

**What**

`ChatSession` 是“一个 UI chat tab 一个 Engine”的运行单元；它拥有 Engine、AbortController、FIFO 队列、per-session pending approvals、pending model switch、cancel flags。`ChatSessionManager` 管 live sessions map、Engine factory、max session/idle TTL、close/sweeper、MCP owner cleanup。

**How**

`ChatSession.enqueueTurn()` 把 task 入队并 pump；pump 一次只跑一个 active turn，创建 AbortController，把 task/cwd/goal/injected/clientMessageId 转发到 `engine.run()`，完成后再跑下一条，见 `packages/core/src/protocol/chat-session.ts:35`、`packages/core/src/protocol/chat-session.ts:88`、`packages/core/src/protocol/chat-session.ts:203`。`cancel()` abort 当前 controller、清空队列，并把用户取消的 active run resolve 成 clean `aborted_streaming`，见 `packages/core/src/protocol/chat-session.ts:110`、`packages/core/src/protocol/chat-session.ts:223`。model switch 忙时先记录 `pendingModel`，在 run boundary 应用并 reset session usage，见 `packages/core/src/protocol/chat-session.ts:168`、`packages/core/src/protocol/chat-session.ts:240`。

`ChatSessionManager.getOrCreate()` 打开 session path approvals，复用已有 session 时会在下一 turn 前重新应用 per-send permissionMode；新 session 通过 factory 创建 Engine，超过 maxSessions 抛 Overloaded，见 `packages/core/src/protocol/chat-session-manager.ts:53`。close 会 cancel session、清 path/credential approvals、unregister MCP owner，见 `packages/core/src/protocol/chat-session-manager.ts:98`。`closeAllAsync()` 额外 kill 全部 background shell 并清理 background-agent output files，见 `packages/core/src/protocol/chat-session-manager.ts:118`。

**Why**

FIFO 队列是为了 fast second send 不被静默拒绝，而是等待第一 turn 完成，见 `packages/core/src/protocol/chat-session.ts:35`。忙时延迟 model switch 是为了不在 running LLM client 下替换模型，注释直接指向 session-isolation 研究发现的问题，见 `packages/core/src/protocol/chat-session.ts:57`。Manager 复用 session 时重新应用 permissionMode，是为了修复已恢复 session 第一次创建时的档位一直沿用、后续 pill 改动不生效的问题，见 `packages/core/src/protocol/chat-session-manager.ts:58`。`close()` 不 kill 所有 background shell，而 `closeAllAsync()` 在 app/worker shutdown 时 kill，是为了 idle chat tab 切走再回来 dev server 仍可活着，但进程退出不能遗留孤儿，见 `packages/core/src/protocol/chat-session-manager.ts:118`。

### 3.5 Transport、factories、helpers 与 redaction

**What**

Transport 是协议的物理传输抽象，只有 `send/onMessage/close` 三个方法；实现包括 in-process、stdio NDJSON、TCP NDJSON。`factories.ts` 和 `helpers.ts` 提供业务侧推荐入口和 in-process 便利包装；`redact.ts` 在 query/config 边界清理 secret。

**How**

`createInProcessTransport()` 返回一对 EventEmitter-backed transport；close 只清理本端 incoming channel，见 `packages/core/src/protocol/transport.ts:17`、`packages/core/src/protocol/transport.ts:30`。`StdioTransport` 和 `SocketTransport` 都用一行一个 JSON 值的 framing，跳过 malformed lines，见 `packages/core/src/protocol/transport.ts:72`、`packages/core/src/protocol/tcp-transport.ts:24`。TCP listen 默认 `127.0.0.1`，见 `packages/core/src/protocol/tcp-transport.ts:64`。`createServer()` 从 flat config 构造 Engine + AgentServer，`createClient()` 包装 AgentClient，见 `packages/core/src/protocol/factories.ts:1`、`packages/core/src/protocol/factories.ts:86`。`createInProcessClient()` 用 in-process transport 包 Engine，close 顺序是 server 再 client，见 `packages/core/src/protocol/helpers.ts:42`。`redactLlmConfig()` 删除 apiKey，只返回 hasApiKey / apiKeyPreview；`maskSecretValue()` 处理 config_get 的单 key/value，见 `packages/core/src/protocol/redact.ts:3`、`packages/core/src/protocol/redact.ts:52`、`packages/core/src/protocol/redact.ts:81`。

**Why**

Transport 抽象让同一 AgentServer 可跑在同进程、stdio worker、TCP headless host 上，而 server 逻辑无需变化；TCP 文件头直接说明这是为了让同一 AgentServer 可被远程/本地 client 访问，见 `packages/core/src/protocol/tcp-transport.ts:4`。TCP v1 明确没有认证，只建议 localhost/SSH tunnel，不应公网绑定，见 `packages/core/src/protocol/tcp-transport.ts:14`。factories 保持 transport 外置，是为了不把 in-process、stdio、未来 IPC 的选择藏进 factory，避免破坏多 host 故事，见 `packages/core/src/protocol/factories.ts:21`。redaction 的理由是 protocol query 响应会到任何 connected client，原始 API key / provider credential / auth header 不能原样离开 server boundary，见 `packages/core/src/protocol/redact.ts:3`。

## 4. 交叉边界与已知约束

- Core 包实际在 `packages/core/`，没有 `src/core`；core 不能 import tui，desktop renderer 不能 runtime-import codeshell 包，见 `CODESHELL.md:49`、`CODESHELL.md:51`。
- Engine 与 tool-system 仍存在结构性耦合：ToolContext 里的 `ToolRuntimeHost` 是降低循环依赖的局部解法，但 CODESHELL 仍把 `core -> tool-system -> engine` 循环列为后续拆分债务，见 `packages/core/src/tool-system/context.ts:24`、`CODESHELL.md:69`。
- Arena 仍纠缠在 core/protocol/settings/index 多处，本文件只作为背景记录，不展开 B1 finding，见 `CODESHELL.md:70`。
- StreamEvent 是 engine/TurnLoop/ModelFacade/tool-system 共同产出的 UI 流契约，protocol 只负责 envelope 与跨进程传输；具体 union 在 `packages/core/src/types.ts:429`，protocol envelope 在 `packages/core/src/protocol/types.ts:313`。

## 5. 自查

- engine 已覆盖：EngineConfig/EngineRuntime/Engine.run、TurnLoop、ModelFacade/session usage、steer/streaming queue/orphan patch/headless 背景续跑、goal/token/image policy。
- tool-system 已覆盖：ToolRegistry/builtin/preset、ToolExecutor/ToolContext/ToolRuntimeHost、permission/path-policy/plan/hooks/investigation guard、MCP、sandbox/host bridge。
- protocol 已覆盖：types/methods/StreamEvent、AgentServer、AgentClient、ChatSession/Manager、transport/factories/helpers/redact。
- 每个子模块都包含 What / How / Why，并带 `file:line` 锚点。
- 本文未写 `packages/**` 源码，未运行 build，未涉及 A2/B1。
- 未标注“推测”：本次写入的 Why 均来自源码注释、CODESHELL 约束或直接代码结构；没有把无依据推断写成事实。
