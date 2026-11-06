# Mimi 轮次循环优化验收（2026-11-06 spec）

- Spec：[2026-11-06-mimi-turn-loop-optimization-design.md](../superpowers/specs/2026-11-06-mimi-turn-loop-optimization-design.md)
- Plan：[2026-11-06-mimi-turn-loop-optimization.md](../superpowers/plans/2026-11-06-mimi-turn-loop-optimization.md)
- 分支：`claude/pet/mimi-turn-loop-20261106`
- 状态口径：**测试**＝单元/集成测试固定；**离线实测**＝真实 core Engine + Mimi profile + 立即返回的本地假模型，在真实 Mimi 会话与 usage ledger 的副本上测量；**待真机**＝需要装机后用真实模型与微信验证。

## 指标

| 指标                       | 改动前                                                                      | 改动后                                                                                                                                                            | 目标                          | 状态                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| G1 连发合并                | 准备阶段或排队中到达的同路由消息各自一轮、各自回复                          | 从 leader 接下到 `agent/run` 返回之间到达的同路由消息全部并入同一轮，只回一次；worker 尚未登记 run 时 steer 被拒会在 run 仍在进行时有界重试（50 ms × 最多 40 次） | 1 次回复                      | 测试（准备阶段合并、三条合一、leader 未运行回退、`/clear` 与其他发送者不合并、steer 先被拒后接受、run 结束时回退）；待真机 |
| G2 第二轮首次 cacheHitRate | 0（世界状态在系统提示末尾）                                                 | Mimi 系统提示跨轮逐字节一致，世界状态进入不落盘的易变消息                                                                                                         | ≥ 0.7                         | 测试（系统提示跨两轮相同）；命中率待真机                                                                                   |
| G3 轮间 / 尾部 P50         | 1.9 s / 4.7 s（离线实测，真实会话副本）；现场日志 1.6–3.3 s / 3.5–5.0 s     | 0.14 s / 0.18 s（离线实测）                                                                                                                                       | ≤ 1.0 s / ≤ 1.0 s             | 离线实测达标；待真机复核                                                                                                   |
| G4 准备阶段                | 无日志                                                                      | 每阶段 `pet.turn.phase` + `pet.turn.prep_total`；互不依赖的读取并行                                                                                               | ≤ 0.5 s                       | 计时与并行已落地（测试）；数值待真机                                                                                       |
| G5 IM 笔记+回复同响应      | 两次模型响应                                                                | 提示要求同一响应、笔记在前；执行顺序有测试固定                                                                                                                    | 一轮                          | 测试；待真机观察模型遵从度                                                                                                 |
| G6 回执改写                | 主进程整份解析 8.7 MB transcript                                            | 只读尾部 4 MiB（小文件仍全量）                                                                                                                                    | ≤ 50 ms                       | 测试；耗时待真机                                                                                                           |
| G7 记忆                    | 每轮一次主模型 core 提取，`no-repo` 记忆 7 周无产出；段收尾仅闲置 12 h 触发 | Mimi 关闭 core 记忆流水线；段收尾新增 NewContext 成功后与日结（新本地日期、段 ≥ 6 h、闲置 ≥ 30 min）触发                                                          | 0 次每轮提取；每天 ≥ 1 次收尾 | 测试；`memories.json` 增长待真机                                                                                           |
| G8 跨段首轮                | notes 滚动失败时同步主模型摘要 ≈16 s，且在 1,024 token 处截断仍被采用       | 改用不调模型的 `fallbackSummary`（固定说明 + 简报，按 4,000 字符协议上限截断）；`buildSummarizeFn` 上限 4,096 且截断即拒绝                                        | 0 次同步摘要；不写截断摘要    | 测试                                                                                                                       |
| G9 微信单轮端到端 P50      | 14 s 起                                                                     | —                                                                                                                                                                 | ≤ 8 s（目标值，非门禁）       | 待真机                                                                                                                     |

## G3 离线实测明细

根因：每个模型步骤与收尾阶段多次调用 `UsageLedger.summary`，每次重新打开并解析 usage ledger 下全部约 3,900 个回执文件（单次 0.75–1.2 s）。修复为按文件 inode/size/mtime/ctime 缓存已解析回执（`PinnedFileCache`），2 s 内变更的文件不缓存，每次仍列目录并 stat，跨进程写入照常可见。

| 场景（6 次，P50）          | 轮间           | 尾部           | 一轮 3 步（假模型） |
| -------------------------- | -------------- | -------------- | ------------------- |
| 新会话                     | 34 → 34 ms     | 46 → 39 ms     | 344 → 348 ms        |
| 真实会话副本 + ledger 副本 | 1,934 → 138 ms | 4,736 → 183 ms | 10,525 → 1,340 ms   |

剩余开销主要是本机打开 8.7 MB transcript 的单次约 80 ms（疑似终端安全软件扫描），未在本版本处理：常驻追加描述符会改变所有会话的文件句柄语义（Windows 重命名/删除、fd 压力、输出 journal 校验），需单独设计。

计时日志：`turn.gap_timing`（含 `turnBoundaryMs`）、`engine.prep_timing`、`engine.finalize_timing`（含 `lastTurnBoundaryMs`），用于真机复核。

## GatewayReply 之后到达消息的行为（plan Task 7 Step 7）

run 内已调用 GatewayReply 后才注入的消息走 engine 的 `finalize_backfill` 重驱。宿主侧 `requestPetHostAction` 对同一轮第二次 gatewayReply 是**替换**待发草稿（不是拒绝），注入 steer 时还会主动作废旧草稿；适配器在整个 run 返回后才发送，因此用户只收到一条合并后的回复，新消息的回答不会丢。已有测试 `packages/pet/src/host-actions.test.ts` 覆盖。`turn-loop.ts` 中"宿主拒绝重复回复"的过时注释已更正。

## 与 spec 的差异

- §10 由"run 后后台归档"改为"不调模型的 `fallbackSummary`"：后台归档会与下一轮并发写同一 transcript，且只是把等待挪到下一轮。
- §9.2 第 3 点（设置页提示配置辅助模型）未做：段收尾在未配置辅助模型时回退到默认文本模型，但频率从每轮降到约每天一次，影响小。建议在设置中配置便宜的辅助模型。
- §6 的阶段名：`segmentWorldPersonalization` 拆为 `worldPersonalization`（提前、无副作用）与 `segmentBeginTurn`（保持原位置，避免准备失败时已开新段却未归档）。

## 对非 Mimi 会话的影响

- `buildSummarizeFn` 输出上限 1,024 → 4,096，截断即拒绝：所有压缩路径按"摘要被拒、保留原历史"处理；连续 3 次被拒后该 context manager 不再尝试摘要，仍由 snip / window / emergency 三层兜底；手动 `/compact` 遇截断会报错而不是写入截断摘要。
- 其余 core 改动（`runtimeContextPlacement`、`disableMemoryPipeline`、`fallbackSummary`）默认关闭，非 Mimi 行为不变；usage ledger 缓存对所有长生命周期 ledger 生效。

## 顺带修复

- 测试污染：desktop 与 core 日志器在测试中写入真实 `~/.code-shell/logs`（本机 engine 日志单日 29 MB 含大量测试会话）。现在两者都跟随 `CODE_SHELL_HOME`（与 `codeShellHome()` 同一规则），测试预加载额外重定向；验证测试运行前后真实日志行数不变。

## 测试基线

`packages/core/src/engine` 与 `packages/core/src/session` 在本分支与 merge-base 上的失败名单逐条一致（各 11 项，均为既有失败或已知偶发：`engine-current-model`、`engine.auto-compaction-goal` 合并运行超时、output-journal 存储/性能、`turn-diff.bom` 等），无新增失败。

## 待真机验收

装机后用真实模型与微信：

1. 5 秒内连发 3 条 → 只回 1 条，且覆盖三条内容（G1）。
2. 连续两轮间隔 < 5 min，看第二轮首个 `model_request_boundary` 的 cacheHitRate（G2）。
3. 取 10 轮的 `turn.gap_timing` / `engine.finalize_timing` / `pet.turn.prep_total`（G3、G4）。
4. 需要更新笔记的微信回复只有一次模型响应（G5）。
5. 连续使用跨过一个本地日期后，`pet/memories.json` 与 journal 有新增（G7）。
6. 微信单轮端到端 P50（G9）。
