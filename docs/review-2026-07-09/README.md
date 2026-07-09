# 架构审查索引与导读

本目录是 2026-07-09 的 CodeShell 架构审查与修复落地产物，范围只覆盖 core 引擎（engine / tool-system / protocol）和普通 desktop renderer 消费流。目标分三层讲清楚：结构是什么、运行设计怎么流、为什么这样设计；再基于这些事实反推出具体优化点、修复设计、worktree 落地和 merge 交接状态。

## 先看这里

总入口有两个，按目的并列阅读：

- `../archive/review-2026-07-09/19-landing-status.md`：修复落地与 merge 交接单，列出 6 个隔离 worktree、分支、TDD 结果、merge 顺序和清理命令。
- `13-findings-register.md`：F-01~F-08 与 N-01~N-09 的统一总账入口，含严重度、状态、修复设计指针、落地状态和后续处理顺序。

可视化入口有两个，都是单文件离线页面，可直接双击打开，不需要 dev server：

- `visualization-flow.html`：当前主版本，纯数据流、端到端 51 步，覆盖用户输入→goal→turn→工具→权限→执行→模型产出→协议→主进程→渲染→卡片。
- `visualization-v3.html`：bug 版，带 N-03/N-06 两个 P1 bug 触发帧 + 17 findings 叠加，用于定位问题发生在哪一步。

## 文件清单

| 文件 | 是什么 | 给谁看 | 什么时候读 |
|---|---|---|---|
| `GUIDELINE.md` | 本次 review 的任务契约、范围、护栏和产物要求 | 继续维护这套文档的人 | 开始前先读，确认范围和禁止事项 |
| `README.md` | 当前目录总索引、入口、阅读路径和文件清单 | 所有接手本目录的人 | 打开目录后先读，用它跳转到目标文档 |
| `../archive/review-2026-07-09/01-core-engine-structure.md` | core engine / tool-system / protocol 的结构、设计、Why | 想理解 core 架构的人 | 读任何修复设计前先读 |
| `../archive/review-2026-07-09/02-desktop-stream-walkthrough.md` | 从 core token 到桌面 UI 的 24 步端到端流 | 改 desktop streaming / 折叠 / Markdown 的人 | 需要定位 UI 流事件问题时读 |
| `../archive/review-2026-07-09/03-optimization-findings.md` | 8 条优化点清单，含严重度和建议方向 | 排优先级、分派修复的人 | 想看全局问题列表时读 |
| `../archive/review-2026-07-09/04-p1-deep-dive-and-fix-design.md` | 5 条 P1 的根因、复现、修复方案和 TDD 点 | 准备修 P1 的工程师 | 从 finding 进入实际修复前读 |
| `../archive/review-2026-07-09/05-p2-deep-dive-and-fix-design.md` | 3 条 P2 的深挖、取舍和修复设计 | 准备处理低优先级收尾的人 | P1 排完或顺手修资源/契约问题时读 |
| `../archive/review-2026-07-09/06-turn-loop-state-machine.md` | Turn 生命周期实现态状态机、注入点和不变量 | 改 Engine / TurnLoop 的人 | 需要理解 turn 边界、maxTurns、steer、abort 时读 |
| `../archive/review-2026-07-09/07-new-observations-verification.md` | 对 N-01~N-03 的证据级校准 | 排查后续新观察的人 | 读 06 后确认哪些观察已确证时读 |
| `../archive/review-2026-07-09/08-N03-fix-design.md` | N-03 `max_turns` 双发 `turn_complete` 的修复设计 | 准备修 N-03 的工程师 | 修 maxTurns terminal 契约前读 |
| `../archive/review-2026-07-09/09-protocol-event-and-session-contract.md` | Protocol StreamEvent / notification / session 边界契约 | 改 protocol 或 SDK client 的人 | 需要确认事件生产者、session envelope、approval 路由时读 |
| `../archive/review-2026-07-09/10-tool-system-execution-and-permission-contract.md` | ToolExecutor / permission / path-policy / sandbox 深度契约 | 改工具系统或权限链的人 | 需要处理 F-06、N-06~N-09 时读 |
| `../archive/review-2026-07-09/11-N06-verification.md` | N-06 interactive approval session cache 的证据级验证 | 准备评估 N-06 安全影响的人 | 修 N-06 或复核严重度前读 |
| `../archive/review-2026-07-09/12-N06-fix-design.md` | N-06 session rule cache 隔离的修复设计 | 准备修 N-06 的工程师 | 实现 permission session bucket 前读 |
| `13-findings-register.md` | F/N 全部 finding 的统一总账、状态、指针和落地顺序 | 总指挥、排期和交接的人 | 开始排修复优先级时先读 |
| `../archive/review-2026-07-09/14-remaining-observations-verification.md` | N-04/N-05/N-07/N-08/N-09 的证据级复核 | 复核剩余 N 系列观察的人 | 需要确认 P2/P3 状态时读 |
| `../archive/review-2026-07-09/15-p2-fix-checklist.md` | P2/P3 轻量修复方向清单 | 准备收尾 P2/P3 的工程师 | P1 排完后制定小批次修复时读 |
| `../archive/review-2026-07-09/16-consistency-audit.md` | 本次一致性交叉校验记录 | 维护这套文档的人 | 需要查看本轮修订留痕时读 |
| `../archive/review-2026-07-09/17-fix-execution-plan.md` | 6 个修复批次的执行计划、分支/worktree 拆分和 TDD 顺序 | 准备落地或复盘落地过程的人 | 需要理解为什么拆成这些 worktree 时读 |
| `../archive/review-2026-07-09/18-fix-code-review.md` | N-03、N-06 两个 P1 修复 worktree 的独立代码审查报告 | 准备 merge P1 修复的人 | 合并 `codeshell-n03`、`codeshell-n06` 前读 |
| `../archive/review-2026-07-09/19-landing-status.md` | 6 个隔离 worktree 的 merge 交接单、TDD 结果、分支名、清理命令 | 负责把修复合回 main 的人 | 准备 merge 或接手落地状态时先读 |
| `../archive/review-2026-07-09/20-p2-code-review.md` | B3~B6 四个 P2 修复 worktree 的独立代码审查报告 | 准备 merge P2 修复的人 | 合并 `codeshell-b3`~`codeshell-b6` 前读 |
| `visualization-flow.html` | 当前主版本：纯数据流、端到端 51 步离线可视化 | 想快速建立端到端流转直觉的人 | 读 02 前后都可以，直接双击打开 |
| `visualization-v3.html` | bug 版：N-03/N-06 两个 P1 bug 触发帧 + 17 findings 叠加 | 想同时看 bug 触发位置和 finding 分布的人 | 讲解问题发生在哪一步或交接视觉材料时打开 |

## 阅读路径

想理解架构：先读 `GUIDELINE.md` 确认范围，再读 `../archive/review-2026-07-09/01-core-engine-structure.md`，然后读 `../archive/review-2026-07-09/02-desktop-stream-walkthrough.md`。如果想用图建立端到端数据流直觉，直接双击 `visualization-flow.html`；如果要同时看 bug 触发位置和 finding 分布，打开 `visualization-v3.html`。

想快速接管全局：先读 `../archive/review-2026-07-09/19-landing-status.md` 和 `13-findings-register.md`。前者告诉你哪些修复已经在隔离 worktree TDD 落地、怎么 merge；后者告诉你每条 finding 的严重度、证据、设计和当前状态。再按表里的修复设计指针跳到 `04`、`05`、`08`、`12`、`15`。需要追溯新观察来源时，按 `06` → `07` → `09` → `10` → `11` → `14` 的顺序回读。

想动手修 bug：先看 `../archive/review-2026-07-09/03-optimization-findings.md` 的总表，P1 进入 `../archive/review-2026-07-09/04-p1-deep-dive-and-fix-design.md`，P2 进入 `../archive/review-2026-07-09/05-p2-deep-dive-and-fix-design.md`。涉及事件流或折叠时回查 `02`，涉及 Engine / ToolExecutor / Protocol 时回查 `01`。

想修后续新观察：N-03 读 `07` 的确证结论和 `08` 的方案 A；N-06 读 `11` 的安全级确证和 `12` 的 session bucket 设计；N-04/N-05 回 `09` 和 `14`；N-07/N-08/N-09 回 `10` 和 `14`；P2/P3 轻量落地方向看 `15`。

想看修复怎么落地、怎么 merge：先读 `../archive/review-2026-07-09/19-landing-status.md` 的总览和 merge 顺序，再读 `../archive/review-2026-07-09/18-fix-code-review.md`（P1：`../codeshell-n03`、`../codeshell-n06`）与 `../archive/review-2026-07-09/20-p2-code-review.md`（P2：`../codeshell-b3`、`../codeshell-b4`、`../codeshell-b5`、`../codeshell-b6`）。最后按 `19` 的 worktree/分支表逐个检查 6 个 worktree。

想看可视化：打开 `docs/review-2026-07-09/visualization-flow.html` 或 `docs/review-2026-07-09/visualization-v3.html`。两个页面都是单文件离线页面，不需要安装依赖、不需要跑构建。

## Findings 总览

| 编号 | 标题 | 严重度 | 深挖位置 |
|---|---|---|---|
| F-01 | streaming fallback 的撤销/补偿契约在桌面链路不可用 | P1 | `../archive/review-2026-07-09/04-p1-deep-dive-and-fix-design.md` |
| F-02 | `stream_request_start` 用 `activeAgents` 推断归属，运行态一脏就压掉主回复槽 | P1 | `../archive/review-2026-07-09/04-p1-deep-dive-and-fix-design.md` |
| F-03 | coalescer 按 agent 合并 delta，却没有在硬边界上切段 | P1 | `../archive/review-2026-07-09/04-p1-deep-dive-and-fix-design.md` |
| F-04 | snapshot 的 seq 游标只存在于重放路径，live IPC 没有对齐游标 | P1 | `../archive/review-2026-07-09/04-p1-deep-dive-and-fix-design.md` |
| F-05 | `requireExisting` 先创建 live session 再拒绝缺失磁盘会话 | P2 | `../archive/review-2026-07-09/05-p2-deep-dive-and-fix-design.md` |
| F-06 | `pre_tool_use: ask` 用户同意后会跳过 classifier deny/rules | P1 | `../archive/review-2026-07-09/04-p1-deep-dive-and-fix-design.md` |
| F-07 | builtin capability 的 `off` 可热生效，`on` 受构造期 frozen registry 限制 | P2 | `../archive/review-2026-07-09/05-p2-deep-dive-and-fix-design.md` |
| F-08 | `tool_summary` 没有目标 id / agent 契约，desktop 只能挂到最近顶层工具 | P2 | `../archive/review-2026-07-09/05-p2-deep-dive-and-fix-design.md` |
| N-01 | `TurnPhase` / `TurnState.phase` 只初始化不推进 | 非问题 | `../archive/review-2026-07-09/07-new-observations-verification.md` |
| N-02 | `StreamingToolQueue` 实际不是 streaming chunk 驱动 enqueue | P2 | `../archive/review-2026-07-09/07-new-observations-verification.md` |
| N-03 | `max_turns` live path 双发 `turn_complete(max_turns)` | P1 | `../archive/review-2026-07-09/07-new-observations-verification.md`、`../archive/review-2026-07-09/08-N03-fix-design.md` |
| N-04 | SDK `AgentClient` approval surface 丢 session 边界 | P2 | `../archive/review-2026-07-09/09-protocol-event-and-session-contract.md`、`../archive/review-2026-07-09/14-remaining-observations-verification.md` |
| N-05 | `goal_cleared` 类型注释与 protocol/server 行为不一致 | P2 | `../archive/review-2026-07-09/09-protocol-event-and-session-contract.md`、`../archive/review-2026-07-09/14-remaining-observations-verification.md` |
| N-06 | Interactive approval session rule cache 未按 sessionId 隔离 | P1 | `../archive/review-2026-07-09/10-tool-system-execution-and-permission-contract.md`、`../archive/review-2026-07-09/11-N06-verification.md`、`../archive/review-2026-07-09/12-N06-fix-design.md` |
| N-07 | `permissionDefault` 当前不参与 classifier 判定 | P2 | `../archive/review-2026-07-09/10-tool-system-execution-and-permission-contract.md`、`../archive/review-2026-07-09/14-remaining-observations-verification.md` |
| N-08 | PowerShell 执行工具不走 sandbox | P2 | `../archive/review-2026-07-09/10-tool-system-execution-and-permission-contract.md`、`../archive/review-2026-07-09/14-remaining-observations-verification.md` |
| N-09 | `resultsToMessages()` 与当前 tool_result 契约漂移但未被主链路使用 | P3 | `../archive/review-2026-07-09/10-tool-system-execution-and-permission-contract.md`、`../archive/review-2026-07-09/14-remaining-observations-verification.md` |

`04` 已深挖全部 P1：F-01、F-02、F-03、F-04、F-06。`05` 已深挖全部 P2：F-05、F-07、F-08。
`07` 已校准 N-01~N-03；`08` 给出 N-03 修复设计；`09` 新增 N-04/N-05；`10` 新增 N-06~N-09；`11` 确证 N-06；`12` 给出 N-06 修复设计；`14` 复核剩余 N 系列；`15` 汇总 P2/P3 轻量修复方向；`17` 给出 6 批次修复执行计划；`18` 审查 P1 修复；`19` 给出 merge 交接单；`20` 审查 P2 修复。完整状态以 `13-findings-register.md` 和 `../archive/review-2026-07-09/19-landing-status.md` 为准，P2 独立审查结论以 `../archive/review-2026-07-09/20-p2-code-review.md` 为准。

## 落地与 merge 状态

17 号执行计划中的 6 个批次已在隔离 worktree TDD 落地，未 commit、未 push、未污染 main。P1 修复 N-03、N-06 已由 `../archive/review-2026-07-09/18-fix-code-review.md` 独立审查 APPROVE；P2 修复 B3~B6 已由 `../archive/review-2026-07-09/20-p2-code-review.md` 独立审查 APPROVE。merge 交接、分支名、测试结果和清理命令看 `../archive/review-2026-07-09/19-landing-status.md`。

建议 merge 顺序按 `19` 和 `20` 执行：N-03 → N-06 → B4 → B3 → B6 → B5。B5/F-08 与 N-03 都动 `turn-loop.ts`，P1 合入后再 rebase B5 并复跑对应测试。
