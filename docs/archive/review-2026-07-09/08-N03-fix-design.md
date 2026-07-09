# N-03 `max_turns` 双发 `turn_complete` 修复设计

本文只做修复设计，不改 `packages/**` 源码，不跑构建/测试。结论基于
`docs/archive/review-2026-07-09/07-new-observations-verification.md` 中已确证的 N-03，
并回读当前源码行号。

## 0. 结论摘要

推荐方案：**A. 移除 TurnLoop 的 maxTurns 内部 `turn_complete`，由 Engine epilogue 统一发
live terminal event**。

理由：当前契约已经由 Engine epilogue 体现：保存 terminal state、执行 end hooks 后，
再向 caller 发一次 `turn_complete`。TurnLoop 的 `max_turns` 分支是唯一特例，既造成双发，
又让第一条 terminal event 早于 Engine 收尾。删除这个特例是最小、最符合现有状态机的修复。

落地半径：**小**。核心代码只需要动 `packages/core/src/engine/turn-loop.ts` 的一个 emit，
再补 Engine 层集成测试和同步更新 TurnLoop maxTurns 单测注释/断言。

## 1. 应有契约

### 1.1 `turn_complete` 的语义

`turn_complete` 是 stream terminal event，携带 `TerminalReason`：

- `packages/core/src/types.ts:398` 到 `packages/core/src/types.ts:408` 定义
  `TerminalReason`，包含 `completed`、`model_error`、`aborted_streaming`、`max_turns`、
  `goal_budget_exhausted` 等终态原因。
- `packages/core/src/types.ts:462` 定义 stream event：
  `{ type: "turn_complete"; reason: TerminalReason; agentId?: string }`。

应有 live 契约：

1. 对一次进入 Engine epilogue 的 `Engine.run(..., { onStream })`，`turn_complete` 应由
   **Engine** 作为唯一 producer 发出。
2. 发送时机应在 TurnLoop 已返回、可选 headless drain 已完成、run-scoped cleanup 已执行、
   session terminal state 已保存、`on_agent_end` 已执行之后。
3. 同一个 Engine run 对同一个 caller `onStream` 最多发 **一次** agentId-less
   `turn_complete`。如果是子代理，子 Engine 仍只发一次；父 Engine 的 child stream wrapper
   只给子事件补 `agentId`，不是新的 terminal producer。

当前代码能支撑这个契约的位置：

- Engine 等待 TurnLoop 返回：`packages/core/src/engine/engine.ts:2197` 到
  `packages/core/src/engine/engine.ts:2199`。
- Headless 背景 drain 发生在 Engine epilogue 前，且可能复入同一个 TurnLoop：
  `packages/core/src/engine/engine.ts:2201` 到 `packages/core/src/engine/engine.ts:2258`。
- run-scoped cleanup 在 `finally` 中发生：`packages/core/src/engine/engine.ts:2261`。
- `on_session_end` 在最终保存前执行：`packages/core/src/engine/engine.ts:2294` 到
  `packages/core/src/engine/engine.ts:2298`。
- Engine 保存 terminal state：`packages/core/src/engine/engine.ts:2345` 到
  `packages/core/src/engine/engine.ts:2353`。
- `on_agent_end` 执行后，Engine 才发 completion：
  `packages/core/src/engine/engine.ts:2355` 到 `packages/core/src/engine/engine.ts:2363`。

协议层目前是转发而不是 live producer：

- `ChatSession` 取 per-turn/default `onStream` 并传给 `engine.run`：
  `packages/core/src/protocol/chat-session.ts:211` 到
  `packages/core/src/protocol/chat-session.ts:216`。
- `AgentServer.send` 把 Engine stream event notify 给 client：
  `packages/core/src/protocol/server.ts:498` 到 `packages/core/src/protocol/server.ts:499`。
- background wakeup 同样只是把 `onStream` 转成 notify：
  `packages/core/src/protocol/server.ts:291`。
- legacy run path 把 `streamToClient` 传给 Engine：
  `packages/core/src/protocol/server.ts:597` 到 `packages/core/src/protocol/server.ts:601`。

### 1.2 TurnLoop 的角色

TurnLoop 应返回 terminal reason，不应定义 Engine live terminal boundary。

除 `max_turns` 特例外，当前 TurnLoop 的其它终态都只 `return`，不发 `turn_complete`：

- abort：`packages/core/src/engine/turn-loop.ts:576` 到
  `packages/core/src/engine/turn-loop.ts:578`。
- context recovery 失败后 `model_error` / `prompt_too_long`：
  `packages/core/src/engine/turn-loop.ts:710` 到
  `packages/core/src/engine/turn-loop.ts:721`。
- model abort / model error：`packages/core/src/engine/turn-loop.ts:723` 到
  `packages/core/src/engine/turn-loop.ts:737`。
- goal budget exhausted：`packages/core/src/engine/turn-loop.ts:855` 到
  `packages/core/src/engine/turn-loop.ts:873`。
- normal completed：`packages/core/src/engine/turn-loop.ts:974` 到
  `packages/core/src/engine/turn-loop.ts:977`。
- outer catch 收口：`packages/core/src/engine/turn-loop.ts:1214` 到
  `packages/core/src/engine/turn-loop.ts:1224`。

这说明 `max_turns` 内部 emit 不是统一设计，而是和其它 terminal reason 不一致的特例。

## 2. 双发路径精确定位

### 2.1 共同前提

普通 live path 中，Engine 把 caller 的同一个 stream callback 交给 TurnLoop：

- Engine 先包装 caller `onStream` 以记录 `task_update` / `goal_progress`，再转发给 user：
  `packages/core/src/engine/engine.ts:1001` 到 `packages/core/src/engine/engine.ts:1018`。
- Engine 构造 TurnLoop config 时传入 `onStream: options?.onStream`：
  `packages/core/src/engine/engine.ts:2130` 到 `packages/core/src/engine/engine.ts:2141`。
- TurnLoop constructor 只把 `onStream` 包成 try/catch，防 handler throw，不做 terminal 去重：
  `packages/core/src/engine/turn-loop.ts:337` 到
  `packages/core/src/engine/turn-loop.ts:356`。

### 2.2 发射点 1：TurnLoop maxTurns 收口

位置：

- `packages/core/src/engine/turn-loop.ts:556`：主循环条件是
  `while (this.turnCount < this.config.maxTurns)`。
- 当 `turnCount >= maxTurns` 时退出 while，进入 maxTurns summary 收口：
  `packages/core/src/engine/turn-loop.ts:1227`。
- Summary call 使用 no-tools 模型调用：
  `packages/core/src/engine/turn-loop.ts:1244` 到
  `packages/core/src/engine/turn-loop.ts:1251`。
- 若有 summary text，先发 `assistant_message`：
  `packages/core/src/engine/turn-loop.ts:1261` 到
  `packages/core/src/engine/turn-loop.ts:1267`。
- **第一条 terminal event**：
  `packages/core/src/engine/turn-loop.ts:1268`
  `this.config.onStream?.({ type: "turn_complete", reason: "max_turns" });`
- 随后返回同一个 reason：
  `packages/core/src/engine/turn-loop.ts:1269`
  `return { text: finalText, reason: "max_turns", messages };`

触发条件：

1. TurnLoop 的 `turnCount` 已达到 `config.maxTurns`。
2. 没有 finalize steer 把收口改成继续下一步，或即便有 steer，也最终再次耗尽 maxTurns。
3. caller 提供了 `onStream`。

### 2.3 发射点 2：Engine epilogue

位置：

- Engine 等待 TurnLoop 返回：
  `packages/core/src/engine/engine.ts:2197` 到
  `packages/core/src/engine/engine.ts:2199`。
- 如果是 top-level headless，会先 drain background sub-agent notification；这一步也在最终
  completion 前：
  `packages/core/src/engine/engine.ts:2201` 到 `packages/core/src/engine/engine.ts:2258`。
- Engine 收尾保存 state：
  `packages/core/src/engine/engine.ts:2345` 到
  `packages/core/src/engine/engine.ts:2353`。
- Engine 跑 `on_agent_end`：
  `packages/core/src/engine/engine.ts:2355` 到
  `packages/core/src/engine/engine.ts:2360`。
- **第二条 terminal event**：
  `packages/core/src/engine/engine.ts:2362` 到
  `packages/core/src/engine/engine.ts:2363`
  `options?.onStream?.({ type: "turn_complete", reason: result.reason });`

触发条件：

1. `turnLoop.run(messages)` 返回 `result.reason === "max_turns"`。
2. Engine run 到达 epilogue。
3. caller 提供了 `onStream`。

### 2.4 同一次收口中的时序

```text
Engine.run(task, { onStream })
  -> Engine wraps caller onStream, then passes same options.onStream to TurnLoop
     engine.ts:1001-1018, engine.ts:2130-2141

TurnLoop.run(messages)
  -> while (turnCount < maxTurns) runs normal model/tool turns
     turn-loop.ts:556
  -> turnCount reaches maxTurns, exits while
  -> maxTurns summary call
     turn-loop.ts:1227-1251
  -> emits assistant_message(summary)
     turn-loop.ts:1261-1267
  -> emits turn_complete(max_turns)              [first terminal, too early]
     turn-loop.ts:1268
  -> returns { reason: "max_turns" }
     turn-loop.ts:1269

Engine epilogue
  -> receives result from turnLoop.run
     engine.ts:2197-2199
  -> optional headless drain before finalization
     engine.ts:2201-2258
  -> finally cleanup, on_session_end, saveState, on_agent_end
     engine.ts:2261, 2294-2298, 2345-2360
  -> emits turn_complete(result.reason === "max_turns")  [second terminal]
     engine.ts:2362-2363
```

破坏点：第一条 `turn_complete(max_turns)` 发生在 Engine 保存
`session.state.status = "max_turns"` 和 `on_agent_end` 之前，违反了
“`turn_complete` 是 Engine epilogue 后唯一终态边界”的契约。

## 3. 候选修复方案对比

### 方案 A：TurnLoop 在 maxTurns 分支不发 terminal，由 Engine epilogue 统一发

改动：

- `packages/core/src/engine/turn-loop.ts`
  - 删除 `run()` maxTurns 收口里的
    `this.config.onStream?.({ type: "turn_complete", reason: "max_turns" });`
    即当前 `packages/core/src/engine/turn-loop.ts:1268`。
  - 保留 summary `assistant_message` 和
    `return { text: finalText, reason: "max_turns", messages }`。
- `packages/core/src/engine/turn-loop-max-turns.test.ts`
  - 更新文件头注释，移除“TurnLoop emits matching turn_complete”的说法。
  - 可新增一个 TurnLoop 级断言：直接调用 `TurnLoop.run()` 时，maxTurns 分支不发
    `turn_complete`，只返回 `reason: "max_turns"`。这是内部契约护栏。
- 新增 Engine 级失败测试，见第 5 节。

优点：

- 最小化修复 producer bug。
- 与其它 terminal reason 的现状一致：TurnLoop 只返回 reason，Engine 统一 emit。
- 第一条也是唯一一条 `turn_complete` 会发生在 state save 和 `on_agent_end` 之后。
- 覆盖 headless drain 中同一个 TurnLoop 复入时的 terminal 重复风险：即便复入
  `turnLoop.run()` 多次，TurnLoop 不再发 terminal，最终只有 Engine epilogue 发一次。

风险：

- `packages/core/src/engine/query.ts` 直接使用 TurnLoop：
  `packages/core/src/engine/query.ts:83` 到 `packages/core/src/engine/query.ts:94` 传入
  `onStream`，`packages/core/src/engine/query.ts:119` 到
  `packages/core/src/engine/query.ts:149` 运行并 yield queue。删除 TurnLoop emit 后，
  standalone `query()` 的 `max_turns` 将不再有当前这条特例 terminal event。
- 但 `query()` 当前也没有为 `completed`、`model_error`、`aborted_streaming` 等其它 reason
  统一补 `turn_complete`，所以这不是新增不一致，而是移除唯一特例。若 `query()` 是外部
  stream API，应另开小 patch 在 `query()` 自己的 `.then(r => ...)` epilogue 为所有
  terminal reason 补一次 terminal event，而不是把职责放回 TurnLoop。

对其它路径影响：

- 正常结束 `completed`：无行为变化，仍由 Engine epilogue 发一次。
- abort / cancel：TurnLoop 仍返回 `aborted_streaming`，Engine epilogue 发一次；不会因为删除
  maxTurns 特例而改变 `markStopped()` 或 error event。
- compact：`context_compact` 仍由 Engine/ContextManager 发；TurnLoop 的 maxTurns sync
  `manage()` 不再提前 terminal，不影响 compact 本身。
- headless drain：terminal duplicate 被覆盖；但“复入是否产生额外 summary call /
  assistant_message”仍需运行时验证，见第 7 节。

### 方案 B：Engine 侧按 turn boundary 去重/幂等守卫

可选实现形态：

- 在 Engine 传给 TurnLoop 的 `onStream` 外再包一层 terminal guard，吞掉 TurnLoop 内部
  `turn_complete`，最终仍由 Engine epilogue 发一次。
- 或记录“已经发过 terminal”，Engine epilogue 遇到重复时不再发。

改动：

- `packages/core/src/engine/engine.ts`
  - 在 `options?.onStream` wrapper 附近，即 `packages/core/src/engine/engine.ts:1001` 到
    `packages/core/src/engine/engine.ts:1018`，或构造 TurnLoop config 前，增加 terminal
    guard 状态。
  - 构造 TurnLoop 时传 guarded stream，而不是直接传 `options?.onStream`。

优点：

- 可以不改变 direct TurnLoop / standalone `query()` 的现有 maxTurns terminal 行为。
- 如果未来 TurnLoop 又意外新增 terminal emit，Engine 层可拦住进入 caller 的重复 terminal。

风险：

- 如果采用“Engine 看到已发就跳过 epilogue emit”，会保留第一条 terminal 早于 state save /
  `on_agent_end` 的问题，不能接受。
- 如果采用“吞 TurnLoop terminal，Engine epilogue 再发”，能修 Engine live path，但 producer
  职责仍分裂，TurnLoop 仍保留错误语义，direct TurnLoop consumer 仍会看到早发 terminal。
- 增加 stream wrapper 层，容易和现有 task/goal wrapper、子代理 `agentId` wrapper 叠加，维护成本高。

对其它路径影响：

- 正常结束 / abort / compact 当前不受影响，因为 TurnLoop 不发这些 reason 的
  `turn_complete`。
- headless drain 可避免 terminal 重复，但同样不解决复入引起的潜在额外 summary call。

### 方案 C：单一 terminal producer 重构

改动：

- 把 terminal event 所有权抽成统一 runner/epilogue，例如 Engine 和 `query()` 各自调用同一个
  `emitTerminalOnce(result.reason)` helper。
- 明确禁止 TurnLoop 发任何 `turn_complete`；TurnLoop 只返回 `TurnLoopResult`。
- 同步更新 Engine、query、相关协议/helper 测试。

优点：

- 长期架构最清晰：TurnLoop 是状态机，外层 runner 负责 stream lifecycle terminal。
- 可以顺手修正 `query()` terminal event 不统一的问题。

风险：

- 改动半径中等到大，涉及 Engine、query、测试和可能的外部 API 行为。
- 对 P1 双发 bug 来说过重，容易引入非必要回归。

## 4. 推荐方案与落地步骤

推荐采用 **方案 A**。它直接移除唯一错误 producer，让 Engine 已有 epilogue 契约自然生效。

建议按 TDD 顺序落地：

1. 新增失败测试：`packages/core/src/engine/engine.max-turns-stream.test.ts`。
   - 注册一个 fake provider，按 model name 读取 scenario。
   - Engine 配置使用临时 `sessionStorageDir`、`permissionMode: "bypassPermissions"`、
     `enabledBuiltinTools: []`、`maxTurns: 1` 或 `2`。
   - fake model 第一次返回 `toolCalls: [{ id: "c1", toolName: "NoopTool", args: {} }]`，
     迫使 TurnLoop 进入下一轮；summary call 返回 `{ text: "final summary", toolCalls: [] }`。
   - `engine.run("go", { sessionId, cwd, onStream })` 收集 events。
   - 先断言当前失败现象：
     `events.filter(e => e.type === "turn_complete" && e.reason === "max_turns").length`
     在修复前为 2，目标断言为 1。

2. 修改 `packages/core/src/engine/turn-loop.ts`。
   - 在 maxTurns 收口中保留 `assistant_message`：
     当前 `packages/core/src/engine/turn-loop.ts:1261` 到
     `packages/core/src/engine/turn-loop.ts:1267`。
   - 删除紧随其后的 `turn_complete(max_turns)` emit：
     当前 `packages/core/src/engine/turn-loop.ts:1268`。
   - 保留返回：
     当前 `packages/core/src/engine/turn-loop.ts:1269`。

3. 更新 `packages/core/src/engine/turn-loop-max-turns.test.ts`。
   - 文件头注释当前说“returns reason `max_turns` and emits a matching
     `turn_complete` event”，但同文件测试实际没有传 `onStream`。应改成
     “returns reason `max_turns`; Engine epilogue owns `turn_complete`”。
   - 可新增 TurnLoop 单测：传入 `onStream` 收集 events，跑 maxTurns 场景，断言
     `turn_complete` 数量为 0，同时 `result.reason === "max_turns"`。这能防止以后
     TurnLoop 又引入 terminal producer。

4. 不改协议层 producer。
   - `ChatSession` / `AgentServer` 仍只转发 Engine stream event。
   - 不在 `server.ts` 合成 `turn_complete`；否则会形成第三个 producer。

5. 暂不在本 P1 patch 修改 `query()`，除非新增测试证明 `query()` 对外承诺每个 terminal
   reason 都 yield `turn_complete`。
   - 如果要修 `query()`，应在 `packages/core/src/engine/query.ts:126` 到
     `packages/core/src/engine/query.ts:149` 的 loop promise epilogue 中，为所有
     `TerminalReason` 统一 enqueue 一次 `turn_complete`，并加 query 专属测试。
   - 不应恢复 TurnLoop 内部 emit。

## 5. TDD 测试点

### 5.1 首个失败测试：Engine maxTurns live path 只发一次 terminal

建议文件：**新增** `packages/core/src/engine/engine.max-turns-stream.test.ts`。

场景：

- 使用 fake provider 注册一个 LLM client。
- `maxTurns: 1`：
  - 第 1 次模型调用返回 tool call，让 TurnLoop 不以 `completed` 停止。
  - 工具执行即使失败也会产生 tool_result，随后 while 条件耗尽。
  - 第 2 次模型调用是 maxTurns summary call，返回 `"final summary"`。
- `Engine.run(..., { onStream })` 收集 stream events。

核心断言：

- `result.reason === "max_turns"`。
- `result.text === "final summary"`。
- `events.filter(e => e.type === "turn_complete" && e.reason === "max_turns")`
  长度为 **1**。
- 可额外断言 `engine.getSessionManager().resume(sessionId).state.status === "max_turns"`，
  证明 terminal state 已由 Engine 保存。不要把 `turn_complete` 绝对“最后一个事件”作为强断言，
  因为 Engine 中 `session_title` 是 fire-and-forget：
  `packages/core/src/engine/engine.ts:2320` 到 `packages/core/src/engine/engine.ts:2336`。

修复前预期失败：

- 同一个 `events` 里会有两条 `turn_complete(max_turns)`：
  TurnLoop `packages/core/src/engine/turn-loop.ts:1268` 一条，
  Engine `packages/core/src/engine/engine.ts:2363` 一条。

### 5.2 TurnLoop 内部契约测试

建议位置：追加到 `packages/core/src/engine/turn-loop-max-turns.test.ts`。

场景：

- 复用现有 `makeDeps([toolResp(), summaryResp()])` 风格。
- 给 `TurnLoopConfig` 传 `onStream: events.push`。
- 跑到 `max_turns`。

断言：

- `result.reason === "max_turns"`。
- `events.filter(e => e.type === "turn_complete").length === 0`。
- Summary `assistant_message` 仍存在，避免误删最终可见总结。

这条测试是方案 A 的 producer 边界护栏。

### 5.3 协议层 smoke 测试

建议优先复用现有 `server.*` 测试，而不是为协议层新增同类 fake：

- `packages/core/src/protocol/server.bg-shell-wakeup.test.ts`
- `packages/core/src/protocol/server.backgroundwork.test.ts`
- `packages/core/src/protocol/server.run-model.test.ts`

重点观察：协议层不新增或吞掉 terminal，只转发 Engine 的唯一 terminal。

## 6. 回归面与建议测试

### 6.1 Core / Engine / TurnLoop

必须跑：

- `bun test packages/core/src/engine/engine.max-turns-stream.test.ts`
- `bun test packages/core/src/engine/turn-loop-max-turns.test.ts`
- `bun test packages/core/src/engine/turn-loop-steer-backfill.test.ts`
- `bun test packages/core/src/engine/turn-loop-abort.test.ts`
- `bun test packages/core/src/engine/turn-loop-error-safety.test.ts`
- `bun test packages/core/src/engine/turn-loop-summary-safety.test.ts`
- `bun test packages/core/src/engine/turn-loop-continuation.test.ts`

建议扩展跑：

- `bun test packages/core/src/engine/turn-loop*.test.ts`
- `bun test packages/core/src/engine/engine*.test.ts`

关注路径：

- 正常 `completed`：仍只有 Engine epilogue 发 terminal。
- `aborted_streaming`：Stop/cancel 后不发 error，Engine 最终发一次 terminal。
- `model_error` / `prompt_too_long`：TurnLoop 可发 `error` event，但 terminal 仍只由 Engine 发。
- `goal_budget_exhausted`：仍是预期 stop，前端应按 completed 类状态处理。
- `max_turns`：summary `assistant_message` 不丢，terminal 不双发。

### 6.2 Protocol

建议跑：

- `bun test packages/core/src/protocol/server.*.test.ts`
- `bun test packages/core/src/protocol/chat-session-cancel.test.ts`
- `bun test packages/core/src/protocol/transport.inprocess.test.ts`

关注路径：

- `ChatSession.pump()` 仍把 per-turn/default `onStream` 传给 Engine：
  `packages/core/src/protocol/chat-session.ts:211` 到
  `packages/core/src/protocol/chat-session.ts:216`。
- `AgentServer` send / wakeup / legacy paths仍只是 notify，不合成 `turn_complete`：
  `packages/core/src/protocol/server.ts:291`、
  `packages/core/src/protocol/server.ts:498` 到 `packages/core/src/protocol/server.ts:499`、
  `packages/core/src/protocol/server.ts:597` 到 `packages/core/src/protocol/server.ts:601`。

### 6.3 Desktop stream / fold 回归

建议跑：

- `bun test packages/desktop/src/renderer/types.test.ts`
- `bun test packages/desktop/src/renderer/lib/streamReducer.test.ts`
- `bun test packages/desktop/src/renderer/messages/streamGroups.test.ts`
- `bun test packages/desktop/src/renderer/streamCoalescer.test.ts`
- `bun test packages/desktop/src/renderer/lib/messageMappers.test.ts`
- `bun test packages/desktop/src/main/transcript-reader.test.ts`
- `bun test packages/desktop/src/renderer/automation/foldTranscript.test.ts`

关注点：

- App 对 agentId-less terminal 清 busy：
  `packages/desktop/src/renderer/App.tsx:1583` 到
  `packages/desktop/src/renderer/App.tsx:1584`。修复后 `max_turns` 不应重复清 busy。
- reducer 对多 terminal 有 files_changed 容错，但这不是 producer 正确性的替代：
  `packages/desktop/src/renderer/types.ts:982` 到
  `packages/desktop/src/renderer/types.ts:1032`。
- `max_turns` 在 stream reducer 中按正常完成类状态处理：
  `packages/desktop/src/renderer/lib/streamReducer.test.ts:127` 到
  `packages/desktop/src/renderer/lib/streamReducer.test.ts:131`。
- streamGroups 依赖 `turn_complete` 后 live turn 不再继续 tick：
  `packages/desktop/src/renderer/messages/streamGroups.ts:438` 到
  `packages/desktop/src/renderer/messages/streamGroups.ts:447`。
- stream coalescer 当前不会把 `turn_complete` 作为立即 flush 的 hard boundary，而是普通
  passthrough batch：
  `packages/desktop/src/renderer/streamCoalescer.ts:145` 到
  `packages/desktop/src/renderer/streamCoalescer.ts:149`。本修复减少重复 terminal，但不改变
  coalescer 策略。

## 7. 仍需运行时验证的情形

`07-new-observations-verification.md` 标注过 headless drain 的额外复入可能性尚需运行时验证：

- Engine headless drain 在 `packages/core/src/engine/engine.ts:2258` 可再次调用同一个
  `turnLoop.run([...result.messages, injected])`。
- 注释明确 `turnCount` 会累积，maxTurns 仍约束 re-summarization：
  `packages/core/src/engine/engine.ts:2220` 到 `packages/core/src/engine/engine.ts:2222`。

本推荐方案对该情形的覆盖范围：

- **已覆盖**：即使 headless drain 复入 TurnLoop 并再次进入 maxTurns summary，TurnLoop 不再发
  `turn_complete`，所以同一个 Engine run 的 live terminal event 仍只会由 Engine epilogue
  发一次。
- **未完全覆盖，需运行时进一步验证**：复入是否会产生额外 summary model call、额外
  `assistant_message`、或改变最终 `result.messages` 的形状。方案 A 只修 terminal producer
  归属，不改变 headless drain 的复入状态机。

建议补一个后续运行时测试：

- headless Engine，第一次 run 达到 maxTurns，同时有 pending background notification。
- 断言 `turn_complete(max_turns)` 只有 1 条。
- 额外观察 summary `assistant_message` 数量、model summary call 次数、最终 transcript 形状。
- 如果发现额外 summary call 是用户可见问题，应另立独立 bug；不要把它和 N-03 的
  terminal 双发修复混在同一个小 patch 里。

## 8. 完成前自查

1. 双发点已精确定位：
   - TurnLoop：`packages/core/src/engine/turn-loop.ts:1268`。
   - Engine epilogue：`packages/core/src/engine/engine.ts:2363`。
2. 双发触发时序已覆盖同一个 `onStream` 如何被 Engine 传入 TurnLoop：
   `packages/core/src/engine/engine.ts:2130` 到 `packages/core/src/engine/engine.ts:2141`，
   以及 TurnLoop wrapper 不做去重：
   `packages/core/src/engine/turn-loop.ts:337` 到 `packages/core/src/engine/turn-loop.ts:356`。
3. 候选方案覆盖了：
   - 正常结束。
   - abort / cancel。
   - compact。
   - headless drain。
   - standalone `query()` 的兼容风险。
4. TDD 首测具体到文件、场景和断言；修复前会因两条
   `turn_complete(max_turns)` 失败。
5. 推荐方案明确：方案 A，删除 TurnLoop maxTurns 内部 terminal emit，由 Engine epilogue
   统一发。
6. 未覆盖点已如实标注：headless drain 复入下的额外 summary call / assistant_message
   需要运行时进一步验证。
