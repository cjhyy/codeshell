# Round28 Optimization Lab 静态评分与报告补审

本方向 **0 正式问题、0 候选、0 新关联**。仅从已有 prep 接续归档，没有新增产品、测试、import、函数调用、fixture、VM、React/browser、native、业务 Git、模型或网络执行。没有修改产品。实验能力默认关闭的范围不扩大为默认 Desktop 流程已受影响。

## 阅读与基线

原 prep 的 parent-reported head 是 `9b667863e8a8eb91db7b1f99eb9876169dcf19ec`；当前任务 baseline 由 Root 提供为 `32c633e58c20b3853f49bb0e43264b4577281eac`。作者未运行 Git，二者分别保留为上下文，不声称自己比较了 Git blob。[原10份 prep](evidence/lab-prep/artifact-receipt.json) 已逐字复制；[copy 收据](evidence/lab-prep-copy-receipt.json) 保存每个 original/destination 的 bytes/SHA，原内容、9b 字段和48个初始/结束 hash 均未改。

这是**同一次继续中的15份源码/测试阅读**，包含14全文、1处 controller 选段，总2012行（包括未执行的测试/fixture定义）；归档时只补15次当前 filesystem hash 检查，全部与原阅读字节相同。不是重复计15次新语义阅读。48文件库存的其余 hash 不代表全文审查。详见 [source manifest](evidence/lab-source-manifest.json)。Root 另审 canonical JSON、store-paths 及其测试，不纳入本方向。

全文范围：`report.ts`/`report.test.ts`、`grading.ts`/`grading.test.ts`、`assertions.ts`/`assertions.test.ts`、`overfit-hints.ts`/`overfit-hints.test.ts`、`candidate.ts`、`strategy.ts`/`strategy.test.ts`、`contracts/eval-case.ts`、`contracts/verdict-policy.ts` 和 `test-fixtures/foundation.ts`。Controller 只读 `500–533、726–777、802–865、1013–1073` 的数据读取、评分更正/模板与报告入口片段，未通读或运行大 orchestrator。

## 静态结论与反证

[report.ts](../../packages/optimization-lab/src/report.ts:34) 的 verdict 独立核对 observation、模型/usage 状态，并重新计算 hard assertions；hard failure 不能被语义 passed 覆盖。缺少普通证据保持 unknown，既有声明测试仅用于解释意图，没有本轮通过结果。

[更正头选择](../../packages/optimization-lab/src/report.ts:15) 去重 record hash，再排除被替代记录；只有单一 head 才取其语义分数，冲突 heads 保持 unknown。Controller [exportGrading](../../packages/optimization-lab/src/controller.ts:814) 使用保存的 templateRef，并不每次导出都创建独立竞争模板，因此“普通重复导出必然使报告 unknown”未建立。

报告保留 analysis-only 项作为未知分母，paired repeats 缺失时不作为完整结果；cache 条件或 provider-reported cost 缺失时不宣称可比节省。源码与现有测试都明确这些限制；未把刻意保守的 unknown 判定登记为错误。没有检查资金、授权、采纳、凭据、真实 provider 或完整模型实验。

[overfitHints](../../packages/optimization-lab/src/overfit-hints.ts:1) 明确是有界 advisory，不参与 verdict/ranking；覆盖不全或近似提示不是普通精确评分合同。候选验证器 [candidate.ts:66](../../packages/optimization-lab/src/candidate.ts:66) 拒绝 unchanged/duplicated body，不能仅凭同文本 diff preview 的边缘值推断正常生成缺陷。畸形 Trial repeat/伪造字段也缺少该范围内的普通生产来源，没有扩为候选。

[LAB-R3-01](../audit-2026-10-17-round3/arena-lab.md#lab-r3-01--p3--人工评分更正后反思输入仍携带最初评分) 已记录 `reflectionInput` 对同 trial 的反馈取首条；当前相同源码不重新计数。旧 Arena reviewer-cap 的失败 fixture 仍保持 SKIP，没有通过模型、替代解析或新执行恢复它。

## 历史与证据边界

[prep 历史库存](evidence/lab-prep/history.json) 在读取时扫描 `docs/`、`bugs/` 的2596文件（1250 MD、1346 JSON），递归含 archive/_archive，排除当时仍在编写的 round27 与 round28。468104 JSON 字符串值、676635标量、0 parse errors；lab 总955命中保留100条上下文，score/report 总48命中全部保留。它是固定 prep 时点，不冒称当前新增 Round27 文档也已在该旧库存中搜索；关键词也不证明历史语义穷尽。

[历史决策](evidence/lab-prep/history-decisions.json) 核明 Round3 有20份 Lab source hash，与本 prep 当前字节相同，但旧 manifest 明示“some targeted ranges”，单行 hash 没有全文件范围。Round24 三个 package entry pin 更明确为 inventory/hash-only。不能把这些记录拼成全包语义覆盖。本次未建立独立普通合同问题，如实记录所读范围的 negative，不宣称所有内容均无 bug。

[validation](evidence/lab-validation.json) 为0产品运行；没有 raw/exit 文件需要伪造。最终 [作者收据](evidence/lab-artifact-receipt.json) 只证明本方向材料字节完整，不是产品 gate 或全仓完成证明。
