# Round32 context selection 独立静态复核

结论 **0 formal / 0 candidate / 0 new-related**。当前producer反证否定了“turn_boundary在loop开头立即切掉assistant”的初步疑点。应区分Core模型迭代与picker按真实user锚定的完整任务，不能只看到一个boundary就按模型轮次推断用户任务被截断。

初始记录保存Root已完成Round31的4be4016b8661c6a10c60f4eb0f218552b4b7c5d0上下文，以及peer原prep parent4dad999bd43b776995b5d212dde275dab86a1ddd；后续Root提供Round32正式4be基线/branch，未覆盖原始pins/时间。reviewer没有Git操作，Root独立绑定冻结source。

## 当前producer与消费者

`turn-loop.ts:554–570`的finalizeModelTurn明确只关闭completed模型turn并幂等；响应返回后1199才标记completed。普通无tool分支先发assistant_message、on_turn_end、push消息，再1432 finalize；正常tool-result在1684记录，工具后on_turn_end后1961 finalize。它不是外层loop开始就追加boundary。实际停止、异常和其它分支只读已声明片段，没有执行模型或完整engine循环。

contextSelection的finish若segment没有真实user，会把它追加到previous.eventIds并推进toEventId；因此同一user任务的后续模型迭代、工具和注入reminder不会仅因多一个boundary就成为另一picker任务。UI分组也排除injected/reminder作为新任务。既有9个测试声明涵盖完整task、reminder continuation、连续范围、alignment等，全文223行只读，0执行。

MessageStream打开选择前拒绝liveTurnActive，取真实getSessionRawEvents后buildTurns(raw,false)，通过durable源事件/提交字段alignment后才用selectedTurnRange创建summary fork；没有用UI行号猜原事件范围。raw API→IPC→raw reader保持原始顺序和事件字段，读取窗口/跳过畸形行是源码边界，本次没有实际用户历史或容量压力实验。

## 独立backend范围反证

本reviewer额外静态跟随preload fork、protocol summary、Engine委托、SessionManager、Transcript。summary必须from/to，先selectContextPackage后摘要；后端selectContextRange要求两端各唯一存在、顺序正确，使用inclusive slice并clone，不静默向外扩展范围，也不把坏范围悄悄补成完整task。投影后validateSelectedToolPairs显式拒重复、mismatch、orphan/out-of-order结果及unfinished tool round；SessionManager在模型摘要之前完成选择。这些是源码分支，不是已执行的拒绝测试或真实fork。

该backend范围阅读属于本独立review，不能移记为peer作者读过。它不能独自证明任意范围都完整；当前negative首先来自正确producer顺序和按user合并continuation的前端合同。没有声称完整取消、平台交互、恢复、journal或身份机制正确。

modelSelection21行只读合并已有defaults再写text key；引用定位只找到定义与既有test，没有建立正常UI调用者。没有用人工对象、并发竞态或猜测默认配置来凑候选。

## 历史与证据限制

[history](history.json)在确切完成时点扫描docs/bugs全部MD及递归JSON值标量，含archive与冻结31，排除mutable32：2988=1304MD+1684JSON，645399 strings/957193 scalars，0解析错误。exact19、contract303、old-failed2为总occurrences；保存19/60/2（cap60），实际读exact19、broad前20、failed2，未称全部303条语义穷尽。

专门读旧R74/C18-1的summary取消/超时报告与旧turn-loop归档选段。旧取消入口、30秒RPC/后台仍运行、旧busy-fork基线失败均是其它既有原因，不重报，不借旧测试通过数。归档亦描述tool_result/on_turn_end之后才写boundary；旧模型轮次与当前user task分组不能混同。三个旧报告专门pins晚于scanner excerpt，initialSemanticReadSha256保持null。

[source manifest](source-manifest.json)为16个实际语义source/contract rows：1709行产品/测试、86行旧报告；3项仅hash，指令沿用此前SHA相同的阅读，不增加语义行数。大型Core文件只算明确selected范围。初始/结束hash不替代语义阅读，formalization将复用同一次阅读、0新增source语义读取。

metadata两项限制独立记录：一次rg在猜测的transcript-reader中无匹配（exit1），后续跟随实际raw IPC文件；一次scope finalizer将已全文读出的19行raw-api错填1–20，EOF断言拒绝该metadata，见[first诊断](prep-finalizer.first.exit.json)。按原始读前pin里的正确EOF完成范围记录，没有重读source或执行产品；完整combined raw未落盘的限制保留。

**0产品函数/import/测试/fixture/语言实验/真实fork/用户数据/native/模型/网络/Git执行，0pass/expect**。本结论只覆盖声明的普通source合同，不是全仓无bug声明。终态文件见[独立receipt](reviewer-receipt.json)。
