# 审查覆盖与尚未完成范围

按原 **4643个TS/TSX路径**、相同源码SHA的保守台账：

| 记录状态 | 路径数 |
| --- | ---: |
| 有完整范围静态语义审查记录 | 355 |
| 只有部分范围审查记录 | 354 |
| 缺少可绑定的充分覆盖记录 | 3934 |
| 尚不能标完整范围（后两项之和） | **4288** |

这说明该口径下还有4288个路径未达到完整范围记录要求。unknown不等于从未读过，full也只代表原审查目的下的完整语义文本，不能代表所有行为、平台与运行机制都正确。355中也包含测试声明或测试基础设施文本；读过测试不等于运行通过。

[46–60迁移原报告](evidence/coverage-migration/report.md)将旧304/168/4171更新为355/354/3934：51个unknown升级full，186个unknown升级selected；不把多份selected拼成full，不相加作者/复核者重叠。77份规范非空manifest schema已适配，MD-only/其它旧格式仍保守保留原状态。旧55的hash键归一化失败原件仍保留，不再将旧0/511当成无进展结论。

[统一逐路径索引](evidence/coverage-migration/unified-current-index.json)、[逐路径变化](evidence/coverage-migration/transitions.json)与[Root当前字节/Git绑定](evidence/coverage-snapshot-current-binding.json)可查。迁移覆盖至正式60；本轮61的源选段未再并入统一索引，不能将这些数字说成全部审查工作的最终全集。

当前同一rg过滤库存4644，额外1路径是旧57的审查fixture `docs/audit-2026-10-17-round57/evidence/static-path.test.ts`，不是新增产品全文。原4643路径当前字节和Git基线全部对应，无缺失或改变。文件hash/索引读取不算产品语义审查。

整个仓库还有非TS/TSX源、脚本、配置、文档、跨模块行为以及各平台/运行验证，未纳入这4643分母。因此不能给出全仓精确剩余文件数、完成百分比、耗时或剩余bug数量。失败实验按用户要求继续跳过，未以反复重跑补成通过；总审查目标仍active。
