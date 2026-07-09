# 优化点清单（B1）

本文件基于 A1/A2 已梳理的架构，只覆盖 core 引擎（engine / tool-system / protocol）与普通 desktop renderer 消费流。未展开 tui / cdp / mobile，也不把 `engine.ts` 待拆、arena 纠缠、engine↔tool-system 循环依赖等已知债务泛泛重复为 finding。

## Findings 汇总

| 编号 | 标题 | 严重度 | 一句话 |
|---|---|---|---|
| F-01 | streaming fallback 的撤销/补偿契约在桌面链路不可用 | P1 | core 发 `tombstone(turn_N)` 并用 `assistant_message` 带最终文本，但 desktop 用本地 message id 删除且只把 `assistant_message` 当封口事件。 |
| F-02 | `stream_request_start` 用 `activeAgents` 推断归属，运行态一脏就压掉主回复槽 | P1 | desktop 用“是否有 active agent”判断请求是否属于子代理，但部分收尾路径只改 message、不清 `activeAgents`。 |
| F-03 | coalescer 按 agent 合并 delta，却没有在硬边界上切段 | P1 | 50ms 窗口内跨 `turn_complete` / `stream_request_start` / tool 边界的 delta 会被合并回第一次出现的位置。 |
| F-04 | snapshot 的 seq 游标只存在于重放路径，live IPC 没有对齐游标 | P1 | main 给 snapshot 打 seq，但 live 事件仍只发原 JSON line，renderer 无法持续推进 `sinceSeq`。 |
| F-05 | `requireExisting` 先创建 live session 再拒绝缺失磁盘会话 | P2 | protocol 能做到“不 run”，但仍可能把一个空 `ChatSession` 留在 manager 里。 |
| F-06 | `pre_tool_use: ask` 用户同意后会跳过 classifier deny/rules | P1 | hook 的 ask 分支发生在 permission classify 前，批准后不再执行 classifier。 |
| F-07 | builtin capability 的 `off` 可热生效，`on` 受构造期 frozen registry 限制 | P2 | 项目级动态能力开关语义不对称，启用被全局禁用的 builtin 需要重启 session。 |
| F-08 | `tool_summary` 没有目标 id / agent 契约，desktop 只能挂到最近顶层工具 | P2 | 子代理 summary 可被误挂到主 feed 工具，或在无顶层工具时丢失。 |

## 详细 findings

### F-01 streaming fallback 的撤销/补偿契约在桌面链路不可用
- 位置：`packages/core/src/engine/turn-loop.ts:1335`、`packages/desktop/src/renderer/types.ts:916`、`packages/desktop/src/renderer/types.ts:664`
- 现状：streaming 模型调用失败时，core 发 `{ type:"tombstone", messageId: "turn_${turnCount}" }`，然后 retry non-streaming；无工具终态再发 `assistant_message`，其中 `message.content` 是最终文本。普通 desktop reducer 则在 `tombstone` 分支按本地 `Message.id` 精确删除，而 `stream_request_start` 创建的是 `freshId("assistant")`；`assistant_message` 分支也只把当前 assistant 标成 `done`，不把 `message.content` 写回 UI 文本。
- 为什么不合理：A2 的流式 fallback 设计意图是“撤销已经部分显示的 streaming 内容，再显示 non-streaming 的最终结果”。现在 producer 的撤销 id 与 consumer 的 message id 不在同一命名空间，补偿事件又被 consumer 当作纯封口事件，导致 fallback 路径无法可靠替换 UI 内容。这是 core StreamEvent 契约与 desktop reducer 语义不一致，影响正确性。
- 影响面：普通 desktop `MessageStream` 的 streaming fallback；主要改动半径在 core `StreamEvent` 相关字段、`TurnLoop` fallback 发事件方式、desktop `applyStreamEvent` 消费语义。
- 建议方向：给 `stream_request_start` 产生并下发稳定的 request/message correlation id，`tombstone` 使用同一 id；或者让 desktop `tombstone` 明确撤销当前 `streamingAssistantId`。同时让 `assistant_message` 在 fallback / 无 delta 场景能 upsert 最终文本，而不是只封口。
- 严重度：P1
- 证据：core fallback 发 `messageId: turn_${turnCount}` 见 `packages/core/src/engine/turn-loop.ts:1335`；desktop tombstone 按 message id 查找删除见 `packages/desktop/src/renderer/types.ts:918`；desktop assistant_message 只标 done 见 `packages/desktop/src/renderer/types.ts:664`；live assistant id 来自 `freshId("assistant")` 见 `packages/desktop/src/renderer/types.ts:448`。

### F-02 `stream_request_start` 用 `activeAgents` 推断归属，运行态一脏就压掉主回复槽
- 位置：`packages/desktop/src/renderer/types.ts:443`、`packages/desktop/src/renderer/types.ts:944`、`packages/desktop/src/renderer/types.ts:1056`
- 现状：desktop 收到 `stream_request_start` 时，只要 `state.activeAgents` 非空就直接 return，不创建主 assistant streaming slot。`agent_end` 会从 `activeAgents` 删除，但 `turn_complete` 的 orphan sweep 只把 agent message 标 done，`background_agent_completed` 也只更新 message 并追加 system 行，都没有清理 `activeAgents`。
- 为什么不合理：A2 的端到端链路依赖 `stream_request_start` 创建稳定的 live assistant accumulator，后续主 `text_delta` 才有地方落。用“当前是否存在 active agent”反推事件归属，是把 renderer 的易脏运行态当作协议路由条件；一旦 agent_end 丢失、后台完成只走 `background_agent_completed`，或 orphan sweep 生效但 `activeAgents` 残留，后续顶层 run 的 `stream_request_start` 会被压掉，主 `text_delta` 因没有 `streamingAssistantId` 被忽略。
- 影响面：desktop 多代理/后台代理之后的普通顶层流式回复；改动半径在 `StreamEvent.stream_request_start` agent 归属、desktop reducer 的 active agent 清理和 slot 创建逻辑。
- 建议方向：不要用 `Object.keys(activeAgents).length` 判定 `stream_request_start` 归属。优先使用事件自带 `agentId`：子代理 request_start 路由到 agent card 或忽略，顶层 request_start 一律创建主 slot。并在 orphan sweep / `background_agent_completed` 中同步清理 `activeAgents`。
- 严重度：P1
- 证据：`stream_request_start` 非空 activeAgents 直接 return 见 `packages/desktop/src/renderer/types.ts:447`；主 `text_delta` 无 `streamingAssistantId` 直接 return 见 `packages/desktop/src/renderer/types.ts:500`；orphan sweep 遍历 activeAgents 但返回时不修改 activeAgents 见 `packages/desktop/src/renderer/types.ts:944`、`packages/desktop/src/renderer/types.ts:1027`；`background_agent_completed` 返回也不修改 activeAgents 见 `packages/desktop/src/renderer/types.ts:1082`。

### F-03 coalescer 按 agent 合并 delta，却没有在硬边界上切段
- 位置：`packages/desktop/src/renderer/streamCoalescer.ts:35`、`packages/desktop/src/renderer/streamCoalescer.ts:104`、`packages/core/src/protocol/chat-session.ts:251`
- 现状：coalescer 用 `text|agentId` 作为 `text_delta` 合并 key，重复 delta 只追加到已有 slot，保留第一次出现的位置；`tool_use_start`、`assistant_message`、`turn_complete`、`stream_request_start` 等边界事件只是 passthrough 进同一个 50ms batch，不会 flush 或重置 delta slot。core 的 `ChatSession` 在 finally 中会立即 pump 队列里的下一 turn。
- 为什么不合理：desktop reducer 把这些边界事件当状态机转移：开槽、封口、折叠、切下一轮。如果一个 50ms 窗口内先有上一轮 delta，再有 `turn_complete`，再有下一轮 `stream_request_start` 和新 delta，新 delta 会被合并到第一次 delta 的位置，在 reducer 看来发生在上一轮封口前。这个优化破坏了 A2 依赖的事件到达顺序。
- 影响面：普通 desktop 高频 streaming，尤其 fast second send / queue drain / 子代理密集事件；改动半径在 `streamCoalescer.ts` 和其测试，不需要改 core。
- 建议方向：把 coalescer 变成 segment-aware：遇到 hard boundary 前先 flush 当前 batch，或至少在 `turn_complete`、`assistant_message`、`stream_request_start`、`tool_use_start` 等边界后换新的 delta key。更稳的方案是 core 在 `stream_request_start` 下发 turn/request id，coalescer 按 request id 合并。
- 严重度：P1
- 证据：slot “first seen” 顺序与重复 delta 不重新 append 的注释见 `packages/desktop/src/renderer/streamCoalescer.ts:35`；text delta 合并逻辑见 `packages/desktop/src/renderer/streamCoalescer.ts:104`；边界事件 passthrough 但不 flush 见 `packages/desktop/src/renderer/streamCoalescer.ts:145`；queued turn 完成后立即 pump 下一项见 `packages/core/src/protocol/chat-session.ts:251`。

### F-04 snapshot 的 seq 游标只存在于重放路径，live IPC 没有对齐游标
- 位置：`packages/desktop/src/main/SessionSnapshotStore.ts:10`、`packages/desktop/src/main/agent-bridge.ts:203`、`packages/desktop/src/preload/index.ts:159`、`packages/desktop/src/renderer/App.tsx:823`
- 现状：main 的 `SessionSnapshotStore` 给每个 event 分配 per-session `seq`，并支持 `get(sessionId, sinceSeq)`。但 live path 仍通过 `safeSend("agent:msg", line)` 发原 JSON-RPC line，preload 转给 renderer 的 envelope 只有 `{ sessionId, event }`，没有 seq。renderer 只在 `base.messages.length === 0` 时 `subscribeSession(engineId, 0)` 并设置 `appliedSeqRef`；正常 live 事件没有 seq 可推进 cursor。
- 为什么不合理：A2 说明 snapshot 是 renderer remount / HMR / crash recovery 的补偿层，目标是“无 gap、无重复”。现在 cursor 只在 snapshot replay 内部成立，live 消费无法和 main snapshot 的 seq 对齐，所以非空 local/disk projection 不能安全地“从最后已应用 seq 补尾”。代码只能用 empty-only replay 避免重复，这牺牲了已有消息后的 missed tail。
- 影响面：desktop renderer reload/HMR/crash recovery；改动半径在 main `agent:msg` wire、preload envelope、renderer snapshot replay 和持久化 cursor。
- 建议方向：把 main 分配的 seq 一并放进 live envelope，或新增 `agent:streamEvent` IPC payload `{ sessionId, event, seq }`，让 renderer 每次 live apply 后推进 cursor。更长期可以把稳定 event id/timestamp 下沉到 core/protocol StreamEvent envelope，而不是只在 main 内存层补。
- 严重度：P1
- 证据：snapshot seq 设计见 `packages/desktop/src/main/SessionSnapshotStore.ts:10`；main append 后仍转发原 line 见 `packages/desktop/src/main/agent-bridge.ts:203`、`packages/desktop/src/main/agent-bridge.ts:208`；preload envelope 无 seq 见 `packages/desktop/src/preload/index.ts:159`；renderer 只在空 base 时 replay snapshot 见 `packages/desktop/src/renderer/App.tsx:823`，`appliedSeqRef` 只在该 replay 分支设置见 `packages/desktop/src/renderer/App.tsx:829`。

### F-05 `requireExisting` 先创建 live session 再拒绝缺失磁盘会话
- 位置：`packages/core/src/protocol/server.ts:411`、`packages/core/src/protocol/server.ts:424`、`packages/core/src/protocol/chat-session-manager.ts:53`
- 现状：`AgentServer.handleRunMulti()` 先调用 `chatManager.getOrCreate(params.sessionId, ...)`，随后才检查 `params.requireExisting === true && !session.engine.sessionExistsOnDisk(...)` 并返回 `SessionNotFound`。`ChatSessionManager.getOrCreate()` 在不存在时会创建 Engine、创建 `ChatSession`、写入 `sessions` map。
- 为什么不合理：`requireExisting` 的设计意图是“继续一个已存在会话；如果磁盘会话被删，必须显式失败，避免在空白上下文执行”。当前虽然没有执行 prompt，但已经创建了一个 live 空 session，并打开 session path approvals；这与“不创建空白会话”的隔离语义不一致，也会占用 `maxSessions` 名额。
- 影响面：protocol 多会话路径，尤其 cron/automation 或 background wakeup 对已删除 session 的 continue；改动半径在 `AgentServer.handleRunMulti()` 和 `ChatSessionManager` 查询/创建边界。
- 建议方向：在 `getOrCreate()` 前做存在性检查，或让 manager 提供“只取现有 live session，不存在时不创建”的路径；如果必须借 Engine 判断磁盘状态，则失败后立即 `close(sessionId)` 并加测试断言 `chatManager.get(sessionId) === undefined`。
- 严重度：P2
- 证据：先 `getOrCreate` 见 `packages/core/src/protocol/server.ts:411`；后检查 `requireExisting` 见 `packages/core/src/protocol/server.ts:424`；manager 创建并保存 session 见 `packages/core/src/protocol/chat-session-manager.ts:78`。现有测试只断言未 run，见 `packages/core/src/protocol/server.require-existing.test.ts:61`、`packages/core/src/protocol/server.require-existing.test.ts:80`。

### F-06 `pre_tool_use: ask` 用户同意后会跳过 classifier deny/rules
- 位置：`packages/core/src/tool-system/executor.ts:264`、`packages/core/src/tool-system/executor.ts:334`、`packages/core/src/tool-system/executor.ts:366`、`packages/core/src/tool-system/permission.ts:930`
- 现状：`ToolExecutor.executeSingle()` 先执行 `pre_tool_use` hook。若 hook 返回 `ask`，则调用 `permission.handleAsk()`；用户批准后继续执行，并且后续 classifier 分支被 `if (hookResult.decision !== "ask")` 跳过。`PermissionClassifier.classify()` 中的显式规则匹配发生在 classifier 内，`handleAsk()` 本身只处理 `dontAsk`、`bypassPermissions`、denial tracker 和 UI approval。
- 为什么不合理：A1 梳理的权限设计意图是 classifier / 用户是授权来源，hook 可以收紧但不能把 deny/ask 升级成 allow。现在 hook 的 `ask` 分支发生在 classifier 之前，批准后直接绕过显式 deny rule 或 classifier 的其它拒绝逻辑，相当于把“hook 要求额外确认”变成了“hook 替代 classifier”。这是权限一致性问题。
- 影响面：core tool-system 所有支持 hook 的工具执行；改动半径集中在 `ToolExecutor.executeSingle()` 的顺序和 permission 测试。
- 建议方向：在 path policy 与 hook rewrite 后先计算 classifierDecision。若 classifierDecision 是 `deny`，hook `ask` 不能覆盖；若 classifierDecision 是 `ask`，可以把 hook reason 合并进同一次 prompt；若 classifierDecision 是 `allow`，hook `ask` 才是降级。这样仍避免双弹窗，但保持 deny > ask > allow。
- 严重度：P1
- 证据：pre hook 先于 classifier 执行见 `packages/core/src/tool-system/executor.ts:264`；hook ask 批准路径见 `packages/core/src/tool-system/executor.ts:334`；classifier 被 ask 分支跳过见 `packages/core/src/tool-system/executor.ts:366`；显式 permission rules 在 classifier 内匹配见 `packages/core/src/tool-system/permission.ts:930`；`handleAsk()` 的 `dontAsk` fast-fail 见 `packages/core/src/tool-system/permission.ts:972`。

### F-07 builtin capability 的 `off` 可热生效，`on` 受构造期 frozen registry 限制
- 位置：`packages/core/src/engine/engine.ts:267`、`packages/core/src/engine/engine.ts:562`、`packages/core/src/engine/engine.ts:1754`
- 现状：Engine 构造时把 `capabilityOverrides.builtin` 与全局 enabled/disabled list 合并，生成构造期 frozen builtin tool set。每 turn 会重新读 override，并用 `applyBuiltinOverrideVisibility()` 隐藏 `off` 工具，同时把 `off` 交给 executor 做执行期拒绝；但 `on` / `inherit` 只能保留 registry 里已经存在的工具，无法把构造期没注册的 builtin 加回来。
- 为什么不合理：项目级 capability override 的用户语义是动态覆盖项目能力，A1 也说明 skills/plugins/agents 的 `off` 会按 turn 生效。builtin 这里变成单向热更新：禁用可靠，启用不可靠且需要 session restart。这会让同一设置面板/项目配置出现不一致行为，增加测试和排障成本。
- 影响面：core Engine builtin registry、desktop capability settings 对下一条消息生效的预期；改动半径取决于方案，最小可在 UI/文档标明 restart，较完整方案要调整 registry/visibility 分层。
- 建议方向：把“工具定义注册全集”和“本 turn 可见/可执行集合”拆开：registry 持有 preset/host 支持的 builtin 全集，per-turn visibility 决定展示，executor 决定执行；或在安全边界清晰的前提下支持 per-session registry rebuild。无论哪种，都让 `on` / `off` 语义对称。
- 严重度：P2
- 证据：`applyBuiltinOverrideVisibility()` 注释明确“can't re-add ctor-frozen registry omitted”见 `packages/core/src/engine/engine.ts:267`；构造期 frozen set 注释见 `packages/core/src/engine/engine.ts:569`；per-turn 只能 hide 不能 add 的注释见 `packages/core/src/engine/engine.ts:1754`；实际 toolDefs 从当前 registry 过滤而来见 `packages/core/src/engine/engine.ts:1808`。

### F-08 `tool_summary` 没有目标 id / agent 契约，desktop 只能挂到最近顶层工具
- 位置：`packages/core/src/types.ts:534`、`packages/core/src/engine/turn-loop.ts:1041`、`packages/core/src/engine/engine.ts:1246`、`packages/desktop/src/renderer/types.ts:650`
- 现状：`StreamEvent` 里的 `tool_summary` 只有 `{ summary }`，没有 `toolCallId`、`agentId` 或 batch id。TurnLoop 在工具结果后异步生成 summary；子 Engine 的 stream events 会被 parent 包一层 `agentId` 转发，但类型没有声明 `tool_summary.agentId`。desktop reducer 注释也承认 `tool_summary has no agentId`，于是把 summary 挂到最近一个顶层 tool message。
- 为什么不合理：A2 的桌面分组设计把主 feed、agent card、tool group 分开，依赖事件可路由。`tool_summary` 是唯一既没有目标工具 id、也没有 agent 契约的工具相关事件；它既不能表达“这是整个工具 batch 的 summary”，也不能表达“这是某个子代理的 summary”。结果是子代理 summary 可能误挂到主 feed 最近工具，或无顶层工具时直接丢失。
- 影响面：desktop 工具卡片 summary、子代理 inline card；改动半径在 `StreamEvent` 类型、TurnLoop 发 summary 的 payload、desktop reducer 渲染位置。
- 建议方向：明确 `tool_summary` 的语义。如果是 batch summary，给它 `agentId?`、`toolCallIds` 或 `turnNumber/requestId`，由 `TurnProcessGroupCard` / agent card 渲染为 group-level summary；如果只服务顶层工具卡片，则 parent wrapper 应过滤子代理 `tool_summary`，避免误挂。
- 严重度：P2
- 证据：StreamEvent 定义只有 summary 见 `packages/core/src/types.ts:534`；TurnLoop 发送 summary 见 `packages/core/src/engine/turn-loop.ts:1041`、`packages/core/src/engine/turn-loop.ts:1048`；子代理事件统一 spread agentId 见 `packages/core/src/engine/engine.ts:1246`；desktop 挂到最近顶层 tool 见 `packages/desktop/src/renderer/types.ts:650`、`packages/desktop/src/renderer/types.ts:654`。

## 建议处理顺序

1. 先处理 F-01、F-02、F-03：这三条都在 desktop 主流链路的状态机边界，会直接影响 token 是否落到正确 message，以及异常 fallback 是否能恢复。
2. 再处理 F-06：这是 tool-system 权限链的顺序问题，半径小，但安全语义重要。
3. 然后处理 F-04：需要改 main/preload/renderer wire，适合和 snapshot replay 测试一起做。
4. 最后处理 F-05、F-07、F-08：分别是 protocol 资源清理、capability 语义一致性、工具 summary 契约完善，优先级低于主流链路正确性。
