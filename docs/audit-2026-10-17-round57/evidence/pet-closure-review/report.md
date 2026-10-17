# Pet followup 与话题关闭：独立静态反证复核

支持作者单一 **PET-R132-C1 / P3 静态候选**，本包 **0 formal / 1 同项 candidate / 0 new related**。Root拟归为PET-R57-01时仍只计一项；本包不预先倒写正式结论。产品、helper、测试、模型、真实会话/文件、网络、Git执行均0。

正常事件线为已有活跃S0（至少3条有意义普通对话、尚未journal、自动提取开启），合法future resume到期，Mimi本身idle≥12h，来源会话idle且无pending/task直接resume拦截。真实host register允许该时间；wake生成稳定H，把它交给beginTurn，关闭S0(endH)并保存S1(startH)。同run经实际worker/protocol/Engine把H与injected:true写入transcript.data；settle后马上closeS0。默认reader过滤H，exact ID查不到end，close在提取前return null。T2不足idle不会换掉H；T2再跨idle的真实U开S2时，S1的startH仍找不到。S2以后可恢复，不能说整个journal永久失效。 [精确链/条件](classification.json)、[源码范围](source-manifest.json)、[已显示摘录](source-excerpts.txt)保留具体行。

关键反证已核：first interaction/未过idle不新开；不存在/external/pending/running来源和paused-task直接resume不走本触发；正常load/persist保留边界ID，backfill复用同reader/边界，无重定位fallback。Main真实接线没有替代readMessages。reader也会接收assistant行ID，因此另独立核普通assistant写入：Engine→wireRunModelFacade→同transcript的ModelFacade→TurnLoop实际call/callWithoutStreaming→recordResponse→appendMessage不传clientMessageId；通用append也仅存入传入data、不补run ID。流事件envelope关联ID与这里的持久data字段不能混用。该必要补读晚于一次初步source-ended通报，before pins与时序如实保存；此后不再扩源。

影响限上述关闭段未进入journal/auto-memory提取；不保证原本一定产生某条memory，不推原始消息丢失、独立span/context归档失败、权限或shutdown关闭行为。所有native/FS/scheduler/model机制仅静态边界，未实际验证。

旧canonical [输入](prior-metadata-inputs.json)亲读docs/audit-2026-10-17/pet-data.md21–24、R10pet26–28及files0/1同SHA，证明纯函数曾全文审过，本次是具体新问题定向重叠，不称首次/新full；原对象是在叶子正文后核，不倒填门槛。旧计划866明确提过injected/closure skip，但指独立span archive不受影响，不能当journal定位补救，也不能说全史没提。此包不重扫全史，Root/132的历史工作不冒充独立复核。 [作者冻结输入](author-freeze-inputs.json)仅在132终态后读取报告作差异核对，额外assistant证据只计136。

范围为21产品selected 1103行，3个既有测试声明selected 111行（执行0），合计1214；产品/测试display union 2262，另CODESHELL指令217行。未读follow-up-service仅hash。范围/导航/旧重叠不升级全局覆盖。 [diagnostics](diagnostics.json)保存首次库存exit2和一次正常空匹配exit1，不假造原raw；[ending](ending.json)27源/指令pin与8个限定元数据输入SHA均同。见 [自排除收据](artifact-receipt.json)。
