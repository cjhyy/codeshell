# Round27 首次运行边界

本轮唯一动态方向在第一次即失败，状态 **SKIP**；没有修夹具、重跑或改用其它执行方式。失败来自 Root 编写的 [focused fixture](evidence/root-containment.test.ts) 的相对导入路径，多退了一层目录。这是本次审查支架错误，不能记为产品缺陷，也不证明仓库缺少该模块。夹具保持首次内容与 SHA 不变。

[首次 driver](evidence/root-run-first.py) 先把 stdout/stderr 合并写入 [原始日志](evidence/root-containment-first.raw.log)，再保存 [exit receipt](evidence/root-containment-first.exit.json)，随后才读取两者。exit **1**，日志 **2272 bytes / SHA256 `3419b38917c264fa865bcca06aa7160da25216f1b056c713ceb57a42f6a33a48`**。Bun 实际报告 **16 pass / 1 fail / 1 error / 54 expect() calls**，共17项跨两文件；wrapper 最后为 `Bun test process failed (1)`，没有 `Completed Bun shard`。

16个 pass 全属既有 `composeFileEdits.test.ts`，它们实际执行了 compose/parser 两个生产纯函数叶子。focused 文件在导入前失败，所声明三个 test 的函数体均未进入，日志没有它们的 JSON 观察；不能把静态写入的 expected/observed 字面量当作运行结果。既有 suite 通过与本次 guard 失败分别记账，不称整个 shard 成功。

新疑点由 [compose 静态报告](compose-report.md) 收录为 **COMPOSE-R27-C1 candidate**。短字符串反例、实际 Edit unique-old 合同及 aggregator payload 流仍有静态分析价值；本轮不据此宣称已经动态确认或升级 formal。没有导入真实 Edit 工具、aggregator、React、viewer、Engine 或 provider，没有执行业务 Git、网络、账号、模型、真实文件编辑或其它 native 流程。

[事前计划](evidence/root-run-plan.json)、[source pins](evidence/root-source-manifest.json) 与 [分账 validation](evidence/root-validation.json) 保留真实范围。其余作者方向只读源码/文档/hash，0产品执行。此前失败方向也不恢复运行。
