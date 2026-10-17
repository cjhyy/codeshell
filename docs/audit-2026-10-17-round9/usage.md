# 统计数据与独立 CostTracker 审查

冻结源：`248d091202869c07274adedf4fd50403105f1b1f`。本方向 **1 项确认 P3、0 个候选**。2 个首次 guarded shard 共 **28 pass、79 expect、0 fail、0 skipped**，其中新增 5 项，既有纯数据基线 23 项。只记录，不修产品。

## COST-R9-01：独立 CostTracker 记录后丢失完整模型标识，累计估价错误（P3）

`packages/core/src/cost-tracker.ts:115` 把 `record(model, ...)` 的完整标识替换成 canonical 名称。后续 `getEstimatedCost()`（`:148`）再按已截断的名称查价。完整 OpenRouter `vendor/model` 名称属于明确支持的输入：本模块 `:36–46` 说明完整标识优先查 snapshot，`data/model-metadata.ts:103–105` 说明此类名称从 snapshot 定价；`CostTracker` 仍在公共 SDK `index.ts:759` 导出。

[实际 fixture](evidence/root-usage-contracts.test.ts) 使用冻结仓库自带 `openrouter-models.json` 的 `google/gemini-4-argon`，不改数据、不查外部价格。该条目 input/output 为 2/10，且 canonical 名称没有 direct metadata。对 1M input + 1M output，`estimateForTokens(fullId, ...)` 返回 12；`record(fullId, ...)` 后存成 `gemini-4-argon`，查不到完整 snapshot，采用默认 3/15，累计返回 18。`formatCompact`、`formatSummary`、`serialize().estimatedCost` 同样返回 18，restore 后仍为 18。原完整标识在最初检查时属于 known，因此 summary 甚至没有 unknown-model 提示。token 数量正常。

两个关键对照限定影响范围：普通 direct metadata `devstral-medium` 的 estimate 和累计都是 2；同一个完整 ID 在内存 `UsageLedger` 中，绑定后的 tracker 得到正确 12 和 1 request。`EngineRuntime` 在 `runtime.ts:60` 绑定账本，所以本项是**导出的独立、未绑定 CostTracker API 缺陷**，不声称当前 Host 主流程账本或实际账单错误。修复应保留原始定价标识或已解析价格，canonical 名称可继续用于显示/分组；持久化也需要保留可恢复定价的身份。

[首次原始日志](evidence/root-usage-contracts.first.log) 为 5 pass、25 expect、0 fail、0 skipped；[退出码](evidence/root-usage-contracts.first.exit.txt) 为 0。这是错误行为的 characterization，测试通过并不表示产品已修复。没有模型/SDK 请求、网络、真实计费、当前价格验证或 UI 挂载。

## 已审查范围与未确认项

- 已阅读 session usage 累加、foreground cache migration、cache hit rate 和 baseline + run fold。既有纯数据测试同时验证 cache 不重复计入、无历史完整性时从零迁移、跨 run 累积和幂等边界；本轮未确认这些普通数据路径的新问题。
- `token-budget.ts` 的有限/无限预算、90% nudge 后 stop 按当前实现工作，新增 2 个纯函数控制通过。静态发现 diminishing 分支在正常单调计数中难以达到，但没有独立可见错误或更强契约，未登记候选。实际 TurnLoop 调用与 run accounting 的关系只做源码追踪，不运行 Engine。
- 只读核对 `usage-history-service.ts` 参数入口、cost-state adoption 和 ledger summary，未执行用户历史目录查询。`cost-store.ts` 是 opaque serialization interface。run accounting/finalize 的相关片段只静态核对，不能以纯 helper 测试代替引擎集成证据。
- `tests/run-manager-usage.test.ts` 只读开头的 fake executor/临时目录用例；没有把名字中的 usage 当作 token accounting 测试，也没有运行该文件。
- 一次猜测 Desktop renderer 文件名的静态导航失败，按约束保留[首次工具响应转录](evidence/root-navigation-skip.md)并跳过该方向。它不是 Bun 失败、产品 bug 或该 renderer 的验证结果。

既有 `session/usage.test.ts`、`core/cost-tracker.test.ts`、`tests/cost-tracker.test.ts` 的首次 shard 共 23 pass、54 expect，见[原始日志](evidence/root-usage-existing-baseline.first.log)和[退出码](evidence/root-usage-existing-baseline.first.exit.txt)。没有全仓 suite/build/lint/typecheck 声明，没有修改共享 dist 或依赖。

[历史去重](evidence/root-dedup.json) 覆盖 `docs/`、`bugs/` 的全部历史 Markdown 和逐层解析 JSON，含 archive/_archive，排除本批。五月已有 redundant `lookupPricing` 性能记录，与本项丢失定价身份不同；未重复登记。关键词搜索与有限上下文仍有语义查重边界。[结构化缺陷](evidence/root-findings.json)、[验证收据](evidence/root-validation.json)、[冻结源清单](evidence/root-source-manifest.json)保留具体范围与字节证据。
