# P1 深挖与修复技术设计

本文只展开 `03-optimization-findings.md` 中 5 条 P1：F-01、F-02、F-03、F-04、F-06。P2 finding 不在本轮展开。

边界约束沿用仓库说明：包管理器用 bun，不用 npm/yarn/pnpm；核心代码在 `packages/core/`；`typecheck` 有存量错误，不把它当作本轮门禁；core 不得 import tui；desktop renderer 不得 runtime import codeshell 包，只能走 `window.codeshell.*` 或 type-only import，见 `CODESHELL.md:21`、`CODESHELL.md:49`、`CODESHELL.md:50`、`CODESHELL.md:51`。

## F-01 streaming fallback 的撤销/补偿契约在桌面链路不可用

### 1. 根因链

1. core 的流式回退路径确实会先尝试 streaming，再在非 context / 非 abort 错误时 fallback 到 non-streaming；注释明确写着“emit tombstone and retry non-streaming”，见 `packages/core/src/engine/turn-loop.ts:1272`、`packages/core/src/engine/turn-loop.ts:1276`、`packages/core/src/engine/turn-loop.ts:1334`。
2. fallback 撤销事件使用 `messageId: turn_${this.turnCount}`，这个 id 只来自 TurnLoop 内部 turn 计数，见 `packages/core/src/engine/turn-loop.ts:1335`。同一轮开始时发出的 `stream_request_start` 只有 `turnNumber`，没有同一个 message/correlation id，见 `packages/core/src/engine/turn-loop.ts:605`；类型也只声明了 `turnNumber` 与可选 `agentId`，见 `packages/core/src/types.ts:444`。
3. desktop reducer 收到 `stream_request_start` 时自己生成 `freshId("assistant")` 作为 UI message id，见 `packages/desktop/src/renderer/types.ts:443`、`packages/desktop/src/renderer/types.ts:448`、`packages/desktop/src/renderer/types.ts:453`、`packages/desktop/src/renderer/types.ts:455`。这个 id 与 core 发出的 `turn_N` 不在同一命名空间。
4. desktop 的 `tombstone` 按 `state.messages.findIndex((m) => m.id === event.messageId)` 精确删除，找不到就 no-op，见 `packages/desktop/src/renderer/types.ts:916`、`packages/desktop/src/renderer/types.ts:918`、`packages/desktop/src/renderer/types.ts:919`。因此 `turn_N` 无法删除 `assistant-时间戳-counter`。
5. fallback 的 non-streaming 响应最终会走普通无工具终态：`assistant_message` 携带 `message.content = finalText`，见 `packages/core/src/engine/turn-loop.ts:879`、`packages/core/src/engine/turn-loop.ts:880`、`packages/core/src/engine/turn-loop.ts:881`。但 desktop 的 `assistant_message` 分支只把当前 streaming assistant 标记 `done`，没有读取或写回 `event.message.content`，见 `packages/desktop/src/renderer/types.ts:664`、`packages/desktop/src/renderer/types.ts:667`、`packages/desktop/src/renderer/types.ts:670`、`packages/desktop/src/renderer/types.ts:672`。
6. 结果是：partial delta 留在 UI 里，tombstone 撤不掉；最终 non-streaming 文本在事件里存在，但 reducer 不消费。03 已把这个总结为 producer/consumer 契约不一致，见 `docs/review-2026-07-09/03-optimization-findings.md:20`、`docs/review-2026-07-09/03-optimization-findings.md:22`、`docs/review-2026-07-09/03-optimization-findings.md:23`。

### 2. 复现/触发路径

1. 用户发起一次普通 desktop 顶层对话，TurnLoop 先发 `stream_request_start`，desktop 创建一个本地 id 的 assistant slot，见 `packages/core/src/engine/turn-loop.ts:605`、`packages/desktop/src/renderer/types.ts:448`。
2. provider streaming 已经发出至少一个 `text_delta`，desktop 将 token 追加到 `streamingAssistantId` 指向的 message，见 `packages/core/src/engine/model-facade.ts:81`、`packages/desktop/src/renderer/types.ts:486`、`packages/desktop/src/renderer/types.ts:500`、`packages/desktop/src/renderer/types.ts:505`。
3. streaming call 抛出非 `ContextLimitError`、非 abort 错误；TurnLoop 发 `tombstone(turn_N)` 并调用 `callWithoutStreaming()`，见 `packages/core/src/engine/turn-loop.ts:1316`、`packages/core/src/engine/turn-loop.ts:1318`、`packages/core/src/engine/turn-loop.ts:1332`、`packages/core/src/engine/turn-loop.ts:1335`、`packages/core/src/engine/turn-loop.ts:1342`。
4. desktop tombstone 找不到 `turn_N` 对应 message，partial text 继续留在 state，见 `packages/desktop/src/renderer/types.ts:918`、`packages/desktop/src/renderer/types.ts:919`。
5. non-streaming 返回最终文本后，TurnLoop 发 `assistant_message(finalText)`，desktop 只封口不替换文本；用户可见结果是 partial text 或空 assistant bubble 被标记 done，见 `packages/core/src/engine/turn-loop.ts:879`、`packages/desktop/src/renderer/types.ts:664`、`packages/desktop/src/renderer/types.ts:672`。

### 3. 影响边界

1. 直接影响普通 desktop `MessageStream` 的主 assistant bubble；A2 说明主 desktop 链路是 `transcriptsReducer` 调 `types.ts` 的 `applyStreamEvent`，不是 mobile/CC Room 的 `lib/streamReducer.ts`，见 `docs/review-2026-07-09/02-desktop-stream-walkthrough.md:75`、`docs/review-2026-07-09/02-desktop-stream-walkthrough.md:78`。
2. core 侧需要改 `StreamEvent` 契约与 `TurnLoop` emit 方式，位置集中在 `packages/core/src/types.ts:444`、`packages/core/src/types.ts:461`、`packages/core/src/types.ts:490`、`packages/core/src/engine/turn-loop.ts:605`、`packages/core/src/engine/turn-loop.ts:1335`。
3. desktop 侧需要改 `MessagesReducerState` 的 streaming id 使用、`stream_request_start`、`assistant_message`、`tombstone` 三个 reducer 分支，位置集中在 `packages/desktop/src/renderer/types.ts:282`、`packages/desktop/src/renderer/types.ts:443`、`packages/desktop/src/renderer/types.ts:664`、`packages/desktop/src/renderer/types.ts:916`。
4. 协议层只转发裸 `StreamEvent` 加 `sessionId` envelope，见 `packages/core/src/protocol/server.ts:498`、`packages/core/src/protocol/server.ts:499`；如果只扩展 `StreamEvent` 字段，不需要让 renderer runtime-import core。

### 4. 修复方案

1. 在 `packages/core/src/types.ts` 扩展事件契约，保持向后兼容：
   - `stream_request_start` 增加 `messageId?: string`。
   - `assistant_message` 增加 `messageId?: string`。
   - `tombstone` 保持 `messageId`，必要时增加 `agentId?: string` 以匹配子代理 wrapper 当前会在运行时 spread `agentId` 的事实，见 `packages/core/src/engine/engine.ts:1246`。
2. 在 `packages/core/src/engine/turn-loop.ts` 的每个顶层 turn 开始处生成稳定 id，例如基于 `turnId` 而不是只基于 `turnCount`。`turnId` 已在 loop 内生成并用于日志，见 `packages/core/src/engine/turn-loop.ts:596`、`packages/core/src/engine/turn-loop.ts:597`。建议形如 `assistant_${turnId}`，避免同一 session resume 或子 Engine 的 `turn_1` 碰撞。
3. `stream_request_start` emit 时带上 `messageId`，见当前 emit 点 `packages/core/src/engine/turn-loop.ts:605`。
4. 将该 `messageId` 传入 `callModelWithFallback()`，fallback tombstone 使用同一 id，替换当前 `turn_${this.turnCount}`，见当前 tombstone 点 `packages/core/src/engine/turn-loop.ts:1335`。
5. 所有本 turn 终态 `assistant_message` 尽量带同一 `messageId`，至少覆盖无工具正常结束和 fallback non-streaming 结束，见当前无工具终态 `packages/core/src/engine/turn-loop.ts:879`、`packages/core/src/engine/turn-loop.ts:881`。goal budget、max-turn summary 等特殊路径也可以带 id，但如果没有对应 `stream_request_start`，字段保持可选即可，见 `packages/core/src/engine/turn-loop.ts:866`、`packages/core/src/engine/turn-loop.ts:1262`。
6. 在 `packages/desktop/src/renderer/types.ts`：
   - `stream_request_start` 顶层 slot 的 id 优先使用 `event.messageId`，无字段时才回退 `freshId("assistant")`，见当前生成点 `packages/desktop/src/renderer/types.ts:448`。
   - `tombstone` 删除匹配 message 后，如果删除的是 `state.streamingAssistantId`，同步把 `streamingAssistantId` 清空；当前 tombstone 只改 `messages` 和 `agentMessageIndex`，见 `packages/desktop/src/renderer/types.ts:916`、`packages/desktop/src/renderer/types.ts:929`。
   - `assistant_message` 增加 `assistantMessageToText(content)` helper：`string` 直接返回；`ContentBlock[]` 只拼接 text block；没有可展示文本时保留当前 message text。这个 helper 只在 renderer 本地处理 shape，不引入 runtime codeshell import。
   - `assistant_message` 优先按 `event.messageId` 找 assistant；找不到但有最终文本时 append 一条 `done:true` assistant message；找到则用最终文本覆盖 streaming 累积文本并标 done。无 `messageId` 时保留现有 `streamingAssistantId` fallback。
7. 不建议让 desktop tombstone 特判 `turn_N` 或“删除当前 streamingAssistantId”作为最终方案；这会继续依赖隐含状态，且无法把 fallback 的最终文本与正确 request 绑定。可以作为临时兼容分支，但主契约应是 core 下发稳定 id。

### 5. TDD 测试点

1. `packages/core/src/engine/turn-loop-streaming-fallback.test.ts` 新增 TurnLoop harness：
   - 场景：fake model 的 `call()` 先通过 `onStream` 发 `text_delta("partial")` 后抛错，`callWithoutStreaming()` 返回 `{ text:"final", toolCalls:[] }`。
   - 断言：事件序列包含 `stream_request_start.messageId`；`tombstone.messageId` 等于该 id；`assistant_message.message.content === "final"` 且 `assistant_message.messageId` 等于该 id；最终 result text 是 `"final"`。
   - 可复用现有 TurnLoop fake deps 模式，参考 `packages/core/src/engine/turn-loop-summary-safety.test.ts:11`、`packages/core/src/engine/turn-loop-summary-safety.test.ts:17`、`packages/core/src/engine/turn-loop-summary-safety.test.ts:30`。
2. `packages/desktop/src/renderer/types.test.ts` 新增 reducer 测试：
   - 场景：`stream_request_start({ messageId:"m1" })` → `text_delta("partial")` → `tombstone({ messageId:"m1" })`。
   - 断言：assistant message 被删除，`streamingAssistantId === null`，不会残留 partial。
3. `packages/desktop/src/renderer/types.test.ts` 新增 fallback 补偿测试：
   - 场景：上一条 tombstone 后再发 `assistant_message({ messageId:"m1", message:{ role:"assistant", content:"final" } })`。
   - 断言：state 中有一条 assistant，`text === "final"`、`done === true`、`doneAt` 有值。
4. `packages/desktop/src/renderer/types.test.ts` 新增 canonical final 覆盖测试：
   - 场景：正常 streaming `text_delta("fin")` 后 `assistant_message({ messageId:"m1", content:"final" })`。
   - 断言：最终 assistant text 是 `"final"` 而不是 `"fin"`，防止漏 token 或 fallback 后 partial 被封口。

### 6. 风险与回归面

1. `StreamEvent` 类型扩展会影响 core、desktop preload type、renderer type-only import；需跑相关 bun 测试，不要用 npm，见 `CODESHELL.md:23`、`CODESHELL.md:28`。
2. `assistant_message` 从“只封口”变成“可覆盖最终文本”可能改变正常 streaming 的显示结果；这是预期修复，但要重点跑 `packages/desktop/src/renderer/types.test.ts` 与 `packages/desktop/src/renderer/messages/AssistantMessageView.test.tsx`。
3. tombstone 删除 message 后会调整 `agentMessageIndex`，当前逻辑已有索引重写，见 `packages/desktop/src/renderer/types.ts:921`、`packages/desktop/src/renderer/types.ts:927`；改动时不能破坏子代理 card index。
4. 子代理事件会经 parent wrapper spread `agentId`，见 `packages/core/src/engine/engine.ts:1246`。如果给 tombstone/assistant_message 增加 `agentId` 类型，desktop 必须避免把子代理终态误写到主 assistant。

## F-02 `stream_request_start` 用 `activeAgents` 推断归属，运行态一脏就压掉主回复槽

### 1. 根因链

1. `StreamEvent` 类型已经允许 `stream_request_start` 携带 `agentId?: string`，见 `packages/core/src/types.ts:444`。子 Engine 的事件会在 parent wrapper 中统一 spread `agentId: req.agentId`，见 `packages/core/src/engine/engine.ts:1226`、`packages/core/src/engine/engine.ts:1246`。
2. desktop reducer 的 `stream_request_start` 分支没有看 `event.agentId`。它的注释说“event itself doesn't carry agentId”，并用 `Object.keys(state.activeAgents).length > 0` 判断这是子代理 request，见 `packages/desktop/src/renderer/types.ts:443`、`packages/desktop/src/renderer/types.ts:444`、`packages/desktop/src/renderer/types.ts:445`、`packages/desktop/src/renderer/types.ts:447`。这条注释已与当前类型和 wrapper 行为不一致。
3. 顶层 `text_delta` 必须依赖 `streamingAssistantId` 已存在；没有 slot 时直接 return state，见 `packages/desktop/src/renderer/types.ts:500`。因此一个错误 return 的 `stream_request_start` 会让后续主回复 token 全部丢失。
4. `activeAgents` 在 `agent_start` 时写入，见 `packages/desktop/src/renderer/types.ts:701`、`packages/desktop/src/renderer/types.ts:706`、`packages/desktop/src/renderer/types.ts:708`；正常 `agent_end` 会删除，见 `packages/desktop/src/renderer/types.ts:767`、`packages/desktop/src/renderer/types.ts:769`、`packages/desktop/src/renderer/types.ts:796`。
5. 但 `turn_complete` 的 orphan sweep 只遍历 `state.activeAgents`、刷新/标记 agent message，没有从 `activeAgents` 删除被 clean sweep 的 orphan；return 里也没有写 `activeAgents`，见 `packages/desktop/src/renderer/types.ts:932`、`packages/desktop/src/renderer/types.ts:944`、`packages/desktop/src/renderer/types.ts:950`、`packages/desktop/src/renderer/types.ts:956`、`packages/desktop/src/renderer/types.ts:1027`、`packages/desktop/src/renderer/types.ts:1033`。
6. `background_agent_completed` 分支同样只按 `agentId` 关 card 并追加 system message，没有清 `activeAgents`，见 `packages/desktop/src/renderer/types.ts:1056`、`packages/desktop/src/renderer/types.ts:1064`、`packages/desktop/src/renderer/types.ts:1071`、`packages/desktop/src/renderer/types.ts:1082`、`packages/desktop/src/renderer/types.ts:1088`。
7. 结果是 `activeAgents` 成了会脏的运行态；后续一个无 `agentId` 的顶层 `stream_request_start` 会被压掉，后续 `text_delta` 又因没有 `streamingAssistantId` 被忽略，见 `packages/desktop/src/renderer/types.ts:447`、`packages/desktop/src/renderer/types.ts:500`。03 已记录这条链路，见 `docs/review-2026-07-09/03-optimization-findings.md:29`、`docs/review-2026-07-09/03-optimization-findings.md:31`、`docs/review-2026-07-09/03-optimization-findings.md:32`。

### 2. 复现/触发路径

1. orphan sweep 路径：`agent_start(A)` 后没有收到 `agent_end(A)`；主 turn clean `turn_complete` 到达。reducer 会把 agent card 标 done，但 `activeAgents.A` 仍保留，见 `packages/desktop/src/renderer/types.ts:944`、`packages/desktop/src/renderer/types.ts:950`、`packages/desktop/src/renderer/types.ts:960`、`packages/desktop/src/renderer/types.ts:1027`。
2. 后台完成路径：`agent_start(A)` → `agent_backgrounded(A)` → 主 turn `turn_complete`，之后收到 `background_agent_completed(A)`。reducer 会把 card 标 done、`backgrounded:false`，但 `activeAgents.A` 仍保留，见 `packages/desktop/src/renderer/types.ts:737`、`packages/desktop/src/renderer/types.ts:747`、`packages/desktop/src/renderer/types.ts:1056`、`packages/desktop/src/renderer/types.ts:1073`、`packages/desktop/src/renderer/types.ts:1074`。
3. 下一次普通顶层发送：core 发无 `agentId` 的 `stream_request_start`，因为顶层 TurnLoop 当前 emit 没带 `agentId`，见 `packages/core/src/engine/turn-loop.ts:605`。desktop 看到 `activeAgents` 非空直接 return，见 `packages/desktop/src/renderer/types.ts:447`。
4. 后续顶层 `text_delta` 没有 `agentId`，按主 feed 路径处理，但 `streamingAssistantId` 为空时直接丢弃，见 `packages/desktop/src/renderer/types.ts:486`、`packages/desktop/src/renderer/types.ts:500`。
5. 现有测试已经覆盖了“orphan 被标 done”和“background completed 关 card”，但没有断言 `activeAgents` 同步清理：见 `packages/desktop/src/renderer/types.test.ts:328`、`packages/desktop/src/renderer/types.test.ts:338`、`packages/desktop/src/renderer/types.test.ts:398`、`packages/desktop/src/renderer/types.test.ts:417`。现有测试还把“activeAgents 非空时 request_start 不开主 slot”固化为行为，见 `packages/desktop/src/renderer/types.test.ts:432`、`packages/desktop/src/renderer/types.test.ts:435`、`packages/desktop/src/renderer/types.test.ts:437`，需要随修复改写。

### 3. 影响边界

1. 直接影响 desktop 多代理、后台代理之后的普通顶层 streaming 回复；用户可见表现是下一轮没有 assistant bubble 或 token 不显示。
2. 改动主要在 `packages/desktop/src/renderer/types.ts` 和 `packages/desktop/src/renderer/types.test.ts`，core 侧已有 `agentId` 类型与 wrapper，不必让 core import desktop。
3. 需要留意 transcript/disk replay：A2 说明普通 desktop disk fold 后仍会进同一个 `applyStreamEvent`，见 `docs/review-2026-07-09/02-desktop-stream-walkthrough.md:75`、`docs/review-2026-07-09/02-desktop-stream-walkthrough.md:78`。改动后 replay 的 active agent cleanup 也应一致。

### 4. 修复方案

1. 修改 `stream_request_start` 分支：
   - 如果 `event.agentId` 存在，明确视为子代理 request，主 feed 不开 assistant slot。
   - 如果 `event.agentId` 不存在，明确视为顶层 request，无论 `activeAgents` 当前是否为空，都创建/替换主 `streamingAssistantId`。
   - 删除或改写当前“event itself doesn't carry agentId”的注释，见 `packages/desktop/src/renderer/types.ts:444`、`packages/desktop/src/renderer/types.ts:445`。
2. 修改 `turn_complete` clean sweep：
   - 进入分支时复制 `activeAgents` 为 `nextActiveAgents`。
   - 对每个 `activeAgents` 条目，如果 clean completion 且 agent 不是 `backgrounded`，在标记 message done 的同时从 `nextActiveAgents` 删除。
   - 如果 `agentMessageIndex[agentId]` 缺失、指向非 agent message，clean completion 下也删除该 `activeAgents` 条目；因为这个条目已经无法再被正常 card 更新，继续保留只会污染路由。
   - 对 `backgrounded` agent 只 flush buffer，保留 active，等待 `agent_end` 或 `background_agent_completed`，这与现有注释一致，见 `packages/desktop/src/renderer/types.ts:951`、`packages/desktop/src/renderer/types.ts:954`。
   - return 时带上 `activeAgents: nextActiveAgents`。
3. 修改 `background_agent_completed`：
   - 如果 payload 有 `agentId`，无论是否找到 card，都从 `activeAgents` 删除该 id。
   - 保留当前 card resolve 与 system message 行为，见 `packages/desktop/src/renderer/types.ts:1063`、`packages/desktop/src/renderer/types.ts:1071`、`packages/desktop/src/renderer/types.ts:1084`。
4. 保留 `agent_end` 的现有删除逻辑，见 `packages/desktop/src/renderer/types.ts:769`、`packages/desktop/src/renderer/types.ts:796`，避免双删问题；对象 rest 删除是幂等的。
5. 不建议在顶层 `text_delta` 无 slot 时自动创建 assistant slot来掩盖问题。主链路设计是 `stream_request_start` 创建 stable accumulator，A2 已说明该职责，见 `docs/review-2026-07-09/02-desktop-stream-walkthrough.md:81`、`docs/review-2026-07-09/02-desktop-stream-walkthrough.md:84`、`docs/review-2026-07-09/02-desktop-stream-walkthrough.md:85`。

### 5. TDD 测试点

1. 改写 `packages/desktop/src/renderer/types.test.ts` 现有第 6 条：
   - 旧断言“active agent 时无条件不打开主 assistant”应拆成两条。
   - 新测试 A：`agent_start(A)` 后收到 `stream_request_start({ agentId:"A" })`，断言不创建新的主 assistant。
   - 新测试 B：构造 `activeAgents` 非空但收到 `stream_request_start({ turnNumber:2 })`，断言创建新的主 assistant slot，`streamingAssistantId` 非空，message 数增加。
2. 在 `types.test.ts` 的 orphan sweep 测试后追加断言：
   - 基于现有 `4b` 场景，除了 `agent.done === true`，还断言 `s.activeAgents` 不包含 `A`，见现有测试位置 `packages/desktop/src/renderer/types.test.ts:328`、`packages/desktop/src/renderer/types.test.ts:338`。
3. 在 `types.test.ts` 的 background completed 测试后追加断言：
   - 基于现有 `4g` 场景，断言 `s.activeAgents` 不包含 `A`，见现有测试位置 `packages/desktop/src/renderer/types.test.ts:398`、`packages/desktop/src/renderer/types.test.ts:417`。
4. 新增端到端 reducer 场景：
   - `agent_start(A)` → clean `turn_complete` → 顶层 `stream_request_start` → 顶层 `text_delta("main")`。
   - 断言最后主 assistant text 是 `"main"`，证明 dirty active agent 不再吞主回复槽。

### 6. 风险与回归面

1. 合法后台 agent 在 parent turn 后仍应显示 running；不能把 `backgrounded` agent 在 `turn_complete` 中清掉。现有语义见 `packages/desktop/src/renderer/types.ts:737`、`packages/desktop/src/renderer/types.ts:740`、`packages/desktop/src/renderer/types.ts:951`、`packages/desktop/src/renderer/types.ts:954`，测试见 `packages/desktop/src/renderer/types.test.ts:369`、`packages/desktop/src/renderer/types.test.ts:380`。
2. 子代理 text/tool 仍必须只进 agent card，不进主 feed；需跑 `packages/desktop/src/renderer/types.test.ts` 中 subagent isolation 组，尤其 `packages/desktop/src/renderer/types.test.ts:269`、`packages/desktop/src/renderer/types.test.ts:281`、`packages/desktop/src/renderer/types.test.ts:303`。
3. disk replay 的 orphan seal 已在 automation fold 测试中断言 `activeAgents` 为空，见 `packages/desktop/src/renderer/automation/foldTranscript.test.ts:150`、`packages/desktop/src/renderer/automation/foldTranscript.test.ts:168`。改 `types.ts` 时不要让 fold 行为回退。

## F-03 coalescer 按 agent 合并 delta，却没有在硬边界上切段

### 1. 根因链

1. desktop coalescer 设计为 50ms 窗口内合并高频事件并批量 dispatch，见 `packages/desktop/src/renderer/streamCoalescer.ts:19`、`packages/desktop/src/renderer/streamCoalescer.ts:25`、`packages/desktop/src/renderer/streamCoalescer.ts:27`、`packages/desktop/src/renderer/streamCoalescer.ts:43`。
2. 它用 insertion-ordered `order` 记录“第一次出现”的 slot；重复 delta key 只 merge，不重新 append，因此位置保留在第一次出现处，见 `packages/desktop/src/renderer/streamCoalescer.ts:35`、`packages/desktop/src/renderer/streamCoalescer.ts:37`、`packages/desktop/src/renderer/streamCoalescer.ts:38`。
3. `text_delta` 的 key 只有 `text|${agentId ?? ""}`，不包含 turn/request/segment，见 `packages/desktop/src/renderer/streamCoalescer.ts:104`、`packages/desktop/src/renderer/streamCoalescer.ts:106`、`packages/desktop/src/renderer/streamCoalescer.ts:107`、`packages/desktop/src/renderer/streamCoalescer.ts:115`。
4. `stream_request_start`、`assistant_message`、`turn_complete`、`tool_use_start`、`tool_result` 等边界事件都走 passthrough；当前逻辑只 append 并 schedule，不 flush、不换 delta key，见 `packages/desktop/src/renderer/streamCoalescer.ts:145`、`packages/desktop/src/renderer/streamCoalescer.ts:148`、`packages/desktop/src/renderer/streamCoalescer.ts:149`。
5. reducer 会按 batch 内数组顺序逐个 `applyStreamEvent`，见 `packages/desktop/src/renderer/transcriptsReducer.ts:128`、`packages/desktop/src/renderer/transcriptsReducer.ts:136`、`packages/desktop/src/renderer/transcriptsReducer.ts:137`。因此 coalescer 重新排列出来的顺序就是状态机看到的真实顺序。
6. core/protocol 允许下一 turn 很快跟上：`ChatSession.pump()` 在 finally 中如果队列非空就立即 `void this.pump()`，见 `packages/core/src/protocol/chat-session.ts:240`、`packages/core/src/protocol/chat-session.ts:251`、`packages/core/src/protocol/chat-session.ts:252`。Engine 在 run 收尾发 `turn_complete`，下一 run 的 TurnLoop 顶部发 `stream_request_start`，见 `packages/core/src/engine/engine.ts:2362`、`packages/core/src/engine/engine.ts:2363`、`packages/core/src/engine/turn-loop.ts:605`。
7. 所以同一 50ms 窗口内可能出现 `text_delta(old)` → `turn_complete` → `stream_request_start` → `text_delta(new)`；第二个 text 因 key 相同被 merge 回第一个 slot，最终 batch 变成 `text_delta(old+new)` → `turn_complete` → `stream_request_start`。03 已记录这会破坏 A2 依赖的状态机边界，见 `docs/review-2026-07-09/03-optimization-findings.md:38`、`docs/review-2026-07-09/03-optimization-findings.md:40`、`docs/review-2026-07-09/03-optimization-findings.md:41`。

### 2. 复现/触发路径

1. fast second send：第一 turn 最后一个 token 到达后，50ms flush 还没发生；紧接着 `turn_complete` 到达，queue drain 立即启动第二 turn 并发 `stream_request_start`，第二 turn 第一个 token 也落在同一窗口。触发条件由 coalescer 50ms 窗口和 `ChatSession` immediate pump 共同构成，见 `packages/desktop/src/renderer/streamCoalescer.ts:96`、`packages/core/src/protocol/chat-session.ts:251`。
2. 工具边界：`text_delta` lead-in 后马上 `tool_use_start`，再有模型/子代理 text delta 落在同一窗口。因为 `tool_use_start` 是 passthrough 且不切 key，后续同 agent text 仍可能合并回工具前，见 `packages/desktop/src/renderer/streamCoalescer.ts:104`、`packages/desktop/src/renderer/streamCoalescer.ts:145`。
3. 子代理密集事件：A2 说明 coalescer 是为工具密集子代理降低 renderer load，见 `docs/review-2026-07-09/02-desktop-stream-walkthrough.md:69`、`docs/review-2026-07-09/02-desktop-stream-walkthrough.md:72`。这种高频路径更容易让不同状态机阶段落入一个 50ms batch。

### 3. 影响边界

1. 直接影响 desktop renderer 的事件顺序，不需要改 core。A2 已把 coalescer 定位在 main/preload 之后、reducer 之前，见 `docs/review-2026-07-09/02-desktop-stream-walkthrough.md:69`、`docs/review-2026-07-09/02-desktop-stream-walkthrough.md:75`。
2. 改动集中在 `packages/desktop/src/renderer/streamCoalescer.ts` 与 `packages/desktop/src/renderer/streamCoalescer.test.ts`。
3. 不能简单取消 batching；现有测试明确把“20 个 tool start/result 一窗一次 dispatch”作为性能契约，见 `packages/desktop/src/renderer/streamCoalescer.test.ts:82`、`packages/desktop/src/renderer/streamCoalescer.test.ts:91`、`packages/desktop/src/renderer/streamCoalescer.test.ts:92`。

### 4. 修复方案

1. 推荐 segment-aware，不推荐“遇到所有边界立即 flush”作为首选。立即 flush 可以修正确性，但会破坏 tool-heavy 一窗一次 dispatch 的性能目标，见 `packages/desktop/src/renderer/streamCoalescer.test.ts:82`、`packages/desktop/src/renderer/streamCoalescer.test.ts:92`。
2. 在 `streamCoalescer.ts` 内引入 `segment` 计数：
   - `let segment = 0`。
   - `text_delta` key 从 `text|agentId` 改为 `text|segment|agentId`。
   - `tool_use_args_delta` key 从 `args|agentId|toolCallId` 改为 `args|segment|agentId|toolCallId`。
3. 增加 `isHardBoundary(event)` helper。初始 hard boundary 建议包含：
   - `stream_request_start`
   - `assistant_message`
   - `turn_complete`
   - `tool_use_start`
   - `tool_result`
   - `agent_start`
   - `agent_end`
   - `agent_backgrounded`
   - `background_agent_completed`
   - `tombstone`
   - `error`
4. 对非 `error` hard boundary：先按当前逻辑 `order.push({ kind:"passthrough", event })`，然后 `segment += 1`，再 `scheduleFlush()`。这样同一个 batch 仍可保留，但边界之后的 delta 会成为新 slot，出现在边界之后。
5. `error` 继续沿用当前“先 flush pending，再单独发 error”的同步路径，见 `packages/desktop/src/renderer/streamCoalescer.ts:138`、`packages/desktop/src/renderer/streamCoalescer.ts:141`、`packages/desktop/src/renderer/streamCoalescer.ts:142`。
6. `usage_update`、`session_started` 等不改变 assistant/tool 状态机顺序的事件可以先保持 non-hard passthrough，避免无意义拆分 text delta；如果后续发现具体事件也形成边界，再按测试补入 `isHardBoundary`。
7. 如果 F-01 同时给 `stream_request_start` 引入 `messageId`，未来可把 text key 进一步改为 `text|messageId|agentId`；本轮最小设计不依赖 core 改动，先用 segment 修正顺序。

### 5. TDD 测试点

1. `packages/desktop/src/renderer/streamCoalescer.test.ts` 新增 turn boundary 测试：
   - push `text_delta("old")` → `turn_complete(completed)` → `stream_request_start(turnNumber:2)` → `text_delta("new")`，全部在一个 interval 内。
   - 断言 flush 后事件顺序为 `text_delta("old")`、`turn_complete`、`stream_request_start`、`text_delta("new")`。
   - 断言有两条 text_delta，不能是 `"oldnew"`。
2. 新增 tool boundary 测试：
   - push `text_delta("before")` → `tool_use_start(t1)` → `text_delta("after")`。
   - 断言顺序为 text before、tool start、text after；不能 merge 成一条 text。
   - 现有测试 15 只覆盖 pending text 在 tool start 前保持顺序，没有覆盖 tool start 后继续 text 的 merge 问题，见 `packages/desktop/src/renderer/streamCoalescer.test.ts:46`、`packages/desktop/src/renderer/streamCoalescer.test.ts:55`。
3. 新增 args boundary 测试：
   - push `tool_use_args_delta(t1,{a:1})` → `tool_result(t1)` → `tool_use_args_delta(t1,{b:2})`。
   - 断言 result 后的 args 不会 merge 回 result 前；如果实现决定 result 后 args 是非法/no-op，也应明确断言不重排。
4. 保留并跑现有性能契约：
   - `a burst of boundary events in one window flushes as ONE batch` 仍应为 1 batch，见 `packages/desktop/src/renderer/streamCoalescer.test.ts:82`、`packages/desktop/src/renderer/streamCoalescer.test.ts:92`。

### 6. 风险与回归面

1. segment key 会增加单个 batch 内 delta event 数量，但不必增加 reducer dispatch 次数；重点回归 `streamCoalescer.test.ts` 的 batch 数断言。
2. reducer 对 `assistant_message` / `turn_complete` 的顺序很敏感：`assistant_message` 封口见 `packages/desktop/src/renderer/types.ts:664`、`turn_complete` 清 streaming ids 见 `packages/desktop/src/renderer/types.ts:1027`、`packages/desktop/src/renderer/types.ts:1030`。修复后需跑 `packages/desktop/src/renderer/types.test.ts`。
3. coalescer 当前使用 type-only import `StreamEvent`，见 `packages/desktop/src/renderer/streamCoalescer.ts:1`；保持 type-only，避免违反 desktop renderer 不 runtime import codeshell package 的边界，见 `CODESHELL.md:51`、`CODESHELL.md:53`。

## F-04 snapshot 的 seq 游标只存在于重放路径，live IPC 没有对齐游标

### 1. 根因链

1. main 的 `SessionSnapshotStore` 设计目标是让 snapshot 与 live increment stream 用 per-session `seq` 对齐，注释明确写了“renderer asks for everything since the last seq it saw”，见 `packages/desktop/src/main/SessionSnapshotStore.ts:10`、`packages/desktop/src/main/SessionSnapshotStore.ts:11`、`packages/desktop/src/main/SessionSnapshotStore.ts:12`、`packages/desktop/src/main/SessionSnapshotStore.ts:13`。
2. `append()` 确实给每个事件分配递增 `seq` 并返回 entry，见 `packages/desktop/src/main/SessionSnapshotStore.ts:48`、`packages/desktop/src/main/SessionSnapshotStore.ts:55`、`packages/desktop/src/main/SessionSnapshotStore.ts:57`、`packages/desktop/src/main/SessionSnapshotStore.ts:61`。
3. AgentBridge 解析 worker line 后也拿到了 `snapshotEntry`，但 live 转发仍是 `this.safeSend("agent:msg", line)`，也就是原始 JSON-RPC line；`snapshotEntry` 只给 outbound taps，见 `packages/desktop/src/main/agent-bridge.ts:203`、`packages/desktop/src/main/agent-bridge.ts:204`、`packages/desktop/src/main/agent-bridge.ts:205`、`packages/desktop/src/main/agent-bridge.ts:208`、`packages/desktop/src/main/agent-bridge.ts:209`、`packages/desktop/src/main/agent-bridge.ts:211`。
4. preload 的 `"agent:msg"` handler 解析原 line 后只调用 `cb({ sessionId, event })`；listener 类型也只有 `{ sessionId, event }`，见 `packages/desktop/src/preload/index.ts:94`、`packages/desktop/src/preload/index.ts:96`、`packages/desktop/src/preload/index.ts:159`、`packages/desktop/src/preload/index.ts:162`、`packages/desktop/src/preload/index.ts:164`、`packages/desktop/src/preload/index.ts:467`。
5. preload 类型声明中的 `StreamEventEnvelope` 同样没有 seq，而 `SessionSnapshot` entry 有 seq，见 `packages/desktop/src/preload/types.d.ts:149`、`packages/desktop/src/preload/types.d.ts:151`、`packages/desktop/src/preload/types.d.ts:154`、`packages/desktop/src/preload/types.d.ts:157`、`packages/desktop/src/preload/types.d.ts:161`、`packages/desktop/src/preload/types.d.ts:163`。
6. renderer 有 `appliedSeqRef`，但只在 empty-base snapshot replay 分支设置，见 `packages/desktop/src/renderer/App.tsx:784`、`packages/desktop/src/renderer/App.tsx:824`、`packages/desktop/src/renderer/App.tsx:826`、`packages/desktop/src/renderer/App.tsx:827`、`packages/desktop/src/renderer/App.tsx:829`。live handler 只 route/log/push event，没有推进 seq，见 `packages/desktop/src/renderer/App.tsx:1463`、`packages/desktop/src/renderer/App.tsx:1481`、`packages/desktop/src/renderer/App.tsx:1527`。
7. `snapshotReplay.ts` 的注释假定 renderer 会“track highest seq it has seen”，但 live StreamEvent 没有 stable id，见 `packages/desktop/src/renderer/snapshotReplay.ts:4`、`packages/desktop/src/renderer/snapshotReplay.ts:6`、`packages/desktop/src/renderer/snapshotReplay.ts:7`、`packages/desktop/src/renderer/snapshotReplay.ts:8`。这与实际 live envelope 缺 seq 矛盾。
8. 另外，`appliedSeqRef` 是 React memory；renderer remount 后会重置。localStorage 持久化当前只保存 `MessagesReducerState`，不保存 snapshot cursor，见 `packages/desktop/src/renderer/transcripts.ts:428`、`packages/desktop/src/renderer/transcripts.ts:434`、`packages/desktop/src/renderer/transcripts.ts:464`、`packages/desktop/src/renderer/transcripts.ts:470`、`packages/desktop/src/renderer/transcripts.ts:488`。因此只把 seq 放进 live envelope 还不够，必须把“已应用到 transcript projection 的最高 seq”与 projection 一起保存。

### 2. 复现/触发路径

1. renderer 正常消费 live events，main snapshot 也持续 append seq，见 `packages/desktop/src/main/agent-bridge.ts:203`、`packages/desktop/src/main/SessionSnapshotStore.ts:49`。
2. renderer 刷新/HMR/crash recovery，React memory 中的 route table、coalescer、`appliedSeqRef` 清空；A2 说明 main 不 remount，snapshot 留在 main，见 `docs/review-2026-07-09/02-desktop-stream-walkthrough.md:51`、`docs/review-2026-07-09/02-desktop-stream-walkthrough.md:55`。
3. 如果 localStorage/disk projection 非空但漏了刷新前最后一段 live tail，hydrate 分支不会 replay snapshot，因为代码只在 `base.messages.length === 0` 时 `subscribeSession(engineId, 0)`，见 `packages/desktop/src/renderer/App.tsx:816`、`packages/desktop/src/renderer/App.tsx:820`、`packages/desktop/src/renderer/App.tsx:823`、`packages/desktop/src/renderer/App.tsx:824`。
4. 如果改成非空也 `sinceSeq=0`，又会因为 StreamEvent 没有稳定 id 而重复 apply 已有消息；`selectReplayEvents()` 只能按 seq 去重，见 `packages/desktop/src/renderer/snapshotReplay.ts:19`、`packages/desktop/src/renderer/snapshotReplay.ts:23`、`packages/desktop/src/renderer/snapshotReplay.ts:24`。
5. 触发结果：非空 projection 后的 missed tail 无法安全补回。03 已把这总结为“cursor 只在 snapshot replay 内部成立，live 消费无法和 main snapshot seq 对齐”，见 `docs/review-2026-07-09/03-optimization-findings.md:47`、`docs/review-2026-07-09/03-optimization-findings.md:49`、`docs/review-2026-07-09/03-optimization-findings.md:50`。

### 3. 影响边界

1. 影响 desktop renderer reload/HMR/crash recovery，不影响 core 引擎正确性。
2. 改动半径跨 main/preload/renderer：
   - main `AgentBridge` live IPC，见 `packages/desktop/src/main/agent-bridge.ts:203`、`packages/desktop/src/main/agent-bridge.ts:208`。
   - preload listener 与 `.d.ts` envelope，见 `packages/desktop/src/preload/index.ts:159`、`packages/desktop/src/preload/types.d.ts:149`。
   - renderer coalescer/batch reducer/transcript persistence/hydrate replay，见 `packages/desktop/src/renderer/App.tsx:1451`、`packages/desktop/src/renderer/transcriptsReducer.ts:128`、`packages/desktop/src/renderer/transcripts.ts:470`、`packages/desktop/src/renderer/App.tsx:816`。
3. 不应把 core protocol envelope 改成 desktop 专属 seq；当前 seq 是 main 内存 snapshot 的补偿层，不是 core `StreamEvent` 的全局事件 id，见 `packages/desktop/src/main/SessionSnapshotStore.ts:1`、`packages/desktop/src/main/SessionSnapshotStore.ts:10`。

### 4. 修复方案

1. main：给 live stream notification 增加带 seq 的 IPC，不改变 core worker 的 JSON-RPC line。
   - 在 `AgentBridge` 读取 line 后，如果 `parseSnapshotAppend(line)` 返回 append，则先 `snapshots.append()` 得到 `{ seq,event }`，再通过新 channel 例如 `"agent:streamEvent"` 发送 `{ sessionId, event, seq }`。
   - 对 streamEvent line 不再同时通过 `"agent:msg"` 发给 preload，避免重复；`"agent:msg"` 继续服务 RPC response 和其它 notification。
   - outbound taps 仍保留原 raw line 与 snapshotEntry，见当前 taps 调用 `packages/desktop/src/main/agent-bridge.ts:209`、`packages/desktop/src/main/agent-bridge.ts:211`。
2. preload：
   - 新增 `ipcRenderer.on("agent:streamEvent", ...)`，直接 fanout `{ sessionId, event, seq }`。
   - 保留 `"agent:msg"` 中 `method === "agent/streamEvent"` 的 legacy fallback，但 main 新路径不应再走到它。
   - 更新 `streamListeners` 类型和 `StreamEventEnvelope`：`seq?: number`。用可选字段兼容 legacy fallback，见当前类型 `packages/desktop/src/preload/types.d.ts:149`。
3. renderer state：
   - 在 `MessagesReducerState` 增加 `snapshotSeq: number`，默认 0；`loadTranscript()`/`saveTranscript()` 跟随现有 state 持久化，见当前 state 定义 `packages/desktop/src/renderer/types.ts:282`、初始值 `packages/desktop/src/renderer/types.ts:333`、load/save `packages/desktop/src/renderer/transcripts.ts:428`、`packages/desktop/src/renderer/transcripts.ts:470`。
   - `transcriptsReducer` 的 `stream_batch` action 增加 `maxSeq?: number` 或改为 `{ events, maxSeq }`；同一 batch 的所有事件 apply 完后，把 `snapshotSeq` 更新为 `Math.max(prev.snapshotSeq, maxSeq)`。这样 cursor 与实际 projection state 同步持久化，而不是只存在 ref 中。
4. coalescer/App：
   - live handler 收到 env 后，把 `event` 与 `seq` 一起进入 per-bucket coalescer；如果不想扩大 coalescer 类型，也可以在 App 的 coalescer flush callback 同步传 `maxSeq` 给 reducer。
   - 因为 `text_delta` 可能被 coalescer merge，cursor 不应按单个 coalesced event 记录；应记录整个 batch 的 `maxSeq`。batch 内事件都被 reducer fold 后再更新 state cursor。
5. hydrate/replay：
   - 非空 base 也应尝试补 tail：如果有 `engineId`，读取 `base.snapshotSeq` 作为 `sinceSeq`，调用 `subscribeSession(engineId, base.snapshotSeq)`。
   - 用 `selectReplayEvents(snapshot, base.snapshotSeq)` 得到 events/cursor；逐个 `applyStreamEvent` 后把 `snapshotSeq` 更新到 cursor。
   - 删除或改写当前 `base.messages.length === 0` 限制，见 `packages/desktop/src/renderer/App.tsx:823`、`packages/desktop/src/renderer/App.tsx:824`。新的去重依据是持久化 cursor，不是“是否空 transcript”。
6. 删除/迁移：
   - 如果把 cursor 放进 `MessagesReducerState`，现有 delete/copy/archive transcript 流程会自然跟随 `saveTranscript()`；如果选择单独 localStorage key，则必须同步更新 `deleteTranscript`、repo copy/archive 相关逻辑，见 `packages/desktop/src/renderer/transcripts.ts:496`、`packages/desktop/src/renderer/transcripts.ts:510`。

### 5. TDD 测试点

1. `packages/desktop/src/main/parseStreamLine.test.ts` 或新 `agent-bridge-live-seq.test.ts`：
   - 建议先抽一个纯 helper，例如 `toLiveStreamEnvelope(line, snapshotEntry)`。
   - 场景：输入 `agent/streamEvent` line 和 snapshot entry `{ seq: 7, event }`。
   - 断言：输出 envelope 是 `{ sessionId:"s1", event, seq:7 }`；非 streamEvent line 仍走 raw `"agent:msg"`。
2. `packages/desktop/src/preload/types.d.ts` 类型层面：
   - `StreamEventEnvelope` 允许 `seq?: number`。
   - 若项目已有 preload IPC test harness，可在 `packages/desktop/src/preload/` 新增测试，断言 `"agent:streamEvent"` listener fanout seq；现有 preload 测试目录见 `packages/desktop/src/preload/rpc-timeout.test.ts:1`。
3. `packages/desktop/src/renderer/transcriptsReducer.test.ts`：
   - 场景：`stream_batch` 带 events `[stream_request_start,text_delta]` 和 `maxSeq: 12`。
   - 断言：messages 被正常 fold，`state.snapshotSeq === 12`。
   - 再发 `maxSeq: 10`，断言 cursor 不回退。
4. `packages/desktop/src/renderer/transcripts.test.ts` 或相邻新测试：
   - 场景：`saveTranscript()` 一个带 `snapshotSeq: 42` 的 state，再 `loadTranscript()`。
   - 断言：`snapshotSeq === 42`；legacy 无字段时默认 0。
5. `packages/desktop/src/renderer/snapshotReplay.test.ts` 扩展：
   - 场景：base cursor 为 2，snapshot entries 为 seq 1、2、3。
   - 断言：只 replay seq 3，cursor 到 3。已有 `selectReplayEvents` 已覆盖核心选择，见 `packages/desktop/src/renderer/snapshotReplay.test.ts:35`、`packages/desktop/src/renderer/snapshotReplay.test.ts:43`；本轮需要把它接到非空 hydrate 的 helper 上。

### 6. 风险与回归面

1. 不能让 streamEvent 同时走 `"agent:msg"` 和新 `"agent:streamEvent"`，否则 renderer 会双 apply。需要覆盖 main/preload tests。
2. `seq` 是 per-session cursor，不是全局 cursor；`SessionSnapshotStore` 每个 session 独立计数，测试已断言 `s1`/`s2` 分开，见 `packages/desktop/src/main/SessionSnapshotStore.test.ts:32`、`packages/desktop/src/main/SessionSnapshotStore.test.ts:38`、`packages/desktop/src/main/SessionSnapshotStore.test.ts:39`。
3. coalescer merge 后用 batch max seq 更新 cursor，可能让一个 batch 内较早事件和较晚事件共用同一 cursor；这没问题，因为 reducer 已经按 batch 顺序应用完全部事件，见 `packages/desktop/src/renderer/transcriptsReducer.ts:136`、`packages/desktop/src/renderer/transcriptsReducer.ts:137`。
4. 如果 snapshot window 已经 eviction，`sinceSeq` 可能落在保留窗口之前；现有 long-disconnect fallback 会在空 state 时读 disk，见 `packages/desktop/src/renderer/App.tsx:837`、`packages/desktop/src/renderer/App.tsx:843`。非空补尾场景后续仍需要 raw transcript since-id 方案，这是 P1 修复之外的增强。

## F-06 `pre_tool_use: ask` 用户同意后会跳过 classifier deny/rules

### 1. 根因链

1. `ToolExecutor.executeSingle()` 先跑 `pre_tool_use` hook，位置在 schema validation 和 path policy 之前/之后的当前流程中：hook emit 见 `packages/core/src/tool-system/executor.ts:264`、`packages/core/src/tool-system/executor.ts:265`、`packages/core/src/tool-system/executor.ts:269`；hook deny 直接返回，见 `packages/core/src/tool-system/executor.ts:270`、`packages/core/src/tool-system/executor.ts:276`。
2. hook 可以 rewrite args，executor 会 revalidate，然后才执行 declared path policy，见 `packages/core/src/tool-system/executor.ts:282`、`packages/core/src/tool-system/executor.ts:285`、`packages/core/src/tool-system/executor.ts:302`、`packages/core/src/tool-system/executor.ts:306`。
3. 如果 `hookResult.decision === "ask"`，executor 直接调用 `permission.handleAsk()`；用户 approve 后继续往下走，见 `packages/core/src/tool-system/executor.ts:329`、`packages/core/src/tool-system/executor.ts:334`、`packages/core/src/tool-system/executor.ts:336`、`packages/core/src/tool-system/executor.ts:342`、`packages/core/src/tool-system/executor.ts:350`。
4. 后面的 classifier 分支明确写成 `if (hookResult.decision !== "ask")`，所以 hook ask 被批准后不会执行 `permission.classify()`，见 `packages/core/src/tool-system/executor.ts:366`、`packages/core/src/tool-system/executor.ts:368`、`packages/core/src/tool-system/executor.ts:369`。
5. 显式 permission rules 是在 `PermissionClassifier.classify()` 内部匹配的，见 `packages/core/src/tool-system/permission.ts:926`、`packages/core/src/tool-system/permission.ts:930`、`packages/core/src/tool-system/permission.ts:931`、`packages/core/src/tool-system/permission.ts:933`。因此跳过 classify 就同时跳过了显式 deny rule。
6. `handleAsk()` 本身不是 classifier。它处理 `dontAsk` fast-fail、`bypassPermissions` fast-allow、denial tracker、risk description 和 approval backend，见 `packages/core/src/tool-system/permission.ts:966`、`packages/core/src/tool-system/permission.ts:972`、`packages/core/src/tool-system/permission.ts:980`、`packages/core/src/tool-system/permission.ts:989`、`packages/core/src/tool-system/permission.ts:999`、`packages/core/src/tool-system/permission.ts:1011`。这里没有 explicit rule 匹配。
7. 现有 `clampHookDecision()` 只用于 `on_permission_check` hook，且发生在 classifier 已执行之后，见 `packages/core/src/tool-system/executor.ts:44`、`packages/core/src/tool-system/executor.ts:377`、`packages/core/src/tool-system/executor.ts:381`、`packages/core/src/tool-system/executor.ts:388`。它保护不了前置 `pre_tool_use ask` 跳过 classifier 的路径。
8. HookRegistry 自身按 deny > ask > allow 聚合 hook 链，见 `packages/core/src/hooks/registry.ts:10`、`packages/core/src/hooks/registry.ts:12`、`packages/core/src/hooks/registry.ts:95`、`packages/core/src/hooks/registry.ts:99`；但这个聚合只发生在 hook 内部，不能替代 classifier 与 user 的最终权限合并。
9. 03 已将问题定性为“hook 的 ask 分支发生在 permission classify 前，批准后不再执行 classifier”，见 `docs/review-2026-07-09/03-optimization-findings.md:65`、`docs/review-2026-07-09/03-optimization-findings.md:67`、`docs/review-2026-07-09/03-optimization-findings.md:68`。

### 2. 复现/触发路径

1. settings/plugin 注册一个 `pre_tool_use` hook，对某工具返回 `{ decision:"ask", messages:["extra review"] }`；HookRegistry 支持 `pre_tool_use` 注册与 emit，见 `packages/core/src/hooks/registry.ts:37`、`packages/core/src/hooks/registry.ts:78`。
2. 权限规则配置同一工具 explicit deny，例如 `{ tool:"Bash", argsPattern:{ command:"^rm" }, decision:"deny" }`；`PermissionRule` shape 见 `packages/core/src/types.ts:332`、`packages/core/src/types.ts:335`，classifier 规则匹配见 `packages/core/src/tool-system/permission.ts:930`、`packages/core/src/tool-system/permission.ts:933`。
3. 执行该工具时，hook ask 先弹用户审批；如果用户 approve，executor 因 `hookResult.decision === "ask"` 跳过 `permission.classify()`，见 `packages/core/src/tool-system/executor.ts:334`、`packages/core/src/tool-system/executor.ts:366`、`packages/core/src/tool-system/executor.ts:368`。
4. 结果：explicit deny rule 没有机会生效，handler 继续执行，见执行入口 `packages/core/src/tool-system/executor.ts:433`、`packages/core/src/tool-system/executor.ts:456`。

### 3. 影响边界

1. 影响 core tool-system 的所有工具执行，因为 `ToolExecutor` 是工具调用统一入口，见 `packages/core/src/tool-system/executor.ts:1`、`packages/core/src/tool-system/executor.ts:119`。
2. 风险级别高于普通 UX bug：这是 permission 语义顺序问题，可能绕过项目显式 deny rules。规则匹配位置见 `packages/core/src/tool-system/permission.ts:930`。
3. 改动半径集中在 `packages/core/src/tool-system/executor.ts`、相关 permission/order 测试，不需要 desktop renderer 或 tui。

### 4. 修复方案

1. 保留早期硬 gate 的顺序：
   - abort fast-path，见 `packages/core/src/tool-system/executor.ts:131`。
   - disabled builtin / goal-only / visibility / MCP / plan mode / schema validation，见 `packages/core/src/tool-system/executor.ts:139`、`packages/core/src/tool-system/executor.ts:219`、`packages/core/src/tool-system/executor.ts:250`。
   - `pre_tool_use` hook 仍可 deny 或 rewrite；rewrite 后继续 revalidate，见 `packages/core/src/tool-system/executor.ts:264`、`packages/core/src/tool-system/executor.ts:282`。
   - declared path policy 保持在 rewrite 后、permission classify 前，见 `packages/core/src/tool-system/executor.ts:302`、`packages/core/src/tool-system/executor.ts:306`。
2. 删除“hook ask approved 后跳过 classifier”的特殊分支。无论 `pre_tool_use` 返回 `ask` 还是 `allow`，都必须执行 `permission.classify(call.toolName, call.args)`。
3. 引入一个明确的权限合并 helper，例如 `mergePermissionDecisions({ classifier, preHook, permissionHook })`，规则固定为：
   - classifier `deny` 是 hard deny，`pre_tool_use ask` 和 `on_permission_check ask` 都不能把它放宽为 ask。
   - classifier `ask` 保持 ask；hook `allow` 不能升级为 allow。
   - classifier `allow` 时，hook `ask` 可以降级为 ask，hook `deny` 可以降级为 deny。
   - 任一 hook `deny` 都可以 deny。
   这个策略与 03 的建议一致，见 `docs/review-2026-07-09/03-optimization-findings.md:70`。
4. `on_permission_check` hook 仍在 classifier 后执行，但现有 `clampHookDecision()` 注释和行为需要收紧：
   - 当前注释允许“relax deny to ask”，见 `packages/core/src/tool-system/executor.ts:36`、`packages/core/src/tool-system/executor.ts:38`、`packages/core/src/tool-system/executor.ts:39`。修复后应改成“hooks may only keep or tighten classifier decision”。
   - 如果保留 helper 名称，语义要改为 deny > ask > allow，不能让 classifier deny 变 ask。
5. 只弹一次审批：
   - 如果最终 decision 是 `deny`，直接返回 error，不调用 `handleAsk()`。
   - 如果最终 decision 是 `ask`，合并 `pre_tool_use` messages 与 `on_permission_check` messages 为一次 reason，调用一次 `handleAsk()`。
   - 如果最终 decision 是 `allow`，不调用 `handleAsk()`。
6. 审批文案：
   - 当前 `handleAsk()` 会把 reason 写成 “Reason (from pre_tool_use hook): ...”，见 `packages/core/src/tool-system/permission.ts:1007`、`packages/core/src/tool-system/permission.ts:1009`。合并多来源后建议把 reason 字符串在 executor 中组织为多段，例如 `pre_tool_use:\n...\n\non_permission_check:\n...`，避免误导。
7. 日志：
   - 保留 `permission.classify` 日志，见 `packages/core/src/tool-system/executor.ts:369`、`packages/core/src/tool-system/executor.ts:370`。
   - 对 hook 尝试升级或放宽 deny 的情况保留 `permission.hook_upgrade_rejected` 或新增 `permission.hook_relax_rejected`，参考现有日志点 `packages/core/src/tool-system/executor.ts:321`、`packages/core/src/tool-system/executor.ts:390`。

### 5. TDD 测试点

1. 新建 `packages/core/src/tool-system/executor-permission-order.test.ts`。
2. 测试：`pre_tool_use ask` 不能覆盖 classifier explicit deny。
   - registry 注册 fake `Danger` tool，handler 设置 `handlerRan = true`。
   - hooks 注册 `pre_tool_use` 返回 `{ decision:"ask", messages:["extra confirmation"] }`。
   - PermissionClassifier 使用 rules `[{ tool:"Danger", decision:"deny" }]`，approval backend 用 approve-all 但记录调用次数。
   - 执行 `executeSingle({ toolName:"Danger" })`。
   - 断言：`result.isError === true`；error 包含 permission denied；`handlerRan === false`；approval backend 调用次数为 0。
3. 测试：`pre_tool_use ask` 可把 classifier allow 降级为 ask。
   - classifier 用 `bypassPermissions` 或 explicit allow rule 让基础 decision 是 allow。
   - hook 返回 ask，approval backend 先返回 `{ approved:true }`。
   - 断言：backend 调用一次，handler 运行。
   - 再让 backend 返回 `{ approved:false }`，断言 handler 不运行。
4. 测试：classifier ask 与 pre hook ask 合并为一次 prompt。
   - default mode 下无 allow rule，classifier fallback 是 ask，见 `packages/core/src/tool-system/permission.ts:951`、`packages/core/src/tool-system/permission.ts:962`。
   - pre hook 也 ask。
   - 断言 approval backend 只调用一次，description/reason 包含 pre hook message。
5. 测试：`on_permission_check ask` 不能放宽 classifier deny。
   - classifier explicit deny。
   - `on_permission_check` 返回 ask。
   - 断言不 prompt、不执行。
6. 测试：hook allow 不能升级 classifier ask/deny。
   - 可复用现有 `clampHookDecision` 行为预期，但要覆盖 `pre_tool_use allow` 与 `on_permission_check allow` 两个入口。当前 executor 只对 pre hook allow 记录升级拒绝日志，见 `packages/core/src/tool-system/executor.ts:316`、`packages/core/src/tool-system/executor.ts:321`。

### 6. 风险与回归面

1. 这是安全语义收紧，可能破坏依赖“hook ask 可把 deny 变成交给用户决定”的插件/设置。现有注释确实把 deny -> ask 描述成“legitimate audit patterns”，见 `packages/core/src/tool-system/executor.ts:36`、`packages/core/src/tool-system/executor.ts:38`、`packages/core/src/tool-system/executor.ts:39`。本 P1 设计选择按 deny > ask > allow 修正，需要在 changelog 或迁移说明中提醒。
2. path policy 仍在 permission classifier 前执行，且可能自己 ask；本修复不解决 path policy 与 permission classifier 的双 prompt 问题。当前 path policy 位置见 `packages/core/src/tool-system/executor.ts:302`、`packages/core/src/tool-system/executor.ts:306`。
3. 需要跑 tool-system 相关 tests：`packages/core/src/tool-system/executor-abort.test.ts` 确保 abort 仍不跑 hook/permission，见 `packages/core/src/tool-system/executor-abort.test.ts:11`、`packages/core/src/tool-system/executor-abort.test.ts:60`；`executor-plan-bash.test.ts` 确保 plan gate 仍早于 permission，见 `packages/core/src/tool-system/executor-plan-bash.test.ts:8`、`packages/core/src/tool-system/executor-plan-bash.test.ts:55`；permission rule tests 确保 explicit rules 仍匹配，见 `packages/core/src/tool-system/permission.path-rules.test.ts:28`、`packages/core/src/tool-system/permission.path-rules.test.ts:64`。

## P2 后续

F-05、F-07、F-08 是 P2，本轮不展开；后续可按同一六段模板继续深挖。

## 自查

1. 覆盖范围：已覆盖 5 条 P1 finding：F-01、F-02、F-03、F-04、F-06；未展开 P2。
2. 小节完整性：每条 P1 均包含根因链、复现/触发路径、影响边界、修复方案、TDD 测试点、风险与回归面。
3. 溯源性：根因与影响结论均锚定到 `file:line` 或 01/02/03 已完成文档；本文件未使用“推测”结论。
4. 边界约束：修复方案未要求 core import tui，未要求 desktop renderer runtime import codeshell 包；测试命令建议均按 bun 生态理解。
5. 最快落地判断：F-03 和 F-02 最快，主要是 renderer 纯逻辑与测试；F-06 次之，半径小但安全语义需审慎；F-01 需要 core/desktop 契约联动；F-04 跨 main/preload/renderer 和持久化，落地最慢。
