# 第21批 NDJSON 独立复核

结论：通过；维持0新正式/0候选/0关联。只读复核作者材料和真实源码，未改作者文件、产品、fixture、raw或exit，没有测试/产品重跑或Git写。

- 直接读完整79行 NdjsonReader、36行现有测试、7031字节 focused fixture、2032字节 first raw，以及 report/validation/preflight/navigation/dedup decisions/history selected。实际 import 是绝对生产 leaf，依赖 node:readline，未见 mock；所有 constructor 显式传入自有 PassThrough/Readable.from。没有默认stdin、真实CLI、provider、timer、approval/auth/schema/安全动态测试。abort listener只是 readline关闭通知，未发送abort命令。
- first exit实际schema是 raw/rawBytes/rawSha256/attempt/exitCode/reruns；重新计算raw SHA=66b5c30a498d68b0aee0cf443220aff93f104350f44dbf99ad6c3dfe19ce56a8、字节2032均匹配，attempt1/exit0/reruns0。raw明确15 pass/30 expect/0fail/0skip、Completed。fixture SHA与preflight相同。7 start grammar +5 iterator grammar +3 lifecycle 与fixture/raw一致，原有两个timer测试均未计入。通过是小型内存流控制，不是完整CLI或全部资源路径证明。
- 4 frozen/current source pins逐个以冻结Git blob和当前字节复核；selected范围均在实际行数内。16个artifact receipt文件逐个SHA/bytes复核，全匹配；收据自排除。报告15个local links及行号均存在/在界内。findings/candidates/related实际均空数组。
- 历史库存2169=1189MD+980JSON，288528 string/404370scalar，0parseerrors；35exact/53mechanism均低于100context上限。关键词并非穷尽，非string scalar仅计数，字符串值负责关键词导航。原May30 readline leak和无调用方verify_note，以及10/12先前静态覆盖已承认；本批生命周期控制与旧修复重叠，没有记新缺陷或宣称全部资源问题已修复。
- 独立重查navigation里精确literal搜索，仍只有 reader及原test两个路径；这仅支持当前选择的packages/scripts/tests扩展名范围，不能排除computed/generated/exported SDK消费者。作者明确没有建立普通CLI消费链，报告没有越界推导用户影响。旧CLI data/read-stdin与其他失败方向未恢复。

作者已披露的历史rg显示截断、两个旧receipt路径猜测和分组计数修正均为metadata导航/文案；本次未发现需要修订的实质问题。后续整批索引加入本复核时需正常纳入它；本复核不改变作者原收据15/30或16个artifact的冻结时点。
