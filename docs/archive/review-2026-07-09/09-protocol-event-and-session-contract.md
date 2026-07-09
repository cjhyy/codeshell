# Protocol 事件发射与 session 边界契约深度剖析

本文只读源码和既有 review 文档，只新增本文件，不修改 `packages/**`，不跑构建/测试。

先校正范围：`StreamEvent` union 的真实定义在 `packages/core/src/types.ts:429`，`packages/core/src/protocol/types.ts:313` 只是把它套进多会话 envelope `{ sessionId, event }`。protocol 对外还有非 `StreamEvent` notification：`agent/approvalRequest`、`agent/approvalResolved`、`agent/status`，见 `packages/core/src/protocol/types.ts:365` 到 `packages/core/src/protocol/types.ts:372`。

## 0. 结论摘要

1. protocol 层没有独立合成或二次包装 `turn_complete`。`server.ts` / `chat-session.ts` 当前只把 Engine/TurnLoop 给出的 `StreamEvent` 包成 `agent/streamEvent`；唯一例外是 protocol 自己合成 `error`（后台唤醒失败）和 `context_compact`（手动 compact query 缩小时），都不是 `turn_complete`。
2. N-03 的 live `max_turns` 双发仍只来自 engine 层两个 producer：`packages/core/src/engine/turn-loop.ts:1268` 和 `packages/core/src/engine/engine.ts:2363`。方案 A 删除 TurnLoop 的 maxTurns 内部 emit 后，protocol 侧不会再额外补出第三个 `turn_complete`，因此对 protocol live path 仍完备。
3. session 隔离主链路以 `RunParams.sessionId` 为入口：`handleRunMulti()` 必填校验，`ChatSessionManager` 按 id 取 session，`ChatSession.pump()` 再把 `this.id` 传入 `engine.run()`，最后 `AgentServer` 用同一个 sid 包 stream envelope。AskUserQuestion 当前也按 `session.pendingApprovals` 隔离，错 session 的 approve fail-closed。
4. approval 不是 `StreamEvent`。当前 protocol/server 只实时发一次 `agent/approvalRequest`，没有像 stream snapshot 那样的 replay 机制；desktop renderer 用内存 `approvalQueue` 和 `approvalBucketsRef` 维持 session 归属。
5. 本轮新增两个 protocol 侧可疑点：N-04（SDK `AgentClient` approval notification 丢 `sessionId` 且不处理 `approvalResolved`），N-05（`goal_cleared` 类型注释承诺显式 clear 会发 stream event，但 server 的 `agent/goalClear` 实际只回 RPC response，desktop 靠本地注入弥补）。

## 1. Protocol 出站形状

### 1.1 Stream envelope

`AgentStreamEventNotification` 是 protocol 多会话核心：

- 类型：`packages/core/src/protocol/types.ts:313` 到 `packages/core/src/protocol/types.ts:317`。
- server 发送：`this.notify(Methods.StreamEvent, { sessionId, event })`，例如 run path 在 `packages/core/src/protocol/server.ts:498` 到 `packages/core/src/protocol/server.ts:499`。
- client 接收：`AgentClient.handleNotification()` 读 `params.sessionId` 和 `params.event`，再 emit `"stream"`，见 `packages/core/src/protocol/client.ts:379` 到 `packages/core/src/protocol/client.ts:385`。
- desktop preload 接收：`packages/desktop/src/preload/index.ts:159` 到 `packages/desktop/src/preload/index.ts:164`。
- desktop renderer 路由：`packages/desktop/src/renderer/App.tsx:1463` 到 `packages/desktop/src/renderer/App.tsx:1486` 先按 envelope `sessionId` 找 bucket。

### 1.2 非 StreamEvent notifications

| method | 语义 | server 发射点 | consumer |
|---|---|---|---|
| `agent/approvalRequest` | tool approval、AskUserQuestion、browser/credential/workspace bridge 请求客户端决策 | `packages/core/src/protocol/server.ts:1937`、`1981`、`2096`、`2152`、`2217`、`2256` | desktop preload 透传 `params`，见 `packages/desktop/src/preload/index.ts:190`；App 按 `env.sessionId` 路由，见 `packages/desktop/src/renderer/App.tsx:1787` 到 `1889` |
| `agent/approvalResolved` | server 主动结束 pending approval/ask，例如 goal AskUser 超时 | `packages/core/src/protocol/server.ts:2017` | preload 透传，见 `packages/desktop/src/preload/index.ts:194`；App 清 inline ask / approval queue，见 `packages/desktop/src/renderer/App.tsx:1891` 到 `1917` |
| `agent/status` | server lifecycle：ready/running/shutdown | ready：`packages/core/src/protocol/server.ts:236`；legacy running/ready：`packages/core/src/protocol/server.ts:583`、`646`；shutdown：`packages/core/src/protocol/server.ts:2332` | `AgentClient` 处理 status，见 `packages/core/src/protocol/client.ts:396` 到 `400` |

## 2. StreamEvent 全量清单

下表按 `packages/core/src/types.ts:429` 到 `packages/core/src/types.ts:615` 的 union 顺序列出。`由谁发` 写 live producer；若当前 core/protocol 未见 producer，明确标注。

| StreamEvent | 语义 | 由谁发 / file:line | 前端如何依赖 |
|---|---|---|---|
| `session_started` | 一次 `Engine.run()` 解析出权威 sid 后立即通知客户端，并给 ctx bar 一个首帧 token seed | Engine：`packages/core/src/engine/engine.ts:1621` 到 `1630`；protocol 只包 envelope：`packages/core/src/protocol/server.ts:498` | App 绑定 engine sid 到 bucket、设置 busy，见 `packages/desktop/src/renderer/App.tsx:1529` 到 `1552`；reducer 记录 `state.sessionId`，见 `packages/desktop/src/renderer/types.ts:431` 到 `440` |
| `session_title` | 第一轮完成后 best-effort 生成 sidebar title | Engine fire-and-forget：`packages/core/src/engine/engine.ts:2320` 到 `2336` | App 不覆盖手动 rename，见 `packages/desktop/src/renderer/App.tsx:1555` 到 `1570`；mobile/room reducer 设置 title，见 `packages/desktop/src/renderer/lib/streamReducer.ts:476` |
| `stream_request_start` | 一个模型请求/turn step 开始，创建 live assistant slot | TurnLoop：`packages/core/src/engine/turn-loop.ts:605` | 主桌面打开空 assistant message，见 `packages/desktop/src/renderer/types.ts:443` 到 `457`；mobile reducer 打开按 agent 分组的 live item，见 `packages/desktop/src/renderer/lib/streamReducer.ts:144` 到 `161` |
| `steer_injected` | queued steer 已被 TurnLoop 消费进 messages/transcript | TurnLoop：`packages/core/src/engine/turn-loop.ts:1373` 到 `1375` | App 从 queued panel 删除对应项，见 `packages/desktop/src/renderer/App.tsx:1503` 到 `1512`；reducer 追加/确认 user bubble，见 `packages/desktop/src/renderer/types.ts:460` 到 `483`；main snapshot 显式排除它，见 `packages/desktop/src/main/parseStreamLine.ts:26` 到 `34` |
| `text_delta` | 模型流式文本 token/chunk | ModelFacade：`packages/core/src/engine/model-facade.ts:78` 到 `82`；TurnLoop wrapper 原样转发：`packages/core/src/engine/turn-loop.ts:1280` 到 `1304` | coalescer 50ms 合并，见 `packages/desktop/src/renderer/streamCoalescer.ts:104` 到 `118`；主 reducer 追加到 assistant 或 agent textBuffer，见 `packages/desktop/src/renderer/types.ts:486` 到 `508` |
| `tool_use_start` | 工具调用开始，可能来自 provider streaming，也可能在完整 response 后补发 | ModelFacade streaming：`packages/core/src/engine/model-facade.ts:82` 到 `92`；TurnLoop 补未流式出现过的 id：`packages/core/src/engine/turn-loop.ts:1005` 到 `1008` | 主 reducer 创建 tool card 并对重复 id 幂等，见 `packages/desktop/src/renderer/types.ts:536` 到 `571`；mobile reducer 也做 idempotent，见 `packages/desktop/src/renderer/lib/streamReducer.ts:229` 到 `257` |
| `tool_use_args_delta` | 工具 args 的增量 JSON，用于展示 live 参数 | ModelFacade：`packages/core/src/engine/model-facade.ts:93` 到 `99` | coalescer 按 tool id merge，见 `packages/desktop/src/renderer/streamCoalescer.ts:120` 到 `136`；主 reducer 合并 `argsLive`，见 `packages/desktop/src/renderer/types.ts:574` 到 `598` |
| `tool_result` | 工具执行完成，携带结果/错误/图片/sandbox 等 | TurnLoop：`packages/core/src/engine/turn-loop.ts:1021` 到 `1034`；异常修补也会生成 synthetic result，但主要进入 messages/transcript | 主 reducer 完成 tool card，见 `packages/desktop/src/renderer/types.ts:601` 到 `640`；mobile reducer 可缓存先到的 orphan result，见 `packages/desktop/src/renderer/lib/streamReducer.ts:278` 到 `311` |
| `assistant_message` | 完整 assistant message 边界；封住当前 streaming bubble | TurnLoop 正常文本：`packages/core/src/engine/turn-loop.ts:879` 到 `882`；goal budget：`866` 到 `873`；token stop：`1143` 到 `1151`；maxTurns summary：`1261` 到 `1267` | 主 reducer把 live assistant `done:true`，见 `packages/desktop/src/renderer/types.ts:664` 到 `675`；mobile reducer seal agent live bubble，见 `packages/desktop/src/renderer/lib/streamReducer.ts:350` 到 `365` |
| `turn_complete` | top-level 或 sub-agent turn terminal boundary，携带 `TerminalReason` | 应由 Engine epilogue 发：`packages/core/src/engine/engine.ts:2362` 到 `2363`；当前另有 N-03 特例：TurnLoop maxTurns `packages/core/src/engine/turn-loop.ts:1268` | App 对 agentId-less terminal 清 busy，见 `packages/desktop/src/renderer/App.tsx:1575` 到 `1584`；主 reducer flush/封口/files_changed/turnEpoch，见 `packages/desktop/src/renderer/types.ts:932` 到 `1033` |
| `goal_progress` | goal judge 进度：未完成、完成、耗尽、接近上限 | approaching：`packages/core/src/engine/turn-loop.ts:309`；not_met：`913` 到 `918`；exhausted：`952` 到 `956`；met：`967` 到 `971`；Engine 顺手持久化：`packages/core/src/engine/engine.ts:1009` 到 `1015` | reducer 追加 marker 并维护 active goal round，见 `packages/desktop/src/renderer/types.ts:815` 到 `851`；mobile reducer更新 goal banner，见 `packages/desktop/src/renderer/lib/streamReducer.ts:396` 到 `402` |
| `goal_set` | 一次 send 设置或替换持久 goal | Engine：`packages/core/src/engine/engine.ts:2028` 到 `2035` | 主 reducer 设置 `activeGoal`，见 `packages/desktop/src/renderer/types.ts:854` 到 `859`；mobile reducer显示 goal，见 `packages/desktop/src/renderer/lib/streamReducer.ts:386` 到 `390` |
| `goal_cleared` | 显式清除持久 goal 的 UI marker | 当前 core/protocol 未见 live producer；`agent/goalClear` 只回 response：`packages/core/src/protocol/server.ts:825` 到 `846`；desktop 本地注入：`packages/desktop/src/renderer/App.tsx:3334` 到 `3355` | 主 reducer 清 `activeGoal`，见 `packages/desktop/src/renderer/types.ts:862` 到 `864`。这里存在 N-05 契约缺口 |
| `error` | 流式错误/终态错误，用于清 busy 和显示错误 | TurnLoop model/context/unexpected error：`packages/core/src/engine/turn-loop.ts:710`、`717` 到 `720`、`736`、`1223`；protocol 后台唤醒失败兜底：`packages/core/src/protocol/server.ts:310` 到 `313` | coalescer 立即单独 flush，见 `packages/desktop/src/renderer/streamCoalescer.ts:138` 到 `143`；App 清 busy，见 `packages/desktop/src/renderer/App.tsx:1583`；reducer显示 system error 并清 streaming ids，见 `packages/desktop/src/renderer/types.ts:1036` 到 `1054` |
| `tombstone` | streaming fallback 时撤销已部分输出的消息 | TurnLoop：`packages/core/src/engine/turn-loop.ts:1334` 到 `1335` | 主 reducer按 messageId 删除并修 agent index，见 `packages/desktop/src/renderer/types.ts:916` 到 `930` |
| `task_update` | TodoWrite/任务列表 snapshot | TodoWrite：`packages/core/src/tool-system/builtin/task.ts:139` 到 `141`；Engine resume replay 最近 snapshot：`packages/core/src/engine/engine.ts:1632` 到 `1643`；Engine wrapper 记录 latestTodos：`packages/core/src/engine/engine.ts:1002` 到 `1005` | 主 reducer显示/更新 task_list，见 `packages/desktop/src/renderer/types.ts:678` 到 `699`；mobile 只展示 sub-agent task_update，见 `packages/desktop/src/renderer/lib/streamReducer.ts:405` 到 `435` |
| `memory_recalled` | MemoryRead 命中记忆时的可见性信号 | Memory tool：`packages/core/src/tool-system/builtin/memory.ts:158` 到 `173` | 当前 desktop main reducer 未见专门 case，未知事件按 default ignore，见 `packages/desktop/src/renderer/types.ts:1091` 到 `1092`。这是“可被 host 消费”的协议事件 |
| `thinking_delta` | thinking/reasoning live text | 当前 core 源码未见 live producer；类型在 `packages/core/src/types.ts:502`，consumer 已支持 | App 视作 noisy event，见 `packages/desktop/src/renderer/App.tsx:1515` 到 `1519`；主 reducer创建/追加 thinking message，见 `packages/desktop/src/renderer/types.ts:511` 到 `534` |
| `agent_start` | 子代理卡片开始 | Agent tool：`packages/core/src/tool-system/builtin/agent.ts:332` 到 `335` | 主 reducer创建 AgentMessage，见 `packages/desktop/src/renderer/types.ts:701` 到 `734`；mobile reducer创建 subagent row，见 `packages/desktop/src/renderer/lib/streamReducer.ts:437` 到 `449` |
| `agent_backgrounded` | 同步子代理超过阈值后转后台，但仍运行 | Agent handoff：`packages/core/src/tool-system/builtin/agent.ts:842` 到 `847` | 主 reducer标 `backgrounded:true`，并让 `turn_complete` sweep 跳过它，见 `packages/desktop/src/renderer/types.ts:737` 到 `749` |
| `agent_end` | 子代理完成/失败，关闭 agent card | success：`packages/core/src/tool-system/builtin/agent.ts:342` 到 `345`；failure/cancel：`packages/core/src/tool-system/builtin/agent.ts:518` 到 `524`、`782`、`878` | 主 reducer first-terminal-state-wins，见 `packages/desktop/src/renderer/types.ts:767` 到 `797`；mobile reducer设 subagent 状态，见 `packages/desktop/src/renderer/lib/streamReducer.ts:451` 到 `460` |
| `agent_heartbeat` | 后台子代理 liveness ping | heartbeat publisher：`packages/core/src/tool-system/builtin/agent-heartbeat.ts:84` 到 `87`；protocol bus 转发：`packages/core/src/protocol/server.ts:219` 到 `220` | 主 reducer刷新 `lastHeartbeat`，见 `packages/desktop/src/renderer/types.ts:751` 到 `765` |
| `tool_summary` | 工具批摘要，fire-and-forget observability | TurnLoop：`packages/core/src/engine/turn-loop.ts:1037` 到 `1048` | 主 reducer挂到最近 tool，见 `packages/desktop/src/renderer/types.ts:650` 到 `661`；此事件没有 toolCallIds/agentId，已在前文 F-08 讨论过 |
| `context_compact` | 上下文被压缩/手动 compact 后的边界提示 | 自动：Engine `contextManager.setOnCompact`，`packages/core/src/engine/engine.ts:2066` 到 `2074`；手动 query：protocol server，`packages/core/src/protocol/server.ts:1401` 到 `1412` | 主 reducer追加 context boundary，见 `packages/desktop/src/renderer/types.ts:799` 到 `812`；子代理流中 Engine 会过滤该事件避免污染主 ctx bar，见 `packages/core/src/engine/engine.ts:1234` 到 `1246` |
| `usage_update` | ctx bar、cache hit、session cumulative usage 更新 | TurnLoop estimate/authoritative：`packages/core/src/engine/turn-loop.ts:438` 到 `462`、`470` 到 `510`；Engine turn boundary cumulative：`packages/core/src/engine/engine.ts:2150` 到 `2175` | App 视作 noisy event，见 `packages/desktop/src/renderer/App.tsx:1515` 到 `1519`；主 reducer更新 prompt/cache counters，见 `packages/desktop/src/renderer/types.ts:866` 到 `914` |
| `background_agent_completed` | 后台工作完成/失败；包括 agent/shell/video/cc | queue 投影：`packages/core/src/tool-system/builtin/agent-notifications.ts:75` 到 `92`、`199` 到 `214`；protocol server 转发：`packages/core/src/protocol/server.ts:219` 到 `220` | App toast，见 `packages/desktop/src/renderer/App.tsx:1465` 到 `1470`；主 reducer关闭 backgrounded card 并追加 system line，见 `packages/desktop/src/renderer/types.ts:1056` 到 `1088`；SDK convenience filter 见 `packages/core/src/protocol/client.ts:330` 到 `334` |

## 3. 终态/边界事件发射点全景

### 3.1 server.ts / chat-session.ts 的边界发射点

| 位置 | 事件 | 触发条件 | 说明 |
|---|---|---|---|
| `packages/core/src/protocol/server.ts:219` 到 `220` | `agent/streamEvent`，event 来自 `agentNotificationBus` | 后台完成或 heartbeat bus publish | protocol 转发 `background_agent_completed` / `agent_heartbeat`，随后 `maybeWakeIdleSession(sessionId)` |
| `packages/core/src/protocol/server.ts:285` 到 `292` | `agent/streamEvent`，event 来自 woken `session.enqueueTurn()` | idle interactive session 有 pending background notifications，server 合成 injected turn | 仍是 Engine stream 的 envelope 转发，不合成 terminal |
| `packages/core/src/protocol/server.ts:310` 到 `313` | `agent/streamEvent` with `{type:"error"}` | 后台唤醒 turn 的 promise reject，且可能早于 turn-loop 产生任何 terminal/error | protocol 自己合成的 terminal-like error，目的是清 busy；明确不是 `turn_complete` |
| `packages/core/src/protocol/server.ts:491` 到 `499` | `agent/streamEvent`，event 来自 `session.enqueueTurn()` | 多会话 `agent/run` 正常路径 | 纯转发；`sessionId` 使用 run params 的 sid |
| `packages/core/src/protocol/server.ts:585` 到 `601` | `agent/streamEvent`，event 来自 legacy `engine.run()` | legacy single-engine run | 纯转发；sid 为 `params.sessionId ?? ""` |
| `packages/core/src/protocol/server.ts:1401` 到 `1412` | `agent/streamEvent` with `context_compact` | `agent/query {type:"compact"}` 且 `forceCompact()` 后 `before > after` | protocol 自己合成 compact boundary；no-op compact 不发，见 `packages/core/src/protocol/server.compact.test.ts:91` 到 `119` |
| `packages/core/src/protocol/server.ts:1937` 到 `1941` | `agent/approvalRequest` | permission/tool approval backend | 带 `sessionId` 当 `ApprovalRequest.sessionId` 存在；chatManager path 存在 session 时写 session map |
| `packages/core/src/protocol/server.ts:1981` 到 `1990` | `agent/approvalRequest`，`toolName:"__ask_user__"` | per-session AskUserQuestion | 写 `session.pendingApprovals`，notification 必带 sessionId |
| `packages/core/src/protocol/server.ts:2007` 到 `2018` | `agent/approvalResolved` | goal-active AskUser 超时 | 清 pending ask，并通知客户端 dismiss stale card |
| `packages/core/src/protocol/server.ts:2096` 到 `2105` | `agent/approvalRequest`，`toolName:"__browser_action__"` | browser bridge action | per-session pending map + 5min timeout |
| `packages/core/src/protocol/server.ts:2152` 到 `2161` | `agent/approvalRequest`，`toolName:"__credential_action__"` | InjectCredential bridge | per-session pending map + 5min timeout |
| `packages/core/src/protocol/server.ts:2217` 到 `2226` | `agent/approvalRequest`，`toolName:"__workspace_action__"` | workspace switch bridge | per-session pending map + 5min timeout |
| `packages/core/src/protocol/server.ts:2256` 到 `2264` | legacy `agent/approvalRequest` AskUser | legacy single engine askUser | 无 sessionId，走 global pending map |
| `packages/core/src/protocol/chat-session.ts:211` 到 `220` | 无直接发射；把 `onStream` 传给 `engine.run()` | `ChatSession.pump()` 启动队首 turn | ChatSession 是 queue/boundary owner，不是 event producer |
| `packages/core/src/protocol/chat-session.ts:118` 到 `129`、`229` 到 `236` | 无直接发射；cancel 后可能把 active promise resolve 为 `aborted_streaming` result | 用户 Stop / session close | stream terminal 仍依赖 Engine；ChatSession 不补 `turn_complete` 或 `error` |

### 3.2 正常 turn 收口序列

```text
client -> agent/run(sessionId, task)
  server.handleRunMulti
    -> ChatSessionManager.getOrCreate(sessionId)
    -> ChatSession.enqueueTurn(... onStream: notify(agent/streamEvent,{sessionId,event}))
      -> ChatSession.pump()
        -> engine.run(task,{ sessionId:this.id, onStream })
          -> session_started
          -> optional task_update resume snapshot
          -> optional goal_set
          -> stream_request_start
          -> text_delta / tool_use_start / tool_use_args_delta / tool_result / usage_update / ...
          -> assistant_message
          -> Engine epilogue saveState + on_agent_end
          -> turn_complete(completed)
    -> RPC response RunResult
```

注意：`session_title` 是 fire-and-forget，可能在 `turn_complete` 后到达，见 `packages/core/src/engine/engine.ts:2320` 到 `2336`。因此 “每个 turn 一个 terminal” 不等于 “terminal 必然是最后一个 stream event”。

### 3.3 abort / cancel 收口序列

```text
client -> agent/cancel(sessionId)
  server.handleCancel
    -> ChatSession.cancel()
       - abort active controller
       - drain queued turns
    -> cancelSessionApprovals(session)
       - resolve pending asks/approvals as cancelled
    -> cancel RPC response {ok:true}

running engine.run sees the signal at one of several abort gates:
  TurnLoop loop top / context manage / model catch / post-model / outer catch
    -> markStopped()
    -> return { reason:"aborted_streaming" }
  Engine epilogue
    -> save state status=aborted_streaming
    -> turn_complete(aborted_streaming)
  original run RPC response resolves with RunResult
```

关键点：

- protocol cancel path 不发 `turn_complete`，见 `packages/core/src/protocol/server.ts:713` 到 `743`。
- pending approval/ask 会被立即 drain，见 `packages/core/src/protocol/server.ts:2351` 到 `2363`。
- 若 Engine 在某个极早 setup 阶段 reject 且没有产生 stream terminal，ChatSession 只把 promise resolve 成 aborted result，见 `packages/core/src/protocol/chat-session.ts:223` 到 `236`；当前主线依赖 Engine 自己在正常 abort gate 返回并由 epilogue 发 terminal。

### 3.4 max_turns 收口序列（当前代码）

```text
TurnLoop while exits because turnCount >= maxTurns
  -> consume finalize steer
  -> contextManager.manage(messages)
  -> emit usage_update estimate
  -> summary model call(no tools, same onStream)
  -> optional text_delta from summary call
  -> assistant_message(summary)
  -> turn_complete(max_turns)                 [TurnLoop producer, current N-03]
  -> return { reason:"max_turns" }

Engine epilogue
  -> save state status=max_turns
  -> on_agent_end
  -> turn_complete(max_turns)                 [Engine producer]

AgentServer
  -> forwards both as two agent/streamEvent notifications with the same sessionId
```

证据：

- TurnLoop 内部发 terminal：`packages/core/src/engine/turn-loop.ts:1261` 到 `1269`。
- Engine epilogue 发 terminal：`packages/core/src/engine/engine.ts:2340` 到 `2363`。
- `ChatSession` 只传 callback：`packages/core/src/protocol/chat-session.ts:211` 到 `220`。
- `AgentServer` 只转发：`packages/core/src/protocol/server.ts:498` 到 `499`。

因此，protocol 侧没有第三个或独立 `turn_complete` 源。方案 A 删除 `packages/core/src/engine/turn-loop.ts:1268` 后，多会话/legacy protocol live path 都只剩 Engine epilogue 的一条 terminal；方案 A 在 protocol 维度完备。

### 3.5 compact 收口序列

自动 compact（run 内）：

```text
Engine contextManager.setOnCompact callback
  -> context_compact event
  -> TurnLoop drains pendingCompactInfo
  -> optional post_compact hook injection
  -> turn continues
  -> eventual assistant_message / turn_complete
```

证据：`packages/core/src/engine/engine.ts:2066` 到 `2074`，`packages/core/src/engine/turn-loop.ts:675` 到 `684`。

手动 compact query：

```text
client -> agent/query({type:"compact", sessionId})
  server materializes live session if needed
  -> compactEngine.forceCompact(sessionId)
  -> if before > after:
       agent/streamEvent { sessionId, event:{type:"context_compact", ...} }
  -> RPC response { type:"compact", data:result }
```

证据：`packages/core/src/protocol/server.ts:1360` 到 `1384`、`1401` 到 `1419`；no-op 不发 stream event 的测试见 `packages/core/src/protocol/server.compact.test.ts:91` 到 `119`。

## 4. Session 边界与隔离契约

### 4.1 sessionId 贯穿路径

1. Client 必须给多会话 run 传 `sessionId`：`RunParams.sessionId` 是 required，见 `packages/core/src/protocol/types.ts:72` 到 `75`；`handleRunMulti()` 运行时也校验非空，见 `packages/core/src/protocol/server.ts:394` 到 `403`。
2. `ChatSessionManager.getOrCreate(sessionId, slice)` 用 `sessions: Map<string, ChatSession>` 路由，见 `packages/core/src/protocol/chat-session-manager.ts:38` 到 `54`。
3. 同一个 `ChatSession` 内 FIFO 串行：`enqueueTurn()` push queue，`pump()` 一次只跑一个 active，见 `packages/core/src/protocol/chat-session.ts:88` 到 `97`、`203` 到 `220`。
4. `ChatSession.pump()` 强制把 `sessionId: this.id` 传给 `engine.run()`，见 `packages/core/src/protocol/chat-session.ts:211` 到 `216`。
5. `AgentServer` 用 run params 的 sid 包每个 stream event：`packages/core/src/protocol/server.ts:491` 到 `499`。
6. `session_started` 还在 event body 内携带权威 sessionId，见 `packages/core/src/engine/engine.ts:1624` 到 `1630`；desktop 用它加固 route table，见 `packages/desktop/src/renderer/App.tsx:1529` 到 `1552`。

### 4.2 ChatSessionManager 隔离资源

- 每个 UI chat tab 一个 Engine：`ChatSession` 持有 `readonly engine`，见 `packages/core/src/protocol/chat-session.ts:40` 到 `50`。
- `getOrCreate()` 复用 session 时只重新应用 per-send permissionMode，不新建 Engine，见 `packages/core/src/protocol/chat-session-manager.ts:55` 到 `71`。
- 新建 session 超过上限抛 Overloaded，见 `packages/core/src/protocol/chat-session-manager.ts:73` 到 `81`。
- close 时取消 session、清 session path approvals、credential allow、inject credential allow、MCP owner，再删 map，见 `packages/core/src/protocol/chat-session-manager.ts:98` 到 `107`。
- idle sweeper 只 close idle session；显式 worker shutdown `closeAllAsync()` 才 kill 全部 background shell，见 `packages/core/src/protocol/chat-session-manager.ts:123` 到 `135`。

### 4.3 AskUserQuestion 跨会话串投现状

当前代码按 session 隔离，不能只靠 active tab 推断：

- `handleRunMulti()` 每次 run 都把该 session engine 的 `askUser` 设成闭包，闭包捕获 `session` 和 `sid`，见 `packages/core/src/protocol/server.ts:463` 到 `474`。
- `requestAskUserForSession()` 把 resolver 存到 `session.pendingApprovals`，并发带 `sessionId` 的 `agent/approvalRequest`，见 `packages/core/src/protocol/server.ts:1952` 到 `1990`。
- `handleApprove()` 在 chatManager path 中只按 `params.sessionId` 找 session，再按 `requestId` 找该 session 的 pending map；找不到就返回 InvalidParams，不回退 legacy global map，见 `packages/core/src/protocol/server.ts:655` 到 `689`。
- desktop inline ask_user message 保存 originating `engineSessionId`，见 `packages/desktop/src/renderer/types.ts:200` 到 `211`；回答时 `findAskUserOrigin()` 通过 requestId 找回 origin session，而不是用当前 active bucket，见 `packages/desktop/src/renderer/App.tsx:3158` 到 `3184`。
- 回归测试也锁了错 session/requestId 会被拒绝且两个 session pending 都不被解开，见 `packages/core/src/protocol/server.askuser-session-isolation.test.ts:103` 到 `129`。

结论：以当前源码为准，AskUserQuestion 的 protocol/server 侧隔离已按 `(sessionId, requestId)` fail-closed；desktop 回答路径也保存 origin sid。

### 4.4 approval 不随 session 切换重放现状

这里要分 protocol 与 desktop：

- protocol/server 只实时发 `agent/approvalRequest`，没有“查询某 session 当前 pending approvals”或“切换 session replay approval”的 RPC。所有 pending 只存在 server 内存 map：legacy `pendingApprovals` 在 `packages/core/src/protocol/server.ts:149`，per-session `pendingApprovals` 在 `packages/core/src/protocol/chat-session.ts:50`。
- main snapshot 只保留 `agent/streamEvent`，明确非 stream notifications 不入 snapshot，见 `packages/desktop/src/main/parseStreamLine.ts:4` 到 `8`、`22` 到 `25`。因此 approvalRequest/Resolved 不会通过 session snapshot replay。
- desktop renderer 当前用内存 `approvalQueue`、`approvalBucketsRef`、`sessionStatusMap` 维护 session 归属和 sidebar asking 状态，见 `packages/desktop/src/renderer/App.tsx:249` 到 `251`、`433`、`479` 到 `541`。
- 新 approval 到达时按 `env.sessionId` 路由到 bucket 并入队，见 `packages/desktop/src/renderer/App.tsx:1787` 到 `1889`；当前展示给 composer 的 `visibleApproval` 只在 `approvalBucketsRef.current.get(approval.requestId) === activeBucket` 时成立，见 `packages/desktop/src/renderer/App.tsx:2627` 到 `2631`。

结论：当前 protocol 层没有 approval replay 契约；desktop 有内存级跨 session 路由/队列，但刷新或 worker 持续 pending 时不能靠 protocol snapshot 恢复 approval。仅从当前代码看，“随 session 切换重放 approval”不是 protocol 保证。

## 5. Protocol 层不变量清单

1. 每个进入 Engine epilogue 的 run 最多一个 agentId-less `turn_complete`。  
   维护代码：设计上应由 Engine epilogue 发，见 `packages/core/src/engine/engine.ts:2340` 到 `2363`；protocol 只转发，见 `packages/core/src/protocol/server.ts:498` 到 `499`。  
   破坏现象：UI busy/files_changed/turnEpoch 归约重复执行；N-03 当前 `max_turns` 已破坏。

2. `turn_complete` 代表 state save 与 `on_agent_end` 之后的终态边界。  
   维护代码：Engine saveState 在 `packages/core/src/engine/engine.ts:2345` 到 `2353`，`on_agent_end` 在 `2355` 到 `2360`，completion 在 `2362` 到 `2363`。  
   破坏现象：UI 清 busy/折叠后，磁盘状态或 hook side effect 仍未完成；maxTurns 的第一条 TurnLoop terminal 就是反例。

3. 所有 `agent/streamEvent` 必须带正确 `sessionId` envelope。  
   维护代码：multi run path 使用 `sid` 包事件，见 `packages/core/src/protocol/server.ts:491` 到 `499`；background bus 拒绝空 sid，见 `packages/core/src/tool-system/builtin/agent-notifications.ts:165` 到 `174`。  
   破坏现象：renderer route miss、落到 legacy runningBucket 或直接丢事件；多 tab 串流。

4. `ChatSession` 不应合成 terminal stream，只负责队列、signal 和调用 Engine。  
   维护代码：`pump()` 只传 `onStream`，见 `packages/core/src/protocol/chat-session.ts:211` 到 `220`；`cancel()` 只 abort/drain queue，见 `packages/core/src/protocol/chat-session.ts:118` 到 `129`。  
   破坏现象：protocol/ChatSession 成为第三个 terminal producer，方案 A 不再完备。

5. approval/ask 必须按 `(sessionId, requestId)` 解开，不能跨 session fallback。  
   维护代码：`handleApprove()` chatManager branch 见 `packages/core/src/protocol/server.ts:655` 到 `689`；AskUser 存 session map，见 `packages/core/src/protocol/server.ts:1959` 到 `1983`。  
   破坏现象：背景 session 的 AskUser 被 active tab 答案解开；历史串投问题复现。

6. Stop/close 必须 drain session pending approvals。  
   维护代码：cancel path 调 `cancelSessionApprovals(s)`，见 `packages/core/src/protocol/server.ts:735` 到 `743`；closeSession 前也 drain，见 `packages/core/src/protocol/server.ts:974` 到 `979`；具体实现见 `packages/core/src/protocol/server.ts:2351` 到 `2363`。  
   破坏现象：AskUser/tool approval 卡悬挂到 5 分钟 timeout 或永久挂起。

7. `context_compact` 只有实际 shrink 时由 manual compact query 发出。  
   维护代码：`if (result.before > result.after)` 才 notify，见 `packages/core/src/protocol/server.ts:1401` 到 `1413`。  
   破坏现象：UI 出现虚假 compact boundary；no-op compact 也污染 transcript/snapshot。

8. 后台 completion/heartbeat 必须带真实 sessionId。  
   维护代码：NotificationQueue 和 bus 都拒绝 undefined/空 sid，见 `packages/core/src/tool-system/builtin/agent-notifications.ts:75` 到 `92`、`165` 到 `174`。  
   破坏现象：background_agent_completed 落到 legacy bucket 或丢失，idle wakeup 无法定位。

9. error 是 terminal-like 清 busy 信号，但不等同 `turn_complete`。  
   维护代码：wakeup setup failure 发 `error` 而不是 `turn_complete`，见 `packages/core/src/protocol/server.ts:301` 到 `313`；desktop 对 agentId-less `error` 和 `turn_complete` 都清 busy，见 `packages/desktop/src/renderer/App.tsx:1583` 到 `1584`。  
   破坏现象：失败被误标 completed，或 UI busy 卡住。

10. stream snapshot 只保留可重放的 stream events，`steer_injected` 不入 snapshot。  
    维护代码：`parseSnapshotAppend()` 只接受 `agent/streamEvent` 且排除 `steer_injected`，见 `packages/desktop/src/main/parseStreamLine.ts:22` 到 `35`。  
    破坏现象：resume 时 steer user bubble 重复，或非 stream notifications 被当作 transcript replay。

11. protocol query/config 出站前必须脱敏。  
    维护代码：config query 用 `redactLlmConfig()`，见 `packages/core/src/protocol/server.ts:1303` 到 `1305`；providers query 用 `redactSecrets()`，见 `packages/core/src/protocol/server.ts:1491` 到 `1499`；config_set/get 用 `maskSecretValue()`，见 `packages/core/src/protocol/server.ts:1538` 到 `1543`、`1567` 到 `1570`。  
    破坏现象：任何 protocol client 可读取 raw API key / auth header / provider credential。

12. SDK/client surface 应保持多会话 envelope 完整。  
    维护代码：stream 已保持 `{sessionId,event}`，见 `packages/core/src/protocol/client.ts:379` 到 `385`。  
    破坏现象：SDK consumer 无法把 event/approval 决策路由回正确 session；当前 approval channel 存在 N-04。

## 6. 新发现

### N-04：SDK `AgentClient` 的 approval 通知面丢失 session 边界，且不处理 `approvalResolved`

**位置**

- `packages/core/src/protocol/types.ts:319` 到 `325`：`ApprovalRequestNotification` 类型包含可选 `sessionId`。
- `packages/core/src/protocol/server.ts:1937` 到 `1941`、`1981` 到 `1990`：server 会发带 `sessionId` 的 approval/AskUser notification。
- `packages/core/src/protocol/client.ts:41` 到 `45`：`AgentClientEvents.approvalRequest` 只有 `(requestId, request)`。
- `packages/core/src/protocol/client.ts:388` 到 `393`：`handleNotification()` 读取 requestId/request，但丢弃 `params.sessionId`。
- `packages/core/src/protocol/client.ts:375` 到 `402`：switch 不处理 `Methods.ApprovalResolved`。

**现状**

desktop preload 直接透传 raw params，所以 desktop 主路径能拿到 sessionId；但 public `AgentClient` SDK path 会把 approvalRequest 降级成 legacy shape。SDK handler 只知道 requestId/request，不知道 originating sessionId，也收不到 goal AskUser timeout 的 `approvalResolved`。

**为何可疑**

多会话 server 的 `handleApprove()` 在 chatManager path 要求 `params.sessionId` 才会按 session map 解开；否则会落到 legacy global map，见 `packages/core/src/protocol/server.ts:655` 到 `693`。因此 SDK consumer 收到 approvalRequest 后无法可靠调用 `approve(sessionId, requestId, decision)`。这和 stream channel 已经保留 `{sessionId,event}` 的契约不一致。

**严重度**

P2。desktop 主路径不受影响，但 SDK / in-process multi-session consumer 会遇到 approval 无法正确路由或 stale ask 无法 dismiss。

**证据**

上述 file:line 均为源码证据；未跑测试。

### N-05：`goal_cleared` StreamEvent 类型注释与 protocol/server 实际行为不一致

**位置**

- `packages/core/src/types.ts:482` 到 `488`：注释写明 `goal_cleared` fires on explicit clear (`agent/goalClear`)。
- `packages/core/src/protocol/server.ts:825` 到 `846`：`handleGoalClear()` 只返回 `{ ok:true, cleared }`，未 notify `agent/streamEvent`。
- `packages/desktop/src/renderer/App.tsx:3334` 到 `3355`：desktop 清 goal 后本地 dispatch `{ type:"goal_cleared" }` 弥补“没有 live worker/stream”的场景。

**现状**

core/protocol 没有在 `agent/goalClear` 成功后发 `goal_cleared` StreamEvent。desktop 依赖本地 optimistic dispatch 让当前 bucket 的 goal block 立即消失；SDK 或其它 client 若只监听 stream，不会收到类型注释承诺的 clear event。

**为何可疑**

类型注释是 StreamEvent 契约的一部分，且主 reducer/mobile reducer 都支持 `goal_cleared`。如果 server 不发，事件清单里的 producer 与 consumer 断开，外部 protocol consumer 会误以为 explicit clear 可通过 stream 观察到。

**严重度**

P2。不会造成 core 状态未清（server 调 `session.clearGoal()` / legacy clear），但会造成非 desktop-local-injection consumer 的 UI 状态不同步。

**证据**

上述 file:line 均为源码证据；未跑测试。

## 7. 对 N-03 / 方案 A 的交叉结论

问题：protocol 侧是否另有独立发射/转发 `turn_complete` 的源？如果有，方案 A 是否仍完备？

结论：

1. `server.ts` / `chat-session.ts` 未见任何 `{ type:"turn_complete" }` 合成点。`server.ts` 只在 comments 中提到 terminal 清 busy，实际合成的是 `{ type:"error" }`，见 `packages/core/src/protocol/server.ts:301` 到 `313`。
2. protocol live run path 只把 Engine/TurnLoop 的 stream callback 包成 `agent/streamEvent`：多会话见 `packages/core/src/protocol/server.ts:498` 到 `499`，legacy 见 `packages/core/src/protocol/server.ts:585` 到 `601`，background wakeup 见 `packages/core/src/protocol/server.ts:291`。
3. `ChatSession` 不生产 stream event，只传 `onStream` 给 Engine，见 `packages/core/src/protocol/chat-session.ts:211` 到 `220`。
4. 因此，N-03 的重复 terminal 在 protocol 侧不会新增生产者；方案 A 删除 `packages/core/src/engine/turn-loop.ts:1268` 后，protocol 对桌面/SDK live stream 只会转发 Engine epilogue 的单条 `turn_complete(max_turns)`。
5. 未覆盖但不属于 protocol 的点仍是 08 文档已标注的 standalone `query()` terminal 语义和 headless drain 额外 summary/assistant_message 可能性。

## 8. 完成前自查

1. StreamEvent 全量清单已覆盖 26 个 union 成员：从 `session_started` 到 `background_agent_completed`。
2. 非 StreamEvent 的 protocol notifications 已单列：`approvalRequest`、`approvalResolved`、`status`。
3. server/chat-session 的终态或边界类发射点已列：stream 转发、background bus、wakeup error、manual compact、approval request/resolved、status、ChatSession cancel/pump。
4. 四种收口序列已覆盖：正常 turn、abort、max_turns、compact。
5. 已明确回答：protocol 侧没有额外 `turn_complete` producer；方案 A 在 protocol live path 上完备。
6. session 隔离按当前代码说明：AskUserQuestion 已按 `(sessionId, requestId)` 隔离；approval replay 不是 protocol 保证，desktop 当前依赖内存队列。
7. 不变量列出 12 条，每条带维护代码和破坏现象。
8. 新发现从 N-04 开始编号，共 2 条，均有 file:line；没有把推测写成确证。
9. 本文未修改 `packages/**` 源码，未运行 build/test，未 commit。
