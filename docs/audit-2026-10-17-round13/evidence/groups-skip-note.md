# groups 聚焦实验首次失败与跳过记录

冻结：`7927a7c8b80b4aec710dee1f6d831ad1982bb466`。

1. 现有 `fileChangeAggregator.test.ts`、`fileChangeAggregator.count.test.ts`、`agentGroup.test.ts` 的一个独立 guarded 首跑完整通过：33 pass / 66 expect / 0 fail / 0 skip。该基线已有的 ApplyPatch 示例只有普通 Add/Update，不能证明 Delete、Move 或符号前缀内容正确。
2. 随后的 `groups-patch-summary.test.ts` 首次 guarded 运行在加载阶段失败：证据 fixture 到源码的相对导入层级写错，Bun 报 `Cannot find module`；0 pass / 1 fail / 1 error，exit 1，无 Completed 门禁。属于本轮审查支架错误，不能当产品缺陷或产品行为证据。
3. `groups-run-first.py` 已先保存 combined stdout/stderr 原始字节及 exit JSON，之后才读取。失败 fixture 和日志保持原状。未更改导入、没有重跑，也没有通过别名、VM、复制函数、另一个 fixture 或单独 AST 实验恢复该聚焦方向。其七个预定测试体均未执行。
4. ApplyPatch 摘要的 Delete 与符号前缀问题仅作源码候选，不赋 P 级、不计正式；Move 只列旧 R2-08 外部变更列表家族的独立显示分支关联。现有基线通过不用于替代上述失败实验。
5. `streamGroups.ts`、`time.ts`、`turnTiming.test.ts` 本轮为源码阅读，没有为它们执行额外 shard；没有恢复旧 i18n、Desktop 投影坏导入、TUI Diff/Questions 或 recorder midnight 失败方向。
