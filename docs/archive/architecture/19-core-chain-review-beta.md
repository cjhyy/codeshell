# Core Chain Review for Beta

本文按 beta 提交前的阅读顺序梳理 `packages/core` 的核心链路。重点不是重复 API 注释,而是解释这些层为什么存在、它们互相怎么接、这样做的好处是什么,以及后续排查时应该从哪里下手。

范围按六个篇章组织:

1. Engine
2. Turn Loop
3. Tool System
4. Context
5. Session / Memory
6. Protocol / Host

## 0. 总体链路

一次用户输入的主路径是:

```text
Host/UI
  -> AgentClient / Transport / AgentServer
  -> ChatSessionManager / ChatSession
  -> Engine.run()
  -> TurnLoop.run()
  -> ModelFacade -> LLM provider
  -> ToolExecutor / ToolRegistry / builtin or MCP tools
  -> ContextManager
  -> Transcript / Session state
  -> StreamEvent back to Host/UI
```

这个结构把几个会频繁变化的东西分开:

- 宿主形态变化: TUI、Desktop worker、in-process、stdio、TCP、RunManager 自动化。
- 模型供应商变化: OpenAI-compatible、Anthropic、fallback model、aux model。
- 工具能力变化: builtin、MCP、plugin、skill、agent、background shell。
- 会话状态变化: transcript、state.json、memory、context compaction、undo/file history。
- 安全策略变化: permission mode、path policy、sandbox、plan mode、capability override、hooks。

核心收益是: Engine 负责装配,TurnLoop 负责状态机,Tool System 负责执行边界,Context 负责上下文压力,Session/Memory 负责持久化,Protocol/Host 负责多宿主接入。每层的职责比较清楚,大多数 bug 可以先定位到层,再进具体文件。

## 1. Engine

### 1.1 职责定位

`Engine` 是 core 的主门面,但它不是大脑本身。它的职责是把一轮运行需要的所有依赖装好:

- 解析当前 cwd、session、settings、preset、permission mode。
- 构造 LLM client、fallback clients、aux summary client。
- 构造 `ToolRegistry`、`ToolExecutor`、`ToolContext`、sandbox、MCP manager。
- 构造 `PromptComposer`、`ContextManager`、`ModelFacade`。
- 注册 run-scoped hooks,例如 goal stop hook、file history hook。
- 创建并运行 `TurnLoop`。
- 运行结束后保存 state、发 session hooks、触发 memory pipeline 和 session title 生成。

关键文件:

| 文件 | 角色 |
|---|---|
| `packages/core/src/engine/engine.ts` | 主装配层和对外 API。 |
| `packages/core/src/engine/runtime.ts` | worker 内共享 runtime,包括 model pool、tool registry、MCP pool、settings、cost tracker、sandbox cache。 |
| `packages/core/src/engine/model-facade.ts` | LLM 调用门面,负责 transcript/logging/usage/fallback model。 |
| `packages/core/src/engine/dynamic-tool-defs.ts` | 每轮把动态工具描述补齐,例如 Agent tool 的 agent_type 枚举。 |
| `packages/core/src/engine/goal.ts` | goal 模式预算、续跑、停止块上限。 |
| `packages/core/src/engine/session-title.ts` | 首轮结束后的标题生成。 |
| `packages/core/src/engine/image-policy.ts`、`image-compression.ts`、`parse-task.ts` | 用户输入图片解析、策略检查、压缩。 |
| `packages/core/src/engine/friendly-error.ts` | 面向 UI 的错误文本。 |
| `packages/core/src/engine/token-budget.ts`、`reactive-threshold.ts` | turn/goal 预算和响应式阈值。 |

### 1.2 Engine.run 的主流程

`Engine.run(task, options)` 的真实流程可以概括为:

1. 确定 cwd 和 session。
2. 读取/恢复 transcript,追加用户消息。
3. 创建或刷新 per-run ToolContext。
4. 根据 settings/preset/capability overrides 计算工具可见性。
5. 构造 system prompt 和 system context。
6. 建立 ContextManager 的 summarization 回调。
7. 构造 ModelFacade 和 TurnLoop。
8. 运行 TurnLoop。
9. 等待当前 session 的后台 sub-agent 完成并注入结果。
10. 保存 session state 和 compacted message cache。
11. 触发 memory pipeline 和 title generation。

为什么这么做:

- Engine 每轮重新计算工具列表和 prompt,所以项目级 capability override、feature flag、settings hot reload 可以在下一条消息生效。
- ToolRegistry 可以被 runtime 共享,但 Engine 每轮给 executor 注入新的 ToolContext,避免不同 session 的 cwd、askUser、model、permissions 串线。
- LLM 主调用和 aux 调用分开,summary/title/memory 可以走便宜模型,不污染主会话成本统计。
- Goal hook 是 run-scoped,结束后 unregister,避免一个 goal 污染后续普通消息。

### 1.3 好处

- 适合多宿主: TUI/Desktop/RunManager 都可以通过同一个 Engine 入口跑。
- 适合多 session: 可共享重资源,但 per-session 状态留在 Engine/ChatSession 内。
- 适合热更新: prompt、hooks、MCP、permission mode、capability override 都能按边界更新。
- 适合 beta 排障: Engine 日志能看到 sessionId、turn、turnId、model、reason、tokens。

### 1.4 Beta 前注意点

- `EngineRuntime` 共享 `ToolRegistry` 和 `MCPManager`,所以任何直接 mutate registry 的逻辑都要确认不会影响其他 session。当前 builtin override 主要通过每轮可见性和 executor gate 处理,这是正确方向。
- `Engine.run()` 后置的 memory pipeline/title 是 fire-and-forget。它们不能影响主结果,但如果 beta 里用户反馈退出后仍有后台日志,先看这里。
- `resolveAuxClient()`、`resolveFallbackClients()` 都是 best effort。fallback 失败会 warn 并跳过,不是硬失败。

## 2. Turn Loop

### 2.1 职责定位

`TurnLoop` 是真正的 agent 状态机。文件是 `packages/core/src/engine/turn-loop.ts`。

它的循环结构是:

```text
turn start
  -> abort fast path
  -> on_turn_start hook
  -> limit reminders
  -> contextManager.manageAsync()
  -> post_compact hook
  -> model call
  -> usage/context accounting
  -> truncated-output recovery
  -> goal budget check
  -> no tool calls? final/on_stop/goal judge
  -> tool calls? execute tools
  -> append tool results
  -> context usage update
  -> next turn
```

### 2.2 关键文件

| 文件 | 角色 |
|---|---|
| `turn-loop.ts` | 多轮状态机。 |
| `turn-state.ts` | 每轮状态/turnId。 |
| `streaming-tool-queue.ts` | 工具执行队列,把并发安全工具和顺序工具统一 drain。 |
| `patch-orphaned-tools.ts` | abort/error 时修复消息里的孤儿 tool_use/tool_result。 |
| `tool-summary.ts` | 工具调用摘要事件,非阻塞。 |
| `stop-reason.ts` | 供应商 stop reason 归一化。 |

### 2.3 为什么把 TurnLoop 从 Engine 拆出来

Engine 管装配,TurnLoop 管“这轮怎么继续”。拆开之后:

- Engine 不需要知道每个 stop reason、tool cap、context recovery 的细节。
- TurnLoop 可以专注状态机不变量,例如 tool_use 和 tool_result 配对、max turns、goal stop blocks、abort。
- 单测更容易聚焦: `turn-loop-*` 测试只看循环行为,不需要完整 host。

### 2.4 关键设计点

- `run()` 不应该 reject。外层注释明确说如果 TurnLoop 抛出,Engine 的 state 保存和 session_end hook 会丢,导致 session 卡在 active。当前代码把外层错误转成 terminal reason。
- abort 检查有三层: loop 顶部、context manage 后、model/tool 后。这是为了阻止用户停止后继续烧 token 或继续执行工具。
- context 管理发生在模型调用前,工具结果追加后也会发 usage update,让 UI 的 context bar 不滞后。
- 如果模型因 max output tokens 截断了 tool call,TurnLoop 不执行半截参数,而是注入 reminder 让模型下一轮重试。
- 工具调用超过 `maxToolCallsPerTurn` 时,只执行前 N 个,并明确告诉模型哪些没跑,避免模型假设全部成功。
- goal 模式用 `on_stop` hook 阻止结束,并用 stop-block 上限防止无限循环。

### 2.5 好处

- 状态转移清楚,便于对照日志排查。
- 对模型异常输出有恢复策略,不会把半截工具参数当真。
- 用户取消更可靠,尤其是 sub-agent 或多工具批量场景。
- goal 模式和普通聊天共用循环,但通过 hook 和 budget 隔离。

### 2.6 Beta 前注意点

- `StreamingToolQueue` 名字容易误解。当前 TurnLoop 是在完整 model response 返回后 enqueue/drain,不是工具参数流式到一半就执行。
- `finalText` 是当前最后一次模型文本,工具轮里如果没有新文本,最终 summary 取决于后续无工具轮。排查“最后回答为空”时看工具轮是否被 abort 或 cap。
- `tool_summary` 是异步 best effort。不要把它当作可靠业务状态。

## 3. Tool System

### 3.1 职责定位

Tool System 是执行边界。它回答四个问题:

1. 有哪些工具。
2. 模型看得到哪些工具。
3. 模型请求的工具能不能执行。
4. 真正执行时带哪些上下文和安全限制。

### 3.2 关键文件

| 文件 | 角色 |
|---|---|
| `tool-system/registry.ts` | 注册 builtin/MCP/custom 工具,统一 timeout 和返回格式。 |
| `tool-system/executor.ts` | 工具执行编排: abort、plan gate、validation、hooks、permission、registry。 |
| `tool-system/context.ts` | 每个 Engine 的 ToolContext,替代旧 singleton。 |
| `tool-system/permission.ts` | 权限分类、approval backend、session cache。 |
| `tool-system/path-policy.ts` | 文件路径 allow/ask/deny,含 workspace/sensitive/external 规则。 |
| `tool-system/validation.ts` | schema 参数校验。 |
| `tool-system/investigation-guard.ts` | 防重复读取和调查预算提醒。 |
| `tool-system/task-guard.ts` | task/todo 相关约束。 |
| `tool-system/mcp-manager.ts` | MCP server 连接和工具注册。 |
| `tool-system/sandbox/*` | Bash 沙箱后端: off、seatbelt、bwrap。 |
| `tool-system/builtin/*` | 内置工具实现。 |

### 3.3 执行顺序

`ToolExecutor.executeSingle()` 的顺序是:

```text
abort fast path
  -> disabled builtin gate
  -> plan mode gate
  -> schema validation
  -> pre_tool_use hook
  -> re-validation if hook rewrites args
  -> investigation guard
  -> PermissionClassifier.classify()
  -> on_permission_check hook, downgrade-only
  -> approval backend when ask
  -> on_tool_start hook
  -> ToolRegistry.executeTool()
  -> on_tool_end hook
  -> post_tool_use hook
  -> file_changed hook for Write/Edit
```

为什么这个顺序重要:

- 先做 abort/gate,能避免取消后还跑 hook 和权限询问。
- validation 在 permission 前,避免权限层处理畸形输入。
- pre_tool_use 可以 rewrite,但 rewrite 后重验,避免 hook 引入非法参数。
- permission hook 不能把 ask/deny 提升到 allow,避免插件或 hook 绕过用户授权。
- registry 层永远把工具异常归一为 `ToolResult`,TurnLoop 可以继续把错误反馈给模型。

### 3.4 ToolContext 为什么重要

`ToolContext` 把过去容易串线的模块级 singleton 变成每个 Engine 的上下文:

- cwd
- llmConfig/modelPool
- toolRegistry
- askUser
- subAgentSpawner
- agentDefinitions
- sandbox
- hooks
- streamCallback
- sessionId
- planMode/permissionMode
- disabled skills/plugins/builtins
- background shell manager
- project shell env

好处是并发 Engine 更安全。比如 Desktop 多标签、sub-agent、automation 同时跑时,工具不会拿到另一个 session 的 askUser 或 cwd。

### 3.5 Builtin 工具分组

高频工具可以按职责读:

- 文件读写: `read.ts`、`write.ts`、`edit.ts`、`apply-patch/*`、`notebook-edit.ts`。
- shell: `bash.ts`、`powershell.ts`、`background-shell-tools.ts`、`repl.ts`。
- 搜索/网络: `grep.ts`、`glob.ts`、`web-search.ts`、`web-fetch.ts`。
- agent/orchestration: `agent.ts`、`agent-registry.ts`、`agent-status.ts`、`task.ts`、`plan.ts`、`complete-goal.ts`。
- media: `view-image.ts`、`generate-image.ts`、`generate-video.ts`、provider files。
- config/memory/automation: `config.ts`、`memory.ts`、`cron.ts`、`update-automation-memory.ts`。
- plugin/skill: `skill.ts`、`skill-prompt.ts`、`tool-search.ts`、`add-marketplace.ts`。

### 3.6 好处

- 安全策略集中在 executor/permission/path-policy/sandbox,工具实现可以更小。
- registry 和 executor 分开,让工具定义、可见性、执行策略可以独立变化。
- hooks 有明确的插入点,并且不能无条件提权。
- sub-agent、MCP、builtin 都可以回到同一 ToolResult 形态。

### 3.7 Beta 前注意点

- 文件路径策略不是 executor 顶层统一调用,而是文件工具内部调用。新增文件工具时必须主动接入 `path-policy.ts`。
- `bypassPermissions` 会让 `handleAsk()` 自动 approve。若将来需要“bypass 仍允许安全 hook 阻断”,需要重新定义该语义。
- `ToolRegistry.executeTool()` 会生成自己的 id,但 executor 会覆盖为模型 tool call id。这是为了 transcript/API 配对正确。

## 4. Context

### 4.1 职责定位

Context 层负责在不破坏 LLM API 消息不变量的前提下,控制消息数组大小。

关键文件:

| 文件 | 角色 |
|---|---|
| `context/manager.ts` | 三层上下文管理编排。 |
| `context/compaction.ts` | token 估算、microcompact、summary/window/snip/emergency 策略。 |
| `context/tool-result-storage.ts` | 大工具结果落盘并替换为 preview。 |
| `context/token-counter.ts` | 消息 token 估算。 |

### 4.2 管理顺序

`ContextManager.manageAsync()` 的顺序是:

```text
persist large tool_results to disk
  -> hard truncate surviving oversized tool_results
  -> per-message aggregate tool-result budget
  -> microcompact old compactable tool results
  -> async summary compaction when pressure is high
  -> snip/window/emergency fallback
```

`manage()` 是同步版本,适合没有 LLM summarization 的场景。

### 4.3 为什么先落盘再压缩

大工具输出如果直接截断,模型无法找回原文。先落盘有几个好处:

- preview 留在上下文里,完整内容保存在 session 目录的 `tool-results/`。
- replacement decision 通过 `ContentReplacementState` 冻结,避免同一个 tool_use_id 每轮重新判断造成 prompt cache 抖动。
- resume 时从消息里重建 replacement state,保证恢复后行为一致。

### 4.4 为什么要保护 tool_use/tool_result 配对

OpenAI/Anthropic 工具消息都有配对约束。`adjustIndexToPreserveAPIInvariants()` 会在裁剪窗口时往前扩展起点,确保保留下来的 `tool_result` 能找到对应 `tool_use`。

好处:

- context compact 不会制造 API validation error。
- emergency compact 即使很激进,也尽量保持协议合法。

### 4.5 microcompact 的策略

microcompact 只清理可重建工具的旧结果,例如 Read/Glob/Grep/Bash/WebFetch/WebSearch。它不会清理 Agent/Skill/Task 等编排工具的结果,因为那些结果代表会话状态。

为什么这样做:

- 旧 Read 内容可以重新读。
- 旧 Agent 结果可能是子任务完成状态,不能随便抹掉。
- 清掉后保留 fingerprint,让模型知道曾经读过什么,而不是完全失忆。

### 4.6 好处

- 大输出不会直接冲爆上下文。
- 压缩是渐进式的: 保真落盘、预算、去重、micro、summary、window。
- 使用真实 API usage 校准估算,UI context bar 更接近真实 prompt tokens。
- compaction 事件会回流到 UI 和 hooks,可解释“为什么上下文变短了”。

### 4.7 Beta 前注意点

- `ContextManager` 依赖 Engine 注入 summarizeFn。没有 aux model 时会退回主模型。
- 工具结果落盘失败会降级为保留原结果,不会中断主流程。只是在只读文件系统里可能更快触发后续截断。
- `microcompactFloorRatio` 过低会造成模型重复读取文件;当前默认 0.7 是为了避免早期 churn。

## 5. Session / Memory

### 5.1 Session 职责定位

Session 层负责“当前对话发生了什么”和“如何恢复”。

关键文件:

| 文件 | 角色 |
|---|---|
| `session/session-manager.ts` | session 目录、state.json、create/resume/list/fork。 |
| `session/transcript.ts` | JSONL 事件日志和 `toMessages()` 转换。 |
| `session/file-history.ts` | Write/Edit/ApplyPatch 前快照,支持 undo/redo。 |
| `session/simple-diff.ts`、`undo-target.ts` | undo 目标和 diff 辅助。 |
| `types.ts` | SessionState、TranscriptEvent、Message、ToolResult 等共享类型。 |

### 5.2 Transcript 是事件日志,不是聊天数组

`Transcript` 存的是事件:

- `session_meta`
- `message`
- `tool_use`
- `tool_result`
- `turn_boundary`
- `summary`
- `error`

`toMessages()` 才把事件日志转换成 LLM 所需的 `Message[]`。

为什么这样做:

- 事件日志可以保留比模型输入更丰富的信息,例如 turn boundary、error、summary。
- 模型输入可以过滤掉不该重放的事件。
- resume/fork/list/preview 可以各取所需,不用把聊天数组当数据库。

### 5.3 SessionManager 的安全边界

`assertSafeSessionId()` 会拒绝路径分隔符、`..`、异常字符和超长 id。原因是 public entry points 会把 sessionId join 到 session dir,必须防止路径逃逸。

好处:

- protocol client、persisted state、explicitSessionId 都不能逃出 sessions 目录。
- beta 里如果暴露 remote/TCP/in-process client,session id 仍有基础防护。

### 5.4 Memory 职责定位

Memory 层负责跨 session 的长期信息。

关键文件:

| 文件 | 角色 |
|---|---|
| `session/memory.ts` | MemoryManager,markdown 文件存储,user/dream scope,soft delete。 |
| `services/memory-orchestrator.ts` | Engine 结束后的 memory pipeline 编排。 |
| `services/extract-memories.ts` | 从 transcript 提取 durable memory。 |
| `services/session-memory.ts` | session summary 存储。 |
| `services/auto-dream.ts` | dream 触发节奏。 |
| `services/dream-consolidation.ts` | dream tool-call loop。 |
| `services/session-memory-sort.ts` | session memory 排序。 |

### 5.5 user / dream 双 scope

Memory 分两个 scope:

- `user`: 用户拥有的记忆,修改需要权限。
- `dream`: 自动整理工作区,LLM 可以更自由地合并/删除。

为什么这么做:

- 自动整理不会直接破坏用户记忆。
- dream 可以先作为草稿区积累和去重。
- prompt 注入时能明确告诉模型哪些记忆归用户所有。

### 5.6 Memory pipeline

Engine 结束后 fire-and-forget:

```text
transcript -> sanitize image/base64 -> MemoryOrchestrator
  -> extract durable memories
  -> save session summary
  -> record session
  -> maybe auto-dream
```

为什么不阻塞主结果:

- 记忆是辅助能力,失败不应该让用户这轮对话失败。
- 可以走 aux/extraction model,降低成本。
- 长 transcript 的提取不会卡 UI 的 turn complete。

### 5.7 好处

- session 和 memory 分工明确: session 是本次会话事实,memory 是跨会话知识。
- transcript JSONL 易追加、易恢复、易局部跳过坏行。
- memory markdown 文件可读、可手动恢复,soft delete 降低误删风险。
- projectDir scope 让项目记忆不污染全局。

### 5.8 Beta 前注意点

- `Transcript.flush()` 失败会静默,事件仍在内存。磁盘异常时当前 turn 可继续,但 resume 可能不完整。
- `Transcript.loadFromFile()` 会跳过 malformed lines 并 repair tool pairs。坏 JSONL 不会整体致命,但可能丢事件。
- Memory frontmatter 解析较轻量,不是完整 YAML parser。复杂冒号/换行字段后续要谨慎。

## 6. Protocol / Host

### 6.1 职责定位

Protocol/Host 层把 core 接到不同宿主,同时保证多 session、取消、审批、流事件、配置热更新有统一语义。

关键文件:

| 文件 | 角色 |
|---|---|
| `protocol/types.ts` | JSON-RPC 方法、参数、响应、错误码。 |
| `protocol/transport.ts` | in-process 和 stdio transport。 |
| `protocol/tcp-transport.ts` | TCP NDJSON transport。 |
| `protocol/client.ts` | AgentClient。 |
| `protocol/server.ts` | AgentServer,请求分派、审批、配置、query、stream event。 |
| `protocol/chat-session.ts` | 单 session FIFO、取消、模型切换延迟到 run boundary。 |
| `protocol/chat-session-manager.ts` | 多 session 管理、idle sweeper、shutdown cleanup。 |
| `protocol/helpers.ts`、`factories.ts` | in-process client/server 组合辅助。 |
| `cli/agent-server-stdio.ts`、`agent-server-tcp.ts` | host worker 入口。 |
| `run/*` | Managed run/automation backend。 |
| `automation/*`、`cron/*` | 定时任务和自动化调度。 |
| `runtime/*` | shell/background-shell/safe-spawn/ring-file。 |

### 6.2 ChatSession 为什么存在

`ChatSession` 是每个 UI tab/session 的串行执行器:

- `enqueueTurn()` 把用户输入排队。
- `pump()` 保证同一 session 同时只有一个 Engine.run。
- `cancel()` abort 当前 turn 并清空后续队列。
- `requestModelSwitch()` 如果当前 busy,延迟到 run boundary。

好处:

- 快速连发不会让两个 Engine.run 同时写同一个 transcript。
- 用户取消是 session-scoped。
- 模型切换不会发生在正在流式输出的 LLM client 中途。

### 6.3 ChatSessionManager 为什么存在

`ChatSessionManager` 负责多个 ChatSession:

- get or create session。
- 限制 max sessions。
- idle TTL 清理。
- shutdown 时 cancel sessions、kill background shells、清理 agent output files。
- 对已有 session 重新应用 permission mode。

好处:

- Desktop/TUI 可以多标签并行,不同 session 不互相阻塞。
- worker 关闭时能统一回收 background shell,降低 beta 用户遇到端口残留的概率。

### 6.4 AgentServer 为什么存在

`AgentServer` 把协议消息翻译成 core 调用:

- `agent/run` -> ChatSession.enqueueTurn。
- `agent/cancel` -> ChatSession.cancel。
- `agent/approve` -> pending approval resolve。
- `agent/configure` -> settings 写入或 reload broadcast。
- `agent/query` -> models/sessions/config/tools/background shells 等查询。
- stream event 包上 sessionId 发给 client。

为什么不让 UI 直接调 Engine:

- 同一协议可以跑 in-process、stdio、TCP。
- Desktop 可以把 core 放到 worker 子进程,隔离崩溃和阻塞。
- 手机/remote/automation 可以复用相同 run/approval/cancel 语义。
- approval/AskUser 的 pending 状态可以集中管理。

### 6.5 RunManager / EngineRunner

`run/*` 是更高层的 managed run 系统,不是 Engine 的替代品。

关键职责:

- `RunManager`: submit/queue/start/resume/cancel、状态机、event sourcing、heartbeat、crash recovery。
- `EngineRunner`: 把 `RunSnapshot` 转成 Engine.run,注入 run-aware approval backend 和 askUser adapter。
- `RunApprovalBackend`: approval/input 可以让 run 进入 waiting 状态,由外部 resume。

为什么放在 Engine 外:

- Engine 保持“执行一个会话”的职责。
- Managed run 可以有自己的状态机、持久化、恢复、队列和 evaluator。
- 自动化/后台任务可以复用 Engine,但不污染交互式聊天路径。

### 6.6 Runtime / Shell

`runtime/*` 支撑工具执行:

- `safe-spawn.ts`: 安全 spawn 包装,处理 abort/timeout。
- `spawn-common.ts`: kill process tree、shell invocation 辅助。
- `background-shell.ts`: long-running shell 进程、pidfile、orphan recovery、ring output。
- `ring-file.ts`: ring buffer 文件。
- `output-clean.ts`、`truncate-output.ts`: shell 输出清洗和截断。

好处:

- Bash 工具不用自己处理跨平台 kill、输出截断、后台进程恢复。
- Host shutdown 可以统一 kill background shells。
- UI 的 BashOutput/ListShells/KillShells 可以查同一 manager。

### 6.7 好处

- 协议稳定,宿主可替换。
- 多 session 语义集中。
- 审批/AskUser/cancel 不散落在 UI 里。
- RunManager 能支持自动化和长任务,而不改 TurnLoop。

### 6.8 Beta 前注意点

- TCP transport 当前注释明确 v1 没有认证,默认只应绑定 localhost 或 SSH tunnel。
- Desktop worker stdout 是 NDJSON 协议流,main 侧会解析并镜像给 renderer/mobile。若 worker 输出非 JSON 杂音,会被当作 malformed line 跳过或只进日志。
- ChatSession 的取消正确性仍依赖 Engine/TurnLoop/LLM provider/tool registry 全链路尊重 AbortSignal。

## 7. 按篇章的逐文件阅读索引

这里不是替代源码,而是给后续 review 的阅读路线。

### Engine

- `engine/engine.ts`: 先读 constructor/config,再读 `run()`,最后读 `refreshRuntimeConfig()`、`buildPermissionConfig()`、`buildToolContext()`、sub-agent spawn 相关方法。
- `engine/turn-loop.ts`: 读 `run()` 主循环,再读 `extend()`、`maybeAnnounceApproachingLimit()`、model call helper。
- `engine/model-facade.ts`: 读 `call()`、`callWithoutStreaming()`、fallback 逻辑。
- `engine/runtime.ts`: 读共享资源和 sandbox cache。
- `engine/goal.ts`: 读预算和续跑纯函数。
- `engine/dynamic-tool-defs.ts`: 读动态工具描述如何影响模型可见 schema。

### Tool System

- `tool-system/registry.ts`: 注册和 timeout。
- `tool-system/executor.ts`: 执行顺序和 hook/permission gate。
- `tool-system/context.ts`: ToolContext 字段,确认新增工具需要什么上下文。
- `tool-system/permission.ts`: mode、rules、approval backend。
- `tool-system/path-policy.ts`: 文件路径规则。
- `tool-system/mcp-manager.ts`: MCP lifecycle。
- `tool-system/sandbox/*`: Bash 沙箱。
- `tool-system/builtin/index.ts`: builtin 工具列表和 guard。
- `tool-system/builtin/*.ts`: 按工具功能读,新增/修改文件工具时重点检查 path policy 和 permissionDefault。

### Context

- `context/manager.ts`: tier 编排。
- `context/compaction.ts`: 具体压缩算法和 tool pair 保护。
- `context/tool-result-storage.ts`: 大输出落盘和 frozen replacement。
- `context/token-counter.ts`: 估算逻辑。

### Session / Memory

- `session/session-manager.ts`: session id 安全、create/resume/list/fork。
- `session/transcript.ts`: event log 和 `toMessages()`。
- `session/file-history.ts`: undo snapshot。
- `session/memory.ts`: user/dream memory 文件系统。
- `services/memory-orchestrator.ts`: memory pipeline。
- `services/extract-memories.ts`、`session-memory.ts`、`auto-dream.ts`、`dream-consolidation.ts`: 长期记忆后处理。

### Protocol / Host

- `protocol/types.ts`: 协议契约。
- `protocol/client.ts`: AgentClient 如何发请求和收 stream。
- `protocol/server.ts`: 请求分派、approval、query/configure。
- `protocol/chat-session.ts`: FIFO/cancel/model switch。
- `protocol/chat-session-manager.ts`: 多 session lifecycle。
- `protocol/transport.ts`、`tcp-transport.ts`: 传输。
- `cli/agent-server-stdio.ts`、`agent-server-tcp.ts`: worker/server 入口。
- `run/RunManager.ts`、`run/EngineRunner.ts`、`run/RunApprovalBackend.ts`: managed run。
- `automation/*`、`cron/*`: 定时任务。
- `runtime/*`: shell 和后台进程。

## 8. 总结

core 当前的主线设计是合理的:

- Engine 做装配,不直接吞掉状态机细节。
- TurnLoop 做状态机,对 abort、context、tool pairing、goal 有明确边界。
- Tool System 把工具执行前后的安全、权限、hook、sandbox 集中起来。
- Context 先保真再压缩,并保护供应商 API 的 tool 消息不变量。
- Session 把事件日志和 LLM messages 分开,Memory 把短期会话和长期记忆分开。
- Protocol/Host 把多宿主、多 session、审批和取消统一起来。

beta 前最值得回归的路径是:

1. Stop/cancel: 普通模型流、工具执行中、sub-agent、background shell。
2. 文件工具: path policy、permission mode、bypass、plan mode。
3. context pressure: 大 Read/Bash 输出、重复 Read、resume 后继续压缩。
4. multi-session: 两个 session 并发 askUser/approval/model switch。
5. automation: headless Engine、permission backend、session_started 前后的错误归属。
6. worker shutdown: background shells/MCP 进程是否被清理。
