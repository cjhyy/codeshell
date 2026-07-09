# 修复落地状态 — merge 交接单

> 2026-07-09 夜间自动编排产出。**全部改动在隔离 git worktree 里，未 commit、未 push、未污染 main。** 每个 worktree 已 `git add -A` 暂存，等卡密sama 审阅后决定 merge。

## 总览

17 号执行计划的 6 个批次全部 TDD 落地完成。每个批次一个独立 worktree + 独立分支，TDD 红→绿，回归全绿。

| 批次 | worktree | 分支 | finding | 严重度 | 测试结果 | 独立审查 |
|---|---|---|---|---|---|---|
| P1-a | `../codeshell-n03` | `fix/n03-dup-turn-complete` | N-03 max_turns 双发 turn_complete | P1 | turn-loop 34 pass | ✅ 18号 APPROVE+nit(已修) |
| P1-b | `../codeshell-n06` | `fix/n06-session-approval-cache` | N-06 权限缓存跨会话串(安全) | P1 | permission+askuser 42 pass | ✅ 18号 APPROVE+nit(已修) |
| B3 | `../codeshell-b3` | `fix/b3-f05-n05` | F-05 空 session / N-05 goal_cleared 事件 | P2 | protocol 78 pass | ⏳ 待审 |
| B4 | `../codeshell-b4` | `fix/b4-n04` | N-04 SDK approval sessionId/resolved | P2 | protocol 77 pass | ⏳ 待审 |
| B5 | `../codeshell-b5` | `fix/b5-f08` | F-08 tool_summary 目标 id/agent 契约 | P2 | B5 矩阵 204 pass | ⏳ 待审 |
| B6 | `../codeshell-b6` | `fix/b6-n08` | N-08 PowerShell sandbox 状态可见性 | P2/P3 | builtin 424 + tool-cards 25 pass | ⏳ 待审 |

## 各批次改动摘要

### N-03（P1，turn-loop）
- `packages/core/src/engine/turn-loop.ts`:1268 删除 max_turns 分支内的 `turn_complete` emit（由 Engine epilogue 统一发）
- 新增 `engine.max-turns-stream.test.ts`（Engine live path 只发 1 次 + headless drain 复入仍 1 次）
- 补 `turn-loop-max-turns.test.ts`（TurnLoop 内部不发 turn_complete，但 summary assistant_message 仍在）
- 遗留：standalone `query()` epilogue 未统一（设计取舍，需另 patch）

### N-06（P1 安全，tool-system）
- `permission.ts`:116 新增 `InteractiveApprovalSessionState`，allow/deny/promptTurn/cwd/projectRules 按 sessionId 分桶；无 sessionId 不读写 session remember
- `permission.ts`:132 `closedSessionIds` FIFO 上限 4096（防无界内存增长；真实 in-flight late approval 由 state identity 兜底）
- `engine.ts`:1663 backend project context 改为 `setSessionContext(sessionId,...)`，不再写全局
- `chat-session-manager.ts`:57 getOrCreate open / close clear interactive approval session
- 遗留：真实 LLM subagent continuation 是 skip 环境，subagent child sessionId 的 live 路径需人工端到端验证一次

### B3 — F-05 + N-05（P2，protocol）
- F-05：`server.ts` handleRunMulti 加 requireExisting preflight；`chat-session-manager.ts` 新增 `sessionExistsOnDisk()`。缺失 session 不再建空 live session、不占 maxSessions，返回 SessionNotFound
- N-05：`server.ts` handleGoalClear 在 cleared 且有 sessionId 时发 `goal_cleared` stream event

### B4 — N-04（P2，protocol SDK）
- `client.ts` 新增 `ApprovalRequestMeta`/`ApprovalResolvedEvent`；`onApprovalRequest` 第三参 meta(带 sessionId)；新增 `onApprovalResolved/offApprovalResolved`
- `types.ts` 补 `ApprovalResolvedNotification`

### B5 — F-08（P2，core+desktop）
- `core/src/types.ts` tool_summary 加 `toolCallIds?`/`agentId?`（optional 兼容）
- `turn-loop.ts` 发 summary 带当前工具批次 ids
- desktop `types.ts` + `lib/streamReducer.ts` 按 id 精确路由，miss 不 fallback，旧无 id 事件保 legacy fallback
- 守住 core↔desktop 边界（desktop 仍 type-only import core）

### B6 — N-08（P2/P3，tool-system+desktop）
- 只做证据成立部分：`powershell.ts` 结果结构化 + 固定携带 `sandbox:{backend:"off"}`（明示未隔离）
- desktop `GenericToolCard.tsx` 复用 `SandboxBadge` 让 PowerShell 卡显示「未隔离」
- 未做「用户误解覆盖面」的臆测改动（证据不足）

## ✅ 集成验证已通过（2026-07-09 夜间实测）

已在临时 worktree 里把 6 份暂存补丁按下面的建议顺序全部应用，验证它们能干净集成：

- **6 份补丁按 N-03→N-06→B4→B3→B6→B5 顺序全部干净应用，零冲突、零语义打架**（`git apply --check` 全通过，无需手工解 hunk）。
- 预期的两处交叉（B5↔N-03 同改 `turn-loop.ts`、B3↔N-06 同碰 `chat-session-manager.ts`）实测均无文本冲突。
- 集成后全量受影响测试全绿：engine 258、protocol 82、tool-system 605(+3 skip)、desktop reducer/tool-cards/types 97 —— 合计 1042+ pass / 0 fail。
- 结论：**6 个修复可以放心按此顺序依次 merge**，不会踩 rebase 坑。（验证用的临时 worktree 已删除，不影响 6 个修复 worktree。）

## 建议 merge 顺序

1. **先 P1**：N-03（半径小、契约清晰）→ N-06（安全，半径中）。两者已过独立审查。
2. **再 P2**：B4 → B3 → B6 → B5（B5 跨 core+desktop 半径最大，放最后）。
3. B5/F-08 与 N-03 都动 `turn-loop.ts`，若都要 merge，注意先后 rebase（N-03 删一处 emit，B5 在 summary 发射处加字段，位置不同但同文件）。

## 夜间增量产出（审查+修复之外）

在既定 17 findings + 6 修复之外，夜间还持续产出了以下增量（全部只读/文档/隔离 worktree，未 commit、未碰 main）：

- **集成验证**：6 修复补丁按建议顺序全部干净集成、1042+ 测试全绿（见上方「集成验证已通过」小节）。
- **可视化 v3**（`visualization-v3.html`）：bug 版，带 N-03/N-06 两个 P1 bug 触发帧 + 17 findings 叠加，用于定位问题发生在哪一步，已独立事实核对（209 数据点，file:line 全对真实源码）。
- **测试覆盖盲区扫描**（`21-test-coverage-gaps.md`）：扫 17 文件，11 个真盲区（高5/中4/低2），最高优先级 = ToolExecutor 权限 hook 硬化、TurnLoop ContextLimitError 恢复、goal 生命周期。
- **权限 hook 硬化测试**（worktree `../codeshell-perm`，分支 `test/perm-hook-hardening`）：针对盲区 #1 补 7 个执行层安全测试，固化「hook 不能绕过/提升权限」的安全保证。**实现本就安全，无 bug**；测试作为回归防线，`executor-permission-hooks.test.ts`，tool-system 605 pass。可选 merge。
- **ContextLimitError 恢复测试**（worktree `../codeshell-ctx`，分支 `test/ctxlimit-recovery`）：针对盲区 #2 补 3 个测试，固化「超限→裁剪最旧 round 重试→最多 3 次→仍失败发 error 返回 prompt_too_long + Engine 持久化终态」。**实现本就稳，无缺陷**；`turn-loop-context-limit.test.ts` + `engine.prompt-too-long.test.ts`，engine 257 pass。「最多重试 3 次」标注需人工确认是否产品化为显式配置。可选 merge。
- **goal 生命周期测试**（worktree `../codeshell-goal`，分支 `test/goal-lifecycle`）：针对盲区 #3 补 4 个测试，固化「预算耗尽→goal_budget_exhausted 终止不执行工具、stop hook 续跑达 maxStopBlocks 上限强制停止（**防无限循环**）、complete_goal/cancel_goal 都清空持久 goal」。**实现本就安全，无缺陷**；`turn-loop-goal-lifecycle.test.ts`，engine 258 pass。「续跑触顶终态=completed」标注需人工确认。可选 merge。
- **三个高优先级盲区（#1/#2/#3）已全部 TDD 固化**（perm / ctx / goal 三个 worktree），均证明实现本就安全、无 bug，测试作为回归防线。中低优先级盲区（见 21 号报告）留人工决定。
- **测试质量审查**（`22-test-quality-audit.md`）：独立审 16 个新测试文件（抽跑 150 pass），评级优7/良8/需改进1，**0 个完全无效假阳性**，列出 6 个可疑弱断言（带 file:line）。结论：这批测试作为回归防线整体可靠。
- **按审查意见补强**（已回写到 `../codeshell-b6`）：GenericToolCard.test.tsx 补 2 个负例（无 sandbox→不显示「未隔离」、seatbelt+deny→显示 seatbelt+网络禁止），闭合「审出弱断言→补强」。另补强了 b3 的 `server.goalclear.test.ts`（`find()` 存在性 → `filter().toHaveLength(1)` 恰好一次 + `clearGoal` 只调一次，锁住「goal_cleared 不重复发」，与今晚 N-03 防双发同源；无实现 bug，protocol 78 pass）。其余弱断言（B5 子代理多 tool 定向、私有字段白盒耦合等）记录在 22 号，留人工决定是否加强。

## 清理

merge 或放弃后清理 worktree：
```bash
git worktree remove ../codeshell-n03 ../codeshell-n06 ../codeshell-b3 ../codeshell-b4 ../codeshell-b5 ../codeshell-b6 ../codeshell-perm ../codeshell-ctx ../codeshell-goal
git branch -d fix/n03-dup-turn-complete fix/n06-session-approval-cache fix/b3-f05-n05 fix/b4-n04 fix/b5-f08 fix/b6-n08 test/perm-hook-hardening test/ctxlimit-recovery test/goal-lifecycle
```

## 待人工验证（各修复设计标注的运行时项）
- N-03：standalone query() 终态统一
- N-06：真实 LLM subagent continuation 的 sessionId 隔离（skip 环境未自动跑）

## 全程护栏
文档产出只读+写 docs/；代码落地全在隔离 worktree、TDD、未 commit、未碰 main。P1 已独立审查（18号），P2 待审。
