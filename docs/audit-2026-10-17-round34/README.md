# 第34批：缓存、版本与UTF8增量输出

本批 **0新增正式问题、1静态候选 UTF8-R34-C1/P3、0新关联**。候选：小于16KiB的增量输出若停在UTF8字符中间，直接解码并推进全部byte游标，下一次读取可能无法重组该字符。真实BashOutput允许对仍运行进程peek；尚未观察当前宿主的分块/peek时序，未升级formal、未修产品。

- [Root候选与限制](evidence/utf8-frontier/proposal.md)、[独立UTF8线索](evidence/utf8-review/review.md)：独立review保留未分类强度，Root单独记录为候选。普通完整buffer的safe-cut helper没有新反例。
- [memoize](evidence/memoize-frontier/review.md)、[semver](evidence/semver-frontier/proposal.md)、[renderer状态/cache](evidence/renderer-status-frontier/report.md)：同版本旧覆盖或有限普通合同复核，均无新增项；task-sanitizer仅hash-only。

冻结父提交 `40d79ff2190a98aa31067eb07006099c2726b21a`，原prep4be/646f上下文与2988/3063历史时点原样保留。正式history3137含冻结33，74新增文档单独补查。30唯一source/metadata指纹、29语义rows、4hash-only、1selected-JSON metadata分别列出，重叠不计独有覆盖。

**0产品/函数/语言fixture/测试执行，0pass/expect**；有只读Node官方资料访问，不证明安装Bun/Node。旧失败方向继续跳过。[候选JSON](candidates.json)、[正式分类](findings.json)、[验证](validation.json)、[源码](source-manifest.json)、[范围](coverage.json)、[聚合复核](evidence/review-aggregate.md)、[metadata复核](evidence/aggregate-review/review.md)、[索引](evidence-index.json)。整体审查继续，不push。
