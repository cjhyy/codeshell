# 第37批：插件市场名称与卸载来源

本批新增 **1项P3静态问题、0候选、0新关联**：[MARKETPLACE-R37-01](marketplace-local.md)。合法市场名`local`与直接本地插件的来源标记重合，使普通界面卸载走错入口并在缺少直接安装目录时拒绝。原候选别名升级为这同一项，没有重复计数。

冻结父提交和整合前main为`ee5c1a90050ce3cdddd3f2ebee2f9a2c0d8824d8`；刷新后没有新增main路径。仅记录问题，未修改产品。原作者、独立读源者和Root的范围分别保留：28个唯一source/metadata指纹、48条语义检查记录与6条hash/carry-forward检查；这些包含重叠及旧报告，不代表28个新读产品文件。

**0产品、函数、语言fixture、测试、安装/卸载、目录业务查询、React或MCP/网络执行，0pass/expect。** 判定来自正常输入的准入、标识生产和具体分支/callee的静态证据；不声称实机操作、删除或损坏。

正式历史库存3318份MD/JSON包含冻结35/36；原两份3216库存保持原时点。新增102份及release TODO的单独变化另行核对。去重只覆盖所列查询与实际读取的上下文，不宣称全仓首报。原材料“正则重复转义”说法已按源码和码点撤回，新增查询属于扩大覆盖；[更正证据](evidence/root-review/regex-codepoint-checks.json)和原件同时保留。

[问题数据](findings.json)、[候选及升级别名](candidates.json)、[验证边界](validation.json)、[源码指纹](source-manifest.json)、[范围](coverage.json)、[聚合复核](evidence/review-aggregate.md)、[历史补查](evidence/history-supplement/review.md)、[证据索引](evidence-index.json)。整体审查继续，未push。
