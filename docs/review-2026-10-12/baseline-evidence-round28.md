# 第二十八轮：既有基线证据归档核对

本轮只核对和归档早期已完成的验证，**新增产品import、fixture执行、测试和发现均为0**。初始84740基线的既有Server/Web、Desktop renderer、Desktop main逐文件结果分别为141/1428、282/2397、283/2461，合计706文件6286测试；本次实际读取全部已有stdout，均有guarded runner的Completed标记、0最终fail/skip，元数据code0/signalnull且706源码文件唯一。

[归档清单](validation/original-baseline-evidence-round28/manifest.json)列出每份原日志的源路径、大小、SHA256、测试数和tar成员名；[原字节压缩包](validation/original-baseline-evidence-round28/baseline-706-raw-logs.tar.gz)含706日志及3份原结果metadata，全部709成员已重新打开并逐字节比较。压缩包SHA256为 `e83019de96329b329694e4780c25c7037b2d4244458a055582a97fdf45d1a84d`。tar固定mtime/owner/mode、gzip mtime0仅规范容器元数据，不改任何原日志或旧结果JSON。

主报告前几项原先只显示/tmp路径，现改为已有validation文件的可点击入口。工作区构建[阅读副本](validation/build.log)在早期归档时仅去掉第25行尾一个空格；本轮另保留[精确原字节](validation/original-baseline-evidence-round28/build.exact-raw.log.gz)及双方SHA和差异清单。typecheck、desktop-build、navigation、settings、workspace-pages五份既有副本与原件逐字节一致，均已tracked。没有因此重新build、运行Electron或再次执行旧测试。

这些证据仍对应早期原基线和当时的隔离实验，不冒充最新0.9.33的全套重跑、修复后验收或真实提供方端到端结果。[最新差异复查](latest-baseline.md)、通用86文件251表征测试与native场景分别列账；没有将706/6286再加到新增专项测试中。失败smoke、开发harness诊断仍按既有附录保留，归档只收这三份metadata对应的最终基线逐文件执行，不把未通过的native smoke改称通过。

[独立706日志审计](validation/original-baseline-evidence-round28/independent-existing-tests.raw.md)及[逐日志收据](validation/original-baseline-evidence-round28/independent-existing-tests.receipt.json)另外核了唯一Completed标记、Bun pass/fail/Ran与metadata的一致性；主审已将tar每份成员对独立SHA/大小逐字节核回。[六对build/UI核对](validation/original-baseline-evidence-round28/independent-build-ui.raw.md)只证明原字节、成功标记和命名范围保留，未从未记录的外层退出码推出额外证据；此前命令状态和基线按原阶段记录保留，本次不重新执行，也不建立新快照兼容性证明。
