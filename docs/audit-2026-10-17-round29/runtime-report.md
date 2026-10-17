# Round29 Core / Web 普通生命周期静态审查

正式冻结点由 Root 提供：`b3488ec155ecf0c3bb39f5e4d3cd21a783077ad0`。本方向 **0 正式发现、0 候选、0 新关联**。复用前置 prep 的同一次静态阅读；正式化仅做文件/hash/JSON元数据核对，**0 新增源码语义阅读、0 产品/import/函数/测试/fixture/VM/native/Git/网络/模型执行**。没有修复或恢复任何旧失败方向。

## 真实源与普通生产/消费链

主范围是 [RunQueue.ts](../../packages/core/src/run/RunQueue.ts) 101行与 [transcriptReplay.ts](../../packages/web/src/lib/transcriptReplay.ts) 207行，均完整只读。早期4087源码coverage库存仅显示这两份当前SHA有pin-only记录；这不是“历史从未读过”的证明，历史正文已有说明。

RunQueue 的 [enqueue/cancel](../../packages/core/src/run/RunQueue.ts:33) 将 pending数组、pendingSet 与 active 分开处理；取消尚未启动项同时移除数组和Set。[66–101](../../packages/core/src/run/RunQueue.ts:66) 通过microtask批处理及并发上限分派，executor调用在Promise链内部，同步throw和异步拒绝都会进入finally释放active slot。本轮只读取现有4个测试声明，没有调用queue、executor、microtask或定时器，也不借旧测试通过数做当前运行证明。

[RunManager constructor](../../packages/core/src/run/RunManager.ts:124) 把queue执行器接到executeRun；[取消](../../packages/core/src/run/RunManager.ts:323) 会更新终态并移除pending项。[启动重读](../../packages/core/src/run/RunManager.ts:527) 在可让出的启动过程后重新检查queued/AbortSignal；[648–674](../../packages/core/src/run/RunManager.ts:648) 对晚到结果保留取消/等待状态，[719–780](../../packages/core/src/run/RunManager.ts:719) 在evaluator以后再次看AbortSignal和最新running状态。选读没有建立一个普通取消/完成顺序会错误覆盖状态的具体gap；没有实际运行任务、锁、heartbeat、evaluator或approval/input流程。大文件RunManager仅核这些片段，不声称通读或全生命周期正确。

Web的 [transcriptToStreamEvents](../../packages/web/src/lib/transcriptReplay.ts:44) 预索引tool名称/参数，对专用tool_use和assistant内容中的tool_use做幂等start；先出现result时可补start。[Core Transcript append方法](../../packages/core/src/session/transcript.ts:537) 和已有replay测试只作普通记录格式合同。replay [201–207](../../packages/web/src/lib/transcriptReplay.ts:201) 明确durable log不能证明当前liveness，保留不完整内容但将run归idle（旧error例外），subagent anchor是recorded而非running。

实际消费侧 [streamReducer](../../packages/web/src/lib/streamReducer.ts:327) 完成tool或缓冲先到result，[assistant_message/turn_complete](../../packages/web/src/lib/streamReducer.ts:463) 封当前assistant并区分子代理和主run作用域，[recorded agent](../../packages/web/src/lib/streamReducer.ts:588) 有明确状态。[web/app/chat.ts:44–67](../../packages/web/app/chat.ts:44) 先投影durable history，再接live events和host running flag；不能要求只靠旧transcript重建正在运行的状态。这里未建立一个新的普通完成/消息状态转换缺口。已有9个replay测试只读，无render/parser/reducer调用；原用户展示/附件XML识别函数不在本次新增审查范围。

## 旧边界与统计

旧 [RunQueue concurrency0](../archive/beta-prep-audit-2026-06-23.md:45) 已明确是有意never-drains测试模式，不把非正配置再报bug。旧 [Phase1/cold queued恢复范围](../audit-2026-10-17/operations-memory.md:66) 已有记录，没重启SDK/恢复/真实任务。旧 [Round14 userMessageDisplay](../audit-2026-10-17-round14/web.md:30) 的fixture相对导入失败保持SKIP，本次不借replay测试或另一入口恢复它。RunQueue/RunManager诸多旧说明与Web既有投影记录的名称命中只是导航，不表明首次审查或新缺陷。

[当前全历史元数据](evidence/runtime-dedup.json) 为 **2765=1275MD+1490JSON，562917字符串/833428标量，169 exact archive/_archive路径，0parse error**，包含已冻结Round28的88份MD/JSON，仅排除当前29。名称/ordinary/旧失败四组命中445/140/156/20，保留80/80/80/20；关键词和有限上下文不等于历史语义穷尽。

原prep当时排除仍在聚合的28，保留2677文件、441/136/152/20命中。该时点和原parentReported32c没有覆盖成新baseline；[13份逐字副本收据](evidence/runtime-prep-copy-receipt.json) 分列原路径、目标、bytes、SHA。两个history时点不能混成一次“无漂移”，新扫描也不算产品重跑。

[源码清单](evidence/runtime-source-manifest.json) 沿用10个prep source/contract pins及范围，共1685声明读行：instruction217、navigation-only MobileOutputClient165与ordinary产品/合同1303分列。主源308行只读一次，正式化不再计第二次。导航曾读到auth/journal字段即停止扩展，没有进行权限、身份、custody或native实验。whole-file SHA仅绑定字节；大型消费者只读选段，作者未执行Git，Root负责将同SHA绑定b348冻结blob。

[validation](evidence/runtime-validation.json) 是0执行、runs为空，现有4+9=13测试声明未运行、0pass/0expect。静态反证不等于各异常路径通过；没有日志/exit可伪称首跑成功，也不从无新gap推出整个Core/Web无bug。[历史判断](evidence/runtime-history-decisions.json)、[metadata notes](evidence/runtime-metadata-notes.json) 和 [作者材料收据](evidence/runtime-artifact-receipt.json) 保留限制。未来扩展应由Root先选择普通合同和具体边界，本轮不提出动态执行或替代验证。
