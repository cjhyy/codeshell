# Bug 状态核实 — core/engine 区（codex 复核，2026-07-07，HEAD 7e4b0470）

> 本文件保留已修条目用于追溯；TODO.md 只保留未完成项。

## 1. ✅已修 — 压缩 token 低估 2.5×
- 已修：`context/manager.ts:141-145` `recordActualUsage(inputTokens, messageCount, messages)` 记录真实 tokens、消息数与 `lastActualAnchorEstimate`；`context/manager.ts:151-169` 在消息增长时走 actual+delta，在消息缩容/压缩后用 `lastActualTokens * (currentEstimate / lastActualAnchorEstimate)` 缩放真实锚点，不再因 `messages.length` 变小丢弃真实用量。
- 已修：`engine/turn-loop.ts:737-745` 把当前 `messages` 一并传给 `recordActualUsage(...)`。
- 已修：summary compact 后不再无条件返回；`context/manager.ts:482-528` 只有 `tokens <= snipGate` 才返回，否则继续跑 snip/window/emergency ladder。
- 测试覆盖：`context/manager-hybrid.test.ts:22-31` 覆盖压缩缩容后的真实锚点 rescale；`context/manager-micro-escalation.test.ts:97-115` 覆盖 summary 后仍超 gate 会继续 snip。
- 待改进但非 blocker：无真实 usage anchor 时仍回退启发式估算；`context/compaction.ts:17-23` 的 `estimateTokens()` 仍是 `estimateMessagesTokens()*4/3`。
- **发版 blocker 撤销。**

## 2. ✅已修 — complete_goal 无 active goal 可调
- `tool-system/builtin/index.ts:776-789` 由 `ctx.hasGoal===true` 控制 `complete_goal`/`cancel_goal` 可见性。
- `engine/engine.ts:1728-1804` 每轮构造 `toolVisibility.hasGoal` 并过滤 `toolDefs`；`tool-system/executor.ts:153-163` runtime 再拒；`engine/turn-loop.ts:1091-1098` 只有 `goalTracker` 存在时才短路完成。
- 结论：记忆过时，当前 HEAD 仍为已修。

## 3. ✅已修 — 并发 sessionId race（正常 Engine.run 路径）
- `logging/logger.ts:160-179` 使用 `AsyncLocalStorage`，`getCurrentSid()` 优先读 ALS，`runWithSid()` 为并发 run 提供隔离。
- `engine/engine.ts:1520-1524` 设置 `toolCtx.sessionId` 后直接 `return runWithSid(session.state.sessionId, async () => ...)`；当前正常 run 路径不再在 `runWithSid` 前写模块级 sid fallback。
- `rg -n "setCurrentSid\\(|logger\\.setSid\\(" packages/core/src packages/tui/src packages/desktop/src` 显示 `logger.setSid` 仍存在于 protocol client、TUI UI、state/debug 等 ALS 外 fallback 场景，但不在 `Engine.run` 并发执行体前置写入。
- 测试覆盖：`engine/engine-sid-isolation.test.ts:79-123` 并发 `sid-a`/`sid-b` model call 各自读到正确 sid，且外层 fallback 保持 `"outside-fallback"`。

## 4. ✅已修 — steer 只在 turn 顶部消费
- 当前不是“只顶部”：`engine/turn-loop.ts:571-577` 在每轮顶部消费 `normal_step`；`engine/turn-loop.ts:877-879`、`:963-965`、`:1095-1098`、`:1113-1116`、`:1137-1140`、`:1223-1225` 在完成/回填/max-turns 等路径消费 `finalize_backfill`。
- tool batch 场景下不会在每个 tool call 后插入 steer，这是为了保持 `tool_use`/`tool_result` 邻接合法；`engine/turn-loop.ts:1003-1052` 先 drain tools 并把 tool_result 写入同一 user message，随后进入下一轮，下一轮顶部 `normal_step` 在下一次模型调用前消费 queued steer。
- 测试覆盖：`engine/turn-loop-steer-backfill.test.ts:108-131`、`:196-222` 验证 tool batch 后、下次模型调用前消费 steer，且 steer 位于相邻的 `tool_use`/`tool_result` 之后；`:234-261` 覆盖正常 shutdown 前 backfill。

## 5. 🔶部分修 — 并发 DriveAgent 同工作区碰撞
- 已有：`tool-system/builtin/background-jobs.ts:119-125` 可按 normalized cwd 找 running jobs；`tool-system/builtin/drive-claude-code.ts:125-130` 对同 cwd writable background job 生成 warning。
- 未修：`tool-system/builtin/drive-claude-code.ts:188-193` 即使有 warning 仍 `backgroundJobRegistry.start(...)` 并返回 jobId；`:284-297` background 默认路径照常启动。
- 测试明确保留当前行为：`tool-system/builtin/drive-claude-code.test.ts:181-197` 第二个同 cwd writable job 只 warning，registry 中仍有两个同 cwd running job；`:219-238` 证明相对路径/尾斜杠规范化后也只是 warning。
- 修复方向：writable DriveAgent 按 normalized cwd 加互斥/租约锁，默认拒绝或排队；并发写强制独立 worktree。
- **仍是发版 blocker（若本版要求避免外部 agent 同 cwd 并发写）。**

## 6. ✅已修 — worktree resume 无 cwd 绑定
- `tool-system/builtin/drive-claude-code.ts:110-119` 成功后 `store.record({cli,sessionId,cwd})`；`cc-orchestrator/external-agent-session-store.ts:51-60` 记录 normalized cwd。
- `tool-system/builtin/drive-claude-code.ts:234-251` resume 时读取 binding，stored cwd 不存在/非目录则报错，stored cwd 与请求 cwd 不同则强制用 stored cwd。
- 测试覆盖：`tool-system/builtin/drive-claude-code.test.ts:246-265` 不同 cwd 强制 stored cwd；`:271-289` 相对/绝对同目录视为相同；`:296-333` stored cwd 缺失或变成文件时报错且 runner 不执行。
- 补充：只记 cwd，未自动填 `worktreePath`/`worktreeBranch`；CodeShell 自身 session resume 另有 SessionWorkspace。

## 发版 blocker（本区）
#5（并发 DriveAgent 同 cwd 无锁）。#1、#3、#4 已按当前 HEAD 撤销 blocker。
