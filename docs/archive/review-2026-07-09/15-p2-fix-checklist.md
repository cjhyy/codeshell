# P2 轻量修复设计清单

本清单按 `13-findings-register.md` 的实际严重度收口：P2 为 F-05、F-07、F-08、N-02、N-04、N-05、N-07、N-08；另按本轮要求轻量带上原文 P3 的 N-09。P1 已分别有 08、12、04 的专门修复设计，本文只补 P2/P3 的可落地方向。

## F-05（P2）`requireExisting` 失败前先创建 live empty `ChatSession`

- 问题：`agent/run` 的 `requireExisting:true` 能阻止实际 run，但会先创建一个空 live session，再返回 `SessionNotFound`。
- 位置：`packages/core/src/protocol/server.ts:411`、`packages/core/src/protocol/server.ts:429`、`packages/core/src/protocol/chat-session-manager.ts:53`、`packages/core/src/protocol/chat-session-manager.ts:78`
- 修复方向：改 `AgentServer.handleRunMulti()`，在 `cm.getOrCreate()` 前做 `requireExisting` preflight；若 live map 没有该 session，用 probe engine 调 `sessionExistsOnDisk(sessionId)`，不存在则直接发 `SessionNotFound` 并 return。保留磁盘存在时的 `getOrCreate()` 路径，以免破坏 live session 的 permission mode 重应用；测试补 `chatManager.get(gone) === undefined` 和 `maxSessions` 不被空 session 占用。
- 落地半径：小
- 是否值得现在做：值得
- 依赖/协同：与 P1 无直接冲突；可和 N-05 同属 protocol/server 小批次处理。

## F-07（P2）builtin capability `off` 可热生效，`on` 受构造期 frozen registry 限制

- 问题：项目 override 把 builtin 设为 `off` 下一 turn 可隐藏并执行期拒绝，但把构造期未注册的 builtin 设回 `on` 无法热加入，需要新 session。
- 位置：`packages/core/src/engine/engine.ts:267`、`packages/core/src/engine/engine.ts:569`、`packages/core/src/engine/engine.ts:1754`、`packages/core/src/engine/engine.ts:1808`
- 修复方向：近期不建议做 core 热启用重构；短期只把行为显式暴露给用户，例如在 `packages/core/src/capability-control/types.ts` / `service.ts` 增加运行时提示字段，并在 `packages/desktop/src/renderer/settings/CapabilitiesOverviewSection.tsx` 显示“启用 builtin 需新 session，禁用下一条消息生效”。若未来必须热启用，再拆 `ToolRegistry` 的注册全集与 per-turn visible/executable set，并在 `ToolExecutor` 加 allowlist gate，避免扩大 registry 后隐藏工具可被直接调用。
- 落地半径：小（只做提示）；大（真正热启用）
- 是否值得现在做：不建议改（不建议近期做 core 热启用；提示可延后补）
- 依赖/协同：这是已知 fail-closed 折中；不要和 N-07 的权限语义决策混在一个修复里。

## F-08（P2）`tool_summary` 缺少目标 tool id / agent 契约

- 问题：`tool_summary` 只有 summary 文本，desktop 只能挂到最近顶层 tool，子代理 summary 可能误挂或丢失。
- 位置：`packages/core/src/types.ts:534`、`packages/core/src/engine/turn-loop.ts:1048`、`packages/core/src/engine/engine.ts:1246`、`packages/desktop/src/renderer/types.ts:650`
- 修复方向：扩展 `StreamEvent.tool_summary` 为 `{ summary; toolCallIds?: string[]; agentId?: string }`，在 `TurnLoop` emit 时带 `toolCallIds: toolCalls.map((t) => t.id)`；子代理 `agentId` 可继续由 parent wrapper 补。改 `packages/desktop/src/renderer/types.ts`：有 `agentId` 时只写对应 agent card 的 toolCall，有 `toolCallIds` 时按 id 找顶层 tool，无 id 时保留 legacy fallback；找不到 agent/tool 时不要 fallback 到顶层，避免错挂。
- 落地半径：中
- 是否值得现在做：值得
- 依赖/协同：和 N-03 都会动 `packages/core/src/engine/turn-loop.ts`，可在修 N-03 后顺手补 payload，但 F-08 还会动 core 类型和 desktop reducer，建议测试独立覆盖。

## N-02（P2）`StreamingToolQueue` 名称/注释像流式执行，实际完整 `LLMResponse` 后才 enqueue

- 问题：UI 可在 streaming 阶段收到工具开始/args delta，但真实工具执行要等 `callModelWithFallback()` 返回完整 response 后才入队。
- 位置：`packages/core/src/engine/streaming-tool-queue.ts:1`、`packages/core/src/engine/streaming-tool-queue.ts:8`、`packages/core/src/engine/turn-loop.ts:691`、`packages/core/src/engine/turn-loop.ts:695`、`packages/core/src/engine/turn-loop.ts:1016`
- 修复方向：若暂不做真流式工具执行，先改 `StreamingToolQueue` 文件头和 `TurnLoop` 注释，明确它是“完整模型响应后保序执行，并让 concurrency-safe 工具在 enqueue 后立即启动”的队列；必要时改名为更中性的 `ToolExecutionQueue`。若要做真 streaming enqueue，需另立设计：等 provider 给出完整 tool id/name/args 后再入队，并处理 partial JSON、permission prompt、abort、重复 UI 事件和 transcript 顺序。
- 落地半径：小（命名/注释/测试）；大（真流式执行）
- 是否值得现在做：可延后
- 依赖/协同：可和 N-03 的 `turn-loop.ts` 测试/注释调整同批做；真流式执行不要和 N-03 混修。

## N-04（P2）SDK `AgentClient` approval notification 丢 `sessionId`，且不处理 `approvalResolved`

- 问题：public `AgentClient` 把 `agent/approvalRequest` 降级为 `(requestId, request)`，不暴露 envelope `sessionId`，也没有 `approvalResolved` 事件。
- 位置：`packages/core/src/protocol/client.ts:41`、`packages/core/src/protocol/client.ts:44`、`packages/core/src/protocol/client.ts:388`、`packages/core/src/protocol/client.ts:392`、`packages/core/src/protocol/server.ts:1937`、`packages/core/src/protocol/server.ts:1981`、`packages/core/src/protocol/server.ts:2017`
- 修复方向：改 `AgentClientEvents` 和 `handleNotification()`，把 `params.sessionId` 透出给 SDK consumer；为兼容旧 API，可新增 envelope 事件或给 `approvalRequest` 增加第三个可选 meta 参数。增加 `approvalResolved` event surface，SDK 收到 `Methods.ApprovalResolved` 时带 `{ sessionId?, requestId }` emit；测试覆盖 AskUser/browser/credential/workspace 这类 request 内不一定可靠带 sessionId 的场景。
- 落地半径：中
- 是否值得现在做：值得
- 依赖/协同：可与 N-06 的 session approval 隔离修复协调测试语义，尤其是 `sessionId` 是审批路由/隔离 key；实现上主要在 protocol client，不应阻塞 N-06 backend 修复。

## N-05（P2）`goal_cleared` 注释承诺 stream event，但 `agent/goalClear` 只回 RPC response

- 问题：`StreamEvent` 注释说 explicit `agent/goalClear` 会发 `goal_cleared`，server 实际只返回 `{ ok, cleared }`；desktop 通过本地 dispatch 弥补。
- 位置：`packages/core/src/types.ts:482`、`packages/core/src/types.ts:484`、`packages/core/src/types.ts:488`、`packages/core/src/protocol/server.ts:825`、`packages/core/src/protocol/server.ts:846`、`packages/desktop/src/renderer/App.tsx:3334`、`packages/desktop/src/renderer/App.tsx:3354`、`packages/desktop/src/renderer/types.ts:862`
- 修复方向：推荐让 `AgentServer.handleGoalClear()` 在 clear 成功且有 `sessionId` 时统一 `notify(Methods.StreamEvent, { sessionId, event: { type: "goal_cleared" } })`，使 SDK/其它 client 也能观察到注释承诺的事件。desktop 的本地 optimistic dispatch 可先保留，因为 reducer 对 `activeGoal = null` 是幂等；如果后续发现 UI 重复 marker，再按 `sessionId`/bucket 去重。
- 落地半径：小
- 是否值得现在做：值得
- 依赖/协同：与 F-05 同在 `packages/core/src/protocol/server.ts`，可同一 protocol 小批次处理；与 N-03/N-06 无直接冲突。

## N-07（P2）`RegisteredTool.permissionDefault` 是声明性元数据，不参与 classifier 判定

- 问题：工具定义要求填写 `permissionDefault`，但 `PermissionClassifier` 只看 explicit rules、Bash 特判和 mode fallback，不读取 tool definition。
- 位置：`packages/core/src/types.ts:111`、`packages/core/src/types.ts:117`、`packages/core/src/tool-system/builtin/index.ts:159`、`packages/core/src/tool-system/builtin/index.ts:175`、`packages/core/src/tool-system/builtin/index.ts:661`、`packages/core/src/tool-system/permission.ts:901`、`packages/core/src/tool-system/permission.ts:926`、`packages/core/src/engine/engine.ts:3037`
- 修复方向：先做产品/安全决策：`permissionDefault` 到底是 UI hint 还是执行语义。若是执行语义，让 classifier 或 executor 权限路径能拿到 tool definition，在 explicit rules 和 Bash 特判后、mode fallback 前应用 tool-level default，并补 custom tool allow/ask/deny 与 MCP default ask 测试；若只是 hint，则改注释/文档/字段命名，删掉“fall through to tool permissionDefault”这类执行语义表述。
- 落地半径：中
- 是否值得现在做：可延后
- 依赖/协同：会碰 `packages/core/src/tool-system/permission.ts`，不建议和 N-06 的 P1 安全修复同 PR 混改；等 N-06 落地后再做语义收敛更稳。

## N-08（P2）PowerShell 执行工具不走 sandbox，sandbox 覆盖面容易被误解

- 问题：Bash/background shell 走 `ToolContext.sandbox` 和 sandbox backend，PowerShell 直接 `safeSpawn("pwsh"/"powershell.exe")`，不读 `ctx.sandbox`，也没有 `ToolResult.sandbox` 标记。
- 位置：`packages/core/src/tool-system/sandbox/index.ts:4`、`packages/core/src/tool-system/sandbox/index.ts:7`、`packages/core/src/tool-system/builtin/bash.ts:95`、`packages/core/src/tool-system/builtin/bash.ts:121`、`packages/core/src/tool-system/builtin/powershell.ts:52`、`packages/core/src/tool-system/builtin/powershell.ts:60`、`packages/core/src/tool-system/builtin/powershell.ts:65`、`packages/core/src/runtime/safe-spawn.ts:29`
- 修复方向：短期把 sandbox status/UI/文档写清楚：当前隔离覆盖 Bash、background shell、worktree setup，不覆盖 PowerShell；PowerShell 至少返回 `sandbox:{ backend:"off" }` 或在 sandbox enabled 时给出“未隔离”标记。中期再评估把 `pwsh -NoProfile -NonInteractive -Command ...` 纳入 backend wrapper 的可行性，尤其要处理 Windows 无 seatbelt/bwrap、env allowlist 和 quoting 差异。
- 落地半径：小（可见性/标记）；中（接入 sandbox wrapper）
- 是否值得现在做：值得（先做可见性）
- 依赖/协同：权限审批仍会走现有 tool permission，不是 N-06 同类绕过；可独立处理。

## N-09（P3）`ToolExecutor.resultsToMessages()` 与当前 `tool_result` 契约漂移，但未被主链路调用

- 问题：保留的 helper 把 tool result 简化为纯文本 block，丢 `contentBlocks` 和 `is_error`，而主链路已使用 `toolResultToBlock()`。
- 位置：`packages/core/src/tool-system/executor.ts:638`、`packages/core/src/engine/turn-loop.ts:177`、`packages/core/src/engine/turn-loop.ts:1024`
- 修复方向：先确认它没有外部 API 依赖；若无，删除 `ToolExecutor.resultsToMessages()` 并同步更新旧架构文档引用。若要保留 helper，则把转换逻辑委托给 `toolResultToBlock()` 或抽一个共享转换函数，确保 `contentBlocks`、`is_error` 和错误文本契约一致。
- 落地半径：小
- 是否值得现在做：可延后
- 依赖/协同：P3 维护债；可在后续碰 tool result 转换或 F-08 工具事件契约时顺手清掉，但不建议占用 P1 修复窗口。

## P2 批量处理建议

- 可随 N-03 顺手合并：N-02 的命名/注释/测试护栏最适合跟 N-03 同批，因为都在 `packages/core/src/engine/turn-loop.ts` 附近；F-08 也会动 `turn-loop.ts`，但还涉及 `StreamEvent` 类型和 desktop reducer，建议作为 N-03 后的同分支后续提交或独立 PR。
- 可与 N-06 协调但不强行合并：N-04 和 N-06 都依赖 approval 的 `sessionId` 语义，可共享测试思路；N-04 的 SDK notification surface 可在 N-06 后补齐。N-07 虽然也在 permission area，但它是产品/安全语义决策，不建议和 N-06 的 P1 隔离修复同批。
- protocol 小批次：F-05 和 N-05 都集中在 `packages/core/src/protocol/server.ts`，半径小、互不冲突，适合合并处理；N-04 因为改 public SDK event surface，建议单独留一条兼容性 changelog/测试线。
- 可见性小批次：F-07 的“启用 builtin 需新 session”提示和 N-08 的 sandbox 覆盖提示都可作为低风险 UI/文案/metadata 批次；二者不需要改核心执行路径。
- 独立延后：N-09 是 P3 维护债，可在工具结果转换相关改动时清理；N-02 的真流式执行和 F-07 的真正热启用都属于大半径设计，不建议塞进本轮 P2 轻量修复。

## 覆盖自查

- 已收 register 中全部 P2：F-05、F-07、F-08、N-02、N-04、N-05、N-07、N-08。
- 已额外收 N-09（register 标 P3/维护债）。
- 每条均包含问题、位置、修复方向、落地半径、是否值得现在做、依赖/协同。
- 明确标注不建议改的项：F-07 的 core 热启用重构。
