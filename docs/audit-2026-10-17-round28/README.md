# Repository audit · Round28

本轮新增 **1个P3静态确认问题**，0候选、0新关联。所有产品、测试、React/parser、fixture、native、模型运行均为 **0**；只记录审查范围和证据，没有修产品。冻结基线 `32c633e58c20b3853f49bb0e43264b4577281eac`，整个“审查所有内容”目标继续active。

[STREAMING-R28-01](streaming-report.md)：默认富流式状态下，助手已输出一个内部含空行的完整代码块，随后仍在输出prose。前面的fence-aware函数把完整围栏留在稳定前缀，后面的chunker却再次无条件按空行拆开，再把每段独立交给Markdown。完整代码块变成两个不完整文档，违反组件“每块自包含”的合同。[Root复核](evidence/review-streaming-root.md) 与 [第二独立复核](evidence/review-streaming-independent.md) 均支持这一有限P3。

影响只限实际呈现的**富流式阶段**。done=true后组件用原全文重新渲染，可恢复完成态结构；不改原消息、磁盘或剪贴板，流式本来没有代码copy控件。没有HTML/截图、120ms时序或实际UI复现主张；所有例子和chunk文字均为源码推导。26个既有测试声明只读，不能当成已通过。R27首次失败的compose夹具与旧parseDocument等方向保持SKIP，未修支架、未重跑或改用其它验证。

其余范围如实记录negative：

- [Lab评分与报告](lab-report.md)：15pins、14全文+controller选段2012行，是原prep同一次继续阅读；保存原parent9b与当前32c上下文，没有重复算新语义阅读。旧LAB-R3-01不重报；[Lab独立复核](evidence/review-lab.md) 核对10份副本与边界。
- [Dialog状态与消费者](dialog-report.md)：8pins，6份产品/测试/consumer全文653行，另222指令行；FIFO、request identity guard、cancel与输入法等反证是源码，不是UI实验。
- [Root小型JSON/路径/状态](root-report.md)：11pins581行含指令；canonical JSON反证、native/home路径依赖未运行、状态优先级与选段App合同均没有建立新问题。[独立复核](evidence/review-root.md) 保留其边界。

[覆盖索引](coverage-report.md) 为后续范围选择提供保守metadata：packages的4087个TS/TSX在指定source-manifest结构中，当前同SHA明确full96、selected59、pin-only869、仅旧版本27、无matchingrow3036。它不统计所有prose或其它文件类型，**不是全仓审查百分比，更不能说3036文件从未读过**。完整哈希库存、regex文本候选与真实source语义阅读分开；Root没有把4087个byte检查冒充全文审查或Git绑定。

当前去重语料 **2677=1262MD+1415JSON**，506929字符串值/740424标量值，0parse errors，含169 exact archive/_archive目录路径、排除本轮；每组query保留真实total/context cap，不从关键词推语义穷尽。Lab旧prep的2596库存是较早时点，保留原统计而不替换为2677；profile与当前Root/Streaming/Dialog使用当前语料。旧known C2引用式链接与R19外层prompt围栏不是本次renderer二次split的同因果。

[源码总清单](source-manifest.json) 固定frozen/current/main，[材料校验](worker-integrity.json) 分开42作者材料和18原样prep副本，[证据索引](evidence-index.json) 固定全部字节。74unique source/meta pins不等于74新全文；65声明source checks与51prep hash-only rechecks也不相加作语义覆盖。4087package inventory另为dated filesystem-only检查。

[QC](evidence/root-qc.md) 与 [聚合复核](evidence/review-aggregate.md) 记录最终计数和metadata修正：Root辅助manifest的一处EOF范围已改正，首份错误metadata逐字保留；没有产品重跑。Lab作者reported12个link与独立review当前13个link分别记录，最终verifier按实际文件重数。初始工作区改动只在incoming路径完全disjoint并有最终逐字节保全时FF；最终commit/stage/primary收据另存，不push，继续全仓审查。
