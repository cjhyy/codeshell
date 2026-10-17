# Round29 Root / runtime 独立静态复核

结论：支持两位作者在已声明范围内的 **0 formal / 0 candidate / 0 new-related**。没有发现需要修改冻结作者材料的元数据错误。本复核不新增产品结论，不把有限范围的 negative 扩大为整个 Core/Web、流协议或仓库无 bug。

复核对象为 [root-report.md](../root-report.md)、[runtime-report.md](../runtime-report.md) 及各自 source manifest、三类分类文件、validation、history decisions、作者 receipt；这些均是当前 Round29 文档，不能作为父级报告基线 `b3488ec155ecf0c3bb39f5e4d3cd21a783077ad0` 中已有的产品 source blob。Root 拥有 Git 绑定，本 reviewer 的 Git 命令数为 0。

本 reviewer 在独立复读前保存 16 个产品/test 文件的当前 filesystem SHA，复读 10 个全文、6 个 selected 文件，共 1966 行，finish/current SHA 全部一致；确切范围、首次 pin 时序与当前作者 artifact checks 分列在 [独立 source manifest](review-root-runtime-source-manifest.json)。这不重构作者最初的 pin，也不冒称复读完整 RunManager、preload、reducer、transcript 或移动客户端。一次工具输出截去了 replay test 的 43–60 行，已通过单独 1–80 行文本读取补足，才计入全文 229 行；没有运行 test。

Root 方向的决定性反证：

- [outputCoverage.ts](../../../packages/web/src/lib/outputCoverage.ts) 全文 168 行：copy 新建实例并逐项复制输入 Set；128 条/32 KiB 上限触发 discard 后维持 overflow/incomplete。cursor 观察不清除旧 blocked barrier。这里只认可显式边界存在，没有实验 cursor、身份或 journal 协议。
- [mobileOutputRecovery.ts](../../../packages/web/src/lib/mobileOutputRecovery.ts) 全文 161 行：页面先折叠进私有 chat candidate，取消与总页面预算有检查；完成前检查 snapshot/输入锚点，追赶 continuation 保留同一 candidate 和页面预算。history 投影后显式重置旧 liveness。selected [mobileOutputClient.ts:155](../../../packages/web/src/hooks/mobileOutputClient.ts#L155) 到 270 的实际消费在 current selection 与 pending input 锚点检查后才 commit，并分别处理 pending input、awaiting journal、catchup pending。这支持报告的有限 negative，不能证明整个恢复系统正确。
- [stream-envelope.ts](../../../packages/desktop/src/shared/stream-envelope.ts) 全文 22 行与 [parseStreamLine.ts](../../../packages/desktop/src/main/parseStreamLine.ts) 全文 63 行：payload 的 object/type 基础检查、legacy 无新造 seq、snapshot 的非空 session 与 identified steer 约束、live seq/epoch 附加逻辑可见；preload 235–310 的两个实际 stream listener 均调用同一 normalizer。没有将有效 DTO 上的字段宽容处理升级为新 bug。

runtime 方向的决定性反证：

- [RunQueue.ts](../../../packages/core/src/run/RunQueue.ts) 全文 101 行：pending array 与 Set 的 enqueue/cancel/shift 操作对应，active 单独去重；executor 位于 Promise 链内，finally 释放 slot。已有 test 对 concurrency 0 明确注明 never drains，不能重新包装为缺陷。
- [RunManager.ts:527](../../../packages/core/src/run/RunManager.ts#L527) selected startup 在等待 lock 后重读 queued/AbortSignal；315–366 的 cancel 路径触发 abort、移除 pending 并进入 cancelled；610–790 中 executor 返回后检查 aborted/当前 waiting/cancelled，evaluator 返回后再次检查 aborted 与 latest running 再做终态变更。本复核没有覆盖完整生命周期、锁协议、审批权限、真实取消、定时器或模型运行。
- [transcriptReplay.ts](../../../packages/web/src/lib/transcriptReplay.ts) 全文 207 行：tool preindex、start 幂等以及 result 早于 start 的补起点可见；replay 返回时显式 idle（保留 error）且清空 liveByAgent。selected transcript 530–635 提供普通消息/tool/subagent producer，reducer 578–632 保留 recorded 子代理语义，chat 36–74、96–126 的实际 caller 先读历史再消费 live/host running 标记。没有把历史回放当作当前运行权威。

作者覆盖与 provenance 检查：Root 9 pins / 1029 声明行 = 812 产品/test/consumer + 217 instruction；runtime 10 pins / 1685 声明行 = 1303 普通产品合同 + 217 instruction + 165 navigation-only。两个 manifest 的全部 19 行 source 记录均核过当前 bytes/SHA、全文/selected 边界与加总，不等于独立语义复读了这 19 行的所有范围。

Root 的 5 个产品/test pin 在语义读前采集；stream envelope、parse、preload 与 instruction 共 4 项 initial 为 null，保留 after-read first durable pin，未被本复核补成 before-read。runtime formal 的 10 项 source rows 与复制 prep 逐字段相同，formalization 的 new semantic reads 为 0；原 prep 的父级上下文 32c 与后来 Root 提供的 b348 区分保留。13 份 prep 拷贝仍与 exact owned /tmp 原件逐字相同，只作 provenance，不加第二份作者语义覆盖。

[Root receipt](root-artifact-receipt.json) 与 [runtime receipt](runtime-artifact-receipt.json) 各列出的 12 个冻结文件 bytes/SHA 全匹配；加各 receipt 的当前捕获及 13 个 prep copies，39 份 artifact checks 通过。两份报告当前 15 / 26 个本地链接存在。三类分类文件均为空数组，validation 与报告一致：Root 4+13、runtime 4+9，共 30 个既有 test 声明仅作源码阅读，执行数/通过数均为 0。

历史去重只做独立 stdlib 元数据重查，未执行任何作者脚本：docs/bugs 下排除当前 Round29，2765 文件（1275 MD、1490 JSON）、562917 string values、833428 scalar values、169 个 exact archive/_archive 目录路径、0 parse errors；两份 inventory 的路径/bytes/当前 SHA 全匹配。Root 三组 counts 267/381/53（cap100，保留100/100/53），runtime 四组 445/140/156/20（cap80，保留80/80/80/20）与独立正则计数一致。原 prep 的 2677 文件历史快照仍按其原始时点保留，未用新历史覆盖。关键词和截断 contexts 都不等于所有历史的语义读完。

旧 concurrency0、Phase1 无持久化/冷 queued 恢复边界、identified steer/seq 旧方向不重报。Round14 userMessageDisplay/XML 的失败 import 方向继续 SKIP；阅读现有 replay test 中的声明没有使该失败方向恢复验证，也没有新增 attachment/XML 覆盖。0 产品/import/函数/fixture/test/React/browser/AST/VM/native/network/model/Git 执行，0 作者 verifier 执行；只有本 reviewer 的文件、hash、JSON value、regex、范围和链接元数据检查。作者原有 metadata locator 诊断保持原样，不被当作产品故障或产品重试。
