# 第42批：后台子代理转录的撤销语义

新增 **1项P3：TRANSCRIPT-R42-01**。后台子代理已输出部分回复后，如果普通可恢复streaming失败进入fallback，转换器把tombstone当作封口，旧文字仍留在转录；替换文本另建一行。TUI后台详情直接消费这些行，因而可能显示本应撤销的partial内容。

这是源码成立并经过独立反证核对的问题，**没有真实模型、UI帧或时序验证**。影响只限仍活跃的后台详情显示；不声称持久/raw session损坏、每次fallback都发生或成功结束后Dock仍可见。预备alias TRANSCRIPT-R44-C1与正式ID是同一项，只计一次；0新增候选、0新关联。

[问题记录](findings.json)、[作者](evidence/transcript-frontier/report.md)、[独立复核](evidence/transcript-review/review.md)、[Root源码复核](evidence/root-transcript-review/review.md)。旧Desktop F01针对不同consumer的ID/最终文本补偿问题，R20仅审主attempt；同family背景保留，不重报旧问题。[Root汇总](evidence/review-aggregate.md)说明实际入口、外层清理反证和范围。

另收录[历史覆盖选择复核](evidence/selection-frontier/report.md)：5个产品候选只hash、没有新增正文阅读；原scope/review显式full优先于旧汇总unknown，避免重复计新覆盖。其报告一个未经支持的历史“14”数字由[更正](evidence/root45-selection-correction.json)明确撤回，冻结原件不改，支持的旧selected count只有35，且不是full-file声明。

正式父提交 `5dcd3ee21756eab037f82193fb80b801fb24112e`。预备44/45原3696历史时点保持，正式3773份历史纳入77份冻结41新增MD/JSON、共享字节0变化。关键词和保存片段不等于全历史语义穷尽。

0产品/helper/import/事件或语言fixture/测试、真实模型/流/CLI/React/Ink/浏览器/native/权限身份/业务网络执行，0pass/expect；worker Git0，Root Git元数据操作另列。只增文档、未修产品、未push，整体审查继续。[验证](validation.json)、[源码指纹](source-manifest.json)、[范围](coverage.json)、[证据索引](evidence-index.json)。
