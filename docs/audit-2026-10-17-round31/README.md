# 第31批：搜索大小写候选与入口边界

本批 **0新增正式问题、1候选SEARCH-R31-C1、0新关联**。冻结父提交 `4dad999bd43b776995b5d212dde275dab86a1ddd`，整合前main `4dad999bd43b776995b5d212dde275dab86a1ddd`；未修产品，审查继续。

[候选报告](root-report.md)：逐cell小写与整段查询小写保留的希腊词尾上下文不同，相同字面查询可能静态推演漏匹配。原独立[source评估](evidence/review-search.md)支持P3 helper原因；[入口追踪](entry-report.md)未找到可达App/公开package消费者，Root因此不升为已确认生产UI问题。[独立聚合复核](evidence/review-aggregate-independent.md)保留这一强弱边界。

**0产品/函数/测试执行，0pass/expect**。规范只用于静态推演，不证明安装的runtime版本；无实际终端/UI观察，旧失败方向继续跳过。28份原prep副本保留旧parent19ef/time/history2851，正式化不重复语义阅读。当前history2921含冻结30、排除31，关键词不代表语义穷尽。

[分类](findings.json)、[候选](candidates.json)、[验证](validation.json)、[源码绑定](source-manifest.json)、[覆盖口径](coverage.json)、[聚合记录](evidence/review-aggregate.md)和[索引](evidence-index.json)可复核。主checkout原改动按字节保存，不push。
