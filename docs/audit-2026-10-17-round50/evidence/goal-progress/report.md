# Root91：工具回合中目标“再续”动作丢失

提出1条P3静态发现 GOAL-R91-C1，拟在正式50单次登记DESKTOP-R50-01；待独立92复核后才晋升，不是两个bug。[提案](proposal.json)列精确条件、反例和限制。

实际值流：turn-loop454–477发approaching_limit，1054–1056/1559–1562为正常运行调用；types1774–1818保存marker。普通下一次主模型stream_request_start在1258–1275建立未完成assistant和streamingAssistantId；App907–911可令liveTurnActive=true，经App2580/ChatView1801到MessageStream432。fresh user的turnTiming没有完成标记，不能用旧快照assistant.done兼容分支反驳。

同一未完成用户回合已含一个普通可见、非bookkeeping工具时，streamGroups413–509在live情况下innerEnd=end，把该marker放进过程分组。MessageStream451–461未把onExtendGoal传给分组，TurnProcessGroupCard190–191裸渲GoalProgressView；后者77只有onExtend存在才渲再续区域，因此用户正在等待下一次模型流时缺少该入口。flat分支MessageStream597实际有callback，构成范围反例：无工具回合、非live时lastTool之后的尾部不应算同一触发；不声称所有帧或其他Goal控制入口都不可用。

最初考虑clicked先显示已续的失败反馈线索。虽然当前useRunController1116–1126只void调用并log失败，preload返回Promise且server2231–2294有真实无active-run错误合同，本稿没有建立另一条普通失败UI表现，故不晋升、不计第二项，也未制造任意reject/SDK入口或时序。

Gate：自有fresh4693文件（1457MD、3236JSON，recursive value scalars）纳49排50+，path12/SHA5，6exact对象只库存/派生，未建目标sameSHA old-full。宽goal cause962/cap60首次输出截断，不称所有context已读；后续extend focus30/cap100仅6窗口实际语义阅读（其余仅定位），group/callback focus0，原库存4693初末字节一致。旧July测试缺口与B2 marker-pruning先因不同，不拿旧pass证明现状。查询范围不等于全历史不存在的证明。

目标leaf130行全文静态阅读，其他消费者选段；[manifest](source-manifest.json)逐项区分范围、[初始pin](selection-initial-pins.json)、[实际分组源码](group-source-excerpts.json)、[完成判定](group-source-supplement.json)、[普通主请求](stream-request-source-excerpts.json)、[live入口](live-producer-source-excerpts.json)、[leaf源码](goal-source-excerpts.json)与[旧cause](group-cause-history.json)。邻接identity/auth/Host/native/bridge机制仅边界不认证。真实浏览器、React、布局、clock/timer、产品/helper/fixture/测试、网络与模型运行均0；没有修产品。首metadata截断与误猜路径[诊断](metadata-diagnostics.json)保存；[结束核对](ending-checks.json)、[验证](validation.json)、[冻结回执](reviewer-receipt.json)。
