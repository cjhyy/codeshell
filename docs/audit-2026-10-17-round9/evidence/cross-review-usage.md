# 用量审查交叉复核

结论：**支持 COST-R9-01 作为 P3 确认项，保持独立、未绑定 CostTracker 公共 API 的限定**。两处来源行号已经由 root 纠正并再次核对；没有剩余阻断问题。本复核仅阅读源码、fixture、首次日志、退出码和结构化记录，没有运行测试、修改产品或执行 Git 写操作。

## 合同、正常输入与因果链

公共 `index.ts:759` 仍导出 CostTracker。`cost-tracker.ts:36–46` 明确写出完整 OpenRouter ID 优先查 snapshot；`model-metadata.ts:103–105` 区分 direct IDs 与完整 OpenRouter IDs。既有 `cost-tracker.test.ts:51–59` 也支持 standalone record 后累计 token/cost 的 API。完整 ID 的支持不是从外部服务或潜在 TODO 推断出来的。

实际实现先用完整 ID 检查 known，再在 `cost-tracker.ts:115` 仅保存 canonical 名称；`:148` 累计时重新按保存的名称定价。冻结 snapshot 的 `google/gemini-4-argon` input/output 正是 2/10；direct metadata 没有 `gemini-4-argon`，短名称补全只尝试 deepseek/openai/anthropic，没有 google，最终命中默认 3/15。因此 fixture 中同样 1M/1M token 的 12→18 差异与源码一致。输入是 API 接受的非负有限整数；1M 用于单位价格算术，不是实际 provider 请求、模型长度验收或外部账单。

新增 fixture 没有替换生产定价函数、改 snapshot、mock 价格或调用 snapshot override。它实际检查 estimate、record、累计 tokens、serialize 的存储模型名、formatCompact、formatSummary 和 restore。首次日志证明 3 个 cost characterization/control tests 与 2 个 token-budget tests 都完成。错误金额被断言为当前行为，所以 pass 不意味着产品修复；报告已明确说明。

## SDK 范围与运行时控制

direct metadata 的 devstral-medium 对照累计和 estimate 均为 2。真实内存 UsageLedger 对照在绑定后忽略 tracker 自有 records 的累计，再 begin/settle/finish 一个完整 ID receipt，返回 12 和 1 request。`runtime.ts:49–60` 静态确认 EngineRuntime 创建/接收 UsageLedger 并绑定 CostTracker；ledger pricing 和 summary 源码也保留完整 identity。报告没有把该纯 ledger 控制扩大为完整 EngineRuntime、Host、UI 或真实计费验证，排除主流程的限定正确。

修复建议保留原始定价身份/已解析价格、将 canonical 名称留给显示与分组，符合根因。restore 读取的 records 已失去前缀，因此持久化身份也需要考虑。没有理由从本证据推断所有模型都错、所有 Host cost 都错或实际供应商发票错。

## 去重和材料核对

- 已读 root-dedup 的范围、模式和命中，并直接解析 `docs/archive/review-2026-05-30/findings.json` 的 `$[32]` 完整条目：它是重复 lookup 的性能简化建议，没有登记 record 丢失完整身份造成估价错误。本次的差异说明成立；历史关键词搜索仍不能证明绝对语义穷尽，报告有该限定。
- 首次 raw logs 和 exit receipts 一致：新增 5 pass / 25 expect，既有 23 pass / 54 expect，合计 28 pass / 79 expect；两 shard 都为 exit 0、Completed、0 failures、0 skipped。没有将原有 23 项算成新测试。
- 27 条 source-manifest 记录的字节数和 SHA 与冻结源一致；usage.md 的本地 Markdown 链接全部存在。主定位 `cost-tracker.ts:115`、后续查价 `:148`、公共导出 `index.ts:759` 及 runtime 绑定 `:60` 均准确。
- 起初 usage.md 将 snapshot 合同注释引用为 model-metadata.ts:108–110，结构数据将 baseline 引用为 cost-tracker.test.ts:50；实际分别是 :103–105 与 :51。root 已修正，`root-metadata-note.md` 记载该元数据纠正；未变更任何 fixture、首次日志或产品源码。

复核时 usage.md SHA-256 为 `bbf83d716fbf1c0b5c72cc89130bf2d389a9d1110faa8525d30a92975f93280e`，root-findings.json 为 `ee0d491286fe68ed663717a64fafb8c4208056b2de0757b40f18720209f01d8a`。后续全批最终 evidence index 负责最终产物哈希。
