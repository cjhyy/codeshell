# Round29 Stop 目标数据选择静态审查

本方向 **0 正式问题、0 候选、0 新关联**。冻结baseline由Root提供：`b3488ec155ecf0c3bb39f5e4d3cd21a783077ad0`；作者0 Git、0产品/函数/import/测试/fixture/React/browser/VM/native/网络/模型执行，没有触发任何真实Stop、取消或会话动作，也没有改产品。

## 目标选择与反证

[resolveStopBucket](../../packages/desktop/src/renderer/stopRouting.ts:18) 的合同是 override >activeBucket >runningBucket >null，24行实现直接使用nullish链，和5个未执行的既有测试意图一致。没有把空字符串/畸形手工参数当作普通用户输入；实际主composer只调用 [stop()](../../packages/desktop/src/renderer/App.tsx:2634)，其 [busy](../../packages/desktop/src/renderer/App.tsx:388) 同样来自activeBucket。两个正常会话并发时，当前代码不会仅因global runningBucket最后发送到另一会话就优先取消它。

真实relay路径在 [useRunController:883](../../packages/desktop/src/renderer/app/useRunController.ts:883) 取指定bucket并传给stop；queued guide同样显式传activeBucket。QuickChat [Host:107](../../packages/desktop/src/renderer/panels/QuickChatPanelHost.tsx:107) 传session.bucket，经 [SessionPanelDock:144](../../packages/desktop/src/renderer/app/SessionPanelDock.tsx:144) 接控制器stop，按override优先的合同选择。仅从字符串拼接或未知空override无法建立一个正常错误目标。

[controller stop:961–1017](../../packages/desktop/src/renderer/app/useRunController.ts:961) 只接受真实string override，先使launchVersion失效、标记/删除pending launch，再解析会话、清目标busy、写stopped、发cancel。早到stop之后的异步launch在`:455`检查cancelled/version，已有launch测试源码也表达旧resolve/reject不能结束继任run的意图；该参数化声明3个场景均未执行。这里只确认数据选择及源码保护，不把UI stopped等同Main/Core取消已ACK，也不声称排队原生副作用已回滚。

曾核对stop与通用engine-session resolver的重复分支，但普通 [send:258–303](../../packages/desktop/src/renderer/app/useRunController.ts:258) 在真实launch之前选择并保存engineSessionId。仅凭某个手工旧summary或特殊调用时序，没有建立普通producer下新的wrong-target结果；不登记candidate，也没有进行identity/native取消实验。整个大型controller和App没有全文审完，不能从本negative外推所有Stop终态、审批或后台路由均正确。

## 历史边界

[历史检索](evidence/stop-dedup.json) 遍历`docs/`和`bugs/`下全部MD及递归JSON值标量，包含169个exact archive/_archive目录路径，排除round29：**2765=1275MD+1490JSON，562917字符串值/833428标量，0解析错误**。Stop优先级64、runtime-cancel20是regex occurrence总数，低于100cap，全部上下文保存。大量只是旧库存/验收引用，不能算新语义覆盖或当前通过测试。

[旧R81合同](../review-2026-10-12/browser-stop-contract-round22.md:18) 已明确分开“renderer正确选择当前bucket”与“Main中已派发Browser等待动作不随parent取消”。本轮未重开该native方向，不把它重报为这个纯helper选错会话。旧 [R08房间Stop](../review-2026-10-12/cli-quality-round9.md:31) 是Web/Mobile CLI room帧缺目标且被现有native guard拒绝，另一producer；不能称为当前Desktop误取消native任务。既有 [D5拆分说明](../todo/arch-debt-p1p2-plan.md:224) 也已提到该helper；“库存记录少”不等于历史从未看过。详见 [history decisions](evidence/stop-history-decisions.json)。关键词和所读上下文不代表历史语义穷尽。

## 覆盖与材料

[source manifest](evidence/stop-source-manifest.json) 保存13个source/contract pins：1027行产品/测试源码，222行沿用已读且SHA未变的指令，50行旧合同；全文/selected范围分开。stopRouting24、test42及launch test177全文；useRunController1247行只读声明片段、App2924行只读两个片段。初始inventory里的approvals test仅byte pin，不计语义阅读。新增导航文件缺少before-read SHA时保留null，未伪造时点；作者没有执行Git blob对照，Root负责独立绑定冻结source。

[validation](evidence/stop-validation.json) 的runs为空，0 pass/0expect，没有raw/exit可声称动态复现。只对metadata做文件/JSON/hash/链接核对。一次 [locator错误](evidence/stop-metadata-notes.json) 是猜错SessionPanelDock目录，同一次rg返回真实app路径后只读其选段；保留人工diagnostic，未捕获的原始exit number不编造，没有产品失败后修复或重跑。最终 [作者材料收据](evidence/stop-artifact-receipt.json) 证明本方向自有文件字节，不能替代产品测试或全仓完成审查。
