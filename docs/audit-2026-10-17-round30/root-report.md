# Round30 Intl 与显示辅助函数静态审查

本方向 **0新增正式问题、0候选、0新关联**。正式冻结父提交`19efab9225723c76af447f8b9d9f65aace3b0780`；复用原prep的同一次静态阅读，正式化0新增产品语义读取/0产品运行，未修产品。

完整阅读 [intl.ts](../../packages/core/src/utils/intl.ts)94行；选读 [format.ts:139–300](../../packages/core/src/utils/format.ts:139)、[earlyInput.ts:60–110](../../packages/core/src/utils/earlyInput.ts:60)及[internal export:60–90](../../packages/core/src/index.internal.ts:60)，共338产品行。Intl按固定granularity缓存segmenter，relative formatter按style/numeric缓存；locale unavailable使用undefined缓存。first/last基于grapheme segment并处理空字符串；选读consumer按返回segment长度删除。没有建立普通字符串合同的新反例。

这里没有执行Intl构造器、系统locale读取、输入捕获、stdin/TTY、native或任何产品函数；earlyInput仅是静态消费边界，不能称验证了输入分块/平台交互。原CLI/i18n/Slice失败方向继续跳过。

`showTime=false`在reset短时间分支和relative短style的线索，恰是 [R14旧报告](../audit-2026-10-17-round14/utils.md:31) 已明确排除的孤立helper输入。当前源码名称检索仍只找到definitions/同helper family，未建立新的实际生产consumer或更强合同；不增加候选或related。旧报告全文40行只用于根因边界，旧测试通过数不算本轮验证。

[正式source manifest](evidence/root-source-manifest.json)复用5个prep rows，338产品+40旧报告行。4个产品路径读前pin；旧报告专用pin晚于检索excerpt，初始semantic SHA保持null。原错误时序字段与更正均在[逐字保留prep](evidence/root-prep/metadata-notes.json)，不倒填证明。[12份copy receipt](evidence/root-prep-copy-receipt.json)保留原parentb348/time/旧history2765，正式baseline另列。

[新全历史metadata](evidence/root-dedup.json)包含已冻结29、排除当前30：2851=1285MD+1566JSON，597236字符串/884863标量，169exact archives，0parse。Intl111/display-option15/old-failed146 occurrences，保存100/15/100，cap100；归档和递归JSON值均包括，关键词/cap不是历史语义穷尽。原prep排除当时mutable29的2765文件快照没有被覆盖。新扫描仅metadata，不算第二次产品阅读。

[validation](evidence/root-validation.json) runs为空，0测试/pass/expect/import/fixture/真实任务/模型/网络；没有借另一个入口恢复旧动态失败方向。[分类判断](evidence/root-history-decisions.json)、[作者收据](evidence/root-artifact-receipt.json)保留有限negative结论；不声称Intl平台、格式器全集或全仓无bug。
