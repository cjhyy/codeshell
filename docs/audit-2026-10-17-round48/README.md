# 第48批：前台计时与普通数据链，全部问题目录

新增 **1项P3：TUI-R48-01**。旧后台任务仍在运行时用户提交新前台请求；若最后一个后台在此前台结束前完成，且UI提交并flush该状态，App会重写仍在用的runStartRef。状态栏elapsed与最终turn_duration都漏掉重置前的耗时。两个消费者同一根因，只计一次；STATUSLINE-R64-C1为同项预备alias，0新增候选/关联。

[完整112项列表](ALL-ISSUES.md)含所有正式历史记录及原报告链接，机器目录为[recorded-findings-catalog.json](recorded-findings-catalog.json)。总计 **112=44P2+68P3**，不是当前未修复数量，原111行保持原始状态。正式44记录的3项源码处理、WEB-R8-01旧并发处理注记均保留“运行未复验”的边界。

[正式问题](findings.json)、[64作者](evidence/elapsed-frontier/report.md)、[67独立定向复核](evidence/elapsed-review/review.md)、[Root66源码闭环](evidence/root-elapsed-review/review.md)。67实际核读普通提交入口、后台terminal通知与两个计时消费者，明确未语义读Engine消费顺序；Root另核turn-loop/run-tooling以及Engine交互返回/仅headless等待的小段，补足“旧bg跨前一前台返回”的实现链，不倒填67范围。两者均已知假设而非盲审。没有真实UI帧、计时跳变、模型、clock/timer或测试运行。

反例保留：新前台开始本就应重置；其他bg仍running使bool不变；中间变化未commit、前台先结束或结算先于effect，都不建立此触发。初次spawn的yield在整批工具后消费，不能泛称每次launch都会有中间帧。修正方向见正式记录；本批只写证据，不改产品。

另归档Core记账上下文作者/独立源码阅读、Chat适配器普通字段映射和Server会话标题普通DTO链，均有限0新增问题；计费/持久锁/身份/权限/native/外部SDK机制均未展开或运行。完整范围、同SHA指纹和display/selected/nav/test-declaration区分见[Root汇总](evidence/review-aggregate.md)与[源码清单](source-manifest.json)，不合计重叠阅读为新增唯一覆盖。

最后可复算覆盖快照仍截至冻结45：**4643个TS/TSX中304全文、169仅选段、4170索引不能确认；4339不能标全文，不等于未读或剩余bug数。** 46–48新增阅读没有倒填该快照，非TS/TSX和完整机制也不在分母。见[正式47覆盖复核](../audit-2026-10-17-round47/README.md)。因此无法给出可靠的整个仓库剩余工作量或审查百分比。

预备61–65历史gate为4255份（纳冻46），Root66/peer67为4336份（纳冻47）；各自时间点和首次诊断保持，机器关键词/指纹不等于全历史语义穷尽。68/69/70仅目录或证据元数据，不新增产品正文审读；69与61/65作者重叠，不能叫新独立源码复核。

冻结64的source-excerpts.txt有原始带行号空行尾空格，逐字节保留；只对这一精确冻结产物限定空白豁免，全部新文档/其余文件仍需普通空白检查。产品/helper/fixture/测试/React/计时/模型/native/业务网络执行0，pass/expect0；Root Git和元数据核验另列。未push，原主工作区改动保留，整体审查继续。
