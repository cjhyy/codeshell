# ToolCardShell 独立静态源码复核

有限结论：**0新增 formal / 0 candidate / 0新增 related**。这是新的独立源码阅读：结论形成前没有收到作者54发现，也没有读取其报告、manifest或excerpts；先前53外观审查角色不作为ToolCard依据。只核普通标题、摘要、状态与展开数据链，没有执行产品、工具、helper、测试或UI。

读前pin `ToolCardShell.tsx`133行/5192B，SHA `4a8597d1e9f055fc855f9b4a601da7e0289df3102a8309ab598e12ccb716f3ea`。fresh gate含冻结44、排45–55：**4088=1410MD+2678JSON，1631727strings/2469249scalars，169 exact archive/_archive，0parse**。MD与递归JSON value scalars参与，keys不当值。8个原始metadata对象为库存/排名/incidental claims，没有建立同SHA旧full证据；计划里的“替换整个文件”不是已完成的审查。no-row/无full不等于历史未读，因此可进入本次有限source read。

- `types.ts:18`的六种ToolStatus在Shell57–66全部有映射：queued→idle、running→running、succeeded→ok、failed/denied→err、cancelled→warn。StatusDot完整22行消费同一个token，同时保留原status作title。普通tool_use_start1377–1393、result1488–1501更新running/failed/succeeded与duration，没有从任意坏status或NaN手造反例。
- Shell97–102按message.toolName和独立summary prop显示标题；121–126把可选message.summary与details放在展开内容，116的preview另行保留。ToolMessage.summary有string声明；当前选读的targeted tool_summary1524–1526/1545–1552保留普通指定tool对应摘要。没有把旧legacy无ID摘要归属问题或helper截断另报新项。
- 真实fallback是`index.tsx:131–149`→GenericToolCard94–103→Shell。它传递同一message、summary/details和turnEpoch；Generic的details本来就是React node，不能仅靠手造空参数推出正常卡丢详情。index使用default memo，turnEpoch仍在普通props中。媒体、附件、sandbox/DriveAgent动作与特殊工具实现只显示或止于边界。
- Shell40–56保持默认折叠、运行过本epoch标记与epoch切换折叠；89–92只在hasDetails时切换，详情ID持续配对。2个既有static-render声明与shared disclosure中3个ToolCard相关声明表达“历史手动打开保持、自身run结束后折一次、无epoch保持”的意图，未运行、未观察真实UI时序。未把未挂载的group-only分支或所有specialized卡行为说成已审验。

Generic117–128的truncate consumer对应旧 **DESKTOP-R12-01** UTF-16摘要截断家族，当前只作旧因排除，不新计related，也没打开/运行truncate实现或恢复旧实验。formatDuration只静态选读65–72，没有调用。不存在用旧pass证明当前代码正确的结论。

[source manifest](source-manifest.json) 的8个语义rows为3全文/5选段：**403语义行=303产品+100测试，672显示行**。Shell133、StatusDot22及静态测试35为全文；Generic/types/dispatcher/helper/shared测试为明确selected，邻接媒体、sandbox、agent/legacy路径不纳机制语义。2个instruction哈希另列；10个source/instruction结束SHA全同。 [source excerpts](source-excerpts.json)是读后同SHA快照，不额外算阅读；exact display wall-clock未单独采集而为null，tool chunks与读前pin时点保留。

[history](history.json) 的path25/filename26/SHA7，普通contract218/cap100/retained100和old-failed19均保留。宽contexts打印曾被预算截断，不宣称读完85个尝试显示或全部218；[diagnostics](metadata-diagnostics.json)保留原exit0与边界。可选ToolCard.tsx猜路径不存在，实际index另pin；不是产品失败。 [ending checks](ending-checks.json)核原4088集合/字节无漂移。Root后来报告ec1 docs-only formal45只是外部上下文，原0b baseline与排45的4088时点不倒改，Git0。

分类和限制见 [classification](classification.json)、[history decisions](history-decisions.json)、[validation](validation.json)。没有全组件/全仓无bug、运行通过、真实滚动/点击或修复确认声明。只写本exact tmp，冻结清单见 [reviewer receipt](reviewer-receipt.json)。
