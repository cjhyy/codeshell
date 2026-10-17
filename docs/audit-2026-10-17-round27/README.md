# Repository audit · Round27

本轮 **1 个 P3 静态正式问题、1 个静态候选、1 条旧关联**。只写审查文档和证据，没有修产品代码。上一轮 Round26 已以 `9b667863e8a8eb91db7b1f99eb9876169dcf19ec` 集成，是本轮冻结基线；整个“审查所有内容”的目标仍 active，本轮完成不表示全仓审查完成。

| 分类 | 条目 | 结论 |
| --- | --- | --- |
| P3 static formal | [AGGREGATOR-R27-01](aggregator-report.md) | 隔离 DriveAgent 正确报告 job cwd，但摘要丢掉根目录，文件行按主会话 cwd 构造打开请求，指向另一工作区。 |
| static candidate / SKIP | [COMPOSE-R27-C1](compose-report.md) | later old 内唯一包含 previous after 不能证明同位置，可能错误合并两处编辑；首次聚焦夹具导入失败，未观察此反例输出，未升级。 |
| old-related | [ROOT-R27-R1 → HL-01](root-frontier-report.md) | 精确 GitHub 文件路径 trim 是既有问题，本轮不重复计新bug。 |

正式问题由真实 ordinary producer、成功事件、类型和文件打开消费者的源码值流确认。显式 `isolation:worktree, cleanup:keep` 即可触发；默认 auto 对有改动的 worktree 也只保留而不先 merge。条件示例 `/isolated/src/a.ts` 的 file row 最终按 `/repo` 构造请求。没有启动真实 DriveAgent、创建业务 worktree、点击UI、观察文件打开或声称内容被删除。多 root 同 relative path 的行/key冲突属于同一丢 cwd 原因，不另计。

[唯一首次运行边界](runtime-boundary.md) 必须单独看：**1 failed shard / 0 clean completed / 0 rerun**。Bun 实际打印 **16 pass / 1 fail / 1 error / 54 expectations**；16 pass全部是既有 compose tests，focused三个测试体 **0进入**。Root 自有夹具相对 import 多退了一层，失败发生在聚焦生产叶子导入前。这是审查支架错误，不是产品缺模块。按“有问题跳过”保留原样，未修夹具、未重跑、未换加载方式。[raw](evidence/root-containment-first.raw.log) 与 [exit](evidence/root-containment-first.exit.json) 先保存后读取；raw 2272B，SHA `3419b38917c264fa865bcca06aa7160da25216f1b056c713ceb57a42f6a33a48`，没有 Completed。已有测试通过不支持本次新候选，也不支持另一个纯静态 formal。

[Snapshot / Viewer](snapshot-report.md) 没有新增问题。明确空 snapshot、display cap clone、原 turnDiff 用于 AI、legacy hunk 不保证 net 等合同有源码反证；R26 sentinel、旧 prompt/UTF16/cap/ApplyPatch 家族不重报或恢复失败测试。[Core/Link 小型补充](root-frontier-report.md) 同样没有新发现；其0执行与唯一失败 shard 分账。

历史去重覆盖 `docs/`、`bugs/` 的 **2596 =1250 Markdown +1346 JSON**，递归 JSON values 共468104 string /676635 scalar，含档案、排除本轮、0 parse error。各作者保存 full inventory SHA、匹配总数和 context cap；不同查询计 occurrence 或 matched-unit 的口径分别保留，不相加成问题数。archive/_archive 精确目录 component 为 **169**；整个路径含 `archive` 子串为 **174**，五条差异只是名字口径，不是遗漏档案。关键词扫描和完整字节 hash 不等于全部历史语义穷尽。

[源码总清单](source-manifest.json) 分开 frozen author SHA、current、main；[材料完整性](worker-integrity.json) 与 [证据索引](evidence-index.json) 固定文档/原始日志/副本字节。中断前 prep 的4份文件逐字复制，20 source pins 只作 hash-only 库存复核，不冒称新全文阅读或原时点 Git 证明。作者 read-start 缺失与 after-read capture 标记保留，不回填作者未做的 Git 对照。Root只对实际声明范围认领语义审查。

独立复核包括 [formal交叉复核](evidence/review-aggregator-independent.md)、[Root formal复核](evidence/review-aggregator-root.md)、[失败边界复核](evidence/review-runtime-boundary.md)、[Core/Link复核](evidence/review-root-frontier.md) 及 [聚合复核](evidence/review-aggregate.md)。[QC](evidence/root-qc.md) 记录最终实际计数和来源口径。最终暂存、blob、commit、primary dirty保全由外部集成收据证明；没有借审查文档通过宣称产品测试全绿。
