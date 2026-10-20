# Core记账汇总普通数据链：Root74静态审读

有限结论为0正式问题、0候选、0新关联。当前完整阅读summary.ts81行，只审其内存聚合和成本展示；不代表记账存储、计费、provider、锁或真实账单被验证。旧R9同SHA仅声明selected/excerpt，因此可以补完整阅读，但不称从未读过或首次发现的未读frontier。

summary按provider/providerKind/model的JSON tuple分组，session按accountingSessionId、purpose按自身值分组。类型和实际store消费者只供应metadata，byModel/bySession/byPurpose在metadata后重新置空；正常输入下没有定位到字段覆盖或字符串分隔碰撞。缺usage与未知cost单独计数，formatUsageCost保留unknown和partial。not-sent路径明确设置0usage/0cost，不能仅凭它也参与requests就断言被当成未知扣费。既有unknown-price测试只是阅读声明，没有执行。

实际TUI App355–361把session summary交给formatter；/status691–697使用同formatter；/cost90–97调用绑定ledger的formatSummary，后者输出每模型breakdown。旧detail参数在绑定分支未单独选择legacy输出，但默认已有per-model breakdown，仅此不能证明用户数据丢失。CostTracker未绑定时完整模型标识估价的旧COST-R9-01是不同原因，保留原记录，不重报也不借旧runner当本次运行。

[source manifest](source-manifest.json)区分1产品全文、5产品选段、1选段测试声明、3未选产品hash及2指令carry-forward。相邻显示的API-key、subprocess、文件系统、身份字段和真实计费机制都不算语义认证；没有执行函数、pricing/store、fixture、React、clock/timer、CLI、测试、模型/native/业务网络。

fresh历史4492=1442MD+3050JSON、1953735strings/2921270scalars，含归档、JSON递归值不查键、纳冻48排49–74。实际阅读58个精确path对象的compact字段、summarySHA12窗口、函数1/known-cost4窄窗口和原COST一对象；宽path744/contract98、COST-ID64均有cap，不声称全历史语义穷尽或全部上下文已读。[gate](selection-decisions.json)记录image-history同SHA旧全文在正文前排除，其他两个未选候选本包body0。

初始与结束12源码/指令pins、4492历史字节全同。两次导航表述更正及实际只展示的相邻敏感机制见[metadata notes](metadata-notes.json)，原件保持；不是产品失败或测试重试。全局覆盖304/169/4170仍是dated45快照，本包不倒填总体计数。整体审查继续。
