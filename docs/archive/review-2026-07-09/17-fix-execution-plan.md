# 修复落地执行计划

本文是从已完成审查分析到实际实现的落地桥接文档。范围以 `13-findings-register.md` 中已确证的 N-03、N-06 两个 P1，以及 `15-p2-fix-checklist.md` 里标为“值得现在做”的 P2 为主；`N-02` 虽在 15 号清单中标为“可延后”，但 15 号合并建议明确可随 N-03 做命名/注释/测试护栏，因此作为 N-03 批次的可选同批项处理。

本计划不修改源码、不跑构建/测试、不提交 commit。后续实现必须遵循仓库 `CODESHELL.md`：使用 `bun test`，不使用 npm/yarn/pnpm；typecheck 有存量错误，不作为单批次硬门禁。

## 1. 范围与依据

- N-03：`max_turns` 双发 `turn_complete` 已确证，推荐删除 TurnLoop 内部 maxTurns terminal emit，由 Engine epilogue 统一发 terminal，见 `docs/review-2026-07-09/13-findings-register.md:31`、`docs/review-2026-07-09/13-findings-register.md:33`、`docs/archive/review-2026-07-09/08-N03-fix-design.md:294` 到 `docs/archive/review-2026-07-09/08-N03-fix-design.md:337`。
- N-06：Interactive approval session rule cache 跨 session 泄漏已确证，推荐 backend 内按 `sessionId` 分桶并在 `ChatSessionManager.close(sessionId)` 清理，见 `docs/review-2026-07-09/13-findings-register.md:35` 到 `docs/review-2026-07-09/13-findings-register.md:38`、`docs/archive/review-2026-07-09/12-N06-fix-design.md:101` 到 `docs/archive/review-2026-07-09/12-N06-fix-design.md:117`。
- P2 现在做：F-05、F-08、N-04、N-05、N-08 在 15 号清单分别标为“值得”，见 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:5` 到 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:12`、`docs/archive/review-2026-07-09/15-p2-fix-checklist.md:23` 到 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:30`、`docs/archive/review-2026-07-09/15-p2-fix-checklist.md:41` 到 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:48`、`docs/archive/review-2026-07-09/15-p2-fix-checklist.md:50` 到 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:57`、`docs/archive/review-2026-07-09/15-p2-fix-checklist.md:68` 到 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:75`。
- 合并/拆分规则以 15 号批量建议为准：N-02 可随 N-03；F-08 可在 N-03 后同分支后续提交或独立 PR；N-04 与 N-06 协调但不阻塞；F-05 与 N-05 合并为 protocol 小批次；N-07 不与 N-06 同 PR，见 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:86` 到 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:92`。
- F-01/F-02/F-03/F-04/F-06 已有 04 号 P1 深挖设计，但不纳入本文当前执行窗口；若后续要推进，应另开执行计划。尤其 F-06 也在 permission area，安全语义需审慎，不应和 N-06 混成一个大 PR，见 `docs/archive/review-2026-07-09/04-p1-deep-dive-and-fix-design.md:287` 到 `docs/archive/review-2026-07-09/04-p1-deep-dive-and-fix-design.md:370`。

## 2. 落地批次划分

| 批次 | 包含 finding | 主要触及文件 | 可否与其它批次并行 | 前置依赖 |
|---|---|---|---|---|
| B1 | N-03；可选同批 N-02 轻量注释/命名护栏 | `packages/core/src/engine/turn-loop.ts`、`packages/core/src/engine/turn-loop-max-turns.test.ts`、新增 `packages/core/src/engine/engine.max-turns-stream.test.ts`；可选 `packages/core/src/engine/streaming-tool-queue.ts` | 可与 B2/B3/B6 并行；不建议与 B5 并行，因为 B5 也会动 `turn-loop.ts` | 无。建议最先做，半径小、契约清晰 |
| B2 | N-06 | `packages/core/src/tool-system/permission.ts`、`packages/core/src/engine/engine.ts`、`packages/core/src/protocol/chat-session-manager.ts`、`packages/core/src/tool-system/permission.session-cache.test.ts`、`packages/core/src/protocol/chat-session-manager.permission.test.ts` | 可与 B1/B3/B6 并行；不建议与 N-07 或 F-06 同 PR | 无。实现上应先写 backend cache 失败测试 |
| B3 | F-05 + N-05 protocol 小批次 | `packages/core/src/protocol/server.ts`、`packages/core/src/protocol/server.require-existing.test.ts`、新增或扩展 `packages/core/src/protocol/server.goalclear.test.ts`（文件名需实现时确认） | 可与 B1/B5/B6 并行；若 B2 同时改 `ChatSessionManager`，B3 只在 rebase 时复核 session lifecycle 测试 | 无；建议在 B2 后做以减少 session manager 上下文切换 |
| B4 | N-04 SDK approval envelope | `packages/core/src/protocol/client.ts`、`packages/core/src/protocol/types.ts`、新增 `packages/core/src/protocol/client.approval-events.test.ts`；必要时补 `server.*` approval notify 测试 | 可与 B1/B5/B6 并行；与 B2 语义协调，建议 B2 后做 | 建议等 B2 的 `sessionId` 隔离语义落地后再收敛 SDK surface |
| B5 | F-08 `tool_summary` 路由契约 | `packages/core/src/types.ts`、`packages/core/src/engine/turn-loop.ts`、`packages/core/src/engine/engine.ts`、`packages/desktop/src/renderer/types.ts`、新增/扩展 tool summary 与 desktop reducer 测试 | 可与 B2/B3/B4/B6 并行；必须与 B1 串行或同分支后续提交，避免同时改 `turn-loop.ts` | 建议 B1 后；若 B1 未做 N-02，B5 不应顺带做真流式工具执行 |
| B6 | N-08 sandbox 可见性小批次 | `packages/core/src/tool-system/builtin/powershell.ts`、`packages/core/src/tool-system/builtin/bash.ts`（仅回归对照）、`packages/core/src/types.ts`（如需扩展 `ToolResult.sandbox`）、相关 UI/文案文件需确认 | 可与 B1-B5 并行；不要顺手改权限审批或 sandbox backend wrapper | 无。只做短期“未隔离/覆盖面”可见性，不做中期 wrapper 重构 |

延后项：F-07 core 热启用重构、N-07 `permissionDefault` 执行语义、N-09 维护债均不进入本轮批次。F-07 提示和 N-08 可同属“可见性”主题，但 15 号清单明确 F-07 不建议近期改 core，见 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:14` 到 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:21`。

## 3. 每批执行卡

### B1：N-03 maxTurns terminal producer 收口

目标：同一次 `Engine.run(..., { onStream })` 的 `max_turns` live path 只发一条 agentId-less `turn_complete(max_turns)`，且由 Engine epilogue 发出；TurnLoop 只返回 terminal reason，不再作为 live terminal producer。N-02 若同批，只改注释/命名/测试护栏，不做真流式工具执行。

TDD 顺序：

1. 先新增失败测试 `packages/core/src/engine/engine.max-turns-stream.test.ts`：fake provider 让第一轮返回 tool call，maxTurns summary 返回 `"final summary"`；断言 `result.reason === "max_turns"`、`result.text === "final summary"`、`turn_complete(max_turns)` 只有 1 条。测试设计见 `docs/archive/review-2026-07-09/08-N03-fix-design.md:300` 到 `docs/archive/review-2026-07-09/08-N03-fix-design.md:310`、`docs/archive/review-2026-07-09/08-N03-fix-design.md:341` 到 `docs/archive/review-2026-07-09/08-N03-fix-design.md:369`。
2. 扩展既有 `packages/core/src/engine/turn-loop-max-turns.test.ts`：文件头目前仍写“emits a matching turn_complete event”，见 `packages/core/src/engine/turn-loop-max-turns.test.ts:5` 到 `packages/core/src/engine/turn-loop-max-turns.test.ts:12`；改成 Engine epilogue owns terminal，并追加 TurnLoop 级断言：`onStream` 收集到的 `turn_complete` 数量为 0，`assistant_message` summary 仍存在。
3. 实现：删除 `packages/core/src/engine/turn-loop.ts` maxTurns 收口里的 `this.config.onStream?.({ type: "turn_complete", reason: "max_turns" })`，保留 summary `assistant_message` 和 `return { reason: "max_turns" }`。设计定位见 `docs/archive/review-2026-07-09/08-N03-fix-design.md:311` 到 `docs/archive/review-2026-07-09/08-N03-fix-design.md:318`。
4. 不改 protocol producer，不在 `server.ts` 合成 terminal；`ChatSession` / `AgentServer` 仍只转发 Engine stream event，见 `docs/archive/review-2026-07-09/08-N03-fix-design.md:328` 到 `docs/archive/review-2026-07-09/08-N03-fix-design.md:337`。
5. 跑 B1 测试集并自查事件顺序：summary `assistant_message` 不丢，`turn_complete(max_turns)` 不双发。

验收标准：

- `bun test packages/core/src/engine/engine.max-turns-stream.test.ts` 绿。
- `bun test packages/core/src/engine/turn-loop-max-turns.test.ts` 绿。
- `bun test packages/core/src/engine/turn-loop*.test.ts` 绿，至少包含 `turn-loop-steer-backfill.test.ts`、`turn-loop-abort.test.ts`、`turn-loop-error-safety.test.ts`、`turn-loop-summary-safety.test.ts`、`turn-loop-continuation.test.ts`，这些是 08 号建议回归面，见 `docs/archive/review-2026-07-09/08-N03-fix-design.md:399` 到 `docs/archive/review-2026-07-09/08-N03-fix-design.md:417`。
- 协议 smoke：`server.bg-shell-wakeup.test.ts`、`server.backgroundwork.test.ts`、`server.run-model.test.ts`、`transport.inprocess.test.ts` 绿，见 `docs/archive/review-2026-07-09/08-N03-fix-design.md:389` 到 `docs/archive/review-2026-07-09/08-N03-fix-design.md:442`。
- Desktop stream/fold 护栏绿：`types.test.ts`、`streamReducer.test.ts`、`streamGroups.test.ts`、`streamCoalescer.test.ts`、`messageMappers.test.ts`、`transcript-reader.test.ts`、`foldTranscript.test.ts`，见 `docs/archive/review-2026-07-09/08-N03-fix-design.md:444` 到 `docs/archive/review-2026-07-09/08-N03-fix-design.md:474`。

预计改动半径：小。核心实现一处 emit 删除；测试新增/扩展中等。若同批做 N-02，只允许注释/命名/测试护栏，不做执行模型变化，见 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:32` 到 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:39`。

### B2：N-06 interactive approval session cache 隔离

目标：session-scope allow/deny cache 只在同一 `sessionId` 内生效；无 `sessionId` 不记忆；session close 后清理 bucket；late approval 不得重建已关闭 bucket；project-scope seed 只进入当前 session bucket。

TDD 顺序：

1. 先扩展 `packages/core/src/tool-system/permission.session-cache.test.ts`，新增 allow 隔离失败测试：同一 backend 中 session A 对 `curl ...` session allow，session B 同 head command 必须再次 prompt 并可 deny。当前测试已有 operation 粒度和 burst dedupe 覆盖，但没有跨 `sessionId` 断言，见 `packages/core/src/tool-system/permission.session-cache.test.ts:24` 到 `packages/core/src/tool-system/permission.session-cache.test.ts:194`、`packages/core/src/tool-system/permission.session-cache.test.ts:196` 到 `packages/core/src/tool-system/permission.session-cache.test.ts:250`；设计要求见 `docs/archive/review-2026-07-09/12-N06-fix-design.md:217` 到 `docs/archive/review-2026-07-09/12-N06-fix-design.md:241`、`docs/archive/review-2026-07-09/12-N06-fix-design.md:348` 到 `docs/archive/review-2026-07-09/12-N06-fix-design.md:371`。
2. 补 deny 对称测试、无 `sessionId` 不记忆测试、同 session burst dedupe 仍只 prompt 一次、不同 session 并发不互相吸收。
3. 扩展 `packages/core/src/protocol/chat-session-manager.permission.test.ts`：参考已有 path approval cleanup 与 late approval 测试结构，见 `packages/core/src/protocol/chat-session-manager.permission.test.ts:124` 到 `packages/core/src/protocol/chat-session-manager.permission.test.ts:209`；新增 `ChatSessionManager.close clears interactive approval session rules` 和 `late interactive approval after close does not recreate session bucket`。
4. 实现 `InteractiveApprovalSessionState`：将 allow/deny rules、`promptTurn`、`cwd`、`savedProjectRules`、`onProjectRules` 移入 per-session state；新增 `getSessionState(sessionId, create)` 和 closed-session guard。设计见 `docs/archive/review-2026-07-09/12-N06-fix-design.md:242` 到 `docs/archive/review-2026-07-09/12-N06-fix-design.md:297`。
5. 替换 Engine session context 注入：用当前 `session.state.sessionId` 调 `setSessionContext(...)`，旧 `setCwd()` / `setOnProjectRules()` 只保留 legacy wrapper，不作为修复路径依赖。设计见 `docs/archive/review-2026-07-09/12-N06-fix-design.md:298` 到 `docs/archive/review-2026-07-09/12-N06-fix-design.md:314`。
6. 在 `ChatSessionManager.getOrCreate()` / `close()` 接入 `openInteractiveApprovalSession(sessionId)` / `clearInteractiveApprovalSession(sessionId)`，与 path-policy session lifecycle 对齐，见 `docs/archive/review-2026-07-09/12-N06-fix-design.md:315` 到 `docs/archive/review-2026-07-09/12-N06-fix-design.md:347`。
7. 跑 B2 测试集并自查无 sessionId、project seed、subagent/headless 路径。

验收标准：

- `bun test packages/core/src/tool-system/permission.session-cache.test.ts` 绿，新增 allow/deny/sessionless/并发隔离断言通过。
- `bun test packages/core/src/protocol/chat-session-manager.permission.test.ts` 绿，close cleanup 和 late approval 不重建 bucket 通过。
- `bun test packages/core/src/protocol/server.askuser-session-isolation.test.ts` 绿；该文件现有 `(sessionId, requestId)` 隔离范式见 `packages/core/src/protocol/server.askuser-session-isolation.test.ts:69` 到 `packages/core/src/protocol/server.askuser-session-isolation.test.ts:162`。
- `bun test packages/core/src/protocol/server.askuser-chatmanager.test.ts packages/core/src/protocol/server.askuser-timeout.test.ts packages/core/src/protocol/server.askuser-headless.test.ts` 绿。
- `bun test packages/core/src/tool-system/path-policy-approval.test.ts packages/core/src/credentials/use-credential-tool.test.ts packages/core/src/credentials/inject-credential-tool.test.ts packages/core/src/tool-system/builtin/agent.send-input.llm.test.ts packages/core/src/automation/runner.permission.test.ts` 绿；这些是 12 号列出的 session lifecycle / automation 护栏，见 `docs/archive/review-2026-07-09/12-N06-fix-design.md:373` 到 `docs/archive/review-2026-07-09/12-N06-fix-design.md:399`。

预计改动半径：中。核心在 permission backend 和 session lifecycle，安全语义强；不要同时夹带 N-07 或 F-06。

### B3：F-05 + N-05 protocol 小批次

目标：修复 `requireExisting:true` 创建 live empty session 的副作用；补齐 `agent/goalClear` 成功 clear 后的 `goal_cleared` stream notify，使 SDK/其它 client 也能观察到注释承诺的事件。

TDD 顺序：

1. 先扩展 `packages/core/src/protocol/server.require-existing.test.ts`：现有测试已断言 absent session 不 run、disk exists 时正常 run、无 `requireExisting` 时可新建，见 `packages/core/src/protocol/server.require-existing.test.ts:60` 到 `packages/core/src/protocol/server.require-existing.test.ts:124`；新增断言 `chatManager.get("gone-sid") === undefined`，并覆盖 `maxSessions` 不被空 session 占用。F-05 方向见 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:5` 到 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:12`。
2. 实现 `AgentServer.handleRunMulti()` preflight：在 `cm.getOrCreate()` 前检查 live map / disk probe；不存在则直接 `SessionNotFound` return；磁盘存在保留 `getOrCreate()` 路径。
3. 为 N-05 新增 `packages/core/src/protocol/server.goalclear.test.ts` 或扩展相邻 goal server 测试文件（具体文件名实现时确认）：成功 clear 且有 `sessionId` 时，server 发送 `Methods.StreamEvent`，payload 为 `{ sessionId, event: { type: "goal_cleared" } }`。已有 goal 相关 server 测试可参考 `packages/core/src/protocol/server.goalget.test.ts:43` 到 `packages/core/src/protocol/server.goalget.test.ts:110`。
4. 实现 `AgentServer.handleGoalClear()` notify；desktop 本地 optimistic dispatch 先保留，依赖 reducer 幂等。N-05 方向见 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:50` 到 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:57`。
5. 跑 protocol 相关回归。

验收标准：

- `bun test packages/core/src/protocol/server.require-existing.test.ts` 绿，且新增“未创建 live empty session / 不占 maxSessions”断言通过。
- `bun test packages/core/src/protocol/server.goalclear.test.ts` 绿；若选择扩展既有文件，则对应新增用例必须绿。
- `bun test packages/core/src/protocol/server.*.test.ts` 至少覆盖 run/goal/askuser 相关文件绿；特别关注 B2 后的 session lifecycle 不被 F-05 preflight 破坏。

预计改动半径：小。主要在 `server.ts`，但同文件处理多 RPC，代码审查时要确认没有把 notify 发给无 `sessionId` 的 legacy path。

### B4：N-04 SDK approval notification surface

目标：public `AgentClient` 不再丢 approval envelope 的 `sessionId`，并补 `approvalResolved` 事件 surface；保持旧 API 兼容。

TDD 顺序：

1. 新增 `packages/core/src/protocol/client.approval-events.test.ts`：用 in-process transport 模拟 `Methods.ApprovalRequest` notification，断言 SDK listener 能拿到 `sessionId`。`AgentClient` 现有协议测试模式可参考 `packages/core/src/protocol/client.steer.test.ts:13` 到 `packages/core/src/protocol/client.steer.test.ts:55`。
2. 同文件新增 `approvalResolved` 测试：收到 `Methods.ApprovalResolved` 时 emit `{ sessionId?, requestId }`。
3. 实现 `AgentClientEvents` 和 `handleNotification()`：可给 `approvalRequest` 增加第三个可选 meta 参数，或新增 envelope event；若改旧事件签名，必须兼容旧 listener。N-04 方向见 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:41` 到 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:48`。
4. 跑 client/protocol approval 回归，确认 B2 的 backend 隔离语义与 SDK surface 一致。

验收标准：

- `bun test packages/core/src/protocol/client.approval-events.test.ts` 绿。
- `bun test packages/core/src/protocol/client.steer.test.ts packages/core/src/protocol/server.askuser-session-isolation.test.ts packages/core/src/protocol/server.askuser-chatmanager.test.ts` 绿。
- SDK 文档/类型（如有）不再只暴露裸 `(requestId, request)`；兼容策略需在 PR 描述中写明。

预计改动半径：中。public SDK event surface 有兼容性风险；建议 B2 后独立 PR。

### B5：F-08 tool_summary 路由契约

目标：`tool_summary` 带目标 tool id / agent 契约，desktop 不再猜最近顶层 tool，子代理 summary 不错挂到主 feed。

TDD 顺序：

1. 新增 core 测试 `packages/core/src/engine/turn-loop-tool-summary.test.ts`（文件名可实现时确认）：TurnLoop emit `tool_summary` 时带 `toolCallIds: toolCalls.map(t => t.id)`；子代理 `agentId` 仍由 parent wrapper 补。F-08 方向见 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:23` 到 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:30`。
2. 扩展 `packages/desktop/src/renderer/types.test.ts`：有 `toolCallIds` 时按 id 找顶层 tool；有 `agentId` 时只写对应 agent card 的 toolCall；找不到 agent/tool 时不要 fallback 到顶层。该文件已有 subagent isolation 护栏，见 `packages/desktop/src/renderer/types.test.ts:269` 到 `packages/desktop/src/renderer/types.test.ts:303`。
3. 实现 core 类型：扩展 `StreamEvent.tool_summary` 为 `{ summary; toolCallIds?: string[]; agentId?: string }`，保持 optional 兼容旧 snapshot。
4. 实现 `TurnLoop` payload 和 desktop reducer 路由；不与 N-03 的 terminal producer 逻辑混改。
5. 跑 desktop stream/fold 回归，确认 `streamGroups`、message mapping、transcript replay 不退化。

验收标准：

- `bun test packages/core/src/engine/turn-loop-tool-summary.test.ts` 绿。
- `bun test packages/desktop/src/renderer/types.test.ts packages/desktop/src/renderer/lib/streamReducer.test.ts packages/desktop/src/renderer/messages/streamGroups.test.ts packages/desktop/src/renderer/lib/messageMappers.test.ts` 绿。`streamGroups.test.ts` 是 stream grouping 护栏，文件结构见 `packages/desktop/src/renderer/messages/streamGroups.test.ts:1` 到 `packages/desktop/src/renderer/messages/streamGroups.test.ts:120`。
- `bun test packages/desktop/src/main/transcript-reader.test.ts packages/desktop/src/renderer/automation/foldTranscript.test.ts` 绿，避免 snapshot/automation fold 旧事件兼容退化。

预计改动半径：中。跨 core 类型、TurnLoop 和 desktop reducer；必须 B1 后做或同分支后续提交。

### B6：N-08 PowerShell sandbox 可见性

目标：短期把 sandbox 覆盖面明确暴露：PowerShell 当前不走 sandbox wrapper 时，结果或 UI 应显示未隔离；不在本批次实现 PowerShell sandbox backend wrapper。

TDD 顺序：

1. 新增 `packages/core/src/tool-system/builtin/powershell.sandbox-status.test.ts` 或扩展相邻 PowerShell 测试（需确认文件位置）：给 `ctx.sandbox` 传入 off/fake backend，断言 PowerShell 结果带 `{ sandbox: { backend: "off" } }` 或明确的“未隔离”标记，不伪装成 seatbelt/bwrap。
2. 保留 Bash 对照：`packages/core/src/tool-system/builtin/bash.shell-env.test.ts` 已断言 Bash result carries sandbox mark，见 `packages/core/src/tool-system/builtin/bash.shell-env.test.ts:73` 到 `packages/core/src/tool-system/builtin/bash.shell-env.test.ts:88`；PowerShell 行为应与 UI 展示契约一致，但不要误称已隔离。
3. 实现 `powershell.ts` 的 sandbox status 返回；如需扩展 `ToolResult.sandbox` 类型，保持 backward-compatible optional。
4. 若改 UI 展示，补 desktop renderer 对 tool result sandbox mark 的测试（具体文件需实现时确认；若找不到现有专门文件，新增小测试）。
5. 跑 sandbox 与 shell invocation 回归，不做 backend wrapper 重构。

验收标准：

- `bun test packages/core/src/tool-system/builtin/powershell.sandbox-status.test.ts` 绿，或扩展文件对应用例绿。
- `bun test packages/core/src/tool-system/builtin/bash.shell-env.test.ts packages/core/src/tool-system/sandbox/sandbox.test.ts packages/core/src/tool-system/sandbox/sandbox-win32.test.ts packages/core/src/engine/sandbox-config.test.ts packages/core/src/runtime/spawn-common.test.ts` 绿。
- 文案/返回字段不让用户误以为 PowerShell 已受当前 sandbox backend 保护。N-08 方向见 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:68` 到 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:75`。

预计改动半径：小到中。只做可见性时较小；一旦接入 wrapper 就变成中等设计，不应混入此批。

## 4. 测试矩阵

| 测试文件/命令 | 类型 | 覆盖批次 | 用途 |
|---|---|---|---|
| `packages/core/src/engine/engine.max-turns-stream.test.ts` | 新增 | B1 | Engine live path `turn_complete(max_turns)` 只发一次 |
| `packages/core/src/engine/turn-loop-max-turns.test.ts` | 既有扩展 | B1 | TurnLoop 不再发 terminal；保留 maxTurns summary |
| `packages/core/src/engine/turn-loop-steer-backfill.test.ts` | 回归护栏 | B1 | steer/backfill 与 terminal producer 边界 |
| `packages/core/src/engine/turn-loop-abort.test.ts` | 回归护栏 | B1 | abort terminal reason 不退化 |
| `packages/core/src/engine/turn-loop-error-safety.test.ts` | 回归护栏 | B1 | model error / prompt too long terminal 边界 |
| `packages/core/src/engine/turn-loop-summary-safety.test.ts` | 回归护栏 | B1 | summary/assistant_message 不丢 |
| `packages/core/src/engine/turn-loop-continuation.test.ts` | 回归护栏 | B1 | continuation 状态机不退化 |
| `packages/core/src/protocol/server.bg-shell-wakeup.test.ts` | 回归护栏 | B1 | protocol wakeup 只转发 Engine stream |
| `packages/core/src/protocol/server.backgroundwork.test.ts` | 回归护栏 | B1/B5 | background work stream/event 兼容 |
| `packages/core/src/protocol/server.run-model.test.ts` | 回归护栏 | B1 | legacy run path terminal 转发 |
| `packages/core/src/protocol/transport.inprocess.test.ts` | 回归护栏 | B1/B4 | in-process protocol transport |
| `packages/desktop/src/renderer/types.test.ts` | 既有扩展/回归 | B1/B5 | desktop reducer terminal/tool_summary/subagent routing |
| `packages/desktop/src/renderer/lib/streamReducer.test.ts` | 回归护栏 | B1/B5 | `max_turns` 按完成类状态处理 |
| `packages/desktop/src/renderer/messages/streamGroups.test.ts` | 回归护栏 | B1/B5 | streamGroups 依赖 turn boundary 与 tool/agent folding |
| `packages/desktop/src/renderer/streamCoalescer.test.ts` | 回归护栏 | B1/B5 | coalescer 不破坏 boundary；F-03 另行计划时也必须跑 |
| `packages/desktop/src/renderer/lib/messageMappers.test.ts` | 回归护栏 | B1/B5 | snapshot/message shape 兼容 |
| `packages/desktop/src/main/transcript-reader.test.ts` | 回归护栏 | B1/B5 | transcript 读取兼容旧事件 |
| `packages/desktop/src/renderer/automation/foldTranscript.test.ts` | 回归护栏 | B1/B5 | automation fold 不因 terminal/tool summary 改动退化 |
| `packages/core/src/tool-system/permission.session-cache.test.ts` | 既有扩展 | B2 | session allow/deny/no-session/burst dedupe 隔离 |
| `packages/core/src/protocol/chat-session-manager.permission.test.ts` | 既有扩展 | B2 | close cleanup 与 late approval 不重建 bucket |
| `packages/core/src/protocol/server.askuser-session-isolation.test.ts` | 回归护栏 | B2/B4 | approval resolver 按 `(sessionId, requestId)` 隔离 |
| `packages/core/src/protocol/server.askuser-chatmanager.test.ts` | 回归护栏 | B2/B4 | chatManager approval path |
| `packages/core/src/protocol/server.askuser-timeout.test.ts` | 回归护栏 | B2 | approval timeout lifecycle |
| `packages/core/src/protocol/server.askuser-headless.test.ts` | 回归护栏 | B2 | headless ask 行为 |
| `packages/core/src/tool-system/path-policy-approval.test.ts` | 回归护栏 | B2 | path-policy session grant 不被 interactive cache 改坏 |
| `packages/core/src/credentials/use-credential-tool.test.ts` | 回归护栏 | B2 | credential no-session/session bucket 范式 |
| `packages/core/src/credentials/inject-credential-tool.test.ts` | 回归护栏 | B2 | credential inject session bucket 范式 |
| `packages/core/src/tool-system/builtin/agent.send-input.llm.test.ts` | 回归护栏 | B2 | subagent input/permission sessionId 传播 |
| `packages/core/src/automation/runner.permission.test.ts` | 回归护栏 | B2/B6 | automation permission/sandbox policy |
| `packages/core/src/protocol/server.require-existing.test.ts` | 既有扩展 | B3 | F-05 requireExisting 不创建空 session |
| `packages/core/src/protocol/server.goalclear.test.ts` | 新增或扩展，需确认文件名 | B3 | N-05 `goal_cleared` notify |
| `packages/core/src/protocol/client.approval-events.test.ts` | 新增 | B4 | N-04 SDK approvalRequest meta 与 approvalResolved |
| `packages/core/src/engine/turn-loop-tool-summary.test.ts` | 新增，文件名可确认 | B5 | F-08 tool_summary payload 带 target ids |
| `packages/core/src/tool-system/builtin/bash.shell-env.test.ts` | 回归护栏 | B6 | Bash sandbox mark 对照 |
| `packages/core/src/tool-system/builtin/powershell.sandbox-status.test.ts` | 新增或扩展，需确认文件名 | B6 | PowerShell 未隔离标记 |
| `packages/core/src/tool-system/sandbox/sandbox.test.ts` | 回归护栏 | B6 | sandbox backend 基础行为 |
| `packages/core/src/tool-system/sandbox/sandbox-win32.test.ts` | 回归护栏 | B6 | Windows sandbox fallback 语义 |
| `packages/core/src/engine/sandbox-config.test.ts` | 回归护栏 | B6 | run sandbox config 解析 |
| `packages/core/src/runtime/spawn-common.test.ts` | 回归护栏 | B6 | shell invocation / PowerShell `-Command` 行为 |

批次级建议命令：

- B1：`bun test packages/core/src/engine/engine.max-turns-stream.test.ts packages/core/src/engine/turn-loop-max-turns.test.ts`，随后 `bun test packages/core/src/engine/turn-loop*.test.ts`。
- B2：`bun test packages/core/src/tool-system/permission.session-cache.test.ts packages/core/src/protocol/chat-session-manager.permission.test.ts packages/core/src/protocol/server.askuser-session-isolation.test.ts`，随后跑 12 号列出的 permission/session 回归集。
- B3：`bun test packages/core/src/protocol/server.require-existing.test.ts packages/core/src/protocol/server.goalclear.test.ts`，随后 `bun test packages/core/src/protocol/server.*.test.ts`。
- B4：`bun test packages/core/src/protocol/client.approval-events.test.ts packages/core/src/protocol/client.steer.test.ts packages/core/src/protocol/server.askuser-session-isolation.test.ts`。
- B5：`bun test packages/core/src/engine/turn-loop-tool-summary.test.ts packages/desktop/src/renderer/types.test.ts packages/desktop/src/renderer/messages/streamGroups.test.ts`，随后跑 desktop stream/fold 护栏。
- B6：`bun test packages/core/src/tool-system/builtin/powershell.sandbox-status.test.ts packages/core/src/tool-system/builtin/bash.shell-env.test.ts packages/core/src/tool-system/sandbox/sandbox.test.ts packages/core/src/tool-system/sandbox/sandbox-win32.test.ts`。

## 5. 风险与回滚

| 批次 | 主要风险 | 验证方式 | 回滚方式 |
|---|---|---|---|
| B1 | N-03 涉终态边界：误删 summary、standalone `query()` terminal 现状变化、headless drain 复入额外 summary 未被本修复覆盖 | 新增 Engine 单 terminal 测试；TurnLoop 内部不发 terminal 测试；跑 `turn-loop*.test.ts` 和 protocol/desktop stream 护栏；运行时验证 headless drain | 独立 commit/PR；回滚只恢复 `turn-loop.ts` emit 与相关测试，不能连带回滚其它批次 |
| B2 | N-06 涉安全与多 session 生命周期：无 sessionId 记忆、project seed、late approval、per-session promptTurn 都可能影响真实审批 | 先失败测试覆盖 allow/deny/no-session/close/late approval；跑 askuser/path-policy/credential/automation 回归 | 独立 commit/PR；若线上发现审批异常，可回滚 B2，并临时建议用户不用 session-scope remember |
| B3 | `requireExisting` preflight 可能误判磁盘存在；`goal_cleared` notify 可能和 desktop optimistic dispatch 形成重复 UI marker | server require-existing 测试加 `chatManager.get` 与 maxSessions；goal clear notify 测试；desktop reducer 幂等检查 | 独立 commit/PR；可分别 revert F-05 或 N-05 小 commit |
| B4 | SDK public event surface 兼容性；旧 listener 可能只接收两个参数 | 新增 client event tests；保留旧 API 或新增 envelope event；PR 描述写兼容策略 | 独立 commit/PR；必要时只回滚 client surface，不影响 B2 backend 隔离 |
| B5 | core/desktop event contract 跨层；旧 snapshot 缺 `toolCallIds`；子代理 summary 错挂 | optional 字段兼容；desktop reducer 对找不到 agent/tool 不 fallback；跑 streamGroups/messageMappers/transcript 护栏 | 独立 commit/PR；若错挂严重，回滚 B5 不影响 B1/B2 |
| B6 | 用户可能误解“未隔离”标记；若误接 wrapper 会扩大平台差异 | 只做 status/UI/文案；跑 sandbox/shell invocation 回归；Windows fallback 测试必须绿 | 独立 commit/PR；可回滚 PowerShell result 字段/UI 展示，不影响权限审批 |

回滚策略：每个批次使用独立分支和独立 commit/PR，禁止把 B1+B2+B5 混成一个大提交。若同分支连续做 B1 后 B5，也应两个 commit，便于只回滚 `tool_summary` 契约而保留 N-03 terminal 修复。

## 6. 建议推进方式

推荐“一次推一个批次”：实现者会话先做测试失败，再做实现，再跑批次内必跑测试，再交给新的 codex 会话做 review。审查通过后再进入下一批。

推进序列：

1. B1：N-03 先做。理由：半径小、契约清晰，删除 TurnLoop 唯一错误 terminal producer即可；同时可选择只改 N-02 注释/测试护栏。B1 也是 B5 的前置，先完成能减少 `turn-loop.ts` 冲突。
2. B2：N-06 次之。理由：安全级权限边界泄漏，半径中等但已有完整设计；应独立实现、独立审查，不夹带 N-07/F-06。
3. B3：F-05 + N-05 protocol 小批次。理由：半径小、主要在 `server.ts`，适合在两个 P1 后快速收敛。
4. B4：N-04 SDK approval surface。理由：与 B2 共享 `sessionId` 审批语义，等 B2 落地后更容易定义兼容 API。
5. B5：F-08 tool_summary。理由：与 B1 都碰 `turn-loop.ts`，应等 B1 落地后做；跨 core/desktop，测试独立。
6. B6：N-08 sandbox 可见性。理由：可并行，但不阻塞 P1；若人手充足可与 B3/B4 并行，只要不扩大到 sandbox wrapper。

每批固定工作流：

1. 新开分支或新 commit，先写失败测试。
2. 只实现本批目标；遇到邻近问题记录到后续，不顺手混改。
3. 跑本批必跑测试和矩阵中的相关回归。
4. 自查文件范围、事件契约、legacy optional 字段兼容。
5. 交给独立 codex 会话做 code review；review 只看 bugs/regressions/missing tests。

## 7. 验证仍不足项

这些点在设计文档里被标为需运行时验证或实现期验证，不能只靠静态审查收口：

1. N-03 headless drain 复入：即使 TurnLoop 不再发 terminal，也要实际验证 headless drain 是否产生额外 summary model call、额外 `assistant_message`、或改变最终 transcript 形状，见 `docs/archive/review-2026-07-09/08-N03-fix-design.md:476` 到 `docs/archive/review-2026-07-09/08-N03-fix-design.md:500`。
2. N-03 standalone `query()` 行为：删除 TurnLoop terminal emit 后，`query()` 的 maxTurns 不再有这条特例 terminal；08 号建议不要在本 P1 patch 顺手修 `query()`，除非另加 query 专属测试，见 `docs/archive/review-2026-07-09/08-N03-fix-design.md:220` 到 `docs/archive/review-2026-07-09/08-N03-fix-design.md:228`、`docs/archive/review-2026-07-09/08-N03-fix-design.md:332` 到 `docs/archive/review-2026-07-09/08-N03-fix-design.md:337`。
3. N-06 subagent/headless/automation sessionId：child Engine 正常应有 child sessionId；headless/auto 不应走 interactive session cache；显式 delegate 到 interactive backend 时必须带 `sessionId` 才能记忆，见 `docs/archive/review-2026-07-09/12-N06-fix-design.md:132` 到 `docs/archive/review-2026-07-09/12-N06-fix-design.md:138`、`docs/archive/review-2026-07-09/12-N06-fix-design.md:375` 到 `docs/archive/review-2026-07-09/12-N06-fix-design.md:383`。
4. N-06 no-session 行为：`ApprovalRequest.sessionId` 缺失时，session-scope remember 必须按一次性审批处理或 fail-closed 地不记忆；不得使用 `"__global__"` / `"__nosession__"` 共享桶，见 `docs/archive/review-2026-07-09/12-N06-fix-design.md:261` 到 `docs/archive/review-2026-07-09/12-N06-fix-design.md:266`。
5. N-06 session close / late approval：`ChatSessionManager.close(sessionId)` 后应清理 interactive approval bucket；late approval resolve 不得重建 bucket，见 `docs/archive/review-2026-07-09/12-N06-fix-design.md:333` 到 `docs/archive/review-2026-07-09/12-N06-fix-design.md:347`。
6. N-06 project-scope seed：project approve 仍应持久化到当前 session cwd，但 seed session allow list 只能写当前 `sessionId` bucket；无 state/cwd 时不应写 global allow，见 `docs/archive/review-2026-07-09/12-N06-fix-design.md:292` 到 `docs/archive/review-2026-07-09/12-N06-fix-design.md:297`。
7. N-04 SDK compatibility：`approvalRequest` 旧 listener 是否仍可工作、是否需要新增 envelope event，需要实现时用 client tests 和 changelog/PR 描述确认，见 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:41` 到 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:48`。
8. F-08 old snapshot compatibility：旧 `tool_summary` 没有 `toolCallIds` 时必须保留 legacy fallback；但有 `agentId` 或 id miss 时不得错挂到顶层，见 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:23` 到 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:30`。
9. N-08 UI/结果字段语义：PowerShell 的“未隔离”标记必须能被 UI 正确展示，不得让用户误以为 PowerShell 已被 Bash/background/worktree 的 sandbox 覆盖，见 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:68` 到 `docs/archive/review-2026-07-09/15-p2-fix-checklist.md:75`。

## 8. 完成前自查

- 批次划分与 15 号合并建议一致：N-02 只作为 N-03 可选同批；F-08 在 N-03 后；N-04 与 N-06 协调；N-07 不进 N-06 PR；F-05 与 N-05 合并为 protocol 小批次。
- 串行/并行关系已明确：建议推进串行，但表中标出哪些批次工程上可并行；`turn-loop.ts` 与 permission area 的冲突已隔离。
- 测试矩阵覆盖 N-03、N-06 两个 P1 的新增验收测试和回归护栏，并包含 `turn-loop-max-turns.test.ts`、`permission.session-cache.test.ts`、`server.askuser-session-isolation.test.ts`、`streamGroups` 相关测试。
- 推进序列明确 B1/N-03 最先做，理由是半径小、契约清晰；N-06 第二，理由是安全级但半径中。
- 运行时验证清单收拢了 N-03 headless drain / `query()`、N-06 subagent/headless/sessionId/no-session/close/project seed，以及 P2 的 SDK compatibility、old snapshot、PowerShell 可见性遗留项。
