# 新增测试质量审查报告

## 概述

本次按独立测试质量审查口径，只看测试本身，不审被测实现是否正确。覆盖用户列出的 9 个隔离 worktree、16 个测试文件。

方法：

- 读取主仓 `CODESHELL.md`，并对照 `docs/archive/review-2026-07-09/08-N03-fix-design.md`、`12-N06-fix-design.md`、`15-p2-fix-checklist.md`、`17-fix-execution-plan.md`、`21-test-coverage-gaps.md` 的目标契约。
- 对每个测试文件阅读 diff 和断言逻辑，再读取对应实现路径，判断 mock 边界是否保留目标语义。
- 对关键测试逐项做反事实推理：如果删除对应实现、恢复旧 bug、或改坏目标行为，测试是否会红。
- 只读抽跑所有列出的目标测试文件，未修改测试/源码，未 commit。

抽跑结果：全部通过，共 150 个测试。

- `codeshell-n03`: `bun test packages/core/src/engine/engine.max-turns-stream.test.ts packages/core/src/engine/turn-loop-max-turns.test.ts`，6 pass。
- `codeshell-n06`: `bun test packages/core/src/tool-system/permission.session-cache.test.ts packages/core/src/protocol/chat-session-manager.permission.test.ts`，23 pass。
- `codeshell-b3`: `bun test packages/core/src/protocol/server.require-existing.test.ts packages/core/src/protocol/server.goalclear.test.ts`，6 pass。
- `codeshell-b4`: `bun test packages/core/src/protocol/client.approval-events.test.ts`，2 pass。
- `codeshell-b5`: `bun test packages/core/src/engine/turn-loop-tool-summary.test.ts packages/desktop/src/renderer/types.test.ts packages/desktop/src/renderer/lib/streamReducer.test.ts`，97 pass。
- `codeshell-b6`: `bun test packages/core/src/tool-system/builtin/powershell.sandbox-status.test.ts packages/desktop/src/renderer/tool-cards/GenericToolCard.test.tsx`，2 pass。
- `codeshell-perm`: `bun test packages/core/src/tool-system/executor-permission-hooks.test.ts`，7 pass。
- `codeshell-ctx`: `bun test packages/core/src/engine/turn-loop-context-limit.test.ts packages/core/src/engine/engine.prompt-too-long.test.ts`，3 pass。
- `codeshell-goal`: `bun test packages/core/src/engine/turn-loop-goal-lifecycle.test.ts`，4 pass。

评级分布：优 7 个，良 8 个，需改进 1 个。未发现确认的“永远绿/完全无效断言”；发现 6 个可疑弱断言、白盒耦合或稳定性问题，见后文重点清单。

## 文件级审查

### codeshell-n03/packages/core/src/engine/engine.max-turns-stream.test.ts - 优

事实：测试使用真实 `Engine`，只 mock LLM provider，实际走 `Engine.run()`、TurnLoop、session 持久化和 `onStream`。第一例断言 `result.reason`、`result.text`、`state.status`、`turn_complete(max_turns)` 数量，见 `codeshell-n03/packages/core/src/engine/engine.max-turns-stream.test.ts:84` 到 `:103`。第二例通过真实 `asyncAgentRegistry`/`notificationQueue` 驱动 headless drain re-entry，断言最终文本来自 drain summary 且 terminal 仍只有一条，见 `:118` 到 `:180`。

反事实推断：如果恢复旧 bug，让 TurnLoop 和 Engine epilogue 都发 `turn_complete(max_turns)`，`:103`/`:180` 的数量断言会从 1 变 2 而失败。如果 Engine epilogue 不发 terminal，会变 0 而失败。如果 headless drain 不再复入，`:179` 会拿到 `"final summary"` 而失败。

评价：断言锁住了 N-03 的核心行为，mock 边界合理。可选加强点是额外断言 terminal event 不带 `agentId`，但当前测试已足够作为回归防线。

### codeshell-n03/packages/core/src/engine/turn-loop-max-turns.test.ts - 优

事实：新增用例直接驱动真实 `TurnLoop`，收集 `onStream`，断言 TurnLoop 在 maxTurns 时返回 `max_turns`、不发任何 `turn_complete`、仍发 summary `assistant_message`，见 `codeshell-n03/packages/core/src/engine/turn-loop-max-turns.test.ts:171` 到 `:190`。既有用例仍覆盖 maxTurns summary call 和 turns-remaining reminder，见 `:118` 到 `:156`。

反事实推断：如果把 TurnLoop 内部 terminal emit 加回去，`:189` 会失败。如果误删 summary emit，`:190` 会失败。如果 maxTurns 不再做最终 summary call，既有 `:132` 到 `:141` 会失败。

评价：TDD 真实性强，精准区分 TurnLoop 与 Engine 的 terminal 责任。

### codeshell-n06/packages/core/src/tool-system/permission.session-cache.test.ts - 良

事实：测试直接实例化真实 `InteractiveApprovalBackend`，覆盖 allow/deny 跨 `sessionId` 隔离、无 `sessionId` 不记忆、同 session 仍记忆、project-scope seed 只进当前 session、closed-session tombstone cap，以及既有 operation 粒度和 burst dedupe。关键断言在 `codeshell-n06/packages/core/src/tool-system/permission.session-cache.test.ts:33` 到 `:150`、`:153` 到 `:195`、`:424` 到 `:475`。

反事实推断：如果回到旧的全局 sessionAllowRules/sessionDenyRules，跨 session allow/deny 用例会在 `:61`/`:93` 的 `seen` 数组或 `:62`/`:94` 的结果断言失败。如果无 `sessionId` 仍进共享 bucket，`:121` 到 `:122` 会失败。如果 project seed 写入全局 allow，`:194` 到 `:195` 会失败。

问题：closed tombstone 用例在 `:427`、`:455` 到 `:457` 直接窥探私有字段 `(b as any).closedSessionIds`。这是白盒耦合，不是假阳性，但会把实现结构锁死；行为断言 `:459` 到 `:475` 已能覆盖 late approval 不重建 bucket。建议保留行为断言，把容量 cap 的私有字段检查降级为专门的实现级测试或通过公开 test helper 暴露。

评价：核心安全语义覆盖很强；因私有字段耦合评为良。

### codeshell-n06/packages/core/src/protocol/chat-session-manager.permission.test.ts - 良

事实：新增用例通过真实 `ChatSessionManager.getOrCreate()` 打开 session，再用 singleton interactive backend 制造 session remember，最后调用真实 `mgr.close(sessionId)`。`clears interactive approval session rules` 在 close 后断言同 session 重新 prompt 且被 deny，见 `codeshell-n06/packages/core/src/protocol/chat-session-manager.permission.test.ts:136` 到 `:166`。late approval 用例等待 prompt started 后 close，再 resolve approval，断言后续请求不会命中 late-created cache，见 `:169` 到 `:204`。

反事实推断：如果 `ChatSessionManager.close()` 不调用 `clearInteractiveApprovalSession()`，`:165` 或 `:166` 会失败。如果 late approval resolve 能重建 bucket，`:203` 或 `:204` 会失败。

问题：测试使用 `getInteractiveApprovalBackend()` singleton，`afterEach` 只重置 path/credential 状态，未显式重置 interactive backend prompt/cache，见 `:85` 到 `:94`。当前用例 session id 唯一，且本文件后续不依赖 promptFn 初始状态，实测无污染；但更大范围并跑时仍有测试顺序耦合风险。建议增加 interactive backend test reset helper，或在 afterEach 清 prompt/cache。

评价：生命周期语义测得准；singleton 测试卫生略弱。

### codeshell-b3/packages/core/src/protocol/server.require-existing.test.ts - 优

事实：测试使用真实 `AgentServer` 和真实 `ChatSessionManager`，只用 fake engine 控制 `sessionExistsOnDisk()` 与 run counter。新增断言 absent `requireExisting` 不创建 live empty session，见 `codeshell-b3/packages/core/src/protocol/server.require-existing.test.ts:78` 到 `:81`；并覆盖 maxSessions slot 不被消耗，见 `:84` 到 `:108`。

反事实推断：如果恢复旧路径，先 `getOrCreate("gone-sid")` 再检查磁盘，`:81` 或 `:106` 会失败；在 `maxSessions: 1` 场景还可能返回 Overloaded，`:105` 会失败。

评价：mock 边界在 engine 外围，server/session 副作用走真实代码，断言有效。

### codeshell-b3/packages/core/src/protocol/server.goalclear.test.ts - 良

事实：测试触发真实 `AgentServer` RPC handler，mock 的只是 `chatManager.get().clearGoal()` 返回值。成功分支断言 RPC response 和 `Methods.StreamEvent` payload，见 `codeshell-b3/packages/core/src/protocol/server.goalclear.test.ts:34` 到 `:45`；失败分支断言 `clearGoal false` 不 notify，见 `:55` 到 `:63`。

反事实推断：如果 server 不发 `goal_cleared` notify，`:42` 到 `:45` 会失败。如果 clear false 仍 notify，`:63` 会失败。

弱点：`:42` 使用 `find()`，只证明存在一个正确 notify；如果实现重复发送两个 `goal_cleared`，测试仍会绿。若协议期望 exactly-once，建议改为过滤 `Methods.StreamEvent` 后断言长度为 1，并可顺带断言 response/notify 顺序。

评价：目标行为基本锁住；exactly-once 断言偏弱。

### codeshell-b4/packages/core/src/protocol/client.approval-events.test.ts - 良

事实：测试使用真实 `AgentClient` 和 in-process transport，直接向 client 发送 protocol notification。第一例断言 approvalRequest listener 得到第三参 `meta.sessionId`，见 `codeshell-b4/packages/core/src/protocol/client.approval-events.test.ts:30` 到 `:46`；第二例断言 `approvalResolved` event surface，见 `:53` 到 `:67`。

反事实推断：如果保持旧 client 只 emit `(requestId, request)`，`:42` 到 `:46` 会失败。如果不处理 `Methods.ApprovalResolved`，`:64` 到 `:67` 会失败。

可加强点：目前只测带 `sessionId` 的 notification，没有测 sessionId 缺失时的兼容形态，例如 `meta` 为 `{}` 或 `undefined`、旧 listener 两参数仍能工作。不是假阳性，但 public SDK surface 建议补兼容性用例。

评价：核心新增 surface 有效；兼容面可补。

### codeshell-b5/packages/core/src/engine/turn-loop-tool-summary.test.ts - 良

事实：测试驱动真实 `TurnLoop`，fake model 返回两个 toolCalls，fake toolExecutor 返回对应结果，fake summarizer 返回 summary。断言 `tool_summary` 携带 `summary` 和完整 `toolCallIds`，见 `codeshell-b5/packages/core/src/engine/turn-loop-tool-summary.test.ts:90` 到 `:113`。

反事实推断：如果 TurnLoop 不再发 `toolCallIds`，`:109` 到 `:113` 会失败。如果 summary 事件不发，`summary` 为 `undefined`，`:109` 会失败。

弱点：`:106` 用固定 `setTimeout(30)` 等 fire-and-forget summary promise，存在慢环境下误红/误失败风险；`:108` 用 `find()`，不会发现重复 `tool_summary`。建议改成可等待的 summarizer promise/flush helper，并断言 `tool_summary` 数量为 1。

评价：目标 payload 测得准；异步等待方式可改进。

### codeshell-b5/packages/desktop/src/renderer/types.test.ts - 良

事实：新增 reducer 用例覆盖 top-level `toolCallIds` 优先路由、agent summary 不落到 main tool、target id miss 不 fallback、legacy no-id fallback，见 `codeshell-b5/packages/desktop/src/renderer/types.test.ts:269` 到 `:342`。

反事实推断：如果 top-level reducer 仍总是挂最新 tool，`:285` 到 `:286` 会失败。如果 target id miss 仍 fallback，`:328` 会失败。如果 legacy no-id fallback 被破坏，`:341` 会失败。

弱点：agent 用例只有一个 child tool，见 `:297` 到 `:309`。如果实现对 `agentId` 分支忽略 `toolCallIds`、总是更新该 agent 的最新 tool，这个测试仍会通过。建议增加 agent 内两个 toolCalls，summary 指向第一个，断言第二个无 summary；再补 agent target miss 不 fallback 到该 agent 最新 tool。

评价：主 feed 路由很强；子代理内部 id 定向断言偏弱。

### codeshell-b5/packages/desktop/src/renderer/lib/streamReducer.test.ts - 良

事实：轻量 stream reducer 同样新增 top-level id 路由、agent 隔离、miss 不 fallback，见 `codeshell-b5/packages/desktop/src/renderer/lib/streamReducer.test.ts:106` 到 `:144`。

反事实推断：如果 reducer 忽略 top-level `toolCallIds`，`:114` 到 `:115` 会失败。如果 target miss fallback 到最新 top-level tool，`:144` 会失败。

弱点：agent 用例也只有一个 child tool，见 `:118` 到 `:136`。与 `types.test.ts` 相同，无法防止 agent 内多工具时忽略 target id 的错挂。建议补双 child tool 和 agent id miss 用例。

评价：覆盖方向正确；子代理内部精度不足。

### codeshell-b6/packages/core/src/tool-system/builtin/powershell.sandbox-status.test.ts - 良

事实：测试传入 fake sandbox backend，`wrap()` 若被调用会抛错，实际调用 `powershellTool()` 后断言结构化结果包含 `{ sandbox: { backend: "off" } }`，见 `codeshell-b6/packages/core/src/tool-system/builtin/powershell.sandbox-status.test.ts:11` 到 `:28`。

反事实推断：如果 PowerShell 结果不带 sandbox status，`:28` 会失败。如果本 patch 误把 PowerShell 路由进 sandbox wrapper，`:15` 到 `:18` 会抛错失败。

可加强点：该测试只锁“未隔离标记/不走 wrapper”，不验证命令 stdout；在缺 PowerShell 的环境里，只要 spawn failure 也返回 `{ backend: "off" }` 就会通过。按 N-08 的可见性目标这是可接受的窄测试；若要锁执行成功，应另加环境可控的 safeSpawn mock 或跳过策略。

评价：目标明确，非假阳性；但环境语义较窄。

### codeshell-b6/packages/desktop/src/renderer/tool-cards/GenericToolCard.test.tsx - 需改进

事实：测试构造带 `sandbox: { backend: "off" }` 的 `ToolMessage`，静态渲染 `GenericToolCard`，只断言 HTML 包含 `"未隔离"`，见 `codeshell-b6/packages/desktop/src/renderer/tool-cards/GenericToolCard.test.tsx:21` 到 `:24`。

反事实推断：如果完全不渲染 sandbox badge，`:24` 会失败；所以它不是空断言。

问题：这是本批最像“弱假阳性”的测试。只测正例，且只查文本包含；如果组件无条件给所有 GenericToolCard 渲染 `"未隔离"`，或仅按 `toolName === "PowerShell"` 渲染而忽略 `message.sandbox`，该测试仍会绿。它不能锁住“只有携带 sandbox status 的工具才显示 badge，也不应把 seatbelt/bwrap 显示成未隔离”的条件行为。建议补两个负例：`sandbox` 缺失时不包含 `"未隔离"`；`sandbox: { backend: "seatbelt" }` 时显示隔离 backend/不显示未隔离。

评价：需要加强，否则作为 UI 回归防线偏弱。

### codeshell-perm/packages/core/src/tool-system/executor-permission-hooks.test.ts - 优

事实：测试使用真实 `ToolExecutor`、`ToolRegistry`、`HookRegistry`、`PermissionClassifier`，只 mock approval backend。覆盖 `pre_tool_use allow` 不能绕过 classifier deny/ask、path policy 仍在 handler 前执行、`on_permission_check allow` 不能升级 deny/ask，以及 allow 可降级为 deny/ask，见 `codeshell-perm/packages/core/src/tool-system/executor-permission-hooks.test.ts:97` 到 `:213`。

反事实推断：如果 `pre_tool_use allow` 直接跳过 classifier，`:103` 到 `:105` 或 `:120` 到 `:123` 会失败。如果 path policy 在 hook allow 后被跳过，`:144` 到 `:147` 会失败。如果 `on_permission_check` 允许升级到 allow，`:160` 到 `:163` 或 `:178` 到 `:181` 会失败。如果降级被误禁，`:190` 到 `:213` 会失败。

评价：安全边界测试质量高，mock 保真度好，断言能抓住目标回归。

### codeshell-ctx/packages/core/src/engine/turn-loop-context-limit.test.ts - 优

事实：测试直接驱动真实 `TurnLoop`，fake model 第一次抛 `ContextLimitError` 后成功，断言重试调用移除了最老 round、保留后续内容并加入 context removal marker，见 `codeshell-ctx/packages/core/src/engine/turn-loop-context-limit.test.ts:95` 到 `:109`。失败路径连续 4 次抛错，断言 `prompt_too_long` 和 error event，见 `:112` 到 `:134`。

反事实推断：如果不做 drop/retry，`:101` 到 `:103` 会失败；如果 retry 不裁剪旧消息，`:107` 会失败；如果三次后返回普通 `model_error` 或不发错误 event，`:129` 到 `:134` 会失败。

评价：反事实清晰，直接锁住 TurnLoop 恢复语义。

### codeshell-ctx/packages/core/src/engine/engine.prompt-too-long.test.ts - 优

事实：测试用 fake provider 驱动真实 `Engine.run()`，provider 每次抛 `ContextLimitError`。断言调用次数为 4、error event、Engine epilogue 的 `turn_complete(prompt_too_long)`、以及 `state.status` 持久化，见 `codeshell-ctx/packages/core/src/engine/engine.prompt-too-long.test.ts:53` 到 `:73`。

反事实推断：如果 Engine 不再转发 terminal，`:69` 会失败。如果状态仍被折叠成 `"errored"` 或不保存原始 reason，`:73` 会失败。如果 TurnLoop retry 次数变错，`:64` 会失败。

评价：Engine 层集成断言有效，和 TurnLoop 单测形成互补。

### codeshell-goal/packages/core/src/engine/turn-loop-goal-lifecycle.test.ts - 优

事实：文件同时覆盖 TurnLoop 直接行为和 Engine 持久化行为。预算耗尽用例断言在工具执行前停止、返回 `goal_budget_exhausted` 并发 assistant_message，见 `codeshell-goal/packages/core/src/engine/turn-loop-goal-lifecycle.test.ts:123` 到 `:155`。stop hook cap 用例断言 continuation 被 `maxStopBlocks` 限住，并发 `not_met`/`exhausted` progress，见 `:158` 到 `:202`。Engine 用例通过 fake provider 让模型调用 `complete_goal`/confirmed `cancel_goal`，断言 `engine.getGoal()` 和 `state.activeGoal` 都清空，见 `:249` 到 `:283`、`:290` 到 `:324`。

反事实推断：如果预算 guard 放在工具执行之后，`:147` 会失败。如果 stop hook 不封顶，`:187` 到 `:194` 会失败或跑到错误终态。如果 self-reported complete/cancel 不清持久 goal，`:282` 到 `:283`、`:323` 到 `:324` 会失败。

评价：覆盖真实风险点，Engine 层与 TurnLoop 层互补，TDD 真实性强。

## 重点可疑项

确认的“永远绿/完全无效断言”：0 个。

可疑弱断言/稳定性/白盒耦合：6 个。

1. `codeshell-b6/packages/desktop/src/renderer/tool-cards/GenericToolCard.test.tsx:22` 到 `:24`：只查 HTML 包含 `"未隔离"`，缺少 no-sandbox 和 seatbelt/bwrap 负例；无条件渲染未隔离也会绿。建议补条件渲染负例。评级：需改进。
2. `codeshell-b5/packages/desktop/src/renderer/types.test.ts:289` 到 `:315`：agent summary 只有一个 child tool，不能抓住“agent 内忽略 `toolCallIds`、总挂最新 child tool”的错挂。建议补两个 child tools 和 agent miss。评级：弱断言。
3. `codeshell-b5/packages/desktop/src/renderer/lib/streamReducer.test.ts:118` 到 `:136`：同上，轻量 reducer 的 agent summary 也缺多 child tool 定向断言。评级：弱断言。
4. `codeshell-b3/packages/core/src/protocol/server.goalclear.test.ts:41` 到 `:45`：使用 `find()` 只证明存在正确 stream event，不会发现重复 notify。建议断言 `Methods.StreamEvent` 数量为 1。评级：弱断言。
5. `codeshell-b5/packages/core/src/engine/turn-loop-tool-summary.test.ts:106` 到 `:113`：固定 30ms 等异步 summary，且用 `find()` 不抓重复 summary。建议改为 promise/flush helper 并断言数量。评级：稳定性/弱断言。
6. `codeshell-n06/packages/core/src/tool-system/permission.session-cache.test.ts:427`、`:455` 到 `:457`：直接访问私有 `closedSessionIds`，白盒耦合实现结构。行为断言本身有效，建议通过 test helper 或只保留黑盒 late-approval 行为。评级：白盒耦合。

## 总体结论

整体结论：这批测试作为回归防线总体可靠。核心 P1/P2 行为没有出现“mock 掉正要验证的逻辑”或“断言 mock 自己返回值”的问题；多数测试都触发真实 `Engine`、`TurnLoop`、`AgentServer`、`AgentClient`、`ToolExecutor` 或 reducer，只在 LLM/provider/transport/approval backend 这类边界做可控 fake。

最强的测试：N-03 Engine/TurnLoop terminal、N-06 backend session cache、permission hook hardening、context limit、goal lifecycle。这些测试若恢复对应 bug，基本会稳定变红。

需要优先加强的测试：`GenericToolCard.test.tsx` 的条件渲染负例，以及 B5 两个 desktop reducer 中 agent 内多 tool 的 `toolCallIds` 定向用例。它们不是无效测试，但当前只能证明“正例能显示/能更新某个 child”，还不能完整锁住“不要错挂”的目标行为。

建议后续补强顺序：

1. 给 `GenericToolCard` 补 no-sandbox 与 seatbelt/bwrap 负例。
2. 给两个 desktop reducer 补 agent 内两个 child tools，summary 指向非最新 child；再补 agent target id miss 不 fallback。
3. 把 `turn-loop-tool-summary.test.ts` 的固定 sleep 改成可等待的 summary promise，并断言 summary event exactly once。
4. 给 `server.goalclear.test.ts` 补 exactly-once notify 断言。
5. 为 interactive approval singleton 增加测试 reset helper，降低跨文件污染风险。
