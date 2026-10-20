本包保留 **0 正式项 / 1 候选 PET-R132-C1（P3静态提案）/ 0 新关联项**。候选是：正常定时续办把被reader过滤的合成消息ID用作话题边界，导致该边界相关段的自动journal小结/记忆提取被跳过。尚未运行产品或测试，作者计数不因后续Root决定倒写。

Root提供固定产品baseline1ba606416f4fc94c081159bb3fd10e58cd8d87f0；Git0。[初始pin](initial-pins.json)先于正文。原canonical [对象](prior-canonical-objects.json)与[MD限定](prior-md-selected.json)证明topic75行与closure纯函数曾全文读；topic当前SHA与原row一致。closure的同SHA原row在本次正文后作[补充metadata核对](prior-closure-canonical.json)，不伪称它早于本次阅读。所有旧读重叠保留，没有机械换叶或声称首次/新唯一覆盖。

正常事件线选择一段尚未闭合的活跃S0，已有至少3条有意义普通对话，auto-extract开启，lastInteraction=T0：

- T1距上次互动至少12h，合法未来resume follow-up到期，正常源会话空闲、无待决定事项，且不走paused-task直接resume分支。Host生成H=pet-followup-ID-revision，beginTurn关闭S0(endH)、打开S1(startH)。本run正常持久化H且injected:true；run settle后立即close S0，reader已过滤H，end找不到→null，小结/自动记忆提取不发生。
- T1后不足idle间隔的普通用户消息不会新开段，S1仍保留startH。到T2再次跨idle后，真实用户U开S2、关S1(startH,endU)，此时缺startH→null。S2后续有真实锚点可恢复，不能说所有journal永久失效。
- 更早已成功记录的段不回滚；正确锚定的旧段仍可成功。本事件线不假定更早pending closure的运行结果，也没有读或声称shutdown主动close；手动clear另有下一真实turn边界，不作为主触发证明。

[候选完整链/条件与反证](classification.json)和[精确源码摘录](candidate-evidence.json)给出全路径与hash。主要位置为：

- packages/desktop/src/main/pet/pet-follow-up-runtime.ts:67–101是真实resume→wakeFollowUp；pet-dispatch-service.ts:1178–1188生成chat/H，2217–2223无hostWake区别地beginTurn，2345–2348标injected，2372携同ID，2387–2394在run settle后调用收尾。
- packages/desktop/src/main/pet/pet-segment-controller.ts:191–245捕获旧段并保存新段boundary；pet-work-memory-store.ts:143–153/179–188保留整个segment对象。topic-segment.ts:75及Desktop main/index.ts:2629–2630实用12h默认。pet-registered-follow-up-store.ts:272–305的真实admission要求合法future wakeAt而无小于12h上限，coordinator:123–129/145–173按该时间调度并resume，并非手造无效DTO或时钟实验。
- packages/core/src/protocol/server.ts:1809–1821/1987–1999 → protocol/chat-session.ts:525–527 → engine/run-session-open.ts:178–180/215–217 → session/transcript.ts:562–567，将同injected/ID写入message.data。
- packages/desktop/src/main/pet/pet-segment-closure-service.ts:78–90过滤injected user；195–202定位失败直接return null，无fallback。packages/pet/src/segment-closure.ts:61–75缺任一边界ID就null。backfill仍使用存储的同一边界与reader，不能靠重启自动补成正常锚点。

影响只限上述journal/auto-memory提取。提醒-only、未跨idle、首次互动、blocked/running/external源、paused-task直接续办等不是同触发；独立span/context归档和原始消息并不据此判坏，也不声称实际UI帧、消息删除或权限越界。notify/bound路由本次跟到Host expiry/leave/health/delivery状态链，未另外建立问题；不拿domain DTO替代完整授权认证。

旧因必须保留：[旧计划866行](prior-plan-exact-locator.json)明确谈过closure跳injected，但说明的是独立span归档不受影响，不是本次follow-up成为topic边界后journal窗口null。自身两组只扫描精确匹配的12/16件旧MD/JSON递归值，14/32命中分别cap35/60；实际读[10个bounded窗口](focused-oldcause-actually-read.json)，不把compact定位或保存量说成穷读。[共享batch投影](shared-history-projection.json)纳已冻56排57+，5676件、4212456 value scalar机器访问，topic43命中全保存；这只是Root机器导航，不构成全旧因语义穷尽或新颖性保证。

[清单](source-manifest.json)记录3个纯函数文件full（598行，topic/closure旧full重叠）、17产品selected，共2152产品语义行，另3测试selected声明74行；body2680、含导航2860。2个Core文件只导航无正文语义。测试没有执行；机制源码静态阅读不等于真实FS/lease/模型/权限正确性认证。

[diagnostics](diagnostics.json)记录0fatal metadata错误/0工具截断；main里按wakeFollowUp字面导航exit1的空结果随后沿实际factory找到，非产品失败。首次focused locator的.test.ts/log仅文件名，真正scanner只读MD/JSON值。[结束hash](ending-checks.json)27源/指令pin、33旧canonical/限定查询文档及共享JSON自身均同；未冒称独立复核全部5676集合。[验证口径](validation.json)产品/helper/import/fixture/tests、真实会话/模型/clock/native/network与Git均0。只写exact目录，没有修产品。[收据](reviewer-receipt.json)排除自身。
