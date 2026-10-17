# Round32 task parser 独立复核

支持 [作者报告](../taskparse-report.md) 的有限静态结论：0新增正式/0候选/0新related。IMAGE-R15-C1保持旧候选排除；没有重跑旧fixture、升级旧候选或修产品。

Root独立完整读parse-task190与既有test140，选读普通Desktop encoder230–280和run-image-input明确132行，再完整读R15 injection48及R9 attachments24，共6source pins/585声明行（373产品+140test+72旧报告）。[source manifest](review-taskparse-source-manifest.json)保留读前pins/结束SHA及准确范围；大型consumer未通读。14个既有测试声明均未执行。

普通encoder追加完整、按输入图片顺序排列的block，序列化attrs先escape ampersand再quotes/angle；parser的逆序unescape把普通escaped name/path恢复，图片数组与剩余正文分别保序。其测试源码把孤立marker拒绝、正文空白规整、opening MIME优先与分别保序明确锁定，不能把它们重写成新合同缺陷。run-image-input先解析DTO，再构造image ContentBlock；读到session/workspace/permission参数边界即止，没有验证authority实现、真实文件/图片/模型。

R15 [原候选](../../audit-2026-10-17-round15/injection.md)已经记录equal-count closing-before-opening wire不抛错，但没有普通encoder生产者。R9 [旧审查](../../audit-2026-10-17-round9/attachments.md)已覆盖该leaf/普通转义。当前完整正常block没有建立新的强反例。旧通过数和原candidate fixture仅作历史文本，不计本轮观察；旧Web display/parseDocument/其他失败方向未恢复。

[metadata checks](review-taskparse-checks.json)核作者4semantic+1hash-only全部current SHA及逐项prepRow、9作者artifacts、11逐字copies，另按作者history库存核2988项当前bytes/SHA。原prep parent4dad/history2921保留，正式4be/history2988含冻31/exclude32；Root没有另做一次正则/scalar扫描，也不冒称理解全部库存/300contexts。作者实读29旧摘录+1新noise的限制保留。

作者freeze后Root先读报告再捕获artifact checks，未补称Root读前artifact pin；其明确freeze SHA和最后收据已核，source初始pins另列。[validation](review-taskparse-validation.json) runs为空，0product/import/function/test/fixture/Intl/native/真实Task/network/model，0pass/expect。该negative不表示全部图片/权限/平台或全仓正确。
