# Round27 Root Core/Link 补充独立静态复核

支持 [Root frontier report](../root-frontier-report.md) 的 **0 formal / 0 candidate / 1 old-related（ROOT-R27-R1 → HL-01）**。本review完整读该报告、8份材料/分类/validation与对应声明源码范围，独立核byte/SHA、history value扫描计数和Markdown链接；没有执行产品、测试、import、fixture、VM、native、Git、网络或Root verifier，也没有改Root冻结作者材料。

[author receipt](root-frontier-artifact-receipt.json) 的 **8 artifacts** 全部byte/SHA匹配。[source manifest](root-frontier-source-manifest.json) 的 **11 pins / 513 declared read lines** 均与当前文件byte/SHA、总行数及合法range相同；6个源码/test全文304行、4个消费者selected161行、旧报告全文48行，合计513。此次完整重读了这些声明范围，不把Engine5072行、skills scanner477行或linked service264行的完整SHA当成全文阅读；冻结Git绑定是Root的证据，本review未调用Git。

静态负结果边界成立：memoize的get+has保留cached undefined，fn同步throw在set前；两个resolver选段不足以证明新的rejected Promise生命周期问题。semver只委托库，不能从wrapper的0执行推出库语义正确。cwd工具有明确catch fallback；sanitizer有明确noise启发式和Engine提示分支，Root没有拿无真实任务反例的怀疑凑候选，也没有恢复旧skills/ANSI/i18n动态方向。

`file-selection.ts`公共text仍trim后用于params；selectedFiles/sourceFor选段把该params带入adapter和source identity。这与全文读过的 [Round3 HL-01](../../audit-2026-10-17-round3/host-link.md:7) 同一producer/consumer原因，当前只登记旧关联准确。默认label的UTF16 slice是已有HL-02，未被另算新bug。现有test声明的“exact paths”不是本轮运行证明，Root没有操作真实provider/grant/account。

[dedup](root-frontier-dedup.json) 的完整 **2596文件库存** 独立逐字节SHA重核全部未变；重新递归JSON value scalar并逐occurrence计regex，得到1250 MD、1346 JSON、468104 string values、676635 scalar values，0解析问题，命中精确为memoize1145、sanitizer87、cwd50、Link69、trim13，与保存结果一致。各contexts最多25条，不代表全部context已语义穷尽；这些是occurrence数量，不能换成文件数或已确认问题数。

归档口径差异亦已独立核实：路径component严格等于`archive`或`_archive`有 **169** 条；lowercase整路径包含substring `archive`有 **174** 条。Root dedup的169与本方向早先snapshot recheck的174使用不同定义，不应直接拼成一个统一总数。全部实际库存都保留这些路径，差异不意味着漏扫归档。该事实交Root在聚合QC说明，本review不改冻结作者文件。

报告 **11个本地Markdown链接及所带行号** 全部存在/合法；validation runs为空，0执行计数与独立Runtime失败方向分账；locator错误的metadata摘录明确标注人工转录，不伪装产品raw。未发现本补充的分类、来源、计数、范围或链接阻断。最终聚合索引与stage/Git保全仍由Root完成。
