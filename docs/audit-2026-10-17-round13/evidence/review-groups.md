# groups 只读交叉复核

复核者：input_history_round13。冻结 `7927a7c8b80b4aec710dee1f6d831ad1982bb466`。仅阅读报告、JSON、首跑 raw/exit、fixture、相关源码/既有测试片段及历史锚点，执行元数据 SHA 校验；没有运行 Bun/产品/UI/模型，也未修改 groups 材料或 Git。

结论：接受 **0 正式发现、2 静态候选、1 旧家族关联** 的边界，无需提升候选或补做实验。

- 通过 shard 的真实 raw 包含 33 pass / 66 expect / 0 fail、Completed Bun shard 33 tests / 0 skipped / 0 failures；exit JSON 为 0。命令仅三份已有纯测试，fixture 的实际 import/代码片段对应 aggregateFileChangeSummary、countLines、agentGroup，已有 summary 测试调用 parseUnifiedDiff。报告没有把 streamGroups/time/turnTiming 误算成已执行。
- 聚焦 raw 首次报 Cannot find module，0 pass / 1 fail / 1 error，exit 1，无 Completed。错误发生在第一个源码导入，预定七个 test bodies 未到达。fixture 仍保留四层相对导入，未修路径。validation 将它独立列 failed，不把其计划断言计入 33/66。没有发现别的聚焦运行或修复后替代验证证据；报告、skip note 均明确整条聚焦方向 SKIP。
- C1 的本地工具合同与真实 Coding parser 源码允许 header-only Delete；Desktop flush 的 nonzero line gate 在静态上会过滤该条目。C2 的 V4A marker+任意 text 与 Desktop 排除 `+++`/`---` 的分支不同。两项均只称“可能/源码预测”，没有把未执行 fixture 的 AST/summary 断言当实际结果，没有实际删除、摘要卡或 Undo 结论。
- Move 分支明确只作旧 R2-08 外部 rename 家族关联。旧历史 `docs/audit-2026-10-17/root.md:71` 的 R2-08 确实存在，报告承认独立 parser、静态分支与未运行，confirmed/candidate 计数均不包含它。
- 两个 raw 的字节数和 SHA-256 与首次 receipt 匹配；source/artifact 清单逐项校验结果在本次工具响应中保存。此类哈希只证明证据字节/冻结来源，不证明产品行为。

复核中有一次元数据 locator 错误需要保留：第一次 combined `cat` 读取错猜的 `groups-existing-baseline.first.log` 与 `groups-patch-summary.first.log`，工具分别返回 `No such file or directory`；整体 command 因末尾成功读取 test fixture 返回 0，不能称两个 raw 当时已读。随后依据已经读取的 exit JSON 中明确 `rawLog` 字段，读取 `.first.raw.log` 的实际文件并核验 SHA。这是 review 元数据路径修正，没有重跑产品、修失败 fixture或恢复聚焦验证方向。
