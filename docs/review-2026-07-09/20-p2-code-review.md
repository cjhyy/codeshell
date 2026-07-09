# P2 修复代码审查报告

审查对象：`codeshell-b3`、`codeshell-b4`、`codeshell-b5`、`codeshell-b6` 四个隔离 worktree。审查方式为只读：已看 `git diff HEAD` 全部源码与测试改动，未修改任何 worktree，未 commit。只在主仓写本报告。

依据：`15-p2-fix-checklist.md`、`17-fix-execution-plan.md`、`03-optimization-findings.md`、`09-protocol-event-and-session-contract.md`、`10-tool-system-execution-and-permission-contract.md`、`14-remaining-observations-verification.md`、`19-landing-status.md`。

## 总结

| Worktree | 分支 | 结论 | 验证 |
|---|---|---|---|
| B3 `/Users/admin/Documents/个人学习/代码学习/codeshell-b3` | `fix/b3-f05-n05` | APPROVE | `bun test packages/core/src/protocol`：78 pass，0 fail |
| B4 `/Users/admin/Documents/个人学习/代码学习/codeshell-b4` | `fix/b4-n04` | APPROVE | `bun test packages/core/src/protocol`：77 pass，0 fail |
| B5 `/Users/admin/Documents/个人学习/代码学习/codeshell-b5` | `fix/b5-f08` | APPROVE | `bun test packages/core/src/engine/turn-loop*.test.ts packages/desktop/src/renderer/types.test.ts packages/desktop/src/renderer/lib/streamReducer.test.ts`：128 pass，0 fail |
| B6 `/Users/admin/Documents/个人学习/代码学习/codeshell-b6` | `fix/b6-n08` | APPROVE | `bun test packages/core/src/tool-system/builtin packages/desktop/src/renderer/tool-cards`：449 pass，3 skip，0 fail |

未发现需要 REQUEST CHANGES 的正确性问题、越界重构或本仓边界违规。四个 worktree 均可 merge；建议按 `19-landing-status.md` 的顺序在已落地 P1 后逐个 rebase/merge。

## B3：F-05 + N-05

结论：APPROVE。

实现符合设计。`agent/run requireExisting` 在 `getOrCreate()` 前预检，仅当 live map 没有目标 session 时才 probe 磁盘，缺失时直接返回 `SessionNotFound`，避免创建空 live session：`packages/core/src/protocol/server.ts:417` 到 `:435`。磁盘存在时仍走 `getOrCreate()`，保留 permission mode 等 live session 重应用路径：`packages/core/src/protocol/server.ts:438` 到 `:440`。`ChatSessionManager.sessionExistsOnDisk()` 只构造 probe engine 并调用 `sessionExistsOnDisk()`，不写入 sessions map：`packages/core/src/protocol/chat-session-manager.ts:88` 到 `:92`。

`goalClear` 在确实 cleared 且有非空 `sessionId` 时发 `agent/streamEvent` `{ type:"goal_cleared" }`：`packages/core/src/protocol/server.ts:853` 到 `:857`。这补齐 N-05 的 StreamEvent 注释契约；desktop 既有本地 optimistic dispatch 对清空 goal 是幂等的，兼容性风险低。

测试质量足够。`server.require-existing.test.ts` 新增了缺失 session 不进入 live map 的断言：`packages/core/src/protocol/server.require-existing.test.ts:78` 到 `:81`，也覆盖 maxSessions 不被空 session 占用：`:84` 到 `:105`。删掉 preflight 会回到旧行为并变红。`server.goalclear.test.ts` 覆盖成功 clear 发 stream event：`packages/core/src/protocol/server.goalclear.test.ts:22` 到 `:44`，以及 clear=false 不发 event。

隐患检查：probe 会构造一个 Engine，但只在 `requireExisting:true` 且目标 session 不 live 时发生，且不会打开 session path approvals 或占用 `maxSessions`。这是设计要求的低频路径；未见额外持久副作用。

发现的问题：无。

## B4：N-04

结论：APPROVE。

实现符合设计且保持兼容。`approvalRequest` 旧事件名保留，只新增第三个可选 `meta` 参数暴露 envelope `sessionId`：`packages/core/src/protocol/client.ts:49` 到 `:53`、`:319` 到 `:322`、`:412` 到 `:419`。两参旧 listener 在运行时仍可正常接收前两个参数。新增 `approvalResolved` event surface：`packages/core/src/protocol/client.ts:54`、`:331` 到 `:336`、`:423` 到 `:430`，类型在 `packages/core/src/protocol/types.ts:327` 到 `:332`。

测试覆盖核心契约。`client.approval-events.test.ts` 覆盖 SDK listener 能拿到 `approvalRequest` envelope sessionId：`packages/core/src/protocol/client.approval-events.test.ts:30` 到 `:46`，以及 `approvalResolved` 带 `{ sessionId, requestId }`：`:49` 到 `:62`。删掉对应 notification handling 会变红。测试没有覆盖 sessionId 缺失时 `{ requestId }` 的 fallback，但实现路径简单且不会影响本次目标。

事件契约兼容性：desktop preload 原本直接透传 raw notification，不受该 SDK wrapper 变化影响。SDK 新增第三参和新 listener 是 additive change，没有发现会破坏既有消费方的地方。

发现的问题：无。

## B5：F-08

结论：APPROVE。

实现符合设计并守住 core/desktop 边界。core `StreamEvent.tool_summary` 增加 optional `toolCallIds`/`agentId`，兼容旧事件：`packages/core/src/types.ts:534`。TurnLoop emit summary 时带当前工具 batch 的 ids：`packages/core/src/engine/turn-loop.ts:1048` 到 `:1052`。子代理 `agentId` 仍由 parent wrapper 给 stream event 加上，不在 TurnLoop 硬编码 UI/desktop 概念。

desktop reducer 路由符合 F-08 目标。主 renderer reducer 在 `agentId` 存在时只更新对应 agent card 内 toolCall，找不到 agent/tool 就保持 state：`packages/desktop/src/renderer/types.ts:654` 到 `:668`。顶层事件有 `toolCallIds` 时按目标 id 更新，miss 时不 fallback：`:671` 到 `:678`。无 id 的 legacy 事件保留旧 fallback：`:681` 到 `:686`。mobile/flat stream reducer 同样按 `(tool id, agentId)` 精确匹配：`packages/desktop/src/renderer/lib/streamReducer.ts:334` 到 `:365`。

边界检查：desktop renderer 仍只有 `import type { StreamEvent, TaskInfo } from "@cjhyy/code-shell-core"`，没有新增运行时 codeshell 包 import；core 没有引入 desktop/tui。

测试质量足够。core 测试确认 batch ids 出现在 summary event：`packages/core/src/engine/turn-loop-tool-summary.test.ts:90` 到 `:113`。desktop 测试覆盖按 id 路由、agent 内路由、id miss 不 fallback、legacy no-id fallback：`packages/desktop/src/renderer/types.test.ts:270` 到 `:341`；flat reducer 也有对应覆盖。删掉 ids 或恢复最近工具猜测都会变红。

隐患检查：有 `toolCallIds` 但目标 id miss 时 summary 会被丢弃，这是有意取舍，避免错挂到最近顶层工具。合法 live 流中 `tool_summary` 由 tool result 后异步发出，目标 tool_use_start 应已到达；旧 snapshot/旧 worker 的 no-id 事件仍保留 fallback。当前取舍正确。

发现的问题：无。

## B6：N-08

结论：APPROVE。

实现符合短期可见性设计，没有把 PowerShell 接入 sandbox wrapper。PowerShell 所有文本返回都统一包成 `{ result, sandbox:{ backend:"off" } }`：`packages/core/src/tool-system/builtin/powershell.ts:36` 到 `:40`、`:53` 到 `:90`。执行仍是 `safeSpawn("pwsh"/"powershell.exe", ["-NoProfile","-NonInteractive","-Command", command])`，不调用 `ctx.sandbox.wrap()`：`:57` 到 `:71`。

结构化返回兼容现有工具注册层。`BuiltinToolResult` 既有 `{ result, sandbox }` 形态，registry 会把 `result` 和 `sandbox` 归一化到 `ToolResult`；Bash 已使用同一契约。仓内未发现除新增测试外直接调用 `powershellTool()` 并要求 string 的消费方。若外部把该内部 builtin 函数当 public API 直接 import，需要注意返回类型已从纯 string 扩为 union；这不是本仓当前阻塞项。

desktop 展示最小。`GenericToolCard` 只在 message 带 sandbox 时复用现有 `SandboxBadge`：`packages/desktop/src/renderer/tool-cards/GenericToolCard.tsx:97` 到 `:102`。`SandboxBadge` 文案说明覆盖 Bash/background/worktree/PowerShell 这类带 sandbox visibility 的工具，`backend:"off"` 显示「未隔离」：`packages/desktop/src/renderer/tool-cards/SandboxBadge.tsx:7` 到 `:27`。

测试质量足够。PowerShell 测试传入一个会 throw 的 fake sandbox backend，确认本 patch 没把 PowerShell 路由进 wrapper，且返回 `backend:"off"`：`packages/core/src/tool-system/builtin/powershell.sandbox-status.test.ts:11` 到 `:28`。desktop 测试确认通用工具卡显示未隔离 badge：`packages/desktop/src/renderer/tool-cards/GenericToolCard.test.tsx:22` 到 `:24`。删掉结构化 mark 或 UI badge 都会变红。

发现的问题：无。

## 跨 worktree / merge 风险

- B5 与 N-03 都改 `packages/core/src/engine/turn-loop.ts`，虽然位置不同，仍建议先 merge/rebase N-03，再 rebase B5 后跑 B5 测试。
- B3 与 N-06 都会碰 session lifecycle 附近文件，尤其 `packages/core/src/protocol/chat-session-manager.ts`。若 N-06 已先落地，B3 rebase 后复跑 protocol 测试，确认 `sessionExistsOnDisk()` probe 没绕过 N-06 的 session open/close 清理语义。
- B5 与 B6 都改 `packages/core/src/types.ts`、`packages/desktop/src/renderer/types.ts` 的不同区域，预计是机械冲突或无冲突；merge 后仍建议跑 B5/B6 各自测试。

## Merge 建议

四个 worktree 均可 merge：B3 APPROVE、B4 APPROVE、B5 APPROVE、B6 APPROVE。建议在 P1 分支合入后按 B4 → B3 → B6 → B5 或执行计划建议顺序推进；B5 跨 core+desktop 且碰 `turn-loop.ts`，放在 N-03 之后最稳。

完成前自查：4 个 worktree 均已看完整 diff；均已对照设计与 finding；均已跑指定相关测试；未发现 REQUEST CHANGES；core/TUI、desktop runtime import 边界已核对。
