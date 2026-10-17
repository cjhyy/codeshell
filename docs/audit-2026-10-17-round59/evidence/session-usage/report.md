# prep147：普通 run usage 到 session 累计字段静态复核

**有限0新正式问题、0候选、0new-related。** 实际 producer→foreground/external run计量→session增量提交→usage event字段链未建立正常输入下的丢字段或重复累计反例。本轮产品/helper/import/fixture/test/模型/时钟/timer/native/网络/Git执行均0。

Root提供冻结上下文 `c39eb6f987b7bd5d740fee6d8ab5b46718f9c9af`。指令沿用此前实际AGENTS5/CODESHELL217阅读并核同SHA；不认证Git。逐源[初始pin](initial-pins.json)、[支持pin](support-pins.json)、[真实producer pin](producer-pins.json)、[response producer pin](response-producer-pin.json)均先于各自body或行号导航。

## 原全文与定向范围

亲核原对象后，usage同SHA在R19 `root-source-manifest#/files/4`明确full static leaf；R9该对象只selected，不能以R9替代后来的全文。stream-timing在R19 `timing-source-manifest#/files/0`与`timing.md:7`明确同SHA全文1–41，因此本轮不读timing正文。后续按Root保留的实际生产计量链，usage149行只是定向重读旧full，不宣称新增唯一覆盖。run-accounting原R9 `/files/21`只有selected；旧publisher full175行SHA与当前176行不同，未套同SHAfull且未机械转读publisher。见[gate](gate-decision.json)。

## 实际链与反证

- Engine `:2771–2778/3480–3481`创建并传递真实计量回调；TurnLoop `:1202–1206`在正常provider response有usage时调用 `recordResponseUsage`，`:816–834`同时累计run并回调session foreground。`emitCtxFromUsage:836–889`区分provider当前prompt、single-turn字段与session cumulative/legacy alias；没有把固定prompt大小当作停止累计的条件。
- `run-accounting.ts:33–87`将foreground response加入runCacheUsage与session cache计数；辅助billed usage用独立externalRunUsage，正常`getRunUsage:106–118`才把它加入全部计费token总量。`:145–159`普通aux summary返回usage的接线也走该独立通道。foreground cache与所有billed输入不同是明确注释/字段合同，不据此报漏计。
- Engine `:1776–1786/2083–2087`为具体run建立两个零检查点与ownUsage/ownCacheUsage；`run-state-persistence.ts:43–99`捕获own计数，提交captured-minus-committed到最新state的tokenUsage和独立cache累计，成功后才推进两个checkpoint。普通异常分支返回false且不推进checkpoint；失败提交不被当作成功累计。本读者没有运行失败注入或认证manager内部CAS/锁/FS机制。
- Engine heartbeat `:3555–3569`与finalize `:360–370`先调用持久化，成功后才发 `sessionCumulativeUsageUpdate`。后者`:11–26`以提交后的session state生成cumulative与session*别名，避免只发布原run本地临时计数。`run-finalize:383–393`另发single-turn foreground cache；两种指标用途不同。
- late auxiliary路径 Engine `:3890–3919`先将该delta交session manager，再仅对匹配源run推进已提交usage，保持foreground cache checkpoint独立。这里只核给出的参数/字段及成功后数据流，没有认证其他进程、真实并发、账单或用户数据。
- usage中的add、fold与cache migration已有同SHA全文旧读，本轮确认引用合同而不恢复旧pricing/cached-token实验。`foldRunUsage`明确baseline+current，而提交层再只采用本run未提交delta；不能把同一heartbeat内出现两种表达直接当作重复累加。

既有 `run-state-persistence.test.ts`两项声明对照heartbeat幂等、不同owner辅助增量、billed/cache分离与失败写入不推进checkpoint；仅阅读声明，**未运行**。其FS fixture setup只作导航，不由这些断言证明本轮系统行为。

## 去重、计数与冻结

亲读 `round9/usage.md:1–26`：COST-R9-01限未绑定账本的独立CostTracker完整模型ID丢失，不扩大到当前主流程或实际账单；旧R19 `timing.md:1–42`的受控时钟/旧pass仅历史元数据。OM3时区排序、OM4并行工具起点及旧pricing/cache家族为本批范围排除，未重读原OM报告或重报。已有失败clock/token容量/native方向继续跳过。

Root148[历史投影](shared-history-projection.json)含冻58排59+：6010 MD/JSON、4291442递归JSON value scalar、0parse，含archive不查keys。usage87/timing59均低于cap100且保留全部；机器命中不是全史语义穷尽。另31份[原始路径/SHA导航](targeted-history-navigation.json)仅字节pin。原[canonical pin](canonical-before-pins.json)与[旧因pin](old-cause-before-pin.json)保存准确原窗口，未导入作者方法或旧fixture。

[源manifest](source-manifest.json)：8语义文件，2full（usage149明确旧重叠）/6selected，573产品语义行+63测试声明行，实际显示联合975行；另1文件仅导航、4文件仅hash、2指令hash。不宣称新增唯一覆盖或全会计机制无bug。[摘录](source-excerpts.json)在实际显示后仅复制已读范围。

[首诊断](diagnostics.json)本轮无失败/截断，未运行任何产品实验。[结束核对](ending-checks.json)15源/指令pins、5canonical及31原导航pins、共享batch全部同字节；不据此验证全部6010成员或未来Git。[分类](classification.json)、[验证边界](validation.json)、[冻结检查](freeze-checks.json)、[自排除收据](reviewer-receipt.json)保留。
