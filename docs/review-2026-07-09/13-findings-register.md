# Findings Register 总账

本文是 `docs/review-2026-07-09/` 这轮架构审查的统一总账入口，只汇总既有文档结论，不新增源码判断，不修改 `packages/**`。F 系列来自 `../archive/review-2026-07-09/03-optimization-findings.md`，N 系列来自 `06`、`09`、`10`、`14` 后续深挖；其中 N-03、N-06 分别已有 `08`、`12` 的专门修复设计，P2/P3 轻量修复方向见 `15`。修复落地与 merge 交接见 `../archive/review-2026-07-09/19-landing-status.md`，P1/P2 独立审查结论分别见 `../archive/review-2026-07-09/18-fix-code-review.md`、`../archive/review-2026-07-09/20-p2-code-review.md`。

## 1. 总账表

| 编号 | 一句话标题 | 严重度 | 状态 | 归属模块 | 深挖在哪份文档 | 是否有修复设计 |
|---|---|---|---|---|---|---|
| F-01 | streaming fallback 的 tombstone / assistant_message 补偿契约在桌面链路不可用 | P1 | 已出修复设计 | 桌面流 | `../archive/review-2026-07-09/04-p1-deep-dive-and-fix-design.md` | `04` |
| F-02 | `stream_request_start` 用脏 `activeAgents` 推断归属，可能压掉主回复槽 | P1 | 已出修复设计 | 桌面流 | `../archive/review-2026-07-09/04-p1-deep-dive-and-fix-design.md` | `04` |
| F-03 | coalescer 合并 delta 时没有在 hard boundary 上切段 | P1 | 已出修复设计 | 桌面流 | `../archive/review-2026-07-09/04-p1-deep-dive-and-fix-design.md` | `04` |
| F-04 | snapshot 的 seq 游标只在 replay 内成立，live IPC 不带 seq | P1 | 已出修复设计 | 桌面流 | `../archive/review-2026-07-09/04-p1-deep-dive-and-fix-design.md` | `04` |
| F-05 | `requireExisting` 失败前先创建 live empty `ChatSession` | P2 | 已出修复设计；已在 `../codeshell-b3` TDD 落地，20号独立审查 APPROVE，merge 交接见 `../archive/review-2026-07-09/19-landing-status.md` | protocol | `../archive/review-2026-07-09/05-p2-deep-dive-and-fix-design.md` | `05` |
| F-06 | `pre_tool_use: ask` 用户批准后跳过 classifier deny / rules | P1 | 已出修复设计 | tool-system | `../archive/review-2026-07-09/04-p1-deep-dive-and-fix-design.md`、`../archive/review-2026-07-09/10-tool-system-execution-and-permission-contract.md` | `04` |
| F-07 | builtin `off` 可热生效，`on` 受构造期 frozen registry 限制 | P2 | 已验证确证；已知设计折中，不建议近期强推 core 重构 | engine | `../archive/review-2026-07-09/05-p2-deep-dive-and-fix-design.md`、`../archive/review-2026-07-09/10-tool-system-execution-and-permission-contract.md` | `05`（短期提示；长期热启用仅备选） |
| F-08 | `tool_summary` 缺少目标 tool id / agent 契约，只能猜挂载目标 | P2 | 已出修复设计；已在 `../codeshell-b5` TDD 落地，20号独立审查 APPROVE，merge 交接见 `../archive/review-2026-07-09/19-landing-status.md` | tool-system | `../archive/review-2026-07-09/05-p2-deep-dive-and-fix-design.md`、`../archive/review-2026-07-09/09-protocol-event-and-session-contract.md` | `05` |
| N-01 | `TurnPhase` / `TurnState.phase` 当前只是概念遗留，不驱动 runtime 状态机 | 非问题 | 已验证确证 | engine | `../archive/review-2026-07-09/06-turn-loop-state-machine.md`、`../archive/review-2026-07-09/07-new-observations-verification.md` | 无 |
| N-02 | `StreamingToolQueue` 名称/注释像流式执行，但实际完整 `LLMResponse` 后才 enqueue | P2 | 已验证确证 | engine | `../archive/review-2026-07-09/06-turn-loop-state-machine.md`、`../archive/review-2026-07-09/07-new-observations-verification.md` | 无 |
| N-03 | `max_turns` 路径双发 `turn_complete(max_turns)`，且第一条早于 Engine epilogue | P1 | 已出修复设计；已在 `../codeshell-n03` TDD 落地，18号独立审查 APPROVE+nit（19号记为已修），merge 交接见 `../archive/review-2026-07-09/19-landing-status.md` | engine | `../archive/review-2026-07-09/06-turn-loop-state-machine.md`、`../archive/review-2026-07-09/07-new-observations-verification.md`、`../archive/review-2026-07-09/08-N03-fix-design.md`、`../archive/review-2026-07-09/09-protocol-event-and-session-contract.md` | `08` |
| N-04 | SDK `AgentClient` approval notification 丢 `sessionId`，且不处理 `approvalResolved` | P2 | 已确证（范围校准）；已在 `../codeshell-b4` TDD 落地，20号独立审查 APPROVE，merge 交接见 `../archive/review-2026-07-09/19-landing-status.md` | protocol | `../archive/review-2026-07-09/09-protocol-event-and-session-contract.md`、`../archive/review-2026-07-09/14-remaining-observations-verification.md` | 无 |
| N-05 | `goal_cleared` 类型注释承诺 stream event，但 `agent/goalClear` server 只回 RPC response | P2 | 已确证；已在 `../codeshell-b3` TDD 落地，20号独立审查 APPROVE，merge 交接见 `../archive/review-2026-07-09/19-landing-status.md` | protocol | `../archive/review-2026-07-09/09-protocol-event-and-session-contract.md`、`../archive/review-2026-07-09/14-remaining-observations-verification.md` | 无 |
| N-06 | `InteractiveApprovalBackend` session allow/deny cache 实际挂在 singleton 上，跨 session 泄漏 | P1 | 已出修复设计；已在 `../codeshell-n06` TDD 落地，18号独立审查 APPROVE+nit（19号记为已修），merge 交接见 `../archive/review-2026-07-09/19-landing-status.md` | tool-system | `../archive/review-2026-07-09/10-tool-system-execution-and-permission-contract.md`、`../archive/review-2026-07-09/11-N06-verification.md`、`../archive/review-2026-07-09/12-N06-fix-design.md` | `12` |
| N-07 | `RegisteredTool.permissionDefault` 是声明性元数据，当前不参与 classifier 判定 | P2 | 已确证 | tool-system | `../archive/review-2026-07-09/10-tool-system-execution-and-permission-contract.md`、`../archive/review-2026-07-09/14-remaining-observations-verification.md` | 无 |
| N-08 | PowerShell 执行工具不走 sandbox，sandbox 覆盖面容易被误解 | P2 | 部分成立；已在 `../codeshell-b6` TDD 落地，20号独立审查 APPROVE，merge 交接见 `../archive/review-2026-07-09/19-landing-status.md` | tool-system | `../archive/review-2026-07-09/10-tool-system-execution-and-permission-contract.md`、`../archive/review-2026-07-09/14-remaining-observations-verification.md` | 无 |
| N-09 | `ToolExecutor.resultsToMessages()` 与当前 `tool_result` 契约漂移，但未被主链路调用 | P3 | 已确证（维护债；非主链路） | tool-system | `../archive/review-2026-07-09/10-tool-system-execution-and-permission-contract.md`、`../archive/review-2026-07-09/14-remaining-observations-verification.md` | 无 |

计数：共 17 条；P1 7 条，P2 8 条，P3 1 条，非问题 1 条。

## 2. 修复落地状态

已在隔离 worktree TDD 落地、待按 `../archive/review-2026-07-09/19-landing-status.md` 交接 merge 的 finding：N-03（`../codeshell-n03` / `fix/n03-dup-turn-complete`）、N-06（`../codeshell-n06` / `fix/n06-session-approval-cache`）、F-05 + N-05（`../codeshell-b3` / `fix/b3-f05-n05`）、N-04（`../codeshell-b4` / `fix/b4-n04`）、F-08（`../codeshell-b5` / `fix/b5-f08`）、N-08（`../codeshell-b6` / `fix/b6-n08`）。P1 审查见 `../archive/review-2026-07-09/18-fix-code-review.md`，P2 审查见 `../archive/review-2026-07-09/20-p2-code-review.md`，结论均为 APPROVE。

仍未在本轮 worktree 落地的项分两类：F-01、F-02、F-03、F-04、F-06 仍是已出修复设计但待实现；N-02、N-07、N-09 仍是后续命名/语义/维护债处理项。N-01 是非问题，无需代码落地；F-07 是已知设计折中，近期不建议强推 core 重构。

## 3. 已确证 P1 新观察

**N-03：`max_turns` 双发 `turn_complete`**

`../archive/review-2026-07-09/07-new-observations-verification.md` 已把 06 中的“推测”校准为确证：普通 `Engine.run()` live path 在 `TurnLoop` maxTurns summary 分支发一次 `turn_complete(max_turns)`，Engine epilogue 保存 state 和跑 end hook 后又发一次。`../archive/review-2026-07-09/08-N03-fix-design.md` 推荐方案 A：删除 TurnLoop 内部 maxTurns terminal emit，由 Engine epilogue 统一作为 live terminal event producer。该方案已在 `../codeshell-n03` TDD 落地，并由 `../archive/review-2026-07-09/18-fix-code-review.md` 独立审查 APPROVE；merge 交接见 `../archive/review-2026-07-09/19-landing-status.md`。仍需运行时验证的是 headless drain 复入是否产生额外 summary model call / `assistant_message` / transcript 形状变化；方案 A 已覆盖 terminal 双发本身，但不覆盖这些额外可见形状。

**N-06：Interactive approval session rule cache 跨 session**

`../archive/review-2026-07-09/11-N06-verification.md` 已确证：`InteractiveApprovalBackend` 的 `sessionAllowRules` / `sessionDenyRules` 是 singleton backend 实例字段，读写不按 `ApprovalRequest.sessionId` 分桶；会话 A 的“本会话一直允许/拒绝”可能影响会话 B 的同 operation。`../archive/review-2026-07-09/12-N06-fix-design.md` 推荐在 backend 内引入按 `sessionId` 分桶的 session state，并在 `ChatSessionManager.close(sessionId)` 清理 bucket。该方案已在 `../codeshell-n06` TDD 落地，并由 `../archive/review-2026-07-09/18-fix-code-review.md` 独立审查 APPROVE；merge 交接见 `../archive/review-2026-07-09/19-landing-status.md`。仍需人工端到端验证真实 LLM subagent continuation 的 sessionId 隔离。

## 4. 已确证/部分成立但尚无专门修复设计

- N-04：`AgentClient` SDK approval surface 丢 `sessionId`、不处理 `approvalResolved`。09 给出源码证据，14 做范围校准；desktop preload 主路径不受影响。虽未出独立修复设计文档，但已按 17 号 B4 批次在 `../codeshell-b4` TDD 落地，并由 `../archive/review-2026-07-09/20-p2-code-review.md` 独立审查 APPROVE。
- N-05：`goal_cleared` 注释与 protocol/server 行为不一致。09 给出源码证据，14 已确证；desktop 通过本地 dispatch 弥补，SDK/其它 client 可能不同步。虽未出独立修复设计文档，但已按 17 号 B3 批次在 `../codeshell-b3` TDD 落地，并由 `../archive/review-2026-07-09/20-p2-code-review.md` 独立审查 APPROVE。
- N-07：`permissionDefault` 当前不进入 classifier。10 给出源码证据，14 已确证；需要先决定它是 UI hint 还是执行语义。未跑测试，未出独立修复设计。
- N-08：PowerShell 不走 sandbox 是代码事实；“用户以为所有 shell 都被 sandbox 包住”是 10/14 明确标注的推测风险，因此状态为部分成立。虽未出独立修复设计文档，但已按 17 号 B6 批次在 `../codeshell-b6` TDD 落地，并由 `../archive/review-2026-07-09/20-p2-code-review.md` 独立审查 APPROVE。
- N-09：`resultsToMessages()` 与当前 `tool_result` 契约漂移，但 10/14 中 `rg` 未发现主链路调用；严重度为 P3，状态为已确证的维护债。

N-01、N-02、N-03 不在本段：它们已由 07 做证据级校准。N-06 也不在本段：它已由 11 确证并由 12 给出修复设计。

## 5. F 系列深挖状态

`../archive/review-2026-07-09/04-p1-deep-dive-and-fix-design.md` 已深挖全部 F 系列 P1：F-01、F-02、F-03、F-04、F-06。每条都有根因链、复现/触发路径、影响边界、修复方案、TDD 测试点和风险回归面。

`../archive/review-2026-07-09/05-p2-deep-dive-and-fix-design.md` 已深挖全部 F 系列 P2：F-05、F-07、F-08。F-05 和 F-08 都给了常规修复设计；F-07 的最终口径不同于普通 bug：它是代码注释已明示的设计折中，失败模式 fail-closed，05 不建议近期强推 core 长期重构，可先显式提示“启用 builtin 需新 session”。因此 F-07 不是“证伪”，而是“确证为已知折中，近期不改核心路径”。

F 系列没有已证伪项；也没有 P0。截至 `19`/`20`，F-05 已在 `../codeshell-b3` TDD 落地并由 20 号独立审查 APPROVE；F-08 已在 `../codeshell-b5` TDD 落地并由 20 号独立审查 APPROVE。F-01、F-02、F-03、F-04、F-06 仍处于已出修复设计但未在本轮 worktree 落地的状态；F-07 仍按“已知设计折中，近期不改核心路径”处理。

## 6. 建议 merge / 后续处理顺序

已落地项先按交接单 merge：N-03 → N-06 → B4(N-04) → B3(F-05 + N-05) → B6(N-08) → B5(F-08)。已落地项的测试、分支和清理命令以 `../archive/review-2026-07-09/19-landing-status.md` 为准，P2 审查结论以 `../archive/review-2026-07-09/20-p2-code-review.md` 为准。

| 顺序 | 项 | 当前处理口径 | 备注 |
|---|---|---|---|
| 1 | N-03 | 已在 `../codeshell-n03` TDD 落地，18号 APPROVE，待 merge | 仍需另行处理/验证 standalone `query()` 终态统一 |
| 2 | N-06 | 已在 `../codeshell-n06` TDD 落地，18号 APPROVE，待 merge | 仍需人工端到端验证真实 LLM subagent continuation 的 sessionId 隔离 |
| 3 | B4 / N-04 | 已在 `../codeshell-b4` TDD 落地，20号 APPROVE，待 merge | SDK approval surface additive 兼容 |
| 4 | B3 / F-05 + N-05 | 已在 `../codeshell-b3` TDD 落地，20号 APPROVE，待 merge | requireExisting preflight 与 goal_cleared stream event 同批 |
| 5 | B6 / N-08 | 已在 `../codeshell-b6` TDD 落地，20号 APPROVE，待 merge | 只落地证据成立部分：PowerShell 明示 `sandbox.backend="off"` |
| 6 | B5 / F-08 | 已在 `../codeshell-b5` TDD 落地，20号 APPROVE，待 merge | 与 N-03 都动 `turn-loop.ts`，P1 合入后 rebase 再测 |
| 7 | F-03 | 未在本轮 worktree 落地，仍按 `04` 修复设计排后续实现 | 保留 50ms batching 性能契约，补 boundary segment 测试 |
| 8 | F-02 | 未在本轮 worktree 落地，仍按 `04` 修复设计排后续实现 | 子代理看 `agentId`，顶层 request start 不受脏 `activeAgents` 影响 |
| 9 | F-06 | 未在本轮 worktree 落地，仍按 `04` 修复设计排后续实现 | 与 N-06 同属 permission area，需明确 deny > ask > allow 合并策略 |
| 10 | F-01 | 未在本轮 worktree 落地，仍按 `04` 修复设计排后续实现 | 需要先定 `messageId` / correlation id 兼容字段 |
| 11 | F-04 | 未在本轮 worktree 落地，仍按 `04` 修复设计排后续实现 | 跨 main / preload / renderer / persistence，半径最大 |
| 12 | N-02 | 仍是文档结论/后续命名或注释处理项 | 若做真流式工具执行，需另立设计 |
| 13 | N-07 | 仍是文档结论/产品安全决策项 | 先决定 `permissionDefault` 是 UI hint 还是执行语义 |
| 14 | F-07 | 已知设计折中，近期不建议强推 core 重构 | 短期可做提示，长期热启用需另立设计 |
| 15 | N-09 | P3 维护债，未被主链路调用 | 后续删除 helper 或委托共享转换函数即可 |
| 16 | N-01 | 非问题，无需代码落地 | `TurnPhase` / `TurnState.phase` 是概念遗留 |
