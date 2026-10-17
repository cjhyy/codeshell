# Round28 Optimization Lab 独立静态与材料复核

支持 [Lab report](../lab-report.md) 的 **0 formal / 0 candidate / 0 new-related**。本review读作者报告、manifest/validation/receipts、原prep范围与历史决策，并选读report1–115、controller802–865、verdict-policy18、overfit-hints37、candidate60–81相关源码。没有重新全文审完所有controller/store，未执行产品、函数、测试、import、fixture、VM、React/browser、native、Git、模型、网络或Root verifier，只新增本文件。

独立核 [author receipt](lab-artifact-receipt.json) 的 **7份材料**byte/SHA全部匹配；[copy receipt](lab-prep-copy-receipt.json) 的 **10份副本**均与exact originalPath逐字节相同，包括原self-excluded prep receipt。原parent-reported9b上下文、初始/结束48pin与时间/coverage均保留；本轮32c为Root提供的新冻结上下文，不把副本字段改成新Git验证。作者的Git命令与执行计数为0，冻结blob绑定由Root负责。

[source manifest](lab-source-manifest.json) **15 pins=14 full+1 selected controller，2012声明阅读行**全部当前byte/SHA、总行数、range合法且与原prep manifest一致。Controller仅500–533、726–777、802–865、1013–1073共211行，其余14全文共1801行；不是通读1394行controller。原48个initial/finish/current filesystem hash也逐项相同。归档阶段15次hash复核是同一组此前阅读的继续，不加算15个新语义阅读，更不能将48库存当48全文覆盖；测试与foundation fixture只读定义。

选段反证与negative边界相符：trialVerdict独立要求有效observation/model/usage/status并重算hard assertions，hard failure不能被semantic passed覆盖；latestGrade仅在去重后的单一head时取值，冲突不确定。Controller导出读取data.templateRef已有模板，不能由“重复导出”推成每次都创建竞争head。paired repeats不完整为unknown，缺reported cost/cache信息也保留不可比；overfit明确advisory而不影响ranking。candidate拒绝unchanged/duplicate body。没有普通producer反例时，不能用畸形Trial字段或精确性未承诺的提示覆盖凑候选。

旧LAB-R3-01仍作为排除项：反馈取首条的旧因果不重报，Arena旧失败fixture不恢复。旧Round3的20个source hash与Round24 inventory entry不能拼成全包语义覆盖。本review没有真实provider、完整模型实验或默认Desktop业务观察，也没有因读到实验能力而宣称默认打开。

[旧prep history](lab-prep/history.json) **2596文件**当前byte/SHA独立重核全相同；其1250MD/1346JSON、468104strings/676635scalars、0parse、lab955命中保留100/score-report48保留48，是排除当时mutable Round27与28的旧时点。不能换成当前2677语料已全查的说法。报告已明确该时间差和keyword/context局限；当前negative不是整个private package或全仓无bug证明。

链接计数保留真实口径：[author receipt](lab-artifact-receipt.json) 保存reported **12**，本review当前实际核到 **13个本地Markdown链接**，包括带fragment的旧LAB-R3-01链接与selfreceipt链接，目标文件及所带行号均有效。不猜旧checker怎样计数或当时执行了哪些；不改冻结作者。RootQC应并列这两项，最终metadata verifier按当时现有文件重数，不能借链接检查宣称产品gate。

[validation](lab-validation.json) runs/guardedRuns为空，产品/测试/import/函数/fixture/模型/Git等均0，没有应该存在却缺失的raw或exit。未发现分类、覆盖范围、来源或副本保真的阻断；上述reported12/current13是已明确的metadata时点/口径差异，最终聚合索引与Git/dirty保全由Root完成。
