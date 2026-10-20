# 第49批：普通汇总、preset、消息投影与旧覆盖门槛

本批 **0新增正式问题、0候选、0新增关联**。累计正式历史记录仍为 **112项：44P2、68P3**，不是当前未修复数。[全部112项列表](../audit-2026-10-17-round48/ALL-ISSUES.md)。整体审查继续，不能据此称仓库或任何完整机制已审完。

归档Core记账汇总、普通preset选择/编译数据、模型调用历史query/DTO和Web消息集合投影的有限静态审读。source manifest保留full/selected/nav/hash与测试声明区别，重叠阅读不相加为唯一覆盖。没有产品、helper、fixture、测试、React、clock/timer、模型、权限身份/租约/native或业务网络运行，pass/expect0；仅Root Git及证据元数据核验。

- [Root74汇总](evidence/root-summary-review/report.md)：summary.ts81行当前全文；普通tuple分组、unknown/not-sent/partial字段与真实/cost、/status、App展示链没有新反例。不认证账单、pricing/store/锁。
- [75模型历史](evidence/trace-history-frontier/report.md)：普通query校验、HTTP/公开Web DTO声明和真实Desktop列表消费者；底层排序/裁剪及scope/visibility机制未读，不作正确反证。
- [76 preset](evidence/preset-review/report.md)：普通选择、catalog/injection/prompt映射、compiler和实际Engine值调用。原R9同SHA readScope1–115与97行不一致，保持“可能旧已读到EOF”的歧义；本次定向选段，不称未读或首次全文。
- [83消息投影](evidence/latest-message-frontier/report.md)：正常immutable消息更新、scope切换和实际Workbench通知消费，有限0。hook173行全显示只97行普通语义，不标module全文；DOM、scroll、ResizeObserver、连接及房间鉴权未审。

另将/cost的一个待反证想法明确撤回：[Root80](evidence/root-cost-review/review.md)与[81独立复核](evidence/cost-review/report.md)均核实真实CLI→同进程AgentClient/Engine入口；repl215的sessionCostTracker就是全局costTracker，runtime54–60把同一对象绑定账本。不存在所假设的普通远程TUI空本地singleton前提。没有用任意SDK/providedClient造consumer，也不据此认证/cost所有行为。旧未绑定standalone估价问题COST-R9-01原样保留，不重报。

[71](evidence/title-gate/report.md)、[72](evidence/web-format-gate/report.md)、[73](evidence/model-display-gate/report.md)、[77](evidence/agent-definition-gate/report.md)、[79](evidence/session-usage-gate/report.md)在正文前排除同SHA旧full/complete主目标，产品新增语义0。[78独立metadata复核](evidence/complete-gate-review/report.md)仅支持R6两条reviewMode=complete及原报告的complete primary限定；不把规则扩到所有变体、不改旧索引或总体计数。旧S-C2失败shard/SKIP保留，不借旧部分pass当成功。

[82证据复核](evidence/packet-review/report.md)仅核九冻结包133项receipt-artifact、9receipts、79链接及声明范围；它与73/76作者重叠，不叫新独立源码复核。Root74非全文display union未由82解码重建，其限制保留。Root外层对13包逐字节收据和当前Git源绑定另核。

所有预备原4492历史时点（纳冻48）保持。主分支并发前进到9a2d118…；Root保持owned dc2b3d4…直到全部源读冻结，才合入7个路径。44个本批源码/指令pin与冻结字节一致；历史中仅release-real-operations MD改变，见[incoming drift](evidence/incoming-history-drift.json)。没有把新主分支字节倒填为旧读证据。

开分支脚本最后print误把main标签当baseline，实际CAS、plan及owned HEAD均是冻结dc2b；[澄清](evidence/branch-begin-output-clarification.json)保留原输出与实测。收据汇总初次因重复的zero-semantic gateDecisions被严格适配器拒绝；[首代码](evidence/assemble-first.py)/[首诊断](evidence/assemble-first.txt)保留，只在明确匹配hash-only行后分类为元数据，不是产品重试。各worker首诊断/截断原件也保持。

[源码清单](source-manifest.json)、[范围](coverage.json)、[验证](validation.json)、[索引](evidence-index.json)。最后总体覆盖仍为dated45快照：4643 TS/TSX中304full/169selected/4170unknown，4339不能标全文不等于未读数；46–49新读没有合入，不给百分比。原始编号摘录的尾空格按精确冻结文件/行保留，其余文件须普通空白检查；未修产品、未push，主目录原改动保留。
