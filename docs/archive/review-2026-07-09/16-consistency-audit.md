# 一致性交叉校验审计

本轮只校验并就地修订 `docs/review-2026-07-09/` 下的审查文档和两个 HTML；未修改 `packages/**`，未跑构建，未 commit。

## 校验维度

1. Findings 编号、标题、严重度、状态：以 `13-findings-register.md` 为权威，核对 F-01~F-08、N-01~N-09 在 03/04/05/06/07/09/10/11/13/14/15、README 和 `visualization-v3.html` 中的口径。
2. file:line 锚点抽查：抽查 20 个关键源码锚点，重点覆盖 N-03 的 `turn_complete` 两个发射点和 N-06 的 approval cache 字段/读写点。
3. 交叉引用死链：抽取 `.md` / `.html` 引用和 HTML `href/src`，核对 review 目录内引用、根目录 `CODESHELL.md`、`docs/architecture/*`、`docs/todo/*` 均存在。
4. HTML 数据同步：核对 `visualization-v3.html` 的 N-03/N-06 bug 触发帧与 17 findings 叠加口径；`visualization-flow.html` 是纯数据流端到端 51 步，不含 findings/bug 数据。
5. README 索引完整性：核对 README 文件清单覆盖 01~15、GUIDELINE、README、两个 HTML；新增本审计文档后同步补入 16。

## 发现与修订

共发现并修订 6 处不一致：

| 文件 | 修订摘要 |
|---|---|
| `GUIDELINE.md` | 将任务 A1 的架构底料引用从 `docs/architecture/02-tool-system.md` / `docs/architecture/03-llm-and-model-layer.md` / `docs/architecture/04-protocol-and-sessions.md` 简写展开为完整 `docs/architecture/...` 路径，避免被当作 review 目录内死链。 |
| `13-findings-register.md` | 修正总数口径：17 条 = P1 7、P2 8、P3 1、非问题 1；移除 N-09 “非问题/需人工确认”旧口径，明确 N-09 为 P3 维护债；把第 3 节标题从“仍只是观察”改为“已确证/部分成立但尚无专门修复设计”；补充 N 系列来源含 14、P2/P3 轻量方向见 15；落地顺序第 16 项同步为 P3 维护债。 |
| `06-turn-loop-state-machine.md` | 将 N-03 在脆弱点表中的状态从“新观察（推测）”修为“新观察（07 已确证）”，并把说明改为普通 `Engine.run` maxTurns live path 已确证双发；自查段同步去掉“推测项”旧口径。 |
| `README.md` | 补齐文件清单中的 `14-remaining-observations-verification.md`、`15-p2-fix-checklist.md`、`16-consistency-audit.md` 和可视化入口；阅读路径加入 14/15/可视化；Findings 总览中 N-04/N-05/N-07/N-08/N-09 增补 14，N-06 增补 10，N-09 严重度从 “P3 / 需人工确认” 改为 “P3”。 |
| `visualization-v3.html` | 当前保留的 bug 版可视化：带 N-03/N-06 两个 P1 bug 触发帧和 17 findings 叠加，用于定位问题发生在哪一步。 |
| `16-consistency-audit.md` | 新增本审计记录，记录校验维度、修订项、锚点抽查、剩余风险。 |

## 锚点抽查结果

抽查的关键锚点均仍指向所述代码，未发现需要修正的 file:line：

- N-03：`packages/core/src/engine/turn-loop.ts:1268` 仍是 TurnLoop maxTurns 内部 `turn_complete(max_turns)`；`packages/core/src/engine/engine.ts:2363` 仍是 Engine epilogue `turn_complete(result.reason)`。
- N-06：`packages/core/src/tool-system/permission.ts:142`、`:143` 仍是 `sessionAllowRules` / `sessionDenyRules`；`:191`、`:219`、`:250` 仍是 request cache lookup、`checkSessionRules()` 和 session rule 写入；`:502` 仍是 singleton getter。
- 其它抽样：F-06 `executor.ts:334` / `:366`、F-05 `server.ts:411` / `:429`、F-08 `turn-loop.ts:1048` / `types.ts:534` / desktop `types.ts:650`、F-04 `SessionSnapshotStore.ts:10` / `agent-bridge.ts:203` / `preload/index.ts:159`、N-04 `client.ts:388`、N-05 `server.ts:825` / `:846`、N-08 `powershell.ts:60` / `bash.ts:95`、N-09 `executor.ts:638` 均命中对应语义。

## 结论

- register 仍是唯一权威源；`visualization-v3.html` 的 17 findings 叠加口径与 register 一致。
- README 已覆盖 01~16、GUIDELINE、README、`visualization-flow.html`、`visualization-v3.html`。
- 未发现 review 目录内交叉引用死链。
- 剩余需人工复核：0 处。
