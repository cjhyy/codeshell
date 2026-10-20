# Round27 Root 首次运行边界独立复核

支持 [runtime boundary](../runtime-boundary.md) 与 [Root validation](root-validation.json) 的分账：**1次尝试 / 0 clean completed / 1 failed shard / 0 rerun**；16个既有测试 pass、54 expect 是真实日志，focused三个测试体均未进入。`COMPOSE-R27-C1` 保持静态 candidate，不能把 authored 断言字面量当成已观察的产品结果。没有新的 product finding 或动态确认。

本review只读文档、driver/fixture文本、raw/exit、source manifest与文件byte/SHA；未执行测试、产品import、fixture、VM、React/browser、native、Git或网络，也未运行Root driver、assembler/verifier。只新增本文件；review自身不修改Root原始材料，不把Root执行计成本作者执行。

独立核 [raw](root-containment-first.raw.log) 为 **2272B / SHA256 `3419b38917c264fa865bcca06aa7160da25216f1b056c713ceb57a42f6a33a48`**，与exit、validation、Root receipt一致。原文含16个既有 `(pass)`、`16 pass / 1 fail / 1 error / 54 expect() calls`、17项/两文件，最后是 `Bun test process failed (1)`，不含 `Completed Bun shard`。不能把“reported17”说成17个成功测试，或把failed/error计成产品断言已证实。

[fixture](root-containment.test.ts) 仍为 **2622B / SHA256 `9f38f940423daf3877d3aa9bfd390af7949aac802ca29b68272a4a2cb8d464fe`**，与事前plan和receipt一致。导入字面量 `../../../../packages/desktop/src/renderer/diff/composeFileEdits` 从 evidence 目录多退一层；仅用Path的目录解析与existence元数据核了其目标并非当前仓库实际模块，真正模块文件存在。没有尝试改路径或执行另一种加载。这是Root自写支架的模块定位错误，不是产品缺模块证据。三条focused test声明及console JSON只存在于源码，raw没有其case pass或JSON观察。

[driver](root-run-first.py) 的实际源码先以wb打开raw，把subprocess的stdout/stderr合并交给该句柄，进程返回后写exit receipt；随后只打印保存路径。结合首次保存收据与本次完整raw，边界表述“保存raw/exit后才读取”一致。没有把人工metadata diagnostic摘录冒称这份产品raw。

[Root author receipt](root-artifact-receipt.json) 的 **9份材料**全部 byte/SHA匹配；[source manifest](root-source-manifest.json) 的 **9个当前文件**分别与保存SHA匹配（含运行过的compose/test/parser、runner和静态Edit/aggregator/指令文件）。这是文件字节核对，不是独立全文重审或Git冻结blob核验；冻结Git绑定由Root自己的证据负责。此前metadata locator失误被单独保存，没有修补产品或凭此重启失败方向。

0focused执行与静态分析价值可以同时成立：Root没有在失败后修夹具、重试或用替代执行补观察。现有green suite只覆盖其实际16个案例，不能支持本次新false-containment反例的运行结论。当前记录准确，未发现这份运行边界或9份收据中的分类、计数、归属阻断；最终stage/raw逐字节保全与Git集成仍由Root完成。
