# 新观察证据级验证

本文只做源码阅读和 grep 复核，不改 `packages/**` 源码，不跑构建/测试。范围以 `docs/archive/review-2026-07-09/06-turn-loop-state-machine.md` 的 N-01 / N-02 / N-03 为主，必要时回读 01/02/03 里对 core/desktop stream 链路和历史 finding 的描述。

结论摘要：

| 编号 | 结论 | 严重度 | 一句话 |
|---|---|---|---|
| N-01 | 确证 | 非问题 | `TurnState.phase` 当前只初始化，不参与 runtime 状态推进。 |
| N-02 | 确证 | P2 | `StreamingToolQueue` 当前在完整 `LLMResponse` 后 enqueue，不在流式 chunk 到达时 enqueue。 |
| N-03 | 确证 | P1 | 普通 `Engine.run()` 的 `max_turns` live path 会向同一个 `onStream` 双发 `turn_complete(max_turns)`。 |

## N-01：`TurnPhase` / `TurnState` 是否只是概念遗留

### 1. 命题

当前 core runtime 中，`TurnState.phase` 只在 `TurnLoop.run()` 每个 loop iteration 初始化为 `"pre_check"`，之后没有任何 `state.phase` 读写或显式 phase 推进；实际状态机由代码分支、`continue`、`return` 和事件发射形成，而不是由 `TurnState` 驱动。

### 2. 验证方法

读完整调用链：

- `packages/core/src/types.ts` 的 `TurnPhase` / `TerminalReason` 定义。
- `packages/core/src/engine/turn-state.ts` 的 `TurnState` 与 `initialTurnState()`。
- `packages/core/src/engine/turn-loop.ts` 的 import、`run()` loop、所有 early return/continue、maxTurns 收口。

实际 grep：

```bash
rg -n "\bTurnState\b|\binitialTurnState\b|\bTurnPhase\b|state\.phase|phase\s*=|phase:\s*\"(?:pre_check|model_call|post_check|tool_exec|context_mgmt|hook_notify|complete|error)\"" packages/core/src --glob '!**/*.test.ts'
```

关键命中：

- `packages/core/src/types.ts:381`：`TurnPhase` 定义。
- `packages/core/src/engine/turn-state.ts:7`：`TurnState` 定义。
- `packages/core/src/engine/turn-state.ts:17`：`initialTurnState()`。
- `packages/core/src/engine/turn-loop.ts:18`、`packages/core/src/engine/turn-loop.ts:20`：`TurnState` / `initialTurnState` import。
- `packages/core/src/engine/turn-loop.ts:588`：唯一 runtime 初始化点。
- `packages/core/src/index.ts:29`：`TurnPhase` 对外导出。

没有命中 `state.phase` 读写，也没有命中把 phase 赋成 `"model_call"` / `"tool_exec"` / `"complete"` 等其它值的位置。

### 3. 证据

- `packages/core/src/types.ts:381` 到 `packages/core/src/types.ts:389` 定义 `TurnPhase = "pre_check" | "model_call" | "post_check" | "tool_exec" | "context_mgmt" | "hook_notify" | "complete" | "error"`。这是类型层面的 phase 集合。
- `packages/core/src/engine/turn-state.ts:7` 到 `packages/core/src/engine/turn-state.ts:15` 定义 `TurnState`，其中 `phase: TurnPhase` 是必填字段，`modelResponse`、`toolCalls`、`finalText`、`error`、`terminalReason` 都是可选字段。
- `packages/core/src/engine/turn-state.ts:17` 到 `packages/core/src/engine/turn-state.ts:22` 的 `initialTurnState(turnNumber)` 只返回 `{ phase: "pre_check", turnNumber }`。
- `packages/core/src/engine/turn-loop.ts:556` 进入 `while (this.turnCount < this.config.maxTurns)` 后递增 `turnCount`，`packages/core/src/engine/turn-loop.ts:588` 执行 `const state = initialTurnState(this.turnCount);`。之后 `turn-loop.ts` 中没有任何 `state` 或 `state.phase` 的后续命中。
- `packages/core/src/engine/turn-loop.ts:605` 直接发 `stream_request_start`，`packages/core/src/engine/turn-loop.ts:651` 调 `contextManager.manageAsync()`，`packages/core/src/engine/turn-loop.ts:695` 调 `callModelWithFallback()`，`packages/core/src/engine/turn-loop.ts:877` 按 `response.toolCalls.length === 0` 分支，`packages/core/src/engine/turn-loop.ts:1017` 才执行工具队列，`packages/core/src/engine/turn-loop.ts:977` / `packages/core/src/engine/turn-loop.ts:1224` / `packages/core/src/engine/turn-loop.ts:1269` 通过 return 给出 terminal reason。状态推进全靠这些代码路径，不靠 `state.phase`。

### 4. 结论

确证。

精确说法是：`TurnPhase` 仍是公开导出的类型，`TurnState` 仍被 `TurnLoop` 导入并初始化，但当前 runtime 没有推进、读取或观测显式 phase。06 文档里“概念遗留，`state` 初始化后不推进”的观察成立。

### 5. 影响、建议方向、TDD 测试点

影响：

- 没有直接用户可见现象。它不会导致 turn-fold、双卡片或 stream 错序。
- 风险主要是维护可读性：文件头注释写着 `pre_check -> model_call -> ...`，但实际 runtime 没有这种显式状态对象。后续维护者若以为 `TurnState.phase` 是事实源，可能漏看真正的 early return / continue 边界。

建议方向：

- 二选一即可：要么删除 `TurnState` / `initialTurnState()` 这条未使用运行态，保留文档化的“实现态状态机”；要么真正把 phase 推进下沉到 runtime，并让日志或事件可观测。
- 如果保留概念类型，建议在 `turn-state.ts` 或 `turn-loop.ts` 注释里明确“目前不作为 runtime driver”。

TDD 测试点：

- 场景：维护型护栏，不建议当作业务行为测试。若未来决定实现显式 phase，可新增 `packages/core/src/engine/turn-loop-phase.test.ts`，跑一个“文本回答”和一个“工具调用” fake loop，断言 `onStream` 或 logger 中出现按序 phase：`pre_check -> context_mgmt -> model_call -> post_check -> tool_exec -> complete`。
- 断言：当前没有这样的可观测面，因此该测试在现状下不应添加；一旦要让 `TurnState` 成为真实 runtime 状态，必须先加可观测 phase，再用测试锁顺序。
- 建议测试文件：`packages/core/src/engine/turn-loop-phase.test.ts`。

### 6. 严重度

非问题。它是维护债/命名误导，不是当前用户可见 bug。

## N-02：`StreamingToolQueue` 是否真的在 streaming chunk 到达时 enqueue

### 1. 命题

当前 `StreamingToolQueue` 的工具 enqueue 不发生在 provider streaming chunk 到达阶段；即使 `tool_use_start` / `tool_use_args_delta` 已经流到 UI，实际 `streamingQueue.enqueue(tc)` 也要等 `callModelWithFallback()` 返回完整 `LLMResponse` 后才执行。

### 2. 验证方法

读完整调用链：

- Provider streaming chunk：`packages/core/src/llm/providers/openai.ts`、`packages/core/src/llm/providers/anthropic.ts`。
- Provider chunk 到 core stream event：`packages/core/src/engine/model-facade.ts`。
- TurnLoop 包装 stream callback、记录 streamed tool id、后处理 response、执行工具：`packages/core/src/engine/turn-loop.ts`。
- Queue 自身执行语义：`packages/core/src/engine/streaming-tool-queue.ts`。

实际 grep：

```bash
rg -n "new StreamingToolQueue|StreamingToolQueue|\.enqueue\(|toolQueue\.enqueue|streamingQueue\.enqueue|drain\(\)|tool_use_start|tool_use_delta|chunk\.type|for await|callModelWithFallback|model\.call\(" packages/core/src/engine packages/core/src/llm packages/core/src/tool-system --glob '!**/*.test.ts'
```

关键命中：

- `packages/core/src/engine/turn-loop.ts:692`：创建 `StreamingToolQueue`。
- `packages/core/src/engine/turn-loop.ts:695`：先 `await this.callModelWithFallback(messages)`。
- `packages/core/src/engine/turn-loop.ts:1005` 到 `packages/core/src/engine/turn-loop.ts:1008`：只补发未流式出现过的 `tool_use_start`。
- `packages/core/src/engine/turn-loop.ts:1016` 到 `packages/core/src/engine/turn-loop.ts:1019`：完整 response 后 enqueue/drain。
- `packages/core/src/engine/model-facade.ts:78` 到 `packages/core/src/engine/model-facade.ts:100`：chunk 只被转成 stream event。
- `packages/core/src/llm/providers/openai.ts:596` 到 `packages/core/src/llm/providers/openai.ts:631`、`packages/core/src/llm/providers/anthropic.ts:291` 到 `packages/core/src/llm/providers/anthropic.ts:315`：provider 只发 tool chunk。

### 3. 证据

- `packages/core/src/engine/streaming-tool-queue.ts:1` 到 `packages/core/src/engine/streaming-tool-queue.ts:11` 的注释声称“During streaming, as tool_use blocks arrive: queue.enqueue(toolCall)”。这是设计意图或旧语义。
- `packages/core/src/engine/turn-loop.ts:690` 到 `packages/core/src/engine/turn-loop.ts:692` 在模型请求前清空 streamed ids，并创建 `const streamingQueue = new StreamingToolQueue(this.deps.toolExecutor);`。
- `packages/core/src/engine/turn-loop.ts:693` 到 `packages/core/src/engine/turn-loop.ts:695` 随后 `response = await this.callModelWithFallback(messages);`。这意味着在完整 `LLMResponse` resolve 之前，当前作用域不会执行后面的 enqueue loop。
- `packages/core/src/engine/turn-loop.ts:1280` 到 `packages/core/src/engine/turn-loop.ts:1304` 的 `wrappedStream` 在流式期间只做两件事：看到 `tool_use_start` 就把 id 放进 `this.streamedToolIds`，看到 `text_delta` 就估算 reactive compaction token，然后 `return this.config.onStream!(event)` 转发。这里没有 queue，也没有 `ToolExecutor`。
- `packages/core/src/engine/model-facade.ts:73` 到 `packages/core/src/engine/model-facade.ts:102` 调 provider `createMessage({ stream:true, onChunk })`。`onChunk` 只把 `text` 变成 `text_delta`、把 `tool_use_start` 变成 `tool_use_start` stream event、把 `tool_use_delta` 变成 `tool_use_args_delta` stream event。
- `packages/core/src/llm/providers/openai.ts:607` 到 `packages/core/src/llm/providers/openai.ts:610` 发 `type: "tool_use_start"`；`packages/core/src/llm/providers/openai.ts:624` 到 `packages/core/src/llm/providers/openai.ts:627` 发 `type: "tool_use_delta"`。Anthropic 同类路径在 `packages/core/src/llm/providers/anthropic.ts:296` 到 `packages/core/src/llm/providers/anthropic.ts:299`、`packages/core/src/llm/providers/anthropic.ts:306` 到 `packages/core/src/llm/providers/anthropic.ts:313`。
- `packages/core/src/engine/turn-loop.ts:998` 到 `packages/core/src/engine/turn-loop.ts:1008` 在完整 response 后遍历 `toolCalls`，构造 assistant `tool_use` blocks，并且只给没流式出现过的 id 补发 `tool_use_start`。
- `packages/core/src/engine/turn-loop.ts:1014` 到 `packages/core/src/engine/turn-loop.ts:1019` 才真正执行：

```ts
for (const tc of toolCalls) {
  streamingQueue.enqueue(tc);
}
const results = await streamingQueue.drain();
```

- `packages/core/src/engine/streaming-tool-queue.ts:37` 到 `packages/core/src/engine/streaming-tool-queue.ts:43` 说明 concurrency-safe 工具在 `enqueue()` 内立刻 `executeSingle()`；但因为 `enqueue()` 本身已经晚到完整 response 后，所以“立即开始”也只是 response 后立即开始。
- `packages/core/src/engine/streaming-tool-queue.ts:68` 到 `packages/core/src/engine/streaming-tool-queue.ts:80` 说明 unsafe 工具在 `drain()` 中串行执行。

### 4. 结论

确证。

原观察准确：当前 UI 层能在 streaming 阶段收到 `tool_use_start` / args delta，但工具执行队列不是 streaming chunk 驱动，而是完整模型响应后的 batch 执行。`StreamingToolQueue` 的名字和注释比实现更“流式”。

### 5. 影响、建议方向、TDD 测试点

影响：

- 用户可见表现是：工具卡可以在模型还在吐 token / args 时出现，但真实工具结果不会和剩余模型输出重叠执行，必须等完整 `LLMResponse` 返回后才开始。
- 主要损失是延迟和维护误判：concurrency-safe 工具无法提前跑；开发者可能误以为已经实现了 “边流式边执行”。
- 与 turn-fold / 双卡片类历史问题不是同一类。现有 `streamedToolIds` 去重反而在避免重复 `tool_use_start` 卡片，见 `packages/core/src/engine/turn-loop.ts:1005` 到 `packages/core/src/engine/turn-loop.ts:1008`。

建议方向：

- 若暂不做真流式执行，先改名或改注释：例如把注释从 “During streaming” 改成 “after full response, preserve order and safe concurrency”。
- 若要实现真流式执行，必须等工具 id、name、完整 args 都可确认后再 enqueue，并处理 provider partial JSON、permission prompt、abort、tool_use_start 重复 UI 事件和 transcript 顺序。当前 provider 只有 partial args delta，不保证每个工具在 stream 中已经完整可执行。

TDD 测试点：

- 场景：fake `ModelFacade.call()` 先同步发 `tool_use_start` stream event，再等待一个 promise 才返回 `LLMResponse{ toolCalls:[...] }`；fake `ToolExecutor.executeSingle()` 记录被调用时间。
- 当前行为断言：在 promise resolve 前，`executeSingle()` 调用次数为 0；resolve 后且 `loop.run()` 进入工具阶段，才调用 `executeSingle()` 并发 `tool_result`。
- 若后续修成真 streaming enqueue，就把断言反过来：完整 args chunk 到达后、`LLMResponse` resolve 前，concurrency-safe 工具已经开始执行。
- 建议测试文件：新增 `packages/core/src/engine/turn-loop.streaming-tool-queue.test.ts`，不要只测 `StreamingToolQueue` 单元，因为关键行为在 TurnLoop 调用时机。

### 6. 严重度

P2。它是性能/命名契约问题，不是当前正确性破坏；但足以误导后续优化和 bugfix。

## N-03：`max_turns` 是否会双发 `turn_complete`

### 1. 命题

普通 top-level `Engine.run()` 中，如果 `TurnLoop.run()` 以 `reason: "max_turns"` 收口，并且传入了同一个 `options.onStream`，则该 callback 会收到两个 live `turn_complete` 事件：

1. `TurnLoop` 的 maxTurns summary 分支内部先发 `{ type: "turn_complete", reason: "max_turns" }`。
2. `Engine` epilogue 在保存 state、跑 end hook 后统一再发 `{ type: "turn_complete", reason: result.reason }`，此时 `result.reason` 仍是 `"max_turns"`。

### 2. 验证方法

读完整调用链：

- Engine 构造 TurnLoop 时如何传入 `onStream`。
- `TurnLoop.run()` 的 while 条件、maxTurns summary 分支和返回值。
- `Engine.run()` 在 `turnLoop.run()` 返回后的 finally、state 保存、hook 和最终 emit。
- 子代理 stream wrapper 是否只是转发加 `agentId`。
- 所有 `turn_complete` 或等价事件 producer/replay adapter。

实际 grep：

```bash
rg -n "type:\s*\"turn_complete\"|\{\s*type:\s*\"turn_complete\"|turn_complete\"|turn_end\"|turn_boundary|appendTurnBoundary|messageMappers|roomMsgToEvent" packages/core/src packages/desktop/src packages/tui/src --glob '!**/*.test.ts' --glob '!**/*.test.tsx'
```

live runtime 关键命中：

- `packages/core/src/types.ts:462`：`StreamEvent` 定义 `turn_complete`。
- `packages/core/src/engine/turn-loop.ts:1268`：TurnLoop maxTurns 分支 emit。
- `packages/core/src/engine/engine.ts:2363`：Engine epilogue emit。
- `packages/core/src/engine/engine.ts:1246`：子代理 stream event spread `agentId` 后转发，不是新的源头。

等价 producer / replay adapter 命中：

- `packages/core/src/session/transcript.ts:112` 到 `packages/core/src/session/transcript.ts:114`：`appendTurnBoundary()` 写 `turn_boundary` transcript event。
- `packages/core/src/engine/turn-loop.ts:1195`：工具后继续路径写 `turn_boundary`。
- `packages/desktop/src/main/transcript-reader.ts:214` 到 `packages/desktop/src/main/transcript-reader.ts:215`：replay 时把 `turn_boundary` 映射成 `turn_complete(completed)`。
- `packages/desktop/src/main/transcript-reader.ts:250` 到 `packages/desktop/src/main/transcript-reader.ts:251`：EOF 有 trailing content 时补一个 closing `turn_complete(completed)`。
- `packages/desktop/src/main/mobile-remote/resident-agent.ts:12` 到 `packages/desktop/src/main/mobile-remote/resident-agent.ts:24`：mobile resident normalized event 包含 `turn_end`。
- `packages/desktop/src/main/mobile-remote/resident-agent.ts:135` 到 `packages/desktop/src/main/mobile-remote/resident-agent.ts:137`：Claude stream-json `result` 转成 `turn_end`。
- `packages/desktop/src/main/mobile-remote/codex-parse.ts:37`：Codex JSON `turn.completed` 转成 `turn_end(completed)`。
- `packages/desktop/src/main/mobile-remote/codex-room-agent.ts:66` 到 `packages/desktop/src/main/mobile-remote/codex-room-agent.ts:80`：进程退出兜底可合成 `turn_end`。
- `packages/desktop/src/main/mobile-remote/room-manager.ts:438` 到 `packages/desktop/src/main/mobile-remote/room-manager.ts:439`：room 持久化 `turn_end`。
- `packages/desktop/src/renderer/lib/messageMappers.ts:58`：room `turn_end` 映射成 `turn_complete`。
- `packages/desktop/src/renderer/lib/messageMappers.ts:117`：CC history replay 为 assistant message 补 `turn_complete(completed)`。
- `packages/core/src/tool-system/builtin/agent-transcript-translator.ts:169` 到 `packages/core/src/tool-system/builtin/agent-transcript-translator.ts:170`：后台 agent transcript translator 消费 `turn_complete` / `tombstone` 作为封口信号，不是 producer。

本地 renderer 终态 marker 命中：

- `packages/desktop/src/renderer/App.tsx:2182`：Engine early-return 失败且没有 stream terminal 时，本地 dispatch `turn_end(error)`。
- `packages/desktop/src/renderer/App.tsx:2469`：用户 Stop 时，本地 dispatch `turn_end(stopped)`。
- `packages/desktop/src/renderer/transcriptsReducer.ts:45` 到 `packages/desktop/src/renderer/transcriptsReducer.ts:49`：定义本地 `turn_end` action。
- `packages/desktop/src/renderer/transcriptsReducer.ts:122` 到 `packages/desktop/src/renderer/transcriptsReducer.ts:123`：本地 `turn_end` action 调 `appendTurnEndMessage()`。
- `packages/desktop/src/renderer/types.ts:1196` 到 `packages/desktop/src/renderer/types.ts:1215`：把本地 `turn_end` action 变成 UI message marker。它不走 `StreamEvent.turn_complete`，不是 N-03 的 live 双发来源。

测试缺口 grep：

```bash
rg -n "turn_complete|max_turns|turn_complete.*max_turns|maxTurns" packages/core/src/engine packages/desktop/src/renderer --glob '*test.ts' --glob '*test.tsx'
```

关键命中显示：`packages/core/src/engine/turn-loop-max-turns.test.ts:11` 注释说要 pin `turn_complete`，但同文件实际测试没有传 `onStream`；`packages/core/src/engine/turn-loop-steer-backfill.test.ts:273` 到 `packages/core/src/engine/turn-loop-steer-backfill.test.ts:288` 虽收集 events，却只断言 `steer_injected`，不断言 `turn_complete` 数量。

### 3. 证据

#### 3.1 Engine 把同一个 stream callback 交给 TurnLoop

- `packages/core/src/engine/engine.ts:2130` 到 `packages/core/src/engine/engine.ts:2141` 构造 TurnLoop config，其中 `maxTurns: resolveMaxTurns(...)`，`onStream: options?.onStream`，`signal: options?.signal`。
- `packages/core/src/engine/turn-loop.ts:340` 到 `packages/core/src/engine/turn-loop.ts:346` 会包装 `config.onStream`，但这个 wrapper 只 try/catch 调用 `inner(event)`，没有事件去重或 terminal guard。

#### 3.2 TurnLoop 的 maxTurns 分支会内部发 `turn_complete`

- `packages/core/src/engine/turn-loop.ts:556` 是主 while 条件：`while (this.turnCount < this.config.maxTurns)`。当 `turnCount >= maxTurns` 时跳出 while。
- `packages/core/src/engine/turn-loop.ts:1227` 到 `packages/core/src/engine/turn-loop.ts:1242` 进入 maxTurns 收口：记录日志、消费 finalize steer、manage context、追加 “Turn limit reached” summary reminder。
- `packages/core/src/engine/turn-loop.ts:1244` 到 `packages/core/src/engine/turn-loop.ts:1251` 调一次 no-tools summary model call。
- `packages/core/src/engine/turn-loop.ts:1261` 到 `packages/core/src/engine/turn-loop.ts:1266` 若有 finalText，先发 `assistant_message` 并把 assistant message push 到 messages。
- `packages/core/src/engine/turn-loop.ts:1268` 发 `this.config.onStream?.({ type: "turn_complete", reason: "max_turns" });`。
- `packages/core/src/engine/turn-loop.ts:1269` 返回 `{ text: finalText, reason: "max_turns", messages }`。

#### 3.3 Engine epilogue 无条件再发一次 terminal event

- `packages/core/src/engine/engine.ts:2199` 等待 `result = await turnLoop.run(messages)`。
- `packages/core/src/engine/engine.ts:2261` 到 `packages/core/src/engine/engine.ts:2271` 的 finally 只 unregister hook / 清 active loop/session / 文件历史 hook，不处理 `turn_complete` 去重。
- `packages/core/src/engine/engine.ts:2294` 到 `packages/core/src/engine/engine.ts:2298` 跑 `on_session_end`。
- `packages/core/src/engine/engine.ts:2345` 到 `packages/core/src/engine/engine.ts:2353` 把 `session.state.turnCount`、`session.state.status = result.reason`、usage、cost state 写回并 `saveState`。
- `packages/core/src/engine/engine.ts:2355` 到 `packages/core/src/engine/engine.ts:2360` 跑 `on_agent_end`。
- `packages/core/src/engine/engine.ts:2362` 到 `packages/core/src/engine/engine.ts:2363` 无条件执行 `options?.onStream?.({ type: "turn_complete", reason: result.reason });`。若上一步 TurnLoop 返回 `max_turns`，这里就是第二个 `turn_complete(max_turns)`。

#### 3.4 没有去重/守卫

- `packages/core/src/engine/engine.ts:2363` 没检查 “TurnLoop 是否已经发过 terminal event”。
- `packages/core/src/engine/turn-loop.ts:1268` 也没有只在 standalone `query()` 或非 Engine 场景 emit 的条件。
- `packages/core/src/engine/query.ts:126` 到 `packages/core/src/engine/query.ts:170` 直接使用 `TurnLoop.run()` 并把 queue 里的 stream events yield 出去，但 query 本身不补发 terminal event。也就是说 TurnLoop 只有 maxTurns 自己发 terminal，其他 terminal reason 在 query 入口并没有统一 terminal event。这反过来说明 `turn-loop.ts:1268` 是特例，而不是统一设计。

#### 3.5 当前 consumer 对重复终态有部分缓解，但不是 producer 级去重

- 主 desktop `App.tsx` 在 `packages/desktop/src/renderer/App.tsx:1583` 到 `packages/desktop/src/renderer/App.tsx:1584` 对每个非 sub-agent `turn_complete` / `error` 清 busy。重复 `turn_complete(max_turns)` 会重复清 busy。
- 主 desktop reducer 在 `packages/desktop/src/renderer/types.ts:932` 进入 `case "turn_complete"`。`packages/desktop/src/renderer/types.ts:982` 到 `packages/desktop/src/renderer/types.ts:1003` 会先清理同一真实 user turn 后的旧 `files_changed`，再重新计算 summary，所以重复 terminal 不一定留下两个 files_changed 卡。
- `packages/desktop/src/renderer/types.ts:1020` 到 `packages/desktop/src/renderer/types.ts:1033` 只有 `event.reason === "completed"` 才 `turnEpoch + 1`。因此重复 `max_turns` 不会触发 clean completed 的折叠 epoch 双增，但仍会重复走封口和 files_changed 重算。
- `packages/desktop/src/renderer/types.test.ts:538` 到 `packages/desktop/src/renderer/types.test.ts:543` 明确测试了 clean `turn_complete(completed)` “每次调用都 bump turnEpoch”。`packages/desktop/src/renderer/types.test.ts:595` 到 `packages/desktop/src/renderer/types.test.ts:629` 测了 multi `turn_complete` 时 stale files_changed 会被替换。这是 consumer 侧容错，不是 core 不双发的证据。

### 4. 结论

确证。

原文把 N-03 标成“推测”，现在可从源码路径确定：在普通 `Engine.run()` 且 `TurnLoop` 返回 `max_turns` 的 live stream path 上，TurnLoop 和 Engine 会对同一个 caller `onStream` 各发一次 `turn_complete(max_turns)`。这不是 replay 合成，也不是子代理 `agentId` 转发造成的假重复。

限定条件：

- 只确证 `max_turns` terminal reason。`completed`、`model_error`、`prompt_too_long`、`aborted_streaming`、`goal_budget_exhausted` 等普通 terminal path 没有在 TurnLoop 内发 `turn_complete`，它们只有 Engine epilogue 的统一 emit。
- Headless 背景 drain 还有 `packages/core/src/engine/engine.ts:2258` 的 `result = await turnLoop.run([...result.messages, injected])` 复入路径。若第一次已经把同一个 TurnLoop 推到 `turnCount >= maxTurns` 且之后还有 pending background notification，源码上可能再次进入 maxTurns summary 分支并再次内部发 `turn_complete(max_turns)`；这条需要专门运行时场景验证，本文不把它写成确证。

### 5. 影响、建议方向、TDD 测试点

影响：

- `turn_complete` 在 06 文档中被定义为 Engine epilogue 完成后的最终边界。`packages/core/src/engine/engine.ts:2345` 到 `packages/core/src/engine/engine.ts:2363` 的正常顺序是 save state、`on_agent_end`、再 emit completion。但 `packages/core/src/engine/turn-loop.ts:1268` 让 maxTurns path 的第一个 `turn_complete` 发生在 Engine 保存 terminal state 和 end hooks 之前。
- 用户可见层面：desktop 会收到两个 terminal boundary。当前 `max_turns` 不会 bump clean `turnEpoch`，所以不太会表现为“历史工具卡被折叠两次”；files_changed 也有 stale replacement 容错。但 busy 清理、snapshot/replay terminal event、files_changed 重新计算、消费者自定义回调都会执行两次。
- 与已知 turn-fold / 双卡片类历史问题相关，但不是同一个根因。它属于 producer 侧重复 terminal boundary；F-03 是 coalescer 跨 hard boundary 合并；desktop 的 multi-`turn_complete` files_changed 测试说明 consumer 曾经专门处理过“多 terminal event 不堆卡”的历史问题。

建议方向：

- 统一 terminal event 所有权：`Engine` 应该是 live `turn_complete` 的唯一 producer。删除 `packages/core/src/engine/turn-loop.ts:1268`，让 maxTurns 和其它 terminal reason 一样只通过返回值交给 Engine epilogue。
- 如果还需要 standalone `query()` 有 terminal event，应该在 `query()` 或一个统一 runner wrapper 中补齐所有 terminal reason，而不是让 TurnLoop 只对 `max_turns` 特判。
- 若担心兼容，可先加 producer-side guard：TurnLoopResult 增加内部字段或 Engine 局部标记，避免 Engine 对已发 terminal 的 result 再发。但这会保留“第一个 terminal 早于 state save”的问题，不如移除 TurnLoop 内部 emit。

TDD 测试点：

- 场景：新增 Engine integration fake LLM，模型连续返回工具调用直到 `maxTurns`，summary call 返回文本；`Engine.run(..., { onStream })` 收集事件。
- 断言：`events.filter(e => e.type === "turn_complete" && e.reason === "max_turns").length === 1`；且该事件是同 run 的最后一个 terminal event。可额外断言 `engine.sessionManager.resume(sessionId).state.status === "max_turns"` 或等价 session state 已保存。
- 建议测试文件：新增 `packages/core/src/engine/engine.max-turns-stream.test.ts`。现有 `packages/core/src/engine/turn-loop-max-turns.test.ts` 只测 TurnLoop，不足以覆盖 Engine 双发；`packages/core/src/engine/turn-loop-steer-backfill.test.ts:264` 到 `packages/core/src/engine/turn-loop-steer-backfill.test.ts:288` 有 maxTurns 场景和 `events`，但也只断言 `steer_injected`，不能证明 Engine 层终态唯一。

### 6. 严重度

P1。不是 P0，因为触发条件限定在 `max_turns`，且 desktop 对部分重复终态有容错；但它破坏 core stream 的 terminal event 契约，并且第一个 completion 早于 Engine epilogue，属于真实 producer bug。

## 完成前自查

1. 三条都有明确结论：N-01 确证，N-02 确证，N-03 确证。
2. N-03 已列全本轮 grep 到的 live `turn_complete` producer，以及 transcript / room / replay 等价 producer；并区分 producer、forwarder、consumer。
3. 每条结论都落到具体 file:line。
4. 没有把 headless 背景 drain 的额外复入可能性写成确证，已标注需要运行时场景验证。
5. 本轮未改 `packages/**` 源码，未跑构建/测试。
