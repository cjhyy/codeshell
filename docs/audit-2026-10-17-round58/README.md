# 正式58：投递停机覆盖与传输、环境持久值复核

新增 **1项P2：CHAT-R58-01**，0活跃新候选、0新增关联。历史正式记录合计 **118项（45P2、73P3）**，不是当前未修复数。[完整列表](ALL-ISSUES.md)、[机器目录](recorded-findings-catalog.json)保留原117对象。

正常Node CLI在Mimi投递仍等待结果时收到SIGTERM/SIGINT，gateway仅等adapter/watch结束，queue.stop不等待已分离的consumer和它们后续写入，CLI便释放单实例锁。旧petChat/result请求没有接停机signal且保留自身timer，旧进程仍可继续。新CLI使用同配置获得租约并持久确认新消息后，旧consumer结算仍将它自己的pending/completed整快照rename到同inbox路径，撤回新进程已经写盘的新项。[正式条件、反证与范围](findings.json)。

影响必须限定：新进程内存里的消息仍在，之后的persist可修复；若在恢复写入前异常退出或崩溃，重启就不能从本地inbox恢复被移除项。外部平台是否重投未验证，不说每次交叠必丢，也不把at-least-once允许的重复投递单列bug。138与143同一候选CHAT-R138-C1由Root只晋升一次；144独立亲读旧因，未建立exact prior，不保证全史无同义记录。**仅静态确认，未运行进程、投递、模型或测试。**

Root141另一候选APPROVAL-R141-C1已撤回原“worker退出后无其它读取长期保留”的论证：142核实际Main正常初始化启动PetImDecisions，立即tick并每5000ms读alive/generation清cache。interval注册不是本轮观察到的严格5秒SLA；潜在短窗口/client旧卡未完成确定正常触发和立即一致性合同，不能强行改成新ID。141原候选冻结包保持原样，Root当前不计活跃候选。[Root决策](evidence/root-decision.json)。

| 有限包 | 实际范围与边界 |
| --- | --- |
| [138投递作者](evidence/delivery-queue/report.md) | reserve/persist/queued、正常sender、重试/stop及Gateway实际接线；作者保留候选，旧SWC/C8/CHAT-R11精确排除 |
| [143停机独立复核](evidence/delivery-shutdown-review/report.md) | 实际CLI lease、Node入口、Mimi请求、同路径新入队/ACK与快照persist，影响限定到磁盘窗口/修复前退出 |
| [144旧原因元数据](evidence/delivery-history/report.md) | 产品files为空；亲读C8/N22、SWC、CHAT-R11/archive旧因，不借词组检索证明全史无记录或产品正确 |
| [139 Relay](evidence/relay-stream/report.md) | 301产品/125声明/21文档行，byte65为旧R14全文重叠；control文本/data binary→Duplex/EOF，不认证完整握手/native网络 |
| [140环境持久值](evidence/web-storage/report.md) | 506产品/97声明，旧R5/R18full与W10 quota→secret旧因保留；80/128名称差异缺普通长名producer，不晋升 |
| [Root141配对/审批](evidence/root-pairing/report.md) | 540产品/149声明；默认TTL、同步commit/cache显式重置正常值链，候选经真实poll反证撤回，非全auth/custody认证 |
| [142独立审批](evidence/approval-replay-review/report.md) | 701产品语义，核Main→Pet周期read及必要snapshot/epoch/client消费；否定原前提，不认证全部时序/UI |

全部行数保留作者/独立/历史重叠，不累加为新增唯一覆盖。现有测试只是声明；本轮产品/helper/import/fixture/test/React/native/browser/worker/model/clock/business-network执行 **0**。57静态资源3pass不算本轮运行或投递问题验证。[验证](validation.json)、[Root复核](evidence/review-aggregate.md)。

[共享历史](evidence/root-pairing/history-batch.json)纳冻57排58+：5850 MD/JSON、4251467递归JSON value scalars、0parse错、archives参加、JSON keys不作值；10targets28–87均在100cap内保存。机器访问不是全史语义阅读。144另一次获准复合查询126contexts/24docs，cap300全保留，0parse/dated drift；有限词组/窗口漏检边界明确，0三词同窗不是新颖性证明。

七包149原件逐字节复制、291receipt/copy核验、21个report/manifest/receipt锚点；66唯一pins混合产品、测试、合同、历史元数据、指令及nav/hash，不是新增产品全文。[源清单](source-manifest.json)、[复制回执](evidence/prep-copy-receipt.json)、[索引](evidence-index.json)。Root初宽filename/hash和142/144宽导航截断不补未见内容；138口述CHAT-R11含义已按原件纠正为notification-progress首次load Promise，与永久Discord动态失败方向分开，首诊断原样保留。无产品失败重试。

全部源读者冻结后fetch/refresh；读取基线f31a847f45e4805bce34aeb9e6db7efb503cfcb0，集成前main 35565881e8422b1d001a31ac10730ca3866f5229。[并发路径](evidence/incoming-main-paths.json)、[历史漂移](evidence/incoming-history-drift.json)保留实际变化。仅owned58文档集成，主目录原改动字节保留，no push。

[原覆盖集合hash绑定](evidence/coverage-snapshot-current-binding.json)针对旧4643路径；304full/168selected/4171unknown仍未合并46–53 DEFERRED_UNPARSED及54–58增量。当前4644含旧57证据TS，本轮无新增TS。4339不能标full不是精确剩余数量；非TS/TSX和完整运行机制不在分母，全仓目标active尚未完成。
