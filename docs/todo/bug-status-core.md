# Bug 状态核实 — core/engine 区（codex 只读核实，2026-07-07，HEAD 5459def9）

> codex 沙箱只读无法自写，本文件由主 agent 代为落盘。

## 1. 🔶部分修 — 压缩 token 低估 2.5×
- 已改：`engine/turn-loop.ts:737` 把 `response.usage.promptTokens` 喂 `contextManager.recordActualUsage(...)`；`context/manager.ts:141` 记录真实 anchor；`:151` 用 `lastActualTokens * (currentEstimate/lastActualAnchorEstimate)` 重估。
- 未修：`context/manager.ts:479` 在 `summarized.compacted` 后直接 `return result`，压完仍超 gate 时不再跑 snip/window/emergency ladder；`context/compaction.ts:21` `estimateTokens()` 仍是 heuristic。
- 修复方向：summary compact 后继续跑后续 ladder 直到低于 gate；无真实 anchor 时用 tokenizer 或保守倍率。
- **发版 blocker（codex 判定）**

## 2. ✅已修 — complete_goal 无 active goal 可调
- `tool-system/builtin/index.ts:776` 由 `ctx.hasGoal===true` 控制；`engine/engine.ts:1810` 组 toolDefs 按 guard 过滤；`executor.ts:153` runtime 再拒；`turn-loop.ts:1090` 要求 goalTracker 存在。记忆过时（记忆说仅运行时 guard、schema 未 gate）。

## 3. 🔶部分修 — 并发 sessionId race
- 已有：`logging/logger.ts:160` AsyncLocalStorage，getCurrentSid 优先读 ALS。
- 未修：`engine/engine.ts:1528` 仍在 `runWithSid(...)` 前 `setCurrentSid(...)` 写模块级 fallback。
- 修复方向：正常 run 路径不写模块级 sid fallback；需 sid 处显式传参或更早进 ALS。
- 若本版要求彻底消除全局 sid race → blocker。

## 4. 🔶部分修 — steer 只在 turn 顶部消费
- 已非"只顶部"：`turn-loop.ts:571` 顶部 `consumeQueuedSteer(...,"normal_step")`；`:877` 有 `finalize_backfill`。
- 未修：`:1003` tool 执行整 batch drain，逐个 tool call 后不消费 steer。
- 修复方向：至少在完整 tool_result batch 写入后、下次模型调用前消费 steer（保持 tool_use/tool_result 邻接合法）。

## 5. 🔶部分修 — 并发 DriveAgent 同工作区碰撞
- 已有：`drive-claude-code.ts:125` duplicateCwdWarning；`background-jobs.ts:119` 可按 cwd 找 running。
- 未修：`drive-claude-code.ts:189` 只返回 warning 仍 start；测试 `:182` 断言同 cwd 两 running job 并存。
- 修复方向：writable DriveAgent 按 normalized cwd 加互斥/租约锁，默认拒绝或排队；并发写强制独立 worktree。
- **发版 blocker（codex 判定）**

## 6. ✅已修 — worktree resume 无 cwd 绑定
- `drive-claude-code.ts:110` 成功后 `store.record({cli,sessionId,cwd})`；`external-agent-session-store.ts:51` normalize；`:232` resume 读 binding，stored cwd 不同则强制用 stored，不存在则报错。测试 `:240`。
- 补充：只记 cwd，未自动填 worktreePath/Branch；CodeShell 自身 session resume 另有 SessionWorkspace（`session-manager.ts:325`）。

## 发版 blocker（本区）
#1（压缩压完不续跑 ladder）、#5（并发 DriveAgent 无锁）。#3 若要彻底消除 sid race 也升 blocker。
