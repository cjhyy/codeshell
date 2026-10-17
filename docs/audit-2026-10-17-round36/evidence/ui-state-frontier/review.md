# Future36 Toast 展示状态静态前置

本方向 **0 formal / 0 candidate / 0 new related**。仅写 exact `/tmp/codeshell-audit-round36-ui-state-frontier/`；不改仓库、不调用 Git。Parent 报告已冻 Round33 `40d79ff2190a98aa31067eb07006099c2726b21a`，这里只作上下文，不声称作者核过该 Git blob。formal baseline 尚未建立。所有产品、helper、测试、React/browser/DOM、timer/Promise 语言 fixture、clipboard/storage、native/network/model 调用与权限/身份实验为0。

先 rg 文件名库存，再写 [initial pins](initial-pins.json)，之后执行完整 [history gate](history.json)（[方法](history-method.py)）。`dialogState.ts` 当前2385B/78行 SHA `b7a6b81ccff93ebdd63bd96816373ead1d94d9bc793588312f492f31ac4c28f4` 与 Round28 `dialog-source-manifest.json .files[2]` 明确 full1–78 相同；本轮仅 hash-only 去重，不重新阅读 dialog 产品源码，也不扩大到审批/原生合同。Round28 coverage ranking 的 no-row 是较早选题索引；不能推翻随后全文记录。

`toastState.ts` 当前3442B/100行 SHA `27d4c0abe99db78f1968cae93fb67d644a9c003cf715078ca1cbc485a2f51e48`。本次 gate 找到旧库存、测试收据和设计 prose，没有本索引规则下明确 same-SHA full/selected row；这不证明历史未读。只沿普通 toast 数据和展示状态继续静态阅读。

[Source manifest](source-manifest.json) 保留各自 pin 时点、覆盖和结束 SHA：[consumer pins](consumer-pins.json)、[additional pins](additional-pins.json)、[display pins](display-pins.json)。本轮9份产品/测试源：toastState100、ToastProvider249、storage48全文；toast unit162、storage unit140全文；NotificationHistory1–108/150–193、ToolOutputBlock1–57、main69–89、interaction test230–257/278–297选段。合计627产品行+350测试声明行=977行。另读 R28旧 report17行；该 report 早于专用 pin 已在历史扫描中显示片段，故其 initialSemanticReadSha256 保留 null。4份 hash-only 是 dialog、两份此前已读指令和 R28 coverage manifest；不能计作本轮全文。定位 rg 的额外片段只作导航。14 pins 结束全部相同；[source excerpts](source-excerpts.txt) 在上述阅读后按相同 SHA 做元数据快照，不算第二次阅读。

普通合同未建立新反例：

- `addToast` 限定 active 最新4条、history最新100条，历史完整保留 message/detail；active 被 cap 或 dismiss 后，history 仍保留。`initialToastState` 恢复 history 不重播 active。这些差异有明确源码注释和 unit 声明支持。
- `dismissToast` 仅移除 active；markRead 只改 history read 字段；clearHistory 保留 active。NotificationHistory 真实消费同一 hook，读取/筛选/反转 history，并使用 markRead、clear。没有把这些有意区分报成丢失状态。
- Provider 的普通路径组成 Toast DTO，使用带 sequence 的 id 与 functional state updater。effect 源码清理不在 active 中的 timer，并对保留 active 建立 timer；popup 渲染 message，history context 传出同一 history。以上仅静态证据，不声称观察过 React、计时或焦点行为。interaction test 只读上述选段，未展开 fake clock 设置或运行任何 fixture。
- 普通 ToolOutputBlock copy-failure 分支传 message/error variant；main 普通 root 挂载 Provider。没有执行 copy 或确认宿主行为。storage 源码验证 DTO、保存/恢复最新100条；storage 不可用/满额如何实际表现未实验。
- 未找到真实普通调用者传负数/非有限 duration 或自行构造重复 id；不把任意异常 DTO 当新候选。sessionId 仅记录其普通数据携带，不验证会话路由、身份或权限机制。

历史快照保持原时点：3137文件=1321MD+1816JSON，递归 value scalar 含718308strings/1064468scalars，JSON key不搜，0 parse error。含已冻32/33，排 mutable34/future35/36；archive/_archive确切目录169，literal archive162，substring174。initial regex occurrences70/101/0，留60/60/0、cap60；[supplement](history-supplement.json) 复用完全相同库存，exact70/70和toast-contract36/36完整留存、cap100。所有3137原文件补查与结束 SHA 无漂移，不重写 dated 快照。regex总数和留存片段不代表历史语义穷尽。

旧 Pet 设计关于缺少 detail/sessionId 的描述已与当前 source 不同，不当当前缺陷。旧 TUI completion notification drain/requeue 与 native notification-click capability 记录属于不同 producer，未重报或恢复实验。旧 test receipt 路径不转换成当前通过数。完整记录见 [validation](validation.json)，元数据检查0失败。本 finite negative 只覆盖本次普通状态合同，不代表所有 toast/UI 或全仓无 bug。冻结 artifacts 见 [reviewer receipt](reviewer-receipt.json)。
