# P1 修复代码审查报告

审查对象：

- N-03：`/Users/admin/Documents/个人学习/代码学习/codeshell-n03`，分支 `fix/n03-dup-turn-complete`
- N-06：`/Users/admin/Documents/个人学习/代码学习/codeshell-n06`，分支 `fix/n06-session-approval-cache`

本次只读审查两个修复 worktree，未修改两个 worktree，未 commit。唯一写入文件为本报告。

## N-03：`max_turns` 双发 `turn_complete`

结论：**APPROVE with nits**

验证结果：

- `bun test packages/core/src/engine/turn-loop`：32 pass，0 fail
- `bun test packages/core/src/engine/engine.max-turns-stream.test.ts`：2 pass，0 fail
- 合计：34 pass，0 fail

设计对照：

- 修复实现符合设计方案 A。`/Users/admin/Documents/个人学习/代码学习/codeshell-n03/packages/core/src/engine/turn-loop.ts:1261` 到 `:1268` 保留 maxTurns summary 的 `assistant_message` 和 `{ reason: "max_turns" }` 返回，但已经移除 TurnLoop 内部 `turn_complete(max_turns)`。
- Engine 仍在 epilogue 统一发 terminal event，位置是 `/Users/admin/Documents/个人学习/代码学习/codeshell-n03/packages/core/src/engine/engine.ts:2355` 到 `:2363`，时机在保存 state 和 `on_agent_end` 之后，符合设计文档的 terminal producer 边界。
- `rg` 复核后，Engine/TurnLoop/query 相关源码中 live `turn_complete` producer 只剩 Engine epilogue，未新增协议层或 TurnLoop 侧 producer。

测试质量：

- TurnLoop 单测 `/Users/admin/Documents/个人学习/代码学习/codeshell-n03/packages/core/src/engine/turn-loop-max-turns.test.ts:171` 到 `:190` 会在恢复旧 emit 时变红，能锁住 “TurnLoop 不拥有 terminal producer” 的内部契约。
- Engine 集成测试 `/Users/admin/Documents/个人学习/代码学习/codeshell-n03/packages/core/src/engine/engine.max-turns-stream.test.ts:60` 到 `:108` 会在旧双发路径下收到两条 `turn_complete(max_turns)`，能捕获真实 live path 回归。
- Headless drain 覆盖 `/Users/admin/Documents/个人学习/代码学习/codeshell-n03/packages/core/src/engine/engine.max-turns-stream.test.ts:110` 到 `:180`，验证 re-enter TurnLoop 后仍只有一个 terminal event。该测试没有把 summary call 数量作为强断言，和设计中“headless 额外 summary 是后续观察点”的边界一致。

发现的问题：

- **Nit / 需人工确认**：新增的 Engine 集成测试当前是未跟踪文件。`git diff HEAD` 未包含 `packages/core/src/engine/engine.max-turns-stream.test.ts`，但 `git status --short` 显示 `?? packages/core/src/engine/engine.max-turns-stream.test.ts`。该文件的关键覆盖在 `/Users/admin/Documents/个人学习/代码学习/codeshell-n03/packages/core/src/engine/engine.max-turns-stream.test.ts:60` 到 `:180`。如果实际 merge/commit 只带 tracked diff，这个 P1 回归测试不会落地。建议 merge 前确认该文件纳入变更。

回归风险判断：

- 正常结束、abort、compact、model error 等路径没有被改动，TurnLoop 原本也不为这些 reason 发 `turn_complete`。
- standalone `query()` 仍不统一补发 terminal event，删除 maxTurns 特例后不再保留 query 的旧特殊行为；这与设计文档明确的取舍一致，不建议在本 P1 patch 中扩大范围。

## N-06：InteractiveApprovalBackend session rule cache 隔离

结论：**APPROVE with nits**

验证结果：

- `bun test packages/core/src/tool-system/permission`：32 pass，0 fail
- `bun test packages/core/src/protocol/server.askuser`：9 pass，0 fail
- `bun test packages/core/src/protocol/chat-session-manager.permission.test.ts`：9 pass，0 fail
- 合计：50 pass，0 fail

设计对照：

- 修复实现符合推荐方案 A。`/Users/admin/Documents/个人学习/代码学习/codeshell-n06/packages/core/src/tool-system/permission.ts:151` 到 `:152` 将 session allow/deny state 改为按 `sessionId` 管理的 map，并增加 closed-session tombstone。
- cache 读取已按 bucket 执行：`/Users/admin/Documents/个人学习/代码学习/codeshell-n06/packages/core/src/tool-system/permission.ts:248` 到 `:276`。
- session allow/deny 写入已限定在 active session state 内：`/Users/admin/Documents/个人学习/代码学习/codeshell-n06/packages/core/src/tool-system/permission.ts:317` 到 `:341`。
- 无 `sessionId` 时不会创建共享全局 bucket，session-scope remember 会被忽略并返回一次性结果：`/Users/admin/Documents/个人学习/代码学习/codeshell-n06/packages/core/src/tool-system/permission.ts:223` 到 `:233`、`:317` 到 `:325`。
- project-scope 持久化使用 session context，session seed 只写当前 bucket：`/Users/admin/Documents/个人学习/代码学习/codeshell-n06/packages/core/src/tool-system/permission.ts:342` 到 `:388`。
- Engine 已改为注入 per-session context：`/Users/admin/Documents/个人学习/代码学习/codeshell-n06/packages/core/src/engine/engine.ts:1663` 到 `:1672`。
- ChatSessionManager 已接入 open/clear：`/Users/admin/Documents/个人学习/代码学习/codeshell-n06/packages/core/src/protocol/chat-session-manager.ts:57` 到 `:59`、`:103` 到 `:109`。
- 改动都在 core 内部，没有引入 `core -> tui` 依赖，也没有偏离 bun 测试约束。

测试质量：

- `permission.session-cache.test.ts` 新增 allow 隔离、deny 隔离、无 sessionId 不记忆、同 session 仍记忆、project seed 隔离，覆盖点在 `/Users/admin/Documents/个人学习/代码学习/codeshell-n06/packages/core/src/tool-system/permission.session-cache.test.ts:30` 到 `:196`。这些测试在旧 singleton array 实现下会变红，不是恒真断言。
- 既有 session cache 测试已补上同一 `sessionId`，避免因为新契约“无 sessionId 不记忆”而把原有 operation narrowing 覆盖误测宽。
- close 与 late approval 测试在 `/Users/admin/Documents/个人学习/代码学习/codeshell-n06/packages/core/src/protocol/chat-session-manager.permission.test.ts:136` 到 `:205`，能捕获 close 后 session rule 未清理、late resolve 重新写入 bucket 的回归。

发现的问题：

- **Low / 需人工确认**：`closedSessionIds` 是无界 tombstone set。`clearSession()` 会删除真实 session state，但会把 id 加入 `closedSessionIds`，见 `/Users/admin/Documents/个人学习/代码学习/codeshell-n06/packages/core/src/tool-system/permission.ts:206` 到 `:209`；只有同 id 再次 `openSession()` 时才删除，见 `:201` 到 `:204`。这不会保留 allow/deny 规则，P1 权限串台已经修掉；但长生命周期进程如果持续创建大量一次性 session，会每个关闭过的唯一 session 留一个 string。该模式与现有 path-policy tombstone 类似，但从“session close 是否真清理”的角度建议人工确认是否接受，或后续改成有界 tombstone / pending-request generation 机制。

回归风险判断：

- A/B session allow 和 deny 已隔离；无 sessionId 的 fallback 不共享缓存；同 session 内 remember 仍有效。
- 并发同 session 继续通过 per-bucket `promptTurn` 串行并二次查 cache，见 `/Users/admin/Documents/个人学习/代码学习/codeshell-n06/packages/core/src/tool-system/permission.ts:263` 到 `:276`。不同 session 使用不同 state，因此不会被同一个 prompt chain 阻塞。当前测试覆盖了同 session 并发和跨 session 顺序隔离；没有单独的“不同 session 并发”测试，但实现没有共享 promptTurn。

## 总体建议

总体建议：**可以 merge 回 main，但 merge 前必须确认 N-03 的未跟踪 Engine 集成测试已纳入实际变更**。

两个修复的核心逻辑都实现了设计意图，改动范围集中，没有看到无关抽象或边界违规。N-03 的唯一 merge 风险是新增测试文件未被 `git diff HEAD` 收录；N-06 的主要残余是 closed-session tombstone 的长期增长，建议作为 non-blocking follow-up 或由维护者确认接受。

完成前自查：

- 已分别查看两个 worktree 的 `git diff HEAD`，并额外发现 N-03 未跟踪新增测试。
- 已对照四份设计/验证文档核对实现意图、最小化和边界约束。
- 已审查新增测试是否能在旧 bug 下失败。
- 已运行用户指定测试命令并记录通过数。
- 结论已明确，未给出 REQUEST CHANGES。
