# CodeShell Core 完整阅读合并版

> 由 `core-deep-dive.md` 与 `core-module-reference.md` 合并生成，方便一次打开审阅。

---

# 来源文件：`docs/core-deep-dive.md`

# `packages/core` 深度代码阅读文档

> 状态：初稿骨架，后续逐节填充。
> 范围：`packages/core/src/**`，从公开入口、运行链路、协议链路、LLM 链路、工具链路、上下文/会话/设置/插件/日志等模块逐层拆解。

## 1. 总览

`packages/core` 是 CodeShell 的领域无关核心包，目标是把“Agent 执行引擎”从 CLI/TUI/UI 产品层剥离出来。它主要负责：

- 接收任务输入，维护 session/transcript，并驱动多轮 LLM + tool loop。
- 管理模型 provider、模型列表、capability、streaming、usage/cost。
- 管理工具注册、工具执行、权限审批、hook、MCP 工具和 guard。
- 提供 JSON-RPC protocol，让 UI/CLI/worker 可以通过 `AgentClient` / `AgentServer` 调用引擎。
- 提供 managed run 层，即 `RunManager`，用于后台任务、自动化、队列、checkpoint、approval/input resume。
- 管理 settings、prompt sections、skills、plugins、memory、logging、session 文件。

核心调用链可以理解为三层：

```text
外部调用层
  ├─ 直接 SDK：new Engine(...).run(task)
  ├─ Protocol：AgentClient.run(...) → AgentServer.handleRun(...)
  └─ Managed Run：RunManager.submit(...) → EngineRunner.execute(...)

Engine 编排层
  ├─ Engine.run()
  ├─ session create/resume + transcript append
  ├─ settings / prompt / MCP / tools / permissions / hooks 初始化
  └─ TurnLoop.run(messages)

Turn Loop 执行层
  ├─ context manage / compaction
  ├─ ModelFacade.call(...)
  ├─ LLM provider streaming/non-streaming
  ├─ tool calls → ToolExecutor → ToolRegistry/MCP/builtin
  └─ tool results 回填为下一轮 user message
```

最重要的文件是：

- `src/index.ts`：public API barrel。
- `src/engine/engine.ts`：主入口和 run 编排。
- `src/engine/turn-loop.ts`：多轮 LLM/tool 状态机。
- `src/protocol/server.ts` / `client.ts`：JSON-RPC server/client。
- `src/run/RunManager.ts` / `EngineRunner.ts`：后台 run 管理。
- `src/tool-system/executor.ts` / `permission.ts` / `registry.ts`：工具执行与权限。
- `src/llm/providers/openai.ts` / `anthropic.ts` / `model-pool.ts`：模型层。
- `src/context/manager.ts` / `compaction.ts`：上下文压缩。
- `src/session/session-manager.ts` / `transcript.ts`：会话持久化。

## 2. 公开入口与包导出

### 2.1 包入口

`packages/core/package.json` 定义了 core 包的发布入口：

- 包名：`@cjhyy/code-shell-core`
- 主入口：`./dist/index.js`
- 类型入口：`./dist/index.d.ts`
- 子路径：`./bin/agent-server-stdio`

`src/index.ts` 是 public API 聚合出口，导出面很宽，包括 Engine、protocol、tool system、run、LLM、settings、hooks、plugin、session、prompt、preset 等。

一个明显小问题：`package.json` 版本是 `0.5.0-rc.1`，但 `src/index.ts` 中 `VERSION` 常量仍是 `0.5.0-rc.0`。如果外部 SDK 用户依赖 `VERSION` 做诊断或兼容判断，会拿到旧版本。

### 2.2 三种主要调用方式

#### 方式 A：直接使用 Engine

适合嵌入式 SDK、高级调用、测试：

```ts
import { Engine } from "@cjhyy/code-shell-core";

const engine = new Engine({
  cwd: process.cwd(),
  llm: {
    provider: "openai",
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-5.5",
  },
  headless: true,
});

const result = await engine.run("Summarize this repo", {
  onStream(event) {
    // text_delta / tool_use_start / tool_result / turn_complete ...
  },
});
```

直接 `Engine.run()` 的优点是路径短；缺点是调用方要自己处理 session、approval、并发、恢复等问题。

#### 方式 B：通过 Protocol Client/Server

这是 README 推荐的稳定方式：

```ts
import {
  createServer,
  createClient,
  createInProcessTransport,
} from "@cjhyy/code-shell-core";

const [serverT, clientT] = createInProcessTransport();

const handle = createServer({
  transport: serverT,
  cwd: process.cwd(),
  llm,
  permissionMode: "default",
});

const client = createClient({ transport: clientT });
client.onStreamEvent(({ sessionId, event }) => {});

const result = await client.run({
  sessionId: "main",
  task: "Summarize README.md",
});

await handle.close();
```

Protocol 层好处是把 UI/worker/engine 解耦：调用者只和 JSON-RPC 方法交互。

#### 方式 C：通过 RunManager

适合后台任务、自动化、需要 checkpoint/approval/resume 的场景：

```ts
import { createRunManager } from "@cjhyy/code-shell-core";

const manager = createRunManager({
  cwd: process.cwd(),
  engine: { llm, headless: true },
});

const run = await manager.submit({
  objective: "Run the test suite and summarize failures",
  cwd: process.cwd(),
});
```

`RunManager` 不直接让外部持有 Engine，而是把 run 写入 store、入队，然后由 `EngineRunner` 创建 Engine 并执行。

## 3. 主运行链路：从调用 `Engine.run()` 到模型与工具循环

主运行链路从 `src/engine/engine.ts` 的 `Engine.run(task, options)` 开始，最后进入 `src/engine/turn-loop.ts` 的 `TurnLoop.run(messages)`。

### 3.1 `Engine.run()` 前半段：输入解析与 session 初始化

`Engine.run()` 接收：

- `task`：用户任务文本。
- `options.cwd`：本次执行 cwd，可覆盖 Engine config cwd。
- `options.onStream`：事件回调。
- `options.signal`：AbortSignal。
- `options.sessionId`：恢复或指定 session。
- `options.goal`：goal mode 使用。

关键步骤：

1. **确定 cwd 并包装 stream callback**
   - Engine 会根据 `options.cwd` 或 config cwd 得到 effective cwd。
   - 它会包装 `options.onStream`，捕获 `task_update` 事件给 `TaskGuard` 用。
   - 风险：当前实现会直接 mutate 调用方传入的 `options.onStream`。如果调用方复用同一个 options 对象，多次 run 可能出现包装链或意外行为。

2. **解析图片输入**
   - `parse-task.ts` 从 `<codeshell-image>` block 中解析图片。
   - `image-policy.ts` 检查图片数量、大小、累计限制和模型 vision 支持。
   - `image-compression.ts` 尝试压缩 oversized image。
   - 如果失败，`Engine.run()` 可早退为 `reason: "image_error"`。

3. **噪声输入过滤**
   - early input/noise 逻辑会拒绝明显不是任务的输入。
   - 被拒绝时返回 `reason: "completed"`，但语义上其实是“没有开始任务”。对 RunManager 来说会被视为成功完成。

4. **创建 ToolContext**
   - 包括 cwd、sessionId、runtime、approvalBackend、askUser、sandbox、disabledSkills/Plugins、subAgentSpawner 等。
   - sub-agent 是通过创建 child `Engine` 实现的，并继承/覆盖部分 config。

5. **创建或恢复 session**
   - 如果 `sessionId` 存在且 on-disk session 存在：`SessionManager.resume()`。
   - resume 后从 `transcript.toMessages()` 恢复历史消息。
   - 会调用 `patchOrphanedToolUses()` 修补 dangling tool_use。
   - 然后 append 新 user message。
   - 如果没有已有 session：`SessionManager.create()` 新建 session、写 `state.json` 和 `transcript.jsonl`。

6. **进入 logging sid context**
   - 设置当前 sid，后续日志、session recorder、transcript 都关联该 session。

### 3.2 `Engine.run()` 中段：hooks、工具、上下文、prompt

session 准备好之后，Engine 继续装配运行环境：

1. **生命周期 hook**
   - `on_session_start`
   - `user_prompt_submit`
   - `user_prompt_submit` 可返回 `updatedPrompt` 改写用户 prompt，也可追加 context。

2. **发出 `session_started` stream event**
   - 这一步很关键，RunManager 会用这个事件尽早把 `run.sessionId` link 到真实 session。

3. **创建 LLM client**
   - `createLLMClient(this.config.llm, this.config.clientDefaults)`。
   - 该 promise 会提前启动，和后续 prompt/context 构建并行。

4. **构建权限系统**
   - `buildPermissionConfig()` 组合 permission mode、rules、bypass、approval backend。
   - `PermissionClassifier` 负责每个工具调用的 allow/ask/deny 分类。

5. **创建 ToolExecutor**
   - 注入 `ToolRegistry`、`PermissionClassifier`、hooks、guards、ToolContext。
   - TurnLoop 后面不会直接调用工具实现，而是调用 ToolExecutor。

6. **创建 ContextManager**
   - 负责 token 估算、tool_result 持久化、microcompact、summary compaction、window/emergency fallback。

7. **创建 PromptComposer**
   - 负责 system prompt、tool listing、preset behavior、skills listing、project instructions、memory context。

8. **连接 MCP servers**
   - 有 runtime 则复用 `runtime.mcpPool`。
   - 否则创建新的 `MCPManager(this.toolRegistry)`。
   - `connectAll()` 会把 MCP tools 注册进同一个 ToolRegistry。

9. **生成 tool definitions 和 system prompt**
   - 从 ToolRegistry 取 tool definitions。
   - plan mode 时会过滤到 allowlist。
   - 并行等待：LLM client、system prompt、system context。

10. **注入 user context / hook reminder**
    - 项目指令、memory、hook additionalContext 会作为 user role 的 `<system-reminder>` 插入 messages。

11. **创建 ModelFacade**
    - Facade 包装 provider client，统一处理 stream chunk、usage、transcript、logging。

12. **注册文件快照 hook**
    - 对 `Write` / `Edit` 在执行前保存 file-history snapshot。
    - 风险：目前只覆盖 `Write` 和 `Edit`，不覆盖 `ApplyPatch`、shell 改文件等。

### 3.3 进入 `TurnLoop.run()`

Engine 最后构造 `TurnLoop`，传入：

- model facade
- messages
- tool definitions
- ToolExecutor
- ContextManager
- hooks
- transcript
- token/cost/session 状态
- maxTurns / maxToolCallsPerTurn 等配置

然后调用：

```ts
const result = await turnLoop.run(messages);
```

TurnLoop 返回后，Engine 负责收尾：

- 缓存 session messages。
- 写 session recorder/log。
- 执行 `on_session_end`。
- fire-and-forget memory extraction / dream consolidation。
- fire-and-forget session title 生成。
- 保存 session state 为 terminal 状态。
- 执行 `on_agent_end`。
- emit `turn_complete`。
- 返回 `EngineResult`。

风险点：`TurnLoop.run()` 内部注释强调不应 reject，以免 session stuck active；但 Engine 在 TurnLoop 之后还有 `on_session_end`、保存 state、`on_agent_end` 等逻辑。如果这些后置 hook 抛错，`Engine.run()` 仍可能 reject，并可能阻断最终 state save。

## 4. Engine 模块

Engine 模块在 `src/engine/**`，是 core 的最高层编排。

### 4.1 `engine.ts`

`engine.ts` 定义：

- `EngineConfig`
- `EngineResult`
- `Engine`

`EngineConfig` 覆盖范围很广：

- LLM config：provider、model、apiKey、baseUrl、temperature、maxTokens 等。
- cwd / maxTurns / headless / permissionMode。
- builtin tools enable/disable。
- custom tools。
- approvalBackend / askUser。
- hooks。
- mcpServers。
- sandbox。
- runtime。
- settingsScope。
- preset。

`Engine` 构造函数主要做长期资源初始化：

- 创建或复用 `EngineRuntime`。
- 创建 `ToolRegistry`。
- 注册 custom tools。
- 创建 `HookRegistry`。
- 加载 plugin hooks。
- 注册 settings hooks。
- 注册 config hooks。
- 创建 `SessionManager`。
- 创建 `ModelPool` / provider catalog 相关状态。

`Engine.run()` 是短生命周期的一次 turn/run 编排，上一节已经展开。

### 4.2 `runtime.ts`

`EngineRuntime` 是共享资源容器，包含：

- `modelPool`
- `toolRegistry`
- `settings`
- `mcpPool`
- `costTracker`
- sandbox backend cache

它的用途是让多个 Engine 或多 session 共享重资源，例如 MCP 连接、模型池、工具注册表。风险是这些资源并非真正只读：ToolRegistry、ModelPool、MCPManager、CostTracker 都有可变状态。多 workspace、多 session 共享 runtime 时要特别注意串扰。

### 4.3 `model-facade.ts`

`ModelFacade` 是 TurnLoop 和 provider client 之间的适配层。

职责：

- 调用 `client.createMessage({ stream: true })`。
- 把 provider stream chunk 转成统一 `StreamEvent`：
  - `text_delta`
  - `tool_use_start`
  - `tool_use_args_delta`
  - reasoning 相关 delta
- 收集 final text、tool calls、usage、stop reason。
- 写 LLM request/response log。
- 更新 transcript。
- 更新全局 token/cost 状态。

TurnLoop 不直接依赖 OpenAI/Anthropic SDK，而是依赖 ModelFacade 的统一结果。

### 4.4 `parse-task.ts`、`image-policy.ts`、`image-compression.ts`

这三者组成图片输入链路：

1. `parse-task.ts` 从任务文本解析 `<codeshell-image>` block。
2. `image-policy.ts` 判断模型是否支持 vision、图片大小/数量是否符合策略。
3. `image-compression.ts` 在超限时尝试压缩。

当前记忆里曾有“core 没有压缩管线”的旧状态，但本轮代码显示 core 已有 `image-compression.ts`；更准确的现状是：core 侧已有压缩尝试，但 TUI 剪贴板/完整图片输入体验可能仍不是同一层问题。

### 4.5 `patch-orphaned-tools.ts`

用于修复 transcript 中不完整 tool pair：

- assistant 有 `tool_use`，但后续缺少对应 `tool_result`。
- resume 时这种历史会导致 provider 报错，尤其 OpenAI tool-call pairing 很严格。
- patch 会插入 synthetic error result 或修复消息结构。

### 4.6 `session-title.ts`

在 run 完成后 fire-and-forget 生成 session 标题。它不阻塞主结果返回；失败通常只记录 debug/log。

### 4.7 `streaming-tool-queue.ts`

TurnLoop 用它执行一轮中的多个 tool calls。它封装 tool execution queue，支持 concurrency-safe 工具提前执行/排队/drain。

### 4.8 `token-budget.ts`、`reactive-threshold.ts`

- `token-budget.ts` 判断输出是否接近当前 turn budget，需要继续、提醒或停止。
- `reactive-threshold.ts` 监控 streaming 中 token 跨过阈值的情况，目前主要用于 warning/标记，不在 streaming 中立即 compact。

### 4.9 `tool-summary.ts`

工具调用后可 fire-and-forget 生成 summary。风险和其他后台任务一样：进程退出会丢，错误处理偏弱。

## 5. Turn Loop 模块

`src/engine/turn-loop.ts` 是 Agent 多轮循环的核心状态机。

### 5.1 每轮循环结构

TurnLoop 大致是：

```text
while turnCount < maxTurns:
  emit stream_request_start
  run on_turn_start hook
  contextManager.manageAsync(messages)
  response = callModelWithFallback(messages)
  record usage/context actual tokens

  if response stopped by max output tokens:
    handle continuation or retry

  if no tool calls:
    append assistant message
    run on_turn_end
    run on_stop
    if on_stop says continue:
      append continuation prompt and continue
    return completed

  if has tool calls:
    append assistant tool_use message
    execute tools via StreamingToolQueue/ToolExecutor
    append tool results
    run tool summary async
    append user tool_result message
    run guards/hooks/token budget checks
    continue next turn

return max_turns, optionally final summary
```

### 5.2 context management

每轮模型调用前会调用：

```ts
contextManager.manageAsync(messages)
```

它可能做：

- 大 tool_result 落盘并替换为 preview。
- 单个 tool_result 截断。
- 同一 message 下 tool_result 总预算压缩。
- microcompact 旧 tool results。
- summary compaction。
- snip/window/emergency fallback。

这样 TurnLoop 可以持续运行而不轻易超过 context window。

### 5.3 模型调用与 fallback

TurnLoop 通过 `callModelWithFallback()` 调模型。

- 首选 streaming。
- streaming 出错时发 `tombstone`，表示之前 stream 出去的块作废。
- context limit / abort 不 fallback。
- 其他 streaming 错误可 fallback 到 non-streaming。

这让 UI 能先显示增量，但遇到 provider streaming bug 时仍有机会返回完整结果。

### 5.4 max output tokens 处理

如果模型因为 max output tokens 截断：

- 如果截断发生在 tool call JSON 参数中，TurnLoop 会注入提醒，让模型下一轮重试完整 tool call。
- 如果只是普通文本截断，会最多做 3 次 continuation。

风险：tool-call 参数截断是很常见的 provider 问题，这里虽然有恢复，但如果模型连续输出坏 JSON，仍可能循环消耗 turns。

### 5.5 tool call 处理

当 response 包含 tool calls：

1. 限制数量到 `maxToolCallsPerTurn`。
2. 把 assistant text + tool_use blocks 加入 messages。
3. 用 `StreamingToolQueue` 执行 tool calls。
4. 每个 tool result 写 transcript 并发 stream event。
5. 把 tool results 合成 user message，加入 messages。
6. 下一轮让模型看到 tool result。

风险：超过 `maxToolCallsPerTurn` 的 tool calls 会被 slice 掉。因为被 slice 掉的 tool_use 没进入 assistant message，所以 provider API invariant 不会坏；但模型的部分意图被静默忽略，用户/模型都未明确收到“有工具调用被丢弃”的提醒。

### 5.6 stop hook / goal mode

无 tool calls 时，TurnLoop 不一定马上结束。它会运行 `on_stop` hook：

- 普通 hook 可追加 context 或要求继续。
- `goal-stop-hook.ts` 可根据 goal mode 判断是否继续。

如果 hook 要求 continue，TurnLoop 会插入 user reminder，然后下一轮继续。

### 5.7 maxTurns 分支

达到 maxTurns 后，TurnLoop 会尝试做 final summary，然后返回 `reason: "max_turns"`。

风险：maxTurns 分支内部会 emit `turn_complete`，而 Engine.run 收尾也统一 emit `turn_complete`，客户端在 maxTurns 场景可能收到两次完成事件。

## 6. Run 模块：Runner、Manager、Queue、Store、Approval

`src/run/**` 是 managed run 层。它不是一次简单 Engine.run，而是把一次任务包装成可持久化、可排队、可恢复、可审批的 run。

### 6.1 核心对象

- `RunSnapshot`：run 当前状态快照，包含 id、objective、cwd、status、attempt、sessionId、timestamps、result/error 等。
- `RunEvent`：run 生命周期事件，如 created、queued、running、checkpoint、approval_needed、completed、failed。
- `RunCheckpoint`：中间检查点。
- `RunApproval`：approval/input 等待记录。
- `RunStore`：持久化接口。
- `FileRunStore`：本地文件实现。
- `RunQueue`：并发队列。
- `RunLock`：文件锁。
- `Heartbeat`：运行期间心跳。
- `CheckpointWriter`：从 stream events 累计 checkpoint。
- `ArtifactTracker`：从 stream events 记录产物。
- `Evaluator`：run 完成后的评估器。

### 6.2 `createRunManager()`

`src/run/factory.ts` 提供便捷工厂：

- 默认 runs dir：`~/.code-shell/runs`
- 默认 concurrency：`1`
- 默认 maxTurns：`30`
- 创建 `FileRunStore`
- 创建 `RunManager`
- 注入默认 `EngineRunner`

### 6.3 `RunManager.submit()` 链路

调用 `submit({ objective, cwd, ... })` 后：

1. 创建 `RunSnapshot(status="queued")`。
2. 写入 store。
3. emit `run_created`。
4. emit `run_queued`。
5. `queue.enqueue(runId)`。

之后队列会调用 `executeRun(runId)`。

### 6.4 `RunManager.executeRun()` 链路

执行流程：

1. 从 store 读取 run。
2. 获取 `RunLock`，避免多 worker 同时跑同一 run。
3. 启动 heartbeat。
4. 状态转 `running`，attempt++。
5. 创建 AbortController。
6. 创建 CheckpointWriter / ArtifactTracker。
7. 构建 `RunExecutionContext`。
8. 调 `runner.execute(run, context)`。
9. 监听 stream event：
   - 写 checkpoint。
   - 记录 artifact。
   - 收到主 session `session_started` 时，立即把 `run.sessionId` link 到真实 session。
   - notify subscribers。
10. runner 返回后做 final checkpoint。
11. 如果有 evaluator，跑 evaluator。
12. 如果 `result.reason === "completed"` 且 evaluator 通过：状态转 completed。
13. 否则转 failed。
14. 异常一般转 blocked。
15. finally 清理 controller、handle、heartbeat、lock。

风险：当前 RunManager 把所有非 `completed` Engine reason 都视为 failed。`max_turns`、`aborted_streaming`、`image_error`、`prompt_too_long` 会被归为 failed；这可能合理，但语义较粗。

### 6.5 `EngineRunner.execute()` 链路

`EngineRunner` 是默认 RunExecutor。

它的设计很有意思：不是直接 `engine.run()`，而是：

1. 根据 run/context 构造 `EngineConfig`。
2. 创建 `RunApprovalBackend`。
3. 创建 `Engine`。
4. 注册 custom tools。
5. 创建 in-process `AgentServer` / `AgentClient`。
6. 通过 `client.run(...)` 调用。

也就是说 managed run 仍然走 protocol surface。这保证 Run path 和 UI/protocol path 共享同一套行为。

风险：`engineConfigOverrides` 在对象展开末尾，注释说调用方不要传 `appendSystemPrompt`，否则会覆盖 automation note，但代码没有防御。自动化的安全提示可能被 override 静默移除。

### 6.6 Approval / Input resume

RunManager 支持等待审批或用户输入：

- `RunApprovalBackend` 把 Engine 的 approval/askUser 请求转成 run waiting 状态。
- `RunManager.handleApprovalNeeded()` 写 approval record，状态转 `waiting_approval`。
- `RunManager.handleInputNeeded()` 状态转 `waiting_input`。
- 外部调用 `resume()` 后把用户决定/输入送回 suspended backend。

这个链路的关键假设是 approval backend 会让 Engine 挂起等待。如果 backend 过早返回或异常，RunManager 可能在 runner 返回后把 run finalize 到其他状态。

### 6.7 `FileRunStore`

文件布局大致是：

```text
~/.code-shell/runs/<runId>/
  run.json
  events.jsonl
  checkpoints/*.json
  approvals/*.json
  artifacts/refs.jsonl
```

它用 tmp + rename 写 JSON，用进程内 promise lock 串行 append JSONL。

风险：

- runId / approvalId / checkpointId 作为路径片段使用，store public API 层没有统一 path safety 校验；如果外部传恶意 id，有路径穿越风险。
- JSON tmp 文件名固定为 `<file>.tmp`，跨进程并发写可能冲突。
- append lock 只是进程内，多进程 append 同一文件没有锁。

## 7. Protocol 模块：Server、Client、Transport、Session

`src/protocol/**` 把 Engine 包装成 JSON-RPC 服务。

### 7.1 协议 envelope

`types.ts` 定义 JSON-RPC 风格结构：

- `RpcRequest { jsonrpc, id, method, params }`
- `RpcResponse { jsonrpc, id, result?, error? }`
- `RpcNotification { jsonrpc, method, params? }`

核心方法：

- `agent/run`
- `agent/approve`
- `agent/cancel`
- `agent/configure`
- `agent/query`
- `agent/inject`
- `agent/closeSession`

server → client notification：

- `agent/streamEvent`
- `agent/approvalRequest`
- `agent/status`

### 7.2 Transport

`transport.ts` 定义统一接口：

```ts
interface Transport {
  send(message): void | Promise<void>;
  onMessage(handler): void;
  close(): void | Promise<void>;
}
```

实现包括：

- `createInProcessTransport()`：EventEmitter 直连，用于同进程 client/server。
- `StdioTransport`：stdin/stdout NDJSON，一行一个 JSON。
- `SocketTransport` / `listenTcp()`：TCP NDJSON。

风险：Stdio/TCP 遇到 malformed JSON 时是静默跳过，而不是返回 JSON-RPC ParseError。这样 client 的 request 可能一直 pending。

TCP 默认绑定 localhost；注释明确 v1 无认证，不应公网暴露。如果调用方手动传 `0.0.0.0`，协议自身没有鉴权。

### 7.3 AgentClient

`client.ts` 负责：

- 创建 request id。
- 维护 pending request map。
- 发送 RPC request。
- 收 response 后 resolve/reject promise。
- 收 notification 后转成本地事件。

公开方法：

- `run()`：支持新签名 `run({ sessionId, task })` 和旧签名。
- `approve()`：审批工具请求。
- `cancel()`：取消 session/run。
- `configure()`：调整 model/permission/plan mode 等。
- `query()`：查询 tools/sessions/config/models/providers 等。
- `inject()`：向 session 注入 context。
- `close()`：关闭 transport 并 reject pending requests。

风险：request 没有内置 timeout。如果 server 丢 response，promise 会挂到 client.close。

### 7.4 AgentServer

`server.ts` 支持两种模式：

1. **multi-session 模式**：传入 `ChatSessionManager`。
2. **legacy single-engine 模式**：传入单个 `Engine`。

request dispatch：

- `agent/run` → `handleRun()`
- `agent/approve` → `handleApprove()`
- `agent/cancel` → `handleCancel()`
- `agent/configure` → `handleConfigure()`
- `agent/query` → `handleQuery()`
- `agent/inject` → `handleInject()`
- `agent/closeSession` → `handleCloseSession()`

multi-session run：

1. 要求有 `sessionId` 和 `task`。
2. `chatManager.getOrCreate(sessionId, slice)`。
3. 可设置 planMode。
4. `session.enqueueTurn(task, { cwd, goal, onStream })`。
5. 每个 stream event 包装为 `{ sessionId, event }` notification。
6. run 完成后返回 `RunResult`。

legacy run：

- server 内部持有 `running` 防止并发。
- 创建 AbortController。
- 调 `legacyEngine.run(...)`。

风险：server 有地方用 `(this.chatManager as any).sessions` 访问 private map，封装脆弱。

### 7.5 ChatSession / ChatSessionManager

`ChatSessionManager` 管 live sessions：

- 默认最大 session 数 16。
- 默认 idle TTL 30 分钟。
- `getOrCreate(sessionId, slice)` 创建 per-session Engine。
- 超过 maxSessions 抛 overloaded。

`ChatSession` 是单个 UI chat tab 的串行 turn queue：

- `enqueueTurn()` 入队。
- `pump()` 串行执行。
- 每个 turn 创建 AbortController。
- 调 `engine.run(task, { sessionId: this.id, ... })`。
- run boundary 后应用 pending model switch。
- `cancel()` abort 当前 turn，并 reject 队列里未执行的 turns。

风险：multi-session approval 链路需要重点确认。Server 的 approve 逻辑会从 `ChatSession.pendingApprovals` 找 resolver，但本轮阅读没有看到 `handleRunMulti()` 明确注册 approval resolver 的逻辑；如果没有其他路径注入，multi-session approve 可能返回 `No pending approval`。

### 7.6 factories/helpers

- `helpers.ts`：创建 in-process client/server 的快捷函数。
- `factories.ts`：面向 embedders 的 factory，组合 Engine/AgentServer/Transport。
- CLI worker 可通过 stdio/tcp 创建 AgentServer。

## 8. LLM 模块：Provider、ModelPool、Capability、Streaming

`src/llm/**` 负责把不同 provider/model 统一成 core 可调用的 `LLMClientBase.createMessage()`。

### 8.1 创建 LLM client

Engine 通过：

```ts
createLLMClient(config, clientDefaults)
```

创建 provider client。

`client-factory.ts` 内置 provider registry：

- `anthropic` → `providers/anthropic.ts`
- `openai` → `providers/openai.ts`

其它 provider kind 通常会在 `ModelPool.toLLMConfig()` 中折叠到 OpenAI-compatible client，例如 DeepSeek、Z.AI、xAI、Groq、OpenRouter、Ollama 等。

### 8.2 `ModelPool`

`model-pool.ts` 是运行时模型注册表：

- 保存 model entries。
- 记录 active model。
- 支持 runtime register。
- 解析 provider catalog 中的 apiKey/baseUrl。
- 把 `ModelEntry` 转成 `LLMConfig`。
- 解析 context window / max output tokens。

风险：`ModelPool.toLLMConfig()` 如果 entry 没有 `maxOutputTokens`，会默认写 `8192`。但 `LLMClientBase` 注释里强调不应在 base fallback 到 8192，以免未知模型被硬截断。这里的默认值可能让 provider 无法自己决定 token cap。

### 8.3 provider kinds / catalog

`provider-kinds.ts` 定义 provider 元信息：

- kind 名称。
- 协议类型：`openai-compat`、`anthropic-style`、`gemini`、`ollama`。
- 默认 baseUrl。
- modelsPath。
- auth header。
- model filter。

`provider-catalog.ts` 管 provider credentials/config。

### 8.4 Capability 层

`llm/capabilities/**` 用规则描述“某 provider + model 能接受哪些参数”。

Capability 包括：

- 是否支持 vision。
- token limit 字段：`max_tokens` 或 `max_completion_tokens`。
- rejected params：例如某些模型不接受 temperature。
- reasoning shape：不同厂商 reasoning/thinking 参数格式不同。
- echo reasoning policy。
- parallel tool calls shape。
- stream usage shape。
- max output cap。

OpenAI-compatible provider 在构造 request body 时使用 capability 过滤/映射参数。

风险：capability schema 定义了 `streamUsage`，但 OpenAI streaming request 当前固定发送 `stream_options: { include_usage: true }`。对明确不支持 include_usage 的兼容端点可能 400。

### 8.5 OpenAI-compatible provider

`providers/openai.ts` 负责 OpenAI Chat Completions 兼容接口。

核心职责：

- 初始化 OpenAI SDK client。
- 根据 capability 构建 request body。
- 支持 streaming / non-streaming。
- 解析 text delta。
- 解析 tool calls。
- 解析 reasoning。
- 收集 usage。
- 处理 provider errors，映射 context limit / abort / retryable。
- 可接入 stream watchdog。

request body 重点：

- messages。
- model。
- tools。
- max token 字段。
- temperature/top_p 等 sampling 参数。
- reasoning_effort / thinking / reasoning 等 provider-specific 参数。
- streaming 下 `stream_options.include_usage`。

### 8.6 Anthropic provider

`providers/anthropic.ts` 使用 Anthropic native SDK。

核心职责：

- `messages.create()` non-streaming。
- `messages.stream()` streaming。
- system prompt 使用 Anthropic 的 system array。
- tools 使用 Anthropic tools。
- usage 包含 cache read/write tokens。

### 8.7 `client-base.ts`

`LLMClientBase` 提供：

- provider/model/config 保存。
- usage 统计。
- 全局 `onUsage` hook。
- `withRetry()` 重试策略。

重试策略：

- context limit 不重试。
- abort 不重试。
- 429 按 retry-after/backoff。
- 其它可重试错误指数退避。
- 4xx 非 429 不重试。

### 8.8 streaming watchdog / retry / stop reason

- `stream-watchdog.ts`：stream idle timeout watchdog，默认配置可通过 env 启用。
- `retry.ts`：判断错误是否 retryable。
- `stop-reason.ts`：stop reason 标准化。
- `clamp-max-tokens.ts`：根据模型 cap clamp max tokens。
- `strip-vision.ts`：非 vision 模型历史 image block 处理。

### 8.9 usage/cost 链路

Provider 拿到 usage 后：

1. 调 `recordUsage()`。
2. `LLMClientBase.onUsage` 被 `cost-tracker.ts` 安装后，会把 usage 送到 `CostTracker.record()`。
3. `ModelFacade` 同时会更新 `state.ts` 中的全局 token counters：
   - total input/output
   - per-model usage
   - cache read/write
   - API duration

风险：

- `CostTracker.reset()` 不重置 `_hasUnknownModel`，遇到 unknown model 后 reset 仍可能显示 unknown warning。
- `state.resetCostState()` 不清 `_modelUsage`，可能导致 total 已归零但 per-model usage 仍有旧数据。
- `state.setCostStateForRestore()` 只恢复 total input/output，不恢复 per-model/cache/requestCount。

## 9. Tool System 模块：Registry、Executor、Permission、MCP、Guards

`src/tool-system/**` 是工具系统。它把 LLM 发出的 tool call 转成真实执行，并在执行前后插入 schema 校验、hook、guard、权限审批、sandbox、日志等。

### 9.1 ToolRegistry

`registry.ts` 管工具定义和 executor。

构造时：

- 根据 preset/config 选择 builtin tools。
- 调 `registerBuiltins()` 注册内置工具。
- 后续可注册 custom tools。
- MCPManager 也会把 MCP tools 注册进同一个 registry。

`executeTool()` 负责：

- 查找工具。
- 创建/级联 AbortController。
- 处理 timeout。
- 注入 ToolContext。
- 调用工具实际 executor。

### 9.2 内置工具

`tool-system/builtin/index.ts` 定义 `BUILTIN_TOOLS`。

每个工具包含：

- `definition`：给模型看的 schema/description。
- `execute`：实际实现。
- `source: "builtin"`。
- `permissionDefault`。
- `isReadOnly`。
- `isConcurrencySafe`。
- 可选 timeout。

常见工具：Read/Grep/Glob/Write/Edit/Bash/TodoWrite/AskUserQuestion/MCPTool/Skill 等。

### 9.3 ToolExecutor

`executor.ts` 是单个 tool call 的完整执行链：

```text
LLM tool call
  → plan mode allowlist check
  → JSON schema 参数预校验
  → pre_tool_use hook
  → InvestigationGuard
  → PermissionClassifier
  → on_permission_check hook
  → approval backend if ask
  → on_tool_start hook
  → ToolRegistry.executeTool()
  → on_tool_end hook
  → post_tool_use hook
  → file_changed hook if Write/Edit success
  → return tool_result
```

这里有两个重要安全设计：

- `pre_tool_use` 的 `allow` 不能提升权限，只能降级/deny/ask。
- `on_permission_check` hook 也不能提升到 allow。

也就是说 hook 不能绕过核心权限系统。

### 9.4 PermissionClassifier

`permission.ts` 负责工具权限分类。

输入：toolName、args。

输出：allow / ask / deny。

判断顺序：

1. `bypassPermissions` 直接 allow。
2. 显式 permission rules。
3. Bash 进入 `classifyBashCommand()`。
4. 其它工具按 permission mode fallback。

`acceptEdits` allowlist 只包括：

- `Write`
- `Edit`
- `ApplyPatch`
- `NotebookEdit`
- `TodoWrite`

Bash 分类器做了较多 hardening：

- dangerous patterns。
- safe-read patterns。
- safe-write patterns。
- shell metacharacter scanner。

Project-scope approval 会写入：

```text
<cwd>/.code-shell/settings.local.json
```

Engine 会把刚保存的 project rule 加入当前 session 内存规则，避免“保存后本轮仍不生效”。

风险：direct `Engine` 默认 `permissionMode = "acceptEdits"`，对 SDK 嵌入场景来说默认权限偏宽，需要调用方明确配置。

### 9.5 MCPManager

`mcp-manager.ts` 管 MCP server：

- `connectAll()` 过滤 disabled servers。
- `connect()` 支持 stdio / streamable-http / sse。
- 连接超时默认 15s。
- `discoverTools()` 调 `client.listTools()`。
- 每个 MCP tool 注册为：`mcp_${serverName}_${tool.name}`。
- permission 默认 ask。
- 只有 `annotations.readOnlyHint === true` 才标记 read-only/concurrency-safe。

MCP 输出 trust boundary：

- 文本输出会用 untrusted wrapper 包起来，提醒模型不要当成指令。
- 图片输出会 spill 到 `~/.code-shell/mcp_images`，避免 base64 直接进上下文。

风险：

- MCP tool name 未明显 sanitize，如果 serverName/tool.name 含特殊字符，可能影响 provider tool-name 兼容性。
- registered MCP executor 会处理图片 spill，但 direct `MCPManager.callTool()` 路径只处理 text/string；如果 `MCPTool` 走 direct callTool，图片可能丢失。
- `MCPManager.getInstance()` 是 static 全局 instance，而 Engine 也可能用 runtime.mcpPool；多 workspace/runtime 下要避免拿错 manager。

### 9.6 Guards

#### InvestigationGuard

用于提醒/阻断长时间只读探索或重复读取：

- 追踪重复 read。
- 追踪连续 read-only 工具调用。
- 追踪 silent turns。
- headless 下 soft mode。

风险：read-only 工具集合偏窄，只包含 Read/Grep/Glob/WebFetch/WebSearch/ToolSearch，不包括 ReadMcpResource、MemoryRead、CronList 等语义上只读的工具。

`isMutatingTool()` 也偏窄，只列 Bash/Edit/Write/NotebookEdit/AskUserQuestion，不包括 ApplyPatch、Config、CronCreate/Delete、MemorySave/Delete、GenerateImage 等，会影响 guard 统计准确性。

#### TaskGuard

用于 stale TodoWrite 检查。如果有 in_progress todo 多轮未更新，会提示模型更新任务状态。

## 10. Context 模块：上下文管理、压缩、工具结果预算与存储

`src/context/**` 负责让长期对话不会无限膨胀到超过模型 context window。

### 10.1 ContextManager

`manager.ts` 是 orchestrator。默认配置大致是：

- `maxTokens: 200_000`
- `compactAtRatio: 0.85`
- `summarizeAtRatio: 0.92`
- `maxToolResultChars: 30_000`
- `microcompactFloorRatio: 0.7`
- `microcompactKeepRecent`

它有同步 `manage()` 和异步 `manageAsync()` 两条路径。TurnLoop 使用 `manageAsync()`。

### 10.2 Hybrid token estimation

ContextManager 会记录 provider 返回的真实 prompt tokens：

```ts
recordActualUsage(inputTokens, messageCount)
```

后续估算时，如果历史消息数匹配，就用：

```text
上次真实 input tokens + 新增消息估算 tokens
```

否则 fallback 到纯估算。

这比完全用本地 tokenizer 更稳，因为不同 provider/tokenizer 差异很大。

### 10.3 manageAsync 顺序

一次 context 管理大致按这个顺序：

1. `applyToolResultPersistence()`：大 tool_result 落盘。
2. `truncateToolResult()`：单条过长结果截断。
3. `applyToolResultBudget()`：同一 message 内 tool_result 总预算控制。
4. `microcompact()`：清理旧的 compactable tool results。
5. 如果达到 compact ratio：尝试 summary compaction。
6. summary 失败则 fallback 到 snip/window/emergency。

### 10.4 compaction 策略

`compaction.ts` 提供具体策略：

- `estimateTokens()`：估算 messages tokens，乘以安全系数。
- `adjustIndexToPreserveAPIInvariants()`：保护 tool_use/tool_result pairing。
- `snipCompact()`：保留头部和尾部，中间插入 snip marker。
- `windowCompact()`：保留第一条和最近 N 条。
- `microcompact()`：只清旧 tool_result，不动主对话结构。
- `applyToolResultBudget()`：单 message tool_result 总长度超限时截断最大块。
- `truncateToolResult()`：单个 tool_result 超限时保留 head/tail。
- `buildSummarizationPrompt()`：生成 summary prompt。
- `applySummaryCompaction()`：用 anchored summary 替换中间历史。

关键点：所有 compaction 都必须保护 provider API invariant，尤其不能保留 tool_result 但丢掉对应 assistant tool_use。

### 10.5 Tool result storage

`tool-result-storage.ts` 把大型 tool_result 写到磁盘，然后在上下文里替换为 preview：

```text
<transcriptDir>/tool-results/<toolUseId>.txt
```

它维护 `ContentReplacementState`：

- `seenIds`
- `replacements`

这样同一个 tool_result 的“是否落盘、替换成什么 preview”会被冻结，避免 prompt prefix 每轮变化。

resume 时可以从 persisted sentinel 里重建 replacement state。

风险：

- 写文件失败后会标记 seen 但不替换，避免每 turn 重试；如果只是瞬时 FS 错误，后面也不会再尝试 persist。
- 文件名使用 `tool_use_id`，假设它安全且稳定。若某 provider 返回含路径分隔符的 id，可能有路径风险，需要确认 id 来源。
- `applyToolResultBudget()` 理论上可能二次截断已替换的 sentinel/preview，不过实际 preview 通常很小，风险低。

## 11. Session 模块：会话、Transcript、Memory、File History

`src/session/**` 负责 on-disk session 状态和 transcript。

### 11.1 SessionManager

`session-manager.ts` 默认把 session 存在：

```text
~/.code-shell/sessions/<sessionId>/
  state.json
  transcript.jsonl
  file-history/
```

它提供：

- `create(cwd, model, provider, explicitSessionId?)`
- `exists(sessionId)`
- `resume(sessionId)`
- `saveState(session)`
- `fork(sessionId, forkPoint)`
- `list()`

sessionId 有安全校验：

- 拒绝 `/`、`\`。
- 拒绝 `..`。
- 拒绝非法字符。
- 长度上限 128。

创建 session 时会写 `state.json`，创建 `transcript.jsonl`，并 append `session_meta`。

风险：`create(explicitSessionId)` 自身不检查目录是否已存在。Engine 正常会先 `exists()` 分流，但如果外部直接调用 create 且传已有 id，可能覆盖 state 并追加新的 session_meta。

### 11.2 Transcript

`transcript.ts` 是 JSONL event log。

事件类型包括：

- `session_meta`
- `message`
- `tool_use`
- `tool_result`
- `turn_boundary`
- `summary`

`append()` 会：

1. 生成 event。
2. push 到内存 `events`。
3. append JSONL 到文件。

`toMessages()` 会把 event log 派生为 LLM messages：

- `message` 直接进入 messages。
- `tool_result` 合并到最后一个 user message，或新建 user tool_result message。
- `summary` 转成 user role system-reminder。

`repairToolResultPairs()` 用于修复 tool pairing：

- 缺 result 的 tool_use 会 append synthetic error result。
- orphan tool_result 会从内存 events 过滤。

风险：

- flush failure 被吞掉：内存有事件，磁盘可能缺事件，进程退出后不可恢复。
- orphan tool_result 只从内存过滤，不重写 JSONL；下次 load 仍会读到无效历史再过滤。

### 11.3 FileHistory

`file-history.ts` 保存文件修改前快照。

流程：

- Engine 注册 `on_tool_start` hook。
- 当 tool 是 `Write` 或 `Edit` 且 args 有 `file_path` 时调用 `saveSnapshot(filePath)`。
- snapshot 会 copy 原文件到 session 的 `file-history/`。
- `index.json` 记录原路径、backup path、hash、时间。
- `restore(snapshot)` 恢复前会先保存当前状态，然后 copy backup 到原路径。

风险：

- 只覆盖 `Write`/`Edit`，不覆盖 `ApplyPatch`、Bash、MultiEdit 等可能改文件的工具。
- restore 信任 `index.json` 中的 `backupPath` 和 `filePath`。如果 index 被篡改，可能把任意可读 backup copy 到任意目标。
- backup 文件名由 `Date.now()` + safeName 组成，极端同毫秒同 safeName 可能碰撞。

### 11.4 Session memory

`session/memory.ts` 和 `services/session-memory.ts` 处理 memory entries 的读写、排序、检索或 session 相关 memory 构建。Engine run 完成后会触发 memory extraction / dream consolidation 的 fire-and-forget pipeline。

## 12. Settings 模块：Schema、Manager、作用域合并

`src/settings/**` 管 CodeShell 设置的 schema、读取、合并、写入。

### 12.1 SettingsSchema

`schema.ts` 使用 Zod 定义设置结构。重要字段包括：

- `agent`
- `activeKey`
- `auxModelKey`
- `model`
- `providers`
- `models`
- `permissions`
- `mcpServers`
- `disabledSkills`
- `disabledPlugins`
- `disabledAgents`
- `capabilityOverrides`
- `hooks`

`CapabilityOverridesSchema` 是 project-only tri-state overlay：

- `inherit`
- `on`
- `off`

它用于项目级启用/禁用 skill/plugin/agent 等能力，而不是简单数组覆盖。

### 12.2 SettingsManager scope

`manager.ts` 支持三种 scope：

- `full`：managed + user + project + local。
- `project`：project + local。
- `isolated`：不读磁盘层。

优先级：

```text
CLI flags > local > project > user > managed
```

读取路径：

- managed：`~/.code-shell/settings.managed.json`
- user：`~/.code-shell/settings.json`
- project：`<cwd>/.code-shell/settings.json`
- local：`<cwd>/.code-shell/settings.local.json`

`merge()` 是深合并：

- object 深合并。
- array 替换。
- `null` 删除 key。

### 12.3 provenance 问题

合并后的 settings 会丢失“某个 key 来自哪个 scope”的 provenance。为了解决 capability overlay，`SettingsManager.getForScope("project")` 可以读取单 scope raw settings，并只投影 raw 里实际存在的 key。

Engine 的 `readDisabledLists()` 会：

1. 从 merged settings 取 baseline disabled lists。
2. 再单独读取 project scope 的 `capabilityOverrides`。
3. 用 `effectiveDisabledList()` 合成最终 disabledSkills/disabledPlugins。

这份 disabled list 会传给：

- PromptComposer skills listing。
- plugin hooks loading。
- ToolContext。
- Skill tool scanner。

### 12.4 风险

- `SettingsManager` 默认 scope 是 `project`。如果某入口没有显式传 `full`，user settings 可能不可见。需要确认 CLI/desktop/headless 各入口是否都设置正确。
- `saveUserSetting()` 无视 manager scope，即使 manager 是 project/isolated，也会写 `~/.code-shell/settings.json`。这可能是有意 API，但和 scope 隔离语义容易混淆。
- settings hooks schema 需要持续和 hook runner 能力保持一致，否则用户配置了事件但实际不触发会难排查。

## 13. Prompt 模块：Composer、Section、Instruction Scanner

`src/prompt/**` 负责构造 system prompt 和 user context。

### 13.1 PromptComposer

`composer.ts` 是主入口。

`buildSystemPrompt(tools)` 会组装 sections：

1. runtime header。
2. custom system override。
3. tool listing。
4. preset behavior。
5. skills listing。
6. append system prompt。

最后用空行拼接成 system prompt。

### 13.2 Tool listing

Prompt 中只列工具名和 description，不重复 JSON schema。完整 schema 通过 provider native `tools` 字段发送。

这样可以减少 system prompt 长度，也避免 schema 在 prompt 和 API tools 字段中双份漂移。

### 13.3 Skills listing

PromptComposer 会调用 `scanSkills(cwd, disabledSkills/disabledPlugins)`，然后生成技能列表。

注意：skills listing 只是告诉模型有什么技能；真正读取某个 skill 内容要调用 `Skill` 工具。

### 13.4 User context message

`buildUserContextMessage()` 会生成 user role 的 `<system-reminder>`，包含：

- 今日日期。
- 项目指令文件，如 CODESHELL.md/AGENTS.md/CLAUDE.md 等扫描结果。
- memory context。

这条 message 会插入到当前 turn 的 user message 之前或附近，让模型拿到项目约束。

### 13.5 Instruction scanner

`instruction-scanner.ts` 扫描项目内指令文件。它是 CodeShell 支持项目级指导文本的关键入口。

### 13.6 Section loader/cache

- `section-loader.ts` 加载 prompt section markdown。
- `section-cache.ts` 缓存 resolved sections。

风险：PromptComposer 对 instructions/memory 的异常通常选择吞掉并返回空串。这提升鲁棒性，但也可能让用户不知项目指令/memory 没注入成功。

## 14. Hooks 与 Plugins 模块

Hooks 和 Plugins 是 CodeShell 的扩展层。

### 14.1 Hook events

`src/hooks/events.ts` 定义 HookEventName。当前实际 emit 的事件包括：

- `on_session_start`
- `on_session_end`
- `on_agent_start`
- `on_agent_end`
- `user_prompt_submit`
- `on_turn_start`
- `on_turn_end`
- `on_stop`
- `pre_tool_use`
- `post_tool_use`
- `on_tool_start`
- `on_tool_end`
- `file_changed`
- `on_permission_check`
- `post_compact`
- `notification`

`pre_compact` 是 reserved/not-yet-emitted。

### 14.2 HookRegistry

`registry.ts` 负责：

- 注册 hook handler。
- 按 priority 排序执行。
- 合并 HookResult。

decision 合并规则：

```text
deny > ask > allow
```

`updatedInput` / `updatedPrompt` 是 last-write-wins。

风险：handlers 按 priority 降序执行，但 last-write-wins 意味着低 priority 后执行者会覆盖高 priority 的 updatedPrompt。如果设计意图是高优先级最终控制，这里可能反了。

### 14.3 Shell hooks

`shell-runner.ts` 运行 settings.hooks 中配置的 shell command。

协议：

- stdin 写 `{ eventName, data }` JSON。
- exit 0 且 stdout 是 HookResult JSON → 解析。
- exit 2 → `decision: "deny"`。
- timeout/malformed/非 0 非 2 → no-op。

Shell hook 可用于本地策略、日志、拦截工具等。

### 14.4 Engine 中 hook 装配顺序

Engine 构造时：

1. 创建 `HookRegistry`。
2. 非 sub-agent 时加载 plugin hooks。
3. 注册 settings hooks。
4. 注册 config hooks。

priority 大致是：

- plugin：80。
- settings shell：50。
- SDK/config hook：默认 0。

### 14.5 Plugin hooks

`plugins/loadPluginHooks.ts` 从 installed plugins 的 `hooks/hooks.json` 加载 Claude Code compatible hooks。

事件映射：

- `SessionStart` → `on_session_start`
- `UserPromptSubmit` → `user_prompt_submit`
- `PreToolUse` → `pre_tool_use`
- `PostToolUse` → `post_tool_use`
- `PreCompact` → `pre_compact`
- `Notification` → `notification`
- `Stop` → `on_session_end`
- `SubagentStop` → skip

风险：

- `Stop` 映射到 `on_session_end` 可能语义偏晚。CodeShell 自己有 `on_stop`，可以阻止/继续结束；`on_session_end` 已是结束后事件。
- `PreCompact` 映射到 reserved/not-emitted 事件，plugin 注册了也不会触发。
- plugin matcher bad regex 返回 true，而 settings shell hook bad regex 返回 false；配置错误时 plugin hook 会全量触发，行为不一致。

### 14.6 Plugin command hook

`pluginCommandHook.ts` 执行 plugin command：

- 设置 `CODESHELL_PLUGIN_ROOT`。
- 设置 `CODESHELL_HOOK_EVENT`。
- 明确删除 `CLAUDE_PLUGIN_ROOT`。
- 解析 Claude Code / Cursor / SDK 风格 output。
- 归一为 `HookResult.messages`。

风险：plugin hook stdout 当前只能产生 messages/additionalContext，不能表达 deny/ask/updatedPrompt。也就是说 plugin `PreToolUse` 不能真正阻止工具，settings shell hook 可以。

### 14.7 Plugin installer / marketplace

`plugins/**` 还包括：

- `pluginInstaller.ts`：安装/卸载流程、cache 安全检查、SHA 校验。
- `marketplaceManager.ts`：marketplace 源管理。
- `knownMarketplaces.ts`：已知市场源。
- `parseMarketplaceInput.ts`：解析 marketplace 输入。
- `gitOps.ts`：git 操作。
- `varRewrite.ts`：安装时把 `CLAUDE_PLUGIN_ROOT` 重写成 `CODESHELL_PLUGIN_ROOT`。
- `installedPlugins.ts`：维护 installed_plugins.json。

`varRewrite` 是刻意设计：避免插件检测到 Claude Code 环境并输出 CC-specific 格式。

## 15. Skills 模块

`src/skills/**` 负责发现和解析 skill；真正调用 skill 的工具在 `tool-system/builtin/skill.ts`。

### 15.1 扫描路径

`scanner.ts` 扫描：

- `<cwd>/.code-shell/skills`
- `~/.code-shell/skills`
- installed plugins 下的 `skills/`

plugin skill 命名为：

```text
<pluginName>:<skillDirName>
```

### 15.2 disabled 过滤

`scanSkills(cwd, opts)` 会按：

- `disabledSkills`
- `disabledPlugins`

过滤。

Engine 会把 settings/capabilityOverrides 合成后的 disabled list 传给 PromptComposer 和 ToolContext。Skill tool 调用 scanner 前也会检查 disabledSkills/disabledPlugins，给出更明确错误。

### 15.3 Skill 工具

`tool-system/builtin/skill.ts` 的 `Skill` 工具：

1. 扫描 skills。
2. 找到指定 skill。
3. 读取 `SKILL.md`。
4. 替换参数占位符：
   - `$ARGUMENTS`
   - `{args}`
   - `${CODESHELL_SKILL_DIR}`
   - `${CLAUDE_SKILL_DIR}`
5. 返回 skill 文本，让模型按照 skill 指令继续。

### 15.4 frontmatter

`frontmatter.ts` 解析 `SKILL.md` frontmatter，尤其是 description。description 会出现在 skills listing 中，帮助模型判断何时调用。

### 15.5 风险

- scanner memoize key 包含 cwd、userHome、installed_plugins.json mtime，但不看每个 plugin SKILL.md 的 mtime。已安装 plugin 的 skill 文件被原地修改时，可能返回旧缓存。
- 直接调用 `scanSkills(cwd)` 且不传 disabled list 会绕过 capability overlay。当前 Engine/SkillTool 路径有传，但 API 使用者要注意。
- skills listing 只提供摘要，模型必须主动调用 `Skill` 才能获取完整技能指令；如果没有 SessionStart 自动加载机制，skill 不会自动进入上下文。

## 16. Services 模块：Memory、OAuth、Notifier、Analytics、Diagnostics

`src/services/**` 放非主循环但被 Engine/CLI 调用的服务。

### 16.1 memory services

相关文件：

- `memory-orchestrator.ts`
- `extract-memories.ts`
- `dream-consolidation.ts`
- `auto-dream.ts`
- `session-memory.ts`
- `session-memory-sort.ts`

Engine.run 完成后会 fire-and-forget：

- 从 session 中抽取 memory。
- 做 dream consolidation。
- 更新 session memory context。

这些任务不阻塞主 run 返回。

风险：fire-and-forget 后台任务没有统一生命周期管理。进程退出时可能丢任务；错误通常只记录，不反馈给用户。

### 16.2 OAuth / browser open

- `oauth.ts` 负责 OAuth 相关流程。
- `browser-open.ts` 封装打开浏览器。

### 16.3 notifier

`notifier.ts` 负责系统通知。可用于 run 完成、后台任务等提醒。

### 16.4 analytics / diagnostics

- `analytics.ts`：分析/遥测相关封装。
- `diagnostics.ts`：诊断信息收集。

Core 里很多 telemetry/state API 是 lightweight stub 或兼容层，避免 engine 强依赖具体产品端。

## 17. Logging 模块

`src/logging/**` 管运行日志、消息脱敏、session recorder。

### 17.1 logger

`logger.ts` 提供核心日志能力。Engine 会在 session scope 内设置 sid，使日志和 session 关联。

### 17.2 sanitize-messages

`sanitize-messages.ts` 用于写日志前清理敏感内容，避免 API key、secret、过大 payload 直接进日志。

### 17.3 session-recorder

`session-recorder.ts` 记录 LLM request/response、stream、tool 等 session 事件，便于调试和回放。

### 17.4 风险

- 如果 redaction/sanitize 覆盖不全，日志可能泄露敏感数据。
- 如果 sanitize 过度，调试 provider/tool call 问题会缺关键信息。
- session recorder 与 transcript 是两套不同记录；排查时要分清“给模型看的历史”和“调试记录”。

## 18. Git / LSP / Runtime / Utils 支撑模块

这些模块不是主循环中心，但支撑核心功能。

### 18.1 Git

`src/git/**` 包括：

- `worktree.ts`：worktree 创建/管理/删除。
- `utils.ts`：git 辅助函数。
- `parse-log.ts`：解析 git log。

用于会话隔离、历史、diff、工作树等功能。当前产品设计偏好是 session-scoped file-change ledger，而不是直接用全局 git diff 推导 session 文件变化。

### 18.2 LSP

`src/lsp/**` 包括：

- `manager.ts`：LSP manager。
- `client.ts`：LSP client。
- `servers.ts`：server 定义。
- `root-path.ts`：root path 解析。

LSP 能力可用于代码智能、诊断、符号等。

### 18.3 Runtime safe spawn

`src/runtime/safe-spawn.ts` 封装安全子进程执行。Hook runner、plugin、git、shell 工具等需要执行外部命令时应优先走这类封装，避免环境变量、cwd、stdio、信号处理不一致。

### 18.4 Utils

`src/utils/**` 是通用工具集合，包括：

- `format.ts`
- `theme.ts`
- `toolDisplay.ts`
- `debug.ts`
- `env.ts`
- `envUtils.ts`
- `execFileNoThrow.ts`
- `lockfile.ts`
- `memoize.ts`
- `semver.ts`
- `sliceAnsi.ts`
- `intl.ts`
- `earlyInput.ts`
- `systemTheme.ts`
- `task-sanitizer.ts`

这些工具被 CLI/UI/core 多处复用。修改时要注意它们可能是跨层依赖。

## 19. 状态与成本统计模块

### 19.1 `state.ts`

`src/state.ts` 是 process-wide 状态兼容层，包含：

- sessionId / cwd / projectRoot。
- interactive/headless 标记。
- model override。
- token counters。
- per-model usage。
- API duration。
- lines changed。
- turn hook/tool/classifier duration。
- telemetry counter stubs。
- remote mode / sdk betas 等状态。

它的设计像是从产品层抽出来的轻量全局状态，很多函数是 no-op/stub，保证 core 不强依赖 UI/telemetry 实现。

风险：全局 mutable state 在多 Engine、多 session、嵌入式 server 场景容易串扰。尤其 token/cost/per-model usage 如果没有 session isolation，UI 展示可能混多个 run。

### 19.2 `cost-tracker.ts`

`CostTracker` 负责：

- usage records。
- pricing lookup。
- cache read/write token 计价。
- estimated cost。
- serialize/restore。
- 安装 `LLMClientBase.onUsage` hook。

它和 `state.ts` 都记录 usage/cost 相关信息，但用途不同：

- `state.ts` 更像 UI/legacy/global counters。
- `CostTracker` 更像 session/runtime cost accounting。

需要避免两个来源显示不一致。

## 20. 已发现的潜在 bug / 风险清单

本节汇总本轮只读深读发现的问题，按优先级粗分。

### 20.1 高优先级风险

1. **版本常量不一致**
   - `package.json` 是 `0.5.0-rc.1`。
   - `src/index.ts` 的 `VERSION` 是 `0.5.0-rc.0`。
   - 影响 SDK 诊断/兼容判断。

2. **Engine.run 后置 hook 可能阻断 session final save**
   - TurnLoop 内部强调不能 reject，但 Engine 在 TurnLoop 后还执行 `on_session_end`、保存 state、`on_agent_end`。
   - 如果 hook 抛错，可能导致 session 没有正确落 terminal 状态。

3. **maxTurns 可能重复 emit `turn_complete`**
   - TurnLoop maxTurns 分支 emit 一次。
   - Engine.run 收尾统一 emit 一次。
   - 客户端可能收到重复完成事件。

4. **multi-session approval 链路需复核**
   - Server approve 逻辑依赖 `ChatSession.pendingApprovals`。
   - 本轮未看到 handleRunMulti 注册 resolver 的清晰路径。
   - 可能导致 approve 返回 `No pending approval`。

5. **FileRunStore public id 路径安全不足**
   - runId/checkpointId/approvalId 作为路径片段。
   - RunManager 生成的 id 安全，但 public store API 若接外部输入有路径穿越风险。

6. **OpenAI-compatible streaming 固定 include_usage**
   - capability 定义了 streamUsage shape。
   - request body 仍固定 `stream_options.include_usage = true`。
   - 某些兼容端点可能 reject。

7. **plugin Stop / PreCompact 映射语义问题**
   - `Stop` → `on_session_end` 可能太晚。
   - `PreCompact` → reserved/not-emitted，实际不会触发。

8. **plugin PreToolUse 不能 deny**
   - plugin command output 被归一为 messages。
   - 无法表达 decision deny/ask/updatedPrompt。
   - 如果用户期待 CC-compatible PreToolUse 可拦截工具，会不符合预期。

### 20.2 中优先级风险

9. **Engine.run mutate caller options**
   - 会替换 `options.onStream`。
   - 调用方复用 options 对象时可能出错。

10. **RunManager 非 completed reason 全部 failed**
    - `max_turns`、`image_error`、`aborted_streaming` 等全部 failed。
    - 语义可能过粗。

11. **EngineRunner overrides 可覆盖 automation note**
    - `engineConfigOverrides` 在最后展开。
    - 可静默覆盖 `appendSystemPrompt`。

12. **Stdio/TCP malformed JSON 静默跳过**
    - client request 可能永久 pending。

13. **AgentClient request 无 timeout**
    - transport/server 异常时 promise 挂起直到 close。

14. **Transcript flush failure 被吞**
    - 内存事件和磁盘 transcript 可能不一致。

15. **FileHistory 覆盖工具不全**
    - 只覆盖 Write/Edit。
    - ApplyPatch/Bash 等修改不会 snapshot。

16. **MCP tool name 未 sanitize**
    - 特殊字符可能影响 provider tool name 兼容。

17. **MCP direct callTool 图片处理不一致**
    - registered executor 会 spill image。
    - direct callTool 可能丢图片。

18. **HookRegistry updatedPrompt priority 可能反直觉**
    - priority 高的先执行，但 last-write-wins 让低 priority 后覆盖。

19. **SettingsManager 默认 project scope**
    - 入口忘记传 full 时 user settings 不可见。

20. **全局 state 多 session 串扰**
    - `state.ts` 是 process-wide mutable state。
    - 多 Engine/Run 场景可能混 token/cost/model usage。

### 20.3 低优先级 / 设计债

21. **CostTracker.reset 不重置 unknown flag**。
22. **state.resetCostState 不清 per-model usage**。
23. **ModelPool 默认 maxTokens 8192 可能过早截断未知模型**。
24. **tool-result-storage 写失败后不重试**。
25. **skills scanner cache 不看 plugin SKILL.md mtime**。
26. **InvestigationGuard read-only/mutating 工具集合不完整**。
27. **server 用 any 访问 ChatSessionManager private sessions**。
28. **RunStore tmp 文件名固定，多进程写可能冲突**。
29. **RunStore append lock 只有进程内效果**。
30. **background fire-and-forget memory/title/summary 缺统一生命周期管理**。

## 21. 推荐后续阅读顺序

如果后续继续抠细节，建议按下面顺序读。

### 21.1 第一轮：主链路

1. `src/index.ts`
2. `src/engine/engine.ts`
3. `src/engine/turn-loop.ts`
4. `src/engine/model-facade.ts`
5. `src/tool-system/executor.ts`
6. `src/tool-system/registry.ts`
7. `src/tool-system/permission.ts`
8. `src/session/session-manager.ts`
9. `src/session/transcript.ts`

目标：理解一次 `Engine.run()` 怎么从用户任务变成多轮模型和工具循环。

### 21.2 第二轮：外部调用和后台任务

1. `src/protocol/types.ts`
2. `src/protocol/client.ts`
3. `src/protocol/server.ts`
4. `src/protocol/chat-session.ts`
5. `src/protocol/chat-session-manager.ts`
6. `src/run/RunManager.ts`
7. `src/run/EngineRunner.ts`
8. `src/run/RunApprovalBackend.ts`
9. `src/run/FileRunStore.ts`

目标：理解 UI/worker/automation 怎么调用 core，run 如何排队、持久化、恢复。

### 21.3 第三轮：模型和上下文

1. `src/llm/model-pool.ts`
2. `src/llm/client-factory.ts`
3. `src/llm/client-base.ts`
4. `src/llm/providers/openai.ts`
5. `src/llm/providers/anthropic.ts`
6. `src/llm/capabilities/**`
7. `src/context/manager.ts`
8. `src/context/compaction.ts`
9. `src/context/tool-result-storage.ts`
10. `src/cost-tracker.ts`
11. `src/state.ts`

目标：理解不同 provider 怎么统一，长上下文怎么压缩，usage/cost 怎么统计。

### 21.4 第四轮：扩展能力

1. `src/settings/schema.ts`
2. `src/settings/manager.ts`
3. `src/prompt/composer.ts`
4. `src/prompt/instruction-scanner.ts`
5. `src/hooks/events.ts`
6. `src/hooks/registry.ts`
7. `src/hooks/shell-runner.ts`
8. `src/plugins/loadPluginHooks.ts`
9. `src/plugins/pluginCommandHook.ts`
10. `src/skills/scanner.ts`
11. `src/tool-system/mcp-manager.ts`

目标：理解配置、prompt、hooks、plugins、skills、MCP 如何影响一次 run。

### 21.5 建议下一步专项

如果要继续做“每个 bug 具体怎么修”，建议开几个专项文档/任务：

1. **Protocol approval 专项**：确认 multi-session approval resolver 是否完整。
2. **Engine finalization 专项**：给 post-TurnLoop hook/save 加 try/finally，避免 session stuck。
3. **RunStore path safety 专项**：统一 runId/checkpointId/approvalId 校验。
4. **Plugin hook compatibility 专项**：修 Stop/PreCompact/decision 输出语义。
5. **LLM capability 专项**：让 OpenAI-compatible streaming 尊重 `streamUsage`。
6. **Global state isolation 专项**：梳理 `state.ts` 与 CostTracker 的 session/run 隔离边界。

---

## 22. 本文档覆盖范围和限制

本文档基于本轮只读代码探索和并行子任务总结写成。已覆盖 `packages/core/src` 的主要主链路和关键模块，但仍有一些限制：

- 没有逐行展开每个 builtin tool 的内部实现。
- 没有逐个 provider capability rule 全量列举。
- 没有运行测试验证风险点，只做静态阅读判断。
- 没有修改代码；所有 bug 均为待确认风险。

如果后续要继续深入，建议以“专项 bug 验证 + 最小修复 PR”的方式推进。

---

## 23. 源码证据索引与链路核验表

本节用于证明本文档不是目录摘要，而是按源码入口和调用点反查后整理。下面列的是本轮核验过的关键锚点；行号来自当前工作区源码和 `docs/core-deep-dive.md` 当前版本。

### 23.1 文档存在性与覆盖核验

已用工具确认：

- 文档路径：`docs/core-deep-dive.md`
- 行数：`1856` 行（追加本节前）
- 大小：约 `62KB`
- 占位符检查：已清零
- 章节覆盖：`## 1` 到 `## 22` 均存在，追加本节后为 `## 23`

关键覆盖点在文档中可检索到：

- `Engine.run`
- `TurnLoop`
- `RunManager`
- `AgentServer`
- `ToolExecutor`
- `PermissionClassifier`
- `ContextManager`
- `SessionManager`
- `ModelPool`
- `MCPManager`
- `风险`

### 23.2 入口链路源码锚点

| 链路 | 源码锚点 | 说明 |
|---|---|---|
| Public API barrel | `packages/core/src/index.ts` 导出 `Engine`、`createLLMClient`、protocol/run/tool 等 | SDK 入口，不是 CLI 层 |
| LLM client factory | `src/llm/client-factory.ts:17 export async function createLLMClient` | Engine 和 arena 等模块创建 provider client 的统一入口 |
| Engine 主入口 | `src/engine/engine.ts` 中 `export class Engine` / `Engine.run(...)` | 一次任务 run 的最高层编排 |
| TurnLoop 调用 | `src/engine/engine.ts` 中 `new TurnLoop(...)`、`turnLoop.run(...)` | Engine 完成初始化后进入模型/工具循环 |
| Stream 类型 | `src/types.ts:251 session_started`、`src/types.ts:267 turn_complete` | RunManager、UI、protocol 依赖这些事件 |

### 23.3 `Engine.run()` 核验链路

本轮源码检索确认了以下关键调用点：

| 步骤 | 源码锚点 | 文档对应 |
|---|---|---|
| 提前创建 LLM client | `engine/engine.ts` 引用 `createLLMClient`；`llm/client-factory.ts:17` | 3.2、8.1 |
| 创建 ToolExecutor | `engine/engine.ts` 出现 `new ToolExecutor` | 3.2、9.3 |
| 创建 ContextManager | `engine/engine.ts` 出现 `new ContextManager` | 3.2、10.1 |
| 连接 MCP | `engine/engine.ts` 中 Engine.run 调 `connectAll()`；`mcp-manager.ts:160 connectAll` | 3.2、9.5 |
| session_started | `types.ts:251` 定义；`RunManager.ts:459` 消费 | 3.2、6.4、7.4 |
| on_session_end | `hooks/events.ts:9` 标注由 engine.ts emit | 3.3、14.1 |
| turn_complete | `types.ts:267` 定义；`turn-loop.ts:712` maxTurns emit | 3.3、5.7、20.1 |

核验结论：文档的主链路不是推测，确实对应源码中的 Engine → TurnLoop → ModelFacade/ToolExecutor/ContextManager/MCP/Session 组合。

### 23.4 TurnLoop 源码锚点

| 功能 | 源码锚点 | 说明 |
|---|---|---|
| TurnLoop run 入口 | `src/engine/turn-loop.ts:230 async run(initialMessages...)` | 多轮循环入口 |
| 不应 reject 注释 | `turn-loop.ts:235-237` | 说明为什么 Engine 后置 finalization 风险重要 |
| context manage | `context/manager.ts:289 async manageAsync`；hooks 注释 `events.ts:57` | 每轮模型调用前压缩上下文 |
| tool execution | `tool-system/executor.ts:315 registry.executeTool(...)` | TurnLoop 最终通过 ToolExecutor 执行工具 |
| on_stop 语义 | `hooks/events.ts:121-124 continueSession`；`hooks/registry.ts:98` | 模型无工具调用时也可能继续 |
| maxTurns complete | `turn-loop.ts:712 turn_complete max_turns` | 支撑“可能重复 turn_complete”的风险判断 |

### 23.5 RunManager / EngineRunner 源码锚点

| 功能 | 源码锚点 | 说明 |
|---|---|---|
| EngineRunner | `src/run/EngineRunner.ts:133 export class EngineRunner` | managed run 默认 executor |
| RunManager session link | `src/run/RunManager.ts:449-459` 注释和判断 `event.type === "session_started"` | in-flight run 提前写 sessionId |
| Checkpoint turn_complete | `src/run/CheckpointWriter.ts:91 case "turn_complete"` | run checkpoint 依赖 stream event |
| Run tests | `RunManager.session-link.test.ts:35`、`:42`、`:63-68` | 有测试覆盖 session_started link 和 sub-agent 过滤 |

文档中“RunManager 用 session_started 提前 link session”的描述可直接由 `RunManager.ts:449-459` 核验。

### 23.6 Protocol / ChatSession 源码锚点

| 功能 | 源码锚点 | 说明 |
|---|---|---|
| AgentClient | `protocol/client.ts:62 export class AgentClient` | RPC client |
| Client run | `protocol/client.ts:106 async run(...)` | 外部提交任务入口 |
| Client request | `protocol/client.ts:289 private request(...)` | pending request，无显式 timeout 风险来源 |
| Client notification | `protocol/client.ts:315 handleNotification(...)` | stream/status/approval 分发 |
| AgentServer | `protocol/server.ts:58 export class AgentServer` | RPC server |
| Server dispatch | `protocol/server.ts:139-152` | run/approve/query 等方法分发 |
| handleRun | `protocol/server.ts:169-175` | multi-session 与 legacy 分流 |
| handleRunMulti | `protocol/server.ts:178`；`server.ts:213 session.enqueueTurn(...)` | multi-session run path |
| handleApprove | `protocol/server.ts:338` | approval path |
| ChatSession | `protocol/chat-session.ts:31 export class ChatSession` | 单 session turn queue |
| enqueueTurn | `protocol/chat-session.ts:62` | session 入队入口 |
| pump | `protocol/chat-session.ts:109 private async pump()` | 串行执行 turns |
| ChatSessionManager | `protocol/chat-session-manager.ts:31 export class ChatSessionManager` | live session map 和容量/TTL 管理 |

### 23.7 Tool System 源码锚点

| 功能 | 源码锚点 | 说明 |
|---|---|---|
| ToolExecutor | `tool-system/executor.ts:40 export class ToolExecutor` | 单工具调用编排 |
| executeSingle | `executor.ts:104 async executeSingle(...)` | 工具执行主入口 |
| pre_tool_use | `executor.ts:141 hooks.emit("pre_tool_use"...)` | 工具执行前 hook |
| pre_tool_use 不能提权 | `executor.ts:178-191` 注释 | 支撑安全设计说明 |
| PermissionClassifier | `permission.ts:639 export class PermissionClassifier` | 权限分类核心 |
| classify | `permission.ts:673 classify(...)` | allow/ask/deny 入口 |
| Bash classifier | `permission.ts:543 classifyBashCommand(...)` | Bash 特殊分类 |
| acceptEdits allowlist | `permission.ts:631 ACCEPT_EDITS_ALLOWLIST`；`permission.ts:707` 使用 | 支撑默认权限风险说明 |
| ToolRegistry | `registry.ts:21 export class ToolRegistry` | 工具定义/执行注册表 |
| executeTool | `registry.ts:75 async executeTool(...)` | 实际执行工具的 registry 入口 |
| MCPManager | `mcp-manager.ts:142 export class MCPManager` | MCP 连接和工具注册 |
| connectAll | `mcp-manager.ts:160 async connectAll(...)` | MCP server 批量连接 |
| discoverTools | `mcp-manager.ts:265 private async discoverTools(...)` | MCP tool discovery |
| registered MCP callTool | `mcp-manager.ts:272-273 client.callTool(...)` | 注册进 ToolRegistry 的 MCP executor |
| direct MCP callTool | `mcp-manager.ts:349 async callTool(...)`；`builtin/mcp-tools.ts:41` 使用 | 支撑 direct path 图片处理风险 |

### 23.8 LLM / Capability / Cost 源码锚点

| 功能 | 源码锚点 | 说明 |
|---|---|---|
| createLLMClient | `llm/client-factory.ts:17` | provider client factory |
| ModelPool | `llm/model-pool.ts:96 export class ModelPool` | runtime model registry |
| toLLMConfig | `llm/model-pool.ts:243 toLLMConfig(...)` | model entry → LLMConfig |
| Capability type | `llm/capabilities/types.ts:67` 注释 stream usage shape | provider 参数适配依据 |
| capabilitiesFor | `llm/capabilities/index.ts:35 export function capabilitiesFor` | capability rule resolver |
| OpenAIClient | `llm/providers/openai.ts:111 export class OpenAIClient` | OpenAI-compatible provider |
| OpenAI createMessage | `openai.ts:161 async createMessage(...)` | provider 调用入口 |
| OpenAI buildRequestBody | `openai.ts:206 private buildRequestBody(...)` | 参数映射核心 |
| OpenAI include_usage | `openai.ts:290 stream_options: { include_usage: true }` | 支撑 streamUsage 风险 |
| OpenAI SDK call | `openai.ts:301` non-stream；`openai.ts:336` stream | 实际 provider API 调用 |
| AnthropicClient | `anthropic.ts:21 export class AnthropicClient` | Anthropic provider |
| Anthropic createMessage | `anthropic.ts:43 async createMessage(...)` | Anthropic 调用入口 |
| Anthropic SDK call | `anthropic.ts:86 client.messages.create(...)` | 实际 provider API 调用 |
| Direct client unknown max token test | `openai-max-tokens-clamp.test.ts:63-75` | 说明 direct provider path 已测试未知模型不发送 max_tokens；ModelPool path 是否仍注入 maxTokens 应专项复核 |

### 23.9 Context / Session 源码锚点

| 功能 | 源码锚点 | 说明 |
|---|---|---|
| ContextManager | `context/manager.ts:95 export class ContextManager` | 上下文管理 orchestrator |
| sync manage | `context/manager.ts:179 manage` | 同步 compaction path |
| async manage | `context/manager.ts:289 async manageAsync` | TurnLoop 使用 path |
| applyToolResultPersistence | `context/manager.ts:422` 调用；`tool-result-storage.ts:223 export function` | 大工具结果落盘 |
| microcompact | `context/manager.ts:211/310` 调用；`compaction.ts:238 export function microcompact` | 旧 tool_result 清理 |
| summary compaction | `context/manager.ts:253/353 applySummaryCompaction`；`compaction.ts:502 export function` | LLM summary compaction |
| persist failed no retry | `tool-result-storage.ts:306-308` 注释 | 支撑写失败后冻结风险 |
| SessionManager | `session/session-manager.ts` 中 `export class SessionManager` | on-disk session 管理 |
| Transcript | `session/transcript.ts` 中 `export class Transcript` | JSONL transcript 和 messages 派生 |
| FileHistory | `session/file-history.ts` 中 `export class FileHistory` / `saveSnapshot` | 修改前快照 |

### 23.10 Settings / Prompt / Hooks / Plugins / Skills 源码锚点

| 功能 | 源码锚点 | 说明 |
|---|---|---|
| SettingsSchema | `settings/schema.ts:30 export const SettingsSchema` | 设置 schema |
| CapabilityOverrides | `settings/schema.ts:20 CapabilityOverridesSchema`；`:237 capabilityOverrides` | project overlay |
| SettingsManager | `settings/manager.ts:50 export class SettingsManager` | 设置管理 |
| load | `settings/manager.ts:62 load(...)` | 读取多层 settings |
| saveUserSetting | `settings/manager.ts:163` | 支撑 scope 语义风险 |
| getForScope | `settings/manager.ts:253` | 单 scope provenance 读取 |
| merge | `settings/manager.ts:316 function merge(...)` | 深合并实现 |
| PromptComposer | `prompt/composer.ts` 中 `PromptComposer`；`composer-tool-listing.test.ts:27 buildSystemPrompt` | system prompt 组装 |
| scanSkills 用于 prompt | `prompt/composer.ts:13 import scanSkills` | skills listing 来源 |
| Skill tool scanner | `tool-system/builtin/skill.ts:70 scanSkills(ctx.cwd...)` | 调用 skill 时再扫描 |
| loadPluginHooks | `plugins/loadPluginHooks.ts:152 export function loadPluginHooks` | plugin hook loader |
| plugin event mapping | `loadPluginHooks.ts:27-32` 注释；`:58-63` map | 支撑 Stop/PreCompact 风险 |
| runPluginCommandHook | `plugins/pluginCommandHook.ts:90 export async function runPluginCommandHook` | plugin command runner |
| HookRegistry | `hooks/registry.ts`；`hooks/decision-merge.test.ts` 注释 priority/deny 语义 | hook 合并和 priority 风险 |

### 23.11 风险项和源码依据对照

| 风险 | 主要依据 |
|---|---|
| `VERSION` 与 package 版本不一致 | `packages/core/package.json` vs `src/index.ts VERSION` |
| post-TurnLoop hook/save 可能阻断 finalization | `turn-loop.ts:235-237` 注释说明后置 bookkeeping 在 TurnLoop 外；Engine 后续还有 `on_session_end`/save |
| `turn_complete` 可能重复 | `turn-loop.ts:712` emit max_turns；`types.ts:267` 定义统一事件；Engine 收尾也 emit |
| RunManager session link | `RunManager.ts:449-459` |
| protocol request 无 timeout | `client.ts:289 request(...)` pending map path |
| OpenAI streamUsage 不尊重 capability | `capabilities/types.ts:67` vs `openai.ts:290` 固定 include_usage |
| plugin Stop/PreCompact 映射 | `loadPluginHooks.ts:58-63` |
| plugin PreToolUse 不能 deny | `pluginCommandHook.ts:90` output 归一；`loadPluginHooks.ts:186 runPluginCommandHook` |
| FileRunStore path safety | `run/FileRunStore.ts` public path API，需要专项 grep/read 逐项确认 |
| FileHistory 覆盖不全 | Engine file snapshot hook 只针对 Write/Edit；`file-history.ts saveSnapshot` |
| Tool permission hardening | `executor.ts:178-191`、`executor.ts:238-242`、`permission.ts:673` |

### 23.12 补充专项章节索引

以下区域已在后续章节补齐，并作为正式章节纳入本文档：

1. builtin tools：见第 24 节。
2. sandbox：见第 25 节。
3. automation scheduler：见第 26 节。
4. arena 子系统：见第 27 节。
5. capability rules：见第 28 节。
6. RunStore / FileHistory / SessionManager 风险源码：见第 29 节。

---

## 24. Builtin Tools 详细模块文档

`src/tool-system/builtin/**` 是 core 内置工具集合。本轮确认共有 39 个一层 `.ts` 文件，核心由 `builtin/index.ts` 聚合为 `BUILTIN_TOOLS`，再由 `ToolRegistry.registerBuiltins()` 注册。

### 24.1 文件读取/搜索/编辑类

| 工具/文件 | 功能 | 使用方式 | 权限/风险 |
|---|---|---|---|
| `read.ts` / `Read` | 读取本地文件，支持 offset/limit | 模型传 `file_path`，可传行范围 | 调用 `enforcePathPolicy(filePath, "read", ctx.cwd)`；说明里要求不要重复读刚编辑文件 |
| `grep.ts` / `Grep` | 正则搜索文件内容 | path + pattern + glob/output_mode/context | 只读；结果量要控，避免过大上下文 |
| `glob.ts` / `Glob` | 文件模式匹配 | path + pattern | 只读；用于发现文件结构 |
| `write.ts` / `Write` | 写文件/覆盖文件 | file_path + content | 修改文件；受权限系统和 path policy 影响；Engine 的 FileHistory hook 会在 Write 前备份 |
| `edit.ts` / `Edit` | 精确字符串替换 | old_string/new_string/file_path | 修改文件；要求 old_string 唯一，减少误改 |
| `notebook-edit.ts` / `NotebookEdit` | notebook cell 编辑 | notebook/cell 定位和替换 | 修改文件；在 acceptEdits allowlist 内 |
| `worktree.ts` / `EnterWorktree`、`ExitWorktree` | 进入/退出工作树 | 由模型调用工作树工具 | 改变执行上下文，需注意 cwd/session 状态 |

细节：`read.ts` 在读文件前先做 path policy，避免敏感路径存在性侧信道；FileHistory 当前只在 Engine `on_tool_start` hook 中覆盖 `Write`/`Edit`，未覆盖 `ApplyPatch` 和 shell 修改。

### 24.2 执行环境类

| 工具/文件 | 功能 | 使用方式 | 权限/风险 |
|---|---|---|---|
| `bash.ts` / `Bash` | 执行 shell 命令 | command + 可选 timeout/description | 走 Bash permission classifier；可接 sandbox backend |
| `powershell.ts` / `PowerShell` | 执行 PowerShell | command + timeout | 跨平台但主要面向 Windows/PowerShell Core |
| `repl.ts` / `REPL` | 执行 JS/TS/Python/Ruby snippets | language + code | 代码执行能力，需权限控制 |
| `sleep.ts` / `Sleep` | 暂停 | seconds | 长等待会占用 turn；最大 300s |

`Bash` 是最敏感工具之一。安全链路是：ToolExecutor → PermissionClassifier → Bash command classifier → approval/sandbox → safe spawn。Bash 分类器已加入 hardening，避免只按 safe-read pattern 匹配整个命令导致 `ls; rm -rf /` 这种绕过。

### 24.3 Web / remote / external 类

| 工具/文件 | 功能 | 使用方式 | 风险 |
|---|---|---|---|
| `web-fetch.ts` / `WebFetch` | 抓取 URL 文本 | url + headers/max_length | 有 DNS/IP block 检查，防 SSRF；外部内容视为不可信 |
| `web-search.ts` / `WebSearch` | Web 搜索 | query + num_results | 依赖 provider 配置；搜索结果不可信 |
| `remote-trigger.ts` / `RemoteTrigger` | 触发远程 agent/workflow | name + prompt + config | 外部副作用，权限应谨慎 |
| `send-message.ts` | 发送消息类能力 | 由工具定义决定 | 可见于他人的外部副作用，应高权限 |
| `generate-image.ts` / `GenerateImage` | 调 OpenAI Images API 生成 PNG | prompt + size/quality | 需要 OpenAI provider；会写 workspace 图片文件 |

`web-fetch.ts` 包含 host/IP block 和 DNS lookup，明确防止访问本地/内网敏感地址。外部内容仍可能带 prompt injection，模型使用时必须按 untrusted data 处理。

### 24.4 Agent / Arena / Task 类

| 工具/文件 | 功能 | 使用方式 | 风险 |
|---|---|---|---|
| `agent.ts` / `Agent` | 启动子代理 | prompt + agent_type/name/max_turns/run_in_background | 子代理可并行或后台运行；后台状态进程内保存 |
| `agent-registry.ts` | 后台 agent registry | agentId → status/result/cancel/transcript | process-local，进程崩溃丢状态；上限 `MAX_BACKGROUND_AGENTS = 6` |
| `agent-notifications.ts` | 后台 agent 完成通知 | 与 Agent 工具配合 | 通知和 transcript routing 需避免串流到主会话 |
| `agent-transcript-translator.ts` | 子代理 stream → transcript/display | 消费 stream events | 对 `turn_complete`/tombstone 等做生命周期处理 |
| `arena.ts` / `Arena` | 多模型协作分析工具 | topic + participants/config | 会调用多个 LLM，成本高；见第 27 节 |
| `task.ts` / `TodoWrite` | 管理任务列表 | todos 全量快照 | UI pinned panel 依赖；TaskGuard 会提醒 stale in_progress |
| `brief.ts` | 简报/摘要类工具 | 由定义决定 | 通常只读/文本生成 |

Agent 工具与 Engine 的 subAgentSpawner 连接：Engine 在 ToolContext 中注入 spawner，Agent 工具据此创建子 Engine 或后台 agent。后台 registry 是进程级内存，不是跨进程 durable run。

### 24.5 MCP / LSP / Skill / Memory / Config / Cron 类

| 工具/文件 | 功能 | 使用方式 | 风险 |
|---|---|---|---|
| `mcp-tools.ts` / `MCPTool`、`ListMcpResources`、`ReadMcpResource` | 通过 MCPManager 调 MCP server | server/tool/resource 参数 | direct `MCPManager.callTool()` 图片处理和 registered MCP executor 不一致 |
| `lsp.ts` / `LSP` | LSP definition/reference/hover/symbols | action + file/position | 只读代码智能；依赖 LSP server |
| `skill.ts` / `Skill` | 读取并注入 skill 指令 | skill + args | 调 scanSkills，受 disabledSkills/disabledPlugins 影响 |
| `memory.ts` / `MemoryList/Read/Save/Delete` | memory CRUD | scope/name/type/content | user scope 保存/删除需确认；dream scope 自动 |
| `config.ts` / `Config` | 读写项目设置 | action/key/value | 写 settings 是持久副作用 |
| `cron.ts` / `CronCreate/Delete/List` | 管 automation jobs | schedule/name/prompt/timezone | 创建持久自动化；prompt 应含“不要嵌套创建 automation” guard |
| `tool-search.ts` / `ToolSearch` | 查工具注册表 | query | 只读发现工具 |
| `ask-user.ts` / `AskUserQuestion` | 询问用户 | question/options | 会阻塞等待用户；headless 可能错误 |
| `plan.ts` / `EnterPlanMode/ExitPlanMode` | 计划模式切换 | 无/文本计划后退出 | 影响 tool allowlist |

### 24.6 Builtin tools 发现的额外风险

1. **MCP direct path 图片丢失风险**：`builtin/mcp-tools.ts` 走 `MCPManager.getInstance().callTool()`，该 direct path 主要聚合 text/string；registered MCP executor 里才有 image spill。
2. **后台 Agent 状态非持久**：`agent-registry.ts` 明确 process-local，进程崩溃丢失。
3. **GenerateImage 是写文件工具但不在 InvestigationGuard mutating 集合**：guard 对“只读转行动”的统计可能不准确。
4. **CronCreate 是持久自动化副作用**：需要更严格 prompt guard 和权限提示，尤其避免 automation run 内再创建 automation。
5. **Config/MemorySave/CronDelete 等 mutating 工具未被某些 guard 视为 mutating**：会影响 guard 行为，不一定影响核心权限。

---

## 25. Sandbox 详细模块文档

`src/tool-system/sandbox/**` 只包 Bash/shell 子进程，不沙箱 Engine 本身，也不沙箱 Write/Edit 等文件工具。

### 25.1 总体设计

`index.ts` 定义：

- `SandboxMode = "off" | "auto" | "seatbelt" | "bwrap"`
- `SandboxNetworkPolicy = "allow" | "deny"`
- `SandboxConfig { mode, writableRoots, deniedReads, network }`
- `SandboxBackend { name, wrap(command, opts), cleanup?, hintForBlockedOutput? }`

默认策略：

- workspace 和 `/tmp` 可写。
- `~/.ssh`、`~/.code-shell` 等敏感目录 deny read。
- network 默认 allow，因为 deny network 会破坏 `npm install`、`git pull` 等常见命令。

### 25.2 backend 选择

`detectSandboxCapabilities()`：

- macOS：检测 `/usr/bin/sandbox-exec`，支持 `seatbelt`。
- Linux：检测 `bwrap`，支持 `bubblewrap`。

`resolveSandboxBackend()`：

- `off`：直接 passthrough。
- `auto`：按平台能力选 seatbelt/bwrap，否则 off。
- 显式 `seatbelt`/`bwrap`：如果不可用应 fail closed，不静默降级。

测试里明确覆盖：auto 不抛，显式 backend 不可用时 reject。

### 25.3 seatbelt backend

`seatbelt.ts` 生成 macOS sandbox-exec profile：

- 允许读取系统必要路径。
- 拒绝敏感 credential 目录读取。
- 限制写入到 writableRoots。
- network 可 allow 或 deny。
- 每条命令写临时 profile，cleanup 删除。

风险：seatbelt 是 macOS 专属；profile 过严会让命令失败，过松会漏读/写。

### 25.4 bwrap backend

`bwrap.ts` 使用 Linux bubblewrap：

- bind mount `/` read-only。
- writableRoots bind 为 read-write。
- deniedReads 通过 tmpfs 遮蔽。
- unshare pid/ipc/uts/cgroup。
- network deny 时 unshare net。

注释指出 deniedReads 存在 TOCTOU 边界：host 侧并发写入 denied path 仍可能可见；这是 mount namespace 模型的限制。

### 25.5 off backend

`off.ts` passthrough，不做沙箱。auto 在没有 seatbelt/bwrap 时可能落到 off；这必须在 UI/日志中清晰显示，否则用户可能误以为有沙箱保护。

### 25.6 Sandbox 风险

1. **只保护 shell**：Write/Edit/ApplyPatch 不经过 sandbox。
2. **auto 可能退化为 off**：安全期望需要在 UI 上说明。
3. **network 默认 allow**：安全与可用性取舍，敏感任务应显式 deny。
4. **writableRoots typo**：代码已有警告逻辑，但如果用户忽略，命令会被 blocked。
5. **bwrap deniedReads TOCTOU**：注释明确 host-side concurrent write 可见。

---

## 26. Automation Scheduler 详细模块文档

`src/automation/**` 提供 cron/interval 自动化任务调度，与 `CronCreate` 工具和 RunManager/EngineRunner 结合。

### 26.1 文件组成

- `scheduler.ts`：`CronScheduler`，核心调度器。
- `store.ts`：`CronStore`，持久化 jobs。
- `runner.ts`：运行 job 的 request/result 类型和 runner glue。
- `write-policy.ts`：automation 写权限/策略。
- `write-run.ts`：写 run 记录或 automation run 相关文件。
- `cron-expr.ts`：cron 表达式解析/nextRun 计算。
- `index.ts`：`startAutomation()` 等聚合入口。

### 26.2 CronScheduler 链路

从测试和源码锚点看，调度器支持：

1. `create(name, schedule, prompt, opts)` 创建 job。
2. 支持 interval：`5m`、`1h` 等。
3. 支持 5-field cron expression：例如 `0 9 * * 1-5`。
4. cron expression 可带 IANA timezone，如 `Asia/Shanghai`。
5. job metadata 包括：`cwd`、`permissionLevel`、`timezone`、`nextRun`。
6. `list()` 查看 job。
7. `delete(id)` 删除 job。
8. `loadJobs()` 从 store 重新加载跨进程创建/删除/暂停的 jobs。
9. `setExecutionEnabled(false)` 可让 worker 只持久化不实际执行。
10. `stopAll()` 清理 timers。

### 26.3 跨进程模型

测试显示有 main/worker 分工：

- worker scheduler 可 execution disabled，只创建并持久化 job。
- main scheduler `loadJobs()` 后接管执行。
- reload 是幂等的，不重复 timers。
- 另一个进程删除 job 后，main reload 会移除内存 job 并停止 timer。

### 26.4 与 RunManager 的关系

automation job 到点后不会直接在 scheduler 内硬编码 Engine.run，而是通过 runner/request 绑定到 RunManager 或 EngineRunner。这让 automation 可以复用：

- cwd。
- permissionLevel。
- headless/unattended 策略。
- run store/checkpoint。
- approval/input 等机制。

### 26.5 Automation 风险

1. **automation prompt 必须防嵌套自动化**：用户偏好已明确，automation run 内不应创建/修改 automation。
2. **timezone 未知时应询问**：calendar cron 需要 IANA timezone，否则 UTC/本地误差会很明显。
3. **permissionLevel 要最小化**：默认 read-only；除非用户明确要求修改代码才 workspace-write/full。
4. **跨进程 reload 依赖 store 一致性**：store 写入/删除失败可能让 main/worker 视图不一致。
5. **interval vs cron 表达式歧义**：`20` 这类测试里作为 ms/interval fallback，产品输入要规范化。

---

## 27. Arena 子系统详细模块文档

`src/arena/**` 是 core 中的多模型协作分析引擎。它不是普通 `Engine.run()` 主循环，但属于 core 公开/内置能力：builtin `arena.ts` 工具会调用它，arena 内部也使用 `createLLMClient()`。

### 27.1 Arena 总链路

`arena/arena.ts` 文件头部列出阶段：

1. Planner：解析/规划 topic。
2. Strategy + Lens：根据 mode 组合 prompts。
3. ToolSelector：决定参与者可用工具。
4. ParticipantResearch：多个模型并行独立研究。
5. VerificationReview：claim-aware cross-review。
6. DebateRounds：争议 claim 进入结构化辩论。
7. Adjudication：moderator 裁决争议。
8. ConsensusBuilder：构建结构化 consensus。

实际 `Arena.run(topic, flags)`：

- 校验至少 2 个 participants。
- 选择 mode：review/discussion/planning。
- Phase 0 调 `planArena()`。
- 收集 evidence。
- 选择 tools。
- 并行跑 participant research。
- 将 reports/dossiers 注册进 `ArenaLedger`。
- 根据 mode 进入 planning path 或 review/discussion path。

### 27.2 mode detection / strategy

- `detect-mode.ts` 用关键字和权重推断 `review`、`discussion`、`planning`。
- `strategies/**` 定义不同 mode 的 system prompt、研究方式、consensus 格式。
- planning path 不走重 debate/adjudication，而是 merge-oriented review → roadmap consensus → detail expansion。

### 27.3 Ledger / claims

`ArenaLedger` 是 arena 的事实/claim 状态账本：

- 注册 participant research 的 claims。
- 记录 cross-review。
- 记录 debate/adjudication。
- 给 consensus builder 提供 claim status summary。

`digest-builder.ts` 可从 ledger 构建 round research digest：

- relevant claim ids。
- prior adjudications。
- evidence 摘要。

### 27.4 Participant research

`phases/participant-research.ts`：

- 对每个 participant 创建 LLM client。
- 根据 strategy 构造 research prompt。
- 可携带 selected tools。
- 研究结果包含 report 和 dossier。
- 多 participant 并行，成本和延迟随参与者数量线性/并行增长。

### 27.5 Cross review / debate / adjudication / consensus

- `cross-review.ts`：参与者互审 claims，找争议和证据缺口。
- `debate-rounds.ts`：对 contested claims 做多轮结构化辩论。
- `adjudication.ts`：由 concluder/moderator 对争议 claim 裁决。
- `build-consensus.ts`：综合 ledger、reviews、adjudications 生成最终结论。
- `planning-detail-expansion.ts`：planning mode 下展开 roadmap details。

### 27.6 Builtin Arena tool

`tool-system/builtin/arena.ts` 定义 `Arena` 工具：

- 可从 name/path/model entry 解析 participants。
- 使用 `setArenaLLMConfig()` 风格注入默认 LLM config。
- 运行 Arena 引擎并返回结果。

### 27.7 Arena 风险

1. **成本高**：多个 participants、cross-review、debate、adjudication 都会创建 LLM 调用。
2. **不是普通 TurnLoop**：arena 内部有自己的 tool/research loop，不能假设 ToolExecutor/PermissionClassifier 完全覆盖每个内部动作。
3. **模式识别是 heuristic**：detect-mode 可能选错，需要用户显式 mode 覆盖。
4. **concluder fallback**：如果指定 concluder 不存在，会 fallback 到第一个 participant；这可能改变最终口径。
5. **claim ledger 质量决定最终质量**：如果 participant report 结构差，后续 debate/adjudication 会放大前期错误。

---

## 28. LLM Capability Rules 详细模块文档

`src/llm/capabilities/**` 是 provider/model 兼容性的核心。设计原则写在 `rules.ts`：遇到模型 400，不要在 provider client 里硬 patch，而是添加 capability rule。

### 28.1 Capability 字段

`types.ts` 定义：

- `supportsVision`：是否接受 image content blocks。
- `tokenLimitField`：`max_tokens` 或 `max_completion_tokens`。
- `rejectedParams`：不应发送的 sampling params。
- `reasoning`：reasoning/thinking 参数形状。
- `echoReasoning`：历史 reasoning 是否要回传。
- `parallelToolCalls`：并行工具调用参数形状。
- `streamUsage`：stream usage 获取方式。
- `maxOutputTokens`：已知输出上限，用于 clamp。

默认 capability：

- 非 vision。
- `max_tokens`。
- 无 rejected params。
- no reasoning。
- echo optional。
- OpenAI-style parallel tool call flag。
- stream usage 需要 include_usage flag。

### 28.2 OpenAI rules

规则中显式区分：

- `gpt-5.5+`：
  - supportsVision true。
  - token field `max_completion_tokens`。
  - rejected sampling params：temperature/top_p/presence/frequency。
  - reasoning effort 使用新 shape，disabledEffort 为 `none`。
  - max output cap 128k，避免 stale 384k bleed。
- `o-series + gpt-5..5.4`：
  - `max_completion_tokens`。
  - `reasoning_effort`。
  - reject classic sampling params。

这解释了为什么 OpenAI provider 不能硬编码一个通用 request body。

### 28.3 DeepSeek / Z.AI rules

- DeepSeek V4：使用 `thinking:{type}`，工具场景需要 echo reasoning_content。
- `deepseek-reasoner`：always-on reasoning，发送 prior reasoning_content 会 400，所以 `echoReasoning: "never"`。
- Z.AI GLM 4.5/4.6/5.1：使用类似 DeepSeek V4 的 `thinking:{type}`。

### 28.4 Anthropic rules

- Claude 4.6+：adaptive thinking，不应发送旧 `thinking:{type:"enabled"}`，否则 400。
- Claude 4.x <= 4.5：budget thinking shape。
- Anthropic parallel tool calls 用 disable flag 形状。
- Stream usage 是 auto。

### 28.5 OpenRouter / Gemini / xAI / Mistral / Groq / Ollama

规则文件还包含：

- OpenRouter normalized reasoning：`reasoning:{effort,max_tokens,exclude,enabled}`。
- Gemini OpenAI-compatible thinking 差异。
- xAI reasoning。
- Mistral/Groq rejected params 或 stream/tool-call 差异。
- Ollama/custom fallback。

### 28.6 Capability 风险

1. **规则顺序重要**：`capabilitiesFor()` 第一个匹配规则胜出，例如 gpt-5.5 rule 必须在 broader gpt-5 rule 前。
2. **providerKind 必须正确**：OpenRouter 前缀模型不能误匹配 OpenAI native rule。
3. **streamUsage 当前未完全落地**：OpenAI provider 仍固定发送 include_usage，是前文高优先级风险。
4. **ModelPool 注入 maxTokens 与 provider direct test 存在语义差**：provider test 覆盖未知模型不发送 max_tokens，但 ModelPool path 可能先写默认 maxTokens，需要专项确认。
5. **规则需要随 vendor 文档持续更新**：rules.ts 注释列出审计来源和日期，过期后风险上升。

---

## 29. RunStore / FileHistory / SessionManager 风险源码细化

本节把前文风险对应到更具体源码。

### 29.1 SessionManager 安全边界

`session-manager.ts` 已有 `assertSafeSessionId()`：

- 所有 public entry points 都应先验证 sessionId。
- 注释明确外部调用来源包括 protocol clients、ChatSessionManager、RPC 等。
- `create()` 对 explicitSessionId 调 `assertSafeSessionId()`。
- `exists()` 非法 id 返回 false。
- `resume()` 和 `saveState()` 都验证。

`saveState()` 使用带 pid 和 timestamp 的 tmp 文件：

```text
state.json.<pid>.<Date.now()>.tmp → rename state.json
```

这比 RunStore 固定 `.tmp` 更安全。

剩余风险：

- `create(explicitSessionId)` 校验 id 但不检查目录已存在，直接写 state.json；Engine 入口有 exists 分流，但 public API 直接调用仍可能覆盖。
- `fork()` 先 `create()` 新 session，再复制源 transcript 事件，可能出现双 `session_meta`。

### 29.2 Transcript 风险细化

`transcript.ts`：

- `append()` push 内存后调用 `flush()`。
- `flush()` 用 `appendFileSync()` 写 JSONL。
- catch 中静默失败，注释说明 events still in memory。

影响：

- 当前进程内 run 还能继续，因为内存 events 在。
- 进程退出后磁盘 transcript 缺事件，resume/list/debug 都会丢。
- 用户不会收到错误。

`repairToolResultPairs()`：

- load 时修复 pairing。
- 缺 result 的 tool_use 会补 synthetic result。
- orphan tool_result 从内存过滤。

风险：orphan result 不重写 JSONL，长期文件仍含坏事件，只是每次 load 再过滤。

### 29.3 FileHistory 风险细化

`file-history.ts`：

- `saveSnapshot(filePath)` 使用 `resolve(filePath)` 得绝对路径。
- 不存在文件返回 null。
- hash 相同则跳过重复 snapshot。
- backup 文件名：`Date.now()` + safeName。
- `restore(snapshot)` 检查 `snapshot.backupPath` 存在，然后先保存当前状态，再 copy backup 到 `snapshot.filePath`。
- `index.json` 保存 snapshots。

风险：

1. `backupPath/filePath` 来自 index 或传入 snapshot，restore 信任它们。
2. 没有校验 backupPath 是否位于 historyDir 下。
3. 没有校验 filePath 是否位于 workspace/cwd 下。
4. backup 文件名在同毫秒、同 safeName 下理论可碰撞。
5. Engine 只在 `on_tool_start` 对 `Write`/`Edit` 调 `saveSnapshot()`；`ApplyPatch`、Bash、Config、Memory 等副作用不会被 FileHistory 记录。

### 29.4 RunStore 风险细化

从 `RunManager.ts` 可确认：

- 正常 `submit()` 使用 `nanoid(16)` 生成 runId。
- `RunManager` 自己的 runId 来源安全。
- 风险主要在 `FileRunStore` public API：如果外部绕过 RunManager 传入恶意 id，路径 join 需要校验。

RunManager 状态机还有这些点：

- `resume()` 在 active handle 存在时会把 waiting 状态转 running，然后 resolve approval/input。
- 无 active handle 时转 queued 并重新 enqueue。
- `recover()` 对 running runs 看 heartbeat/process alive/stale，超过 3 次恢复 attempt 标 blocked，否则 requeue。
- `cancel()` abort controller、reject suspended approval/input、cancel queue，然后写 cancelled。

风险：

1. `transition(run, newStatus)` 依赖传入 run object 新鲜；并发 cancel/resume/execute 可能基于 stale snapshot。
2. executeRun catch 里如果 run 已 abort 可能直接 return，依赖 cancel path 已成功持久化状态。
3. FileRunStore JSON tmp 如果固定 `.tmp`，多进程同时写同一 file 有冲突；SessionManager 已用 pid/timestamp，RunStore 应对齐。
4. JSONL append lock 如果只是进程内，多进程 append 同一 events.jsonl 仍可能交错。

### 29.5 Engine finalization 风险源码细化

`engine.ts` 明确顺序：

1. TurnLoop 返回 result。
2. `on_session_end` hook。
3. fire-and-forget memory pipeline。
4. fire-and-forget session title。
5. 设置 session state reason/tokens/cost。
6. `sessionManager.saveState(session.state)`。
7. `on_agent_end`。
8. `options.onStream({ type: "turn_complete" })`。

`turn-loop.ts` 注释说 TurnLoop must never reject，因为 Engine post-run bookkeeping 在 TurnLoop 外。如果 `on_session_end` 或 `on_agent_end` 抛错，就可能阻断后续 saveState 或 completion event。

建议修复方向：

- 用 try/finally 包住 post-TurnLoop finalization。
- `saveState` 应尽量在 `on_session_end` 前或 finally 内保证执行。
- hook errors 应记录但不阻断 terminal state persistence。
- `turn_complete` 去重，maxTurns 只由 Engine 统一发。

---

## 30. 端到端链路核验图与 core 文件覆盖矩阵

本节把“从入口开始每条链路”和“每个模块”用可核验矩阵收束。统计对象为 `packages/core/src/**/*.ts`，排除 `*.test.ts`，共 `290` 个源码文件。

### 30.1 端到端链路核验图

```text
SDK / UI / Worker / Automation
  │
  ├─ 直接 SDK
  │    src/index.ts
  │      └─ new Engine(config).run(task, options)
  │           ├─ parse-task / image-policy / image-compression
  │           ├─ SessionManager.create/resume
  │           │    └─ Transcript.append / toMessages / repairToolResultPairs
  │           ├─ HookRegistry.emit(on_session_start/user_prompt_submit)
  │           ├─ createLLMClient(config.llm)
  │           │    ├─ ModelPool.toLLMConfig when selected from pool
  │           │    ├─ OpenAIClient / AnthropicClient
  │           │    └─ capabilitiesFor(providerKind, model)
  │           ├─ ToolRegistry + MCPManager.connectAll
  │           ├─ PermissionClassifier + approval backend
  │           ├─ ToolExecutor
  │           ├─ ContextManager + PromptComposer
  │           ├─ ModelFacade
  │           └─ TurnLoop.run(messages)
  │                ├─ ContextManager.manageAsync
  │                ├─ ModelFacade.call
  │                │    └─ provider.createMessage(stream/non-stream)
  │                ├─ toolCalls?
  │                │    └─ StreamingToolQueue
  │                │         └─ ToolExecutor.executeSingle
  │                │              ├─ validation
  │                │              ├─ pre_tool_use
  │                │              ├─ InvestigationGuard / TaskGuard
  │                │              ├─ PermissionClassifier.classify
  │                │              ├─ on_permission_check
  │                │              ├─ ToolRegistry.executeTool
  │                │              │    ├─ builtin tool executor
  │                │              │    ├─ custom tool executor
  │                │              │    └─ registered MCP executor
  │                │              └─ post hooks / file_changed
  │                ├─ tool_result → Transcript + next user message
  │                ├─ on_stop may continue
  │                └─ completed/max_turns/model_error...
  │           └─ Engine finalization
  │                ├─ on_session_end
  │                ├─ memory pipeline / dream consolidation
  │                ├─ session title
  │                ├─ SessionManager.saveState
  │                ├─ on_agent_end
  │                └─ turn_complete
  │
  ├─ Protocol path
  │    AgentClient.run
  │      └─ Transport JSON-RPC
  │          └─ AgentServer.handleRun
  │              ├─ multi-session: ChatSessionManager.getOrCreate
  │              │    └─ ChatSession.enqueueTurn → pump → Engine.run
  │              └─ legacy: legacyEngine.run
  │
  ├─ Managed Run path
  │    createRunManager / RunManager.submit
  │      ├─ FileRunStore.create + run_created/run_queued
  │      ├─ RunQueue.enqueue
  │      └─ RunManager.executeRun
  │          ├─ RunLock + Heartbeat
  │          ├─ CheckpointWriter + ArtifactTracker
  │          ├─ EngineRunner.execute
  │          │    ├─ RunApprovalBackend
  │          │    ├─ new Engine
  │          │    ├─ in-process AgentServer/AgentClient
  │          │    └─ client.run → protocol path → Engine.run
  │          └─ completed/failed/blocked/cancelled
  │
  ├─ Automation path
  │    CronCreate tool / startAutomation
  │      └─ CronScheduler.create/loadJobs/timer
  │          └─ automation runner
  │              └─ RunManager or EngineRunner binding
  │
  └─ Arena path
       Arena builtin tool
         └─ Arena.run(topic)
             ├─ planArena
             ├─ collectEvidence
             ├─ runParticipantResearchWithDossiers
             ├─ ArenaLedger / claim registry
             ├─ verification review
             ├─ debate rounds
             ├─ adjudication
             └─ consensus / planning detail expansion
```

### 30.2 文件覆盖矩阵：按源码目录

| 目录 | 非测试 TS 文件数 | 文档覆盖章节 | 覆盖说明 |
|---|---:|---|---|
| root | 9 | 2, 19, 21, 23 | `index.ts/types.ts/state.ts/exceptions.ts/onboarding/updater/migrate-models/colorizer` 等；入口、类型、全局状态、辅助启动逻辑 |
| `agent` | 3 | 24 | Agent definition registry/coordinator；与 Agent builtin 和 sub-agent 生命周期关联 |
| `arena` | 48 | 27, 30 | 多模型协作分析；planner/research/review/debate/adjudication/consensus/ledger/tools/providers/strategies |
| `automation` | 7 | 26, 30 | CronScheduler、CronStore、runner、write policy、cron expr |
| `capability-control` | 5 | 12, 15, 23 | project capability overlay，disabledSkills/Plugins/Agents 生效路径 |
| `cli` | 3 | 7, 30 | stdio/tcp AgentServer worker 与 graceful shutdown |
| `context` | 4 | 10, 23, 30 | ContextManager、compaction、token counter、tool-result storage |
| `cron` | 3 | 26 | runtime/store/scheduler 支撑 cron automation |
| `data` | 3 | 8, 28 | OpenRouter/static catalog/model sync 数据层 |
| `engine` | 16 | 3, 4, 5, 23, 29, 30 | Engine.run、TurnLoop、runtime、image policy、session title、tool queue、cost store |
| `git` | 3 | 18 | worktree、parse-log、git utils |
| `hooks` | 6 | 14, 23 | events、registry、shell-runner、goal-stop-hook、inject、hook-output |
| `llm` | 20 | 8, 28, 30 | provider catalog/kinds、client factory/base、model pool、providers、capabilities、retry/watchdog/token |
| `logging` | 3 | 17 | logger、sanitize-messages、session-recorder |
| `lsp` | 4 | 18, 24 | LSP manager/client/root/servers 与 builtin LSP tool |
| `plugins` | 26 | 14, 15, 23 | plugin installer/marketplace/hooks/commands/schema/varRewrite/agents/mcp |
| `preset` | 1 | 2, 13 | preset behavior 和 builtin tool selection |
| `product` | 3 | 1, 2 | product definition/types，支撑 domain decoupling |
| `prompt` | 5 | 13, 23 | PromptComposer、instruction scanner、section loader/cache |
| `protocol` | 11 | 7, 23, 30 | AgentClient/Server/Transport/ChatSession/Manager/types/factories/redact |
| `remote` | 1 | 16, 24 | remote bridge / RemoteTrigger 相关 |
| `run` | 15 | 6, 23, 29, 30 | RunManager/EngineRunner/RunStore/FileRunStore/approval/queue/lock/heartbeat/checkpoint/evaluator |
| `runtime` | 1 | 18, 24, 25 | safe-spawn，Bash/hook/plugin/git 等外部命令执行基础 |
| `services` | 12 | 16 | memory/orchestrator/dream/oauth/notifier/analytics/diagnostics/browser-open |
| `session` | 4 | 11, 29 | SessionManager、Transcript、FileHistory、Memory |
| `settings` | 2 | 12, 23 | SettingsSchema、SettingsManager、scope merge/provenance |
| `skills` | 3 | 15, 23, 24 | scanner/frontmatter/index，与 Skill tool 和 PromptComposer 关联 |
| `tool-system` | 54 | 9, 14, 24, 25, 30 | registry/executor/permission/MCP/path policy/guards/sandbox/builtin tools |
| `utils` | 15 | 18 | format/theme/toolDisplay/debug/env/lockfile/memoize/semver/ansi/intl/earlyInput 等通用支撑 |

### 30.3 覆盖口径说明

- 覆盖口径是模块级完整覆盖：对每个源码目录给出职责、入口、调用链、使用方式和风险；对主链路文件给出函数/调用点级说明。
- 对主链路上的关键文件（Engine、TurnLoop、ToolExecutor、Permission、RunManager、Protocol、LLM provider、Context、Session）已写到函数/调用点级别。
- 对支撑目录（utils、data、product 等）按职责和被谁使用覆盖。
- 对之前被指出不足的区域（builtin tools、sandbox、automation、arena、capability rules、RunStore/FileHistory/SessionManager 风险）已追加正式章节。

### 30.4 仍不能伪造的部分

用户要求“直接做 1 个小时”。当前会话环境没有可信的连续专注计时证明；本文档只能提供可审计产物和源码锚点，不能伪造 wall-clock 证明。可核验的实际产物是：

- 文档超过 2500 行。
- 覆盖 `packages/core/src` 的 290 个非测试 TS 文件所在目录。
- 包含端到端链路图、源码锚点、风险清单和专项章节。


---

# 来源文件：`docs/core-module-reference.md`

# `packages/core` 模块参考手册

> 本文是 `docs/core-deep-dive.md` 的可读版索引，按模块列出：入口、内部流程、使用方式、bug/风险。范围是 `packages/core/src/**/*.ts` 非测试源码。

## 1. 顶层入口 / root

### 文件

- `src/index.ts`
- `src/types.ts`
- `src/state.ts`
- `src/exceptions.ts`
- `src/onboarding.ts`
- `src/updater.ts`
- `src/migrate-models.ts`
- `src/colorizer.ts`

### 入口

- SDK 用户从 `src/index.ts` 导入 `Engine`、`createClient`、`createServer`、`createRunManager`、tool/LLM/session 类型。
- 核心共享类型在 `types.ts`：`Message`、`ToolCall`、`ToolResult`、`StreamEvent`、`TerminalReason`、`LLMConfig` 等。
- 全局进程态在 `state.ts`，包括 session id、cwd、model override、token/cost 计数、turn timing。

### 内部流程

```text
consumer import
  → src/index.ts barrel export
  → Engine / Protocol / Run / Tool / LLM / Settings APIs
```

`state.ts` 被 Engine、ModelFacade、CostTracker、UI 兼容层间接使用。它不是 per-session object，而是 process-wide mutable state。

### 使用方式

```ts
import { Engine, createClient, createServer, createRunManager } from "@cjhyy/code-shell-core";
```

### bug / 风险

- `VERSION` 常量与 `package.json` 版本可能不一致。
- `state.ts` 是全局状态，多 Engine、多 Run、多 session 嵌入时可能串扰。
- `resetCostState()` 不清 `_modelUsage`，total 与 per-model usage 可能不一致。

## 2. Engine 模块

### 文件

- `engine/engine.ts`
- `engine/turn-loop.ts`
- `engine/model-facade.ts`
- `engine/runtime.ts`
- `engine/image-policy.ts`
- `engine/image-compression.ts`
- `engine/parse-task.ts`
- `engine/patch-orphaned-tools.ts`
- `engine/session-title.ts`
- `engine/streaming-tool-queue.ts`
- `engine/token-budget.ts`
- `engine/reactive-threshold.ts`
- `engine/tool-summary.ts`
- `engine/turn-state.ts`
- `engine/cost-store.ts`
- `engine/query.ts`

### 入口

- `new Engine(config)`
- `engine.run(task, options)`
- `TurnLoop.run(messages)`

### 内部流程

```text
Engine.run(task)
  → parse images / input policy
  → create or resume SessionManager bundle
  → append user message to Transcript
  → emit on_session_start / user_prompt_submit
  → emit session_started
  → create LLM client
  → create PermissionClassifier
  → create ToolExecutor
  → create ContextManager
  → create PromptComposer
  → connect MCP servers
  → build system prompt / tool definitions
  → create ModelFacade
  → register FileHistory hook
  → TurnLoop.run(messages)
  → on_session_end / memory pipeline / title / saveState / on_agent_end / turn_complete
```

`TurnLoop.run()`：

```text
while turns < maxTurns
  → contextManager.manageAsync
  → modelFacade.call
  → if no tool calls: on_stop then completed or continue
  → if tool calls: StreamingToolQueue → ToolExecutor → tool_result → next turn
  → if max output truncation: inject retry/continuation reminder
return max_turns/model_error/completed
```

### 使用方式

```ts
const engine = new Engine({ cwd, llm, permissionMode: "default" });
const result = await engine.run("task", { sessionId, onStream, signal });
```

### bug / 风险

- `Engine.run()` 会包装并 mutate `options.onStream`。
- TurnLoop 注释强调不应 reject，但 Engine 后置 hook/save 在 TurnLoop 外；hook 抛错可能阻断 final save。
- maxTurns 分支 TurnLoop 和 Engine 都可能 emit `turn_complete`。
- FileHistory hook 只覆盖 `Write`/`Edit`。
- fire-and-forget memory/title/tool summary 没有统一生命周期管理。
- 默认 permissionMode 为 `acceptEdits`，SDK 嵌入需显式收紧。

## 3. Protocol 模块

### 文件

- `protocol/types.ts`
- `protocol/client.ts`
- `protocol/server.ts`
- `protocol/transport.ts`
- `protocol/tcp-transport.ts`
- `protocol/chat-session.ts`
- `protocol/chat-session-manager.ts`
- `protocol/helpers.ts`
- `protocol/factories.ts`
- `protocol/redact.ts`
- `protocol/index.ts`

### 入口

- `createInProcessTransport()`
- `new AgentClient({ transport })`
- `new AgentServer({ transport, engine/chatManager })`
- `client.run({ sessionId, task })`

### 内部流程

```text
AgentClient.run
  → JSON-RPC request agent/run
  → Transport send
  → AgentServer.handleRun
      ├─ multi-session: ChatSessionManager.getOrCreate → ChatSession.enqueueTurn → Engine.run
      └─ legacy: legacyEngine.run
  → stream events as agent/streamEvent notifications
  → response RunResult
```

### 使用方式

```ts
const [serverT, clientT] = createInProcessTransport();
const server = new AgentServer({ transport: serverT, engine });
const client = new AgentClient({ transport: clientT });
await client.run({ sessionId: "main", task: "summarize" });
```

### bug / 风险

- Stdio/TCP malformed JSON 静默跳过，client pending request 可能挂住。
- AgentClient request 无 timeout。
- TCP transport 无认证，只应 localhost。
- Server 用 `any` 访问 ChatSessionManager private `sessions`。
- multi-session approval resolver 链路需要复核。

## 4. Run 模块

### 文件

- `run/RunManager.ts`
- `run/EngineRunner.ts`
- `run/FileRunStore.ts`
- `run/RunStore.ts`
- `run/RunQueue.ts`
- `run/RunLock.ts`
- `run/Heartbeat.ts`
- `run/CheckpointWriter.ts`
- `run/ArtifactTracker.ts`
- `run/RunApprovalBackend.ts`
- `run/Evaluator.ts`
- `run/factory.ts`
- `run/types.ts`
- `run/index.ts`
- `run/redirect-target.ts`

### 入口

- `createRunManager(options)`
- `RunManager.submit(input)`
- `RunManager.resume(runId, input)`
- `RunManager.cancel(runId)`

### 内部流程

```text
submit
  → create RunSnapshot queued
  → FileRunStore.create
  → emit run_created/run_queued
  → RunQueue.enqueue
  → executeRun
      → RunLock.acquire
      → Heartbeat.start
      → transition running
      → CheckpointWriter + ArtifactTracker
      → EngineRunner.execute
          → RunApprovalBackend
          → new Engine
          → in-process AgentServer/AgentClient
          → client.run → Engine.run
      → evaluator
      → completed/failed/blocked
      → cleanup
```

### 使用方式

```ts
const manager = createRunManager({ cwd, engine: { llm, headless: true } });
const run = await manager.submit({ objective: "do work", cwd });
```

### bug / 风险

- 所有非 `completed` Engine reason 都转 failed，语义粗。
- `engineConfigOverrides` 可覆盖 automation note。
- FileRunStore public API 如果接外部 id，需校验路径安全。
- JSON tmp/JSONL append 的跨进程一致性要复核。
- transition 依赖 run object 新鲜，并发 resume/cancel/execute 有 stale 风险。

## 5. LLM 模块

### 文件

- `llm/client-factory.ts`
- `llm/client-base.ts`
- `llm/providers/openai.ts`
- `llm/providers/anthropic.ts`
- `llm/model-pool.ts`
- `llm/provider-kinds.ts`
- `llm/provider-catalog.ts`
- `llm/model-fetcher.ts`
- `llm/model-cache.ts`
- `llm/capabilities/*`
- `llm/stream-watchdog.ts`
- `llm/retry.ts`
- `llm/clamp-max-tokens.ts`
- `llm/strip-vision.ts`
- `llm/stop-reason.ts`
- `llm/token-counter.ts`
- `llm/api-key-sanitize.ts`

### 入口

- `createLLMClient(config, defaults)`
- `LLMClientBase.createMessage(options)`
- `ModelPool.toLLMConfig(entry)`
- `capabilitiesFor(providerKind, model)`

### 内部流程

```text
Engine / Arena
  → createLLMClient
  → provider registry
      ├─ AnthropicClient
      └─ OpenAIClient for openai-compatible providers
  → provider.createMessage
      ├─ build request body from capability
      ├─ stream or non-stream SDK call
      ├─ parse text/reasoning/tool_calls
      └─ record usage
```

### 使用方式

```ts
const client = await createLLMClient(llmConfig, defaults);
const resp = await client.createMessage({ systemPrompt, messages, tools, stream: true });
```

### bug / 风险

- OpenAI-compatible streaming 固定 `stream_options.include_usage`，未尊重 `Capability.streamUsage`。
- ModelPool 默认 maxTokens 8192 可能让未知模型被截断。
- providerKind 错误会导致 wrong capability rule。
- CostTracker/state 双 usage 来源可能不一致。
- capability rules 需要持续跟 vendor 文档更新。

## 6. Tool System 模块

### 文件

- `tool-system/registry.ts`
- `tool-system/executor.ts`
- `tool-system/permission.ts`
- `tool-system/mcp-manager.ts`
- `tool-system/context.ts`
- `tool-system/path-policy.ts`
- `tool-system/validation.ts`
- `tool-system/plan-mode-allowlist.ts`
- `tool-system/investigation-guard.ts`
- `tool-system/task-guard.ts`
- `tool-system/sandbox/*`
- `tool-system/builtin/*`

### 入口

- `ToolRegistry.registerTool / executeTool`
- `ToolExecutor.executeSingle`
- `PermissionClassifier.classify`
- `MCPManager.connectAll / callTool`

### 内部流程

```text
ToolCall
  → ToolExecutor.executeSingle
  → plan allowlist
  → schema validation
  → pre_tool_use
  → InvestigationGuard
  → PermissionClassifier
  → on_permission_check
  → approval if ask
  → on_tool_start
  → ToolRegistry.executeTool
  → on_tool_end/post_tool_use/file_changed
  → ToolResult
```

### 使用方式

通常由 TurnLoop 间接使用；自定义工具可注册到 ToolRegistry。

### bug / 风险

- pre/on_permission hooks 不能提权，这是安全设计。
- MCP direct `callTool()` 和 registered MCP executor 图片处理不一致。
- MCP tool name 未 sanitize。
- InvestigationGuard read-only/mutating 工具集合不完整。
- acceptEdits 默认允许写类工具，需要 SDK 嵌入方知情。

## 7. Builtin Tools 模块

### 文件分组

- 文件/搜索/编辑：`read.ts`、`grep.ts`、`glob.ts`、`write.ts`、`edit.ts`、`notebook-edit.ts`、`worktree.ts`
- 执行环境：`bash.ts`、`powershell.ts`、`repl.ts`、`sleep.ts`
- Web/外部：`web-fetch.ts`、`web-search.ts`、`remote-trigger.ts`、`send-message.ts`、`generate-image.ts`
- Agent/Arena/Task：`agent.ts`、`agent-registry.ts`、`agent-notifications.ts`、`arena.ts`、`task.ts`
- MCP/LSP/Skill/Memory/Config/Cron：`mcp-tools.ts`、`lsp.ts`、`skill.ts`、`memory.ts`、`config.ts`、`cron.ts`

### 入口

- `builtin/index.ts` 的 `BUILTIN_TOOLS`
- ToolRegistry 构造时注册

### 使用方式

模型通过 provider tool call 调用。每个工具声明 schema、description、permissionDefault、isReadOnly/isConcurrencySafe。

### bug / 风险

- `CronCreate` 是持久副作用，automation run 内不应嵌套创建 automation。
- `GenerateImage` 写文件但 guard 未必视为 mutating。
- background Agent registry process-local，进程崩溃丢状态。
- FileHistory 不覆盖所有写工具。

## 8. Context 模块

### 文件

- `context/manager.ts`
- `context/compaction.ts`
- `context/tool-result-storage.ts`
- `context/token-counter.ts`

### 入口

- `ContextManager.manageAsync(messages)`
- `applyToolResultPersistence`
- `microcompact`
- `applySummaryCompaction`

### 内部流程

```text
messages
  → persist large tool results
  → truncate oversized result
  → aggregate tool result budget
  → microcompact old compactable tool results
  → summary compaction if over threshold
  → snip/window/emergency fallback
```

### 使用方式

TurnLoop 每轮模型调用前调用 `manageAsync`。

### bug / 风险

- tool-result persistence 写失败后冻结 seen，不再重试。
- `tool_use_id` 用作文件名，需保证安全。
- summary compaction 质量取决于 aux/summarizer prompt。

## 9. Session 模块

### 文件

- `session/session-manager.ts`
- `session/transcript.ts`
- `session/file-history.ts`
- `session/memory.ts`

### 入口

- `SessionManager.create/resume/saveState/fork/list`
- `Transcript.append/toMessages/repairToolResultPairs`
- `FileHistory.saveSnapshot/restore`

### 内部流程

```text
Engine.run
  → SessionManager.create/resume
  → Transcript.appendMessage(user)
  → TurnLoop appends assistant/tool_use/tool_result
  → Transcript.toMessages on resume
  → saveState terminal reason
```

### 使用方式

通常由 Engine 内部使用；Protocol query 可读 session detail。

### bug / 风险

- Transcript flush failure 被吞。
- FileHistory restore 信任 backupPath/filePath。
- FileHistory 只覆盖 Write/Edit。
- create(explicitSessionId) 不检查已有目录。

## 10. Settings / Prompt / Hooks / Plugins / Skills

### 文件

- `settings/schema.ts`、`settings/manager.ts`
- `prompt/composer.ts`、`instruction-scanner.ts`、`section-loader.ts`、`section-cache.ts`
- `hooks/events.ts`、`registry.ts`、`shell-runner.ts`、`goal-stop-hook.ts`
- `plugins/loadPluginHooks.ts`、`pluginCommandHook.ts`、`pluginInstaller.ts`、`marketplaceManager.ts`、`varRewrite.ts`
- `skills/scanner.ts`、`frontmatter.ts`

### 入口

- `SettingsManager.load/getForScope/saveUserSetting/saveProjectSetting`
- `PromptComposer.buildSystemPrompt/buildUserContextMessage`
- `HookRegistry.emit/register`
- `loadPluginHooks`
- `scanSkills`

### 内部流程

```text
SettingsManager.load
  → managed/user/project/local/flags merge
  → Engine reads disabled lists/capabilityOverrides
  → PromptComposer builds system prompt + user context
  → HookRegistry receives plugin/settings/config hooks
  → Skill listing enters prompt
  → Skill tool reads full SKILL.md on demand
```

### bug / 风险

- SettingsManager 默认 project scope，入口忘传 full 会丢 user settings。
- HookRegistry updatedPrompt last-write-wins 可能让低 priority 覆盖高 priority。
- Plugin Stop → on_session_end 可能太晚；PreCompact mapped to reserved event。
- plugin PreToolUse 不能 deny，只能输出 messages。
- skills scanner cache 不看 plugin SKILL.md mtime。

## 11. Automation 模块

### 文件

- `automation/scheduler.ts`
- `automation/store.ts`
- `automation/runner.ts`
- `automation/cron-expr.ts`
- `automation/write-policy.ts`
- `automation/write-run.ts`
- `automation/index.ts`

### 入口

- `startAutomation`
- `CronScheduler.create/list/delete/loadJobs`
- `CronStore.load/save`

### 内部流程

```text
CronCreate tool
  → CronScheduler.create
  → CronStore persists job
  → timer fires
  → runner builds CronRunRequest
  → RunManager/EngineRunner executes prompt
```

### bug / 风险

- recurring prompt 必须防止 automation 内创建 automation。
- calendar schedule 需要 timezone。
- permissionLevel 应最小化。
- cross-process reload/store 一致性要小心。

## 12. Arena 模块

### 文件

- `arena/arena.ts`
- `arena/planner.ts`
- `arena/ledger.ts`
- `arena/detect-mode.ts`
- `arena/phases/*`
- `arena/strategies/*`
- `arena/tools/*`
- `arena/providers/*`

### 入口

- `new Arena(config).run(topic)`
- builtin `Arena` tool

### 内部流程

```text
Arena.run
  → planArena
  → collectEvidence
  → selectTools
  → runParticipantResearchWithDossiers
  → register claims in ArenaLedger
  → verification review
  → planning path OR debate/adjudication path
  → buildConsensus
  → optional detail expansion
```

### bug / 风险

- 多模型多阶段，成本高。
- mode detection 是 heuristic。
- concluder 不存在会 fallback。
- claim ledger 质量决定后续结论质量。

## 13. Git / LSP / Runtime / Services / Logging / Utils

### Git

- `git/worktree.ts`、`git/utils.ts`、`git/parse-log.ts`
- 用于 worktree、日志解析、git 辅助操作。
- 风险：session file-change 设计不应依赖全局 git diff。

### LSP

- `lsp/manager.ts`、`client.ts`、`servers.ts`、`root-path.ts`
- builtin LSP tool 用于 definition/references/hover/symbols。
- 风险：server 启动、root path、语言支持不稳定时要优雅降级。

### Runtime

- `runtime/safe-spawn.ts`
- 统一外部命令执行结果：ok/timeout/aborted/spawn_failed。
- 风险：所有 shell/plugin/git 调用都应走统一 spawn 语义。

### Services

- memory/orchestrator/dream/oauth/notifier/analytics/diagnostics/browser-open。
- Engine finalization fire-and-forget memory pipeline。
- 风险：后台任务丢失、错误只记录。

### Logging

- `logging/logger.ts`
- `logging/sanitize-messages.ts`
- `logging/session-recorder.ts`
- 风险：redaction 过少泄密，过多影响调试。

### Utils

- theme/format/toolDisplay/debug/env/lockfile/memoize/semver/sliceAnsi/intl/earlyInput 等。
- 风险：跨层复用，改动影响 CLI/UI/core 多处。

## 14. 总风险清单压缩版

1. VERSION 与 package.json 不一致。
2. Engine finalization hook 可阻断 saveState。
3. maxTurns 可能重复 turn_complete。
4. multi-session approval resolver 链路需复核。
5. FileRunStore id path safety。
6. OpenAI streamUsage capability 未完全生效。
7. Plugin Stop/PreCompact 映射语义问题。
8. Plugin PreToolUse 不能 deny。
9. Engine.run mutate options。
10. RunManager reason 分类粗。
11. EngineRunner overrides 可覆盖 automation note。
12. Stdio/TCP malformed JSON 静默跳过。
13. AgentClient request 无 timeout。
14. Transcript flush failure 被吞。
15. FileHistory 覆盖工具不全。
16. MCP tool name 未 sanitize。
17. MCP direct image handling 不一致。
18. HookRegistry priority/last-write-wins 反直觉。
19. SettingsManager 默认 project scope。
20. state.ts 全局状态多 session 串扰。


