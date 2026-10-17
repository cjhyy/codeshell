# 第36批：聊天列表、跟随状态与Toast

本批 **0新增正式问题、0候选、0新关联**，未修产品。旧popout active-vs-origin bucket原因明确保留，不表示完整锚点系统无bug。

- [Chat buckets/follow](evidence/chat-view-frontier/report.md)：普通列表helper与真实hook选段有限negative，旧July8/July9原因排除。
- [Toast状态](evidence/ui-state-frontier/review.md)：active/history、dismiss/read/clear普通合同未建立新反例；dialog同SHA旧full，仅hash核对。
- [Root metadata复核](evidence/root-review/review.md)：无新增Root产品语义阅读，指令carry-forward新增语义0，旧运行不借作本轮通过。

冻结父提交 `41d7d62bd39f141228146106383648017b5a8fb4`，整合前main `cecd79dc876da244bf7dd3277774e82d3d3866db`，原40d上下文与3137历史快照保留。28唯一source/metadata指纹、24语义rows（含4份旧报告）、6hash-only分别列；Chat1147申报行含48单行导航，direct ranges1099。33份prep逐字copy不计重复阅读。

正式history3263含冻结35，47新增文档独立补查；相对原3137，34/35差集由各次dated库存分开保存。**0产品/helper/语言fixture/测试/React/DOM/scroll/timer或native运行，0pass/expect**。旧失败方向继续跳过。[分类](findings.json)、[候选](candidates.json)、[验证](validation.json)、[源码](source-manifest.json)、[范围](coverage.json)、[聚合复核](evidence/review-aggregate.md)、[索引](evidence-index.json)。整体审查继续，不push。
