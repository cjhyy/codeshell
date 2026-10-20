# 候选、重复与跳过

以下均不增加本批确认数；详细源码位置与原始观察保留在分报告。

| 条目 | 状态 | 依据 |
| --- | --- | --- |
| Arena reviewer cap | 首次fixture依赖registry实例不一致，Unknown provider；0pass/1fail、无Completed，尚无fakeLLM方法调用。原文件/日志保留，不修支架或换法重跑 | [Arena/Lab](arena-lab.md)，lab-offline-round2.test.ts/.raw.log |
| Arena planner fallback显式mode | 仅静态候选，异常分支可能忽略flags.mode，未验证 | [Arena/Lab](arena-lab.md) |
| Iterate parser形状稳健性 | 未建立可达完整反例；trigram近似误差属明示近似不报bug | [Arena/Lab](arena-lab.md) |
| Link字面%2F/%5C | 拒绝行为有观察，但有明确输入格式规则，缺支持该表示契约，按能力边界 | [Host/Link](host-link.md)，host-link-selection第二项 |
| Host caller-owned adapter引用 | 未发现正常生产调用方会后续突变，未做人为突变实验 | [Host/Link](host-link.md) |
| CDP字面+组合 | 旧07-08已确认，本批有再现但不新增 | [CDP/browser](cdp-browser.md)，geometry/keymap旧项测试 |
| CDP sided modifier、evaluate异常、iframe变换 | 语法承诺或正常端到端触发缺失，均仅候选 | [CDP/browser](cdp-browser.md) |
| Mobile legacy history metadata | 旧R84已确认附件/内部路径投影家族；本批不重复验证/计数；internal anchor额外显示影响仍候选 | [Root](root.md)，旧legacy-history-round24.md |
| 两路完整独立质量复核 | 审查代理服务容量中断，片段结论保留；没有两份最终quality文件，也未换模型重试 | [主审质量记录](quality-root.md) |

Root辅助只读检索的不存在旧路径（shared/transcript.ts、web/src/streamReducer.ts、renderer/messages/types.ts、model-traces/capture.ts等）已跳过；不是动态支架失败、不是产品缺陷。未继续先前被平台中止的认证/权限/原生/安全方向。

私有Arena不被Host加载，Lab默认flag-off，CDP是legacy compatibility SDK；这些明确边界不能被绿色离线测试扩大为默认产品行为。首次失败不等于候选成立，首次通过的错误现象断言也不等于产品已修复。
