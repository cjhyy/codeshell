# 候选、跳过与已知边界账本

本页不产生额外确认数。候选已在各分报告保留源码位置与观察；没有把失败支架当产品缺陷。

| 方向 | 状态与原因 | 证据/详细记录 |
| --- | --- | --- |
| 摘要 JSON 多围栏 / 尾逗号修复 | 首次实验读取参数错误，正常对照也失败；不确认服务影响，不修参数或换法重试。临时 R2-12/13 未分配正式编号 | [Root 候选区](root.md)、root-summary-json.test.ts/.log，1 pass/2 fail/6 expect，无 Completed |
| 同名 memory TTL / pending/global 搬移 | 首次三个案例依赖错误枚举假设，未建立目标触发；保留源码候选，不重试 | [OM 候选区](operations-memory.md)、ops-memory-data-round1.test.ts/.log，1 pass/3 fail；仅首项 OM3 窄观察确认 |
| Discord 长回复 editReply 覆盖 | 顶层 discord.js import 失败，未进入生产断言；静态候选，不移除 import/补依赖/改路径重跑 | [Chat 候选区](chat-data.md)、chat-discord-chunks.test.ts/.log，0 pass/1 fail/1 error，无 Completed |
| Pending 记忆保留旧快照 | 有真实本地动态观察，但可能有意保留最初待审版本；缺明确同步最新契约，OM2 降候选 | [OM2](operations-memory.md)、ops-memory-promotion-round2 第二项 |
| Han/Latin/数字邻接检索 | Redis/2026/OAuth2 无空格假阴性观察成立，但词法产品约定未定，不计确认 | [Sources 候选区](sources.md)、sources-search.test.ts/.log |
| XLSX 注音混入正文 | 东京+注音观察成立；是否应纳入可搜索内容未定，不计确认 | [Sources 候选区](sources.md)、sources-parse 第五项 |
| Codex apply_patch JSON arguments | 变换观察成立，但当前真实 writer 参数形状未证明；只记候选 | [Root 候选区](root.md)、root-changed-file-paths 第三项 |
| engine/query consumer break | 没有 finally/cancel 的静态线索；未发现生产 import/export 消费者，未运行 | [Root 候选区](root.md)、[Sources 移交](sources.md) |
| Review 单一大文件保护 | capFiles 明确保留首文件全部行，可能不能限制单文件超过阈值的渲染；尚未核对性能/设计取舍，不计确认 | [Root 候选区](root.md)、UnifiedDiffViewer.tsx:236-245 |
| WhatsApp 消息类型长度 | 通用 chunk 与 caption/interactive 的平台限制可能不同；缺官方上限合约，未执行/不确认 | [Chat 候选区](chat-data.md) |
| cold queued recover | SDK start 正常；Phase1 无持久队列、recover 明确只扫 running，属于已声明边界 | [OM 已验证边界](operations-memory.md)、ops-progress-recovery-round3 第二项 |
| Sleep abort acknowledgement | 首次 fake timer 复核成立，但旧报告已明确记录；不计新增，不声称任务继续执行 | [Scheduling 已知边界](scheduling-data.md)、time-sleep-data-round2 |
| 文档旧 chunk / Unicode 重建 | 真实本地 worker 的正常控制通过，旧 hash 拒绝与新版引用正确；没有新增问题 | [Sources 收束](sources.md)、sources-local-document |
| 先前平台中止的动态方向 | 不继续、也不变换方式重试；上一轮证据/缺口保持冻结 | [旧候选账本](../audit-2026-10-16/candidates.md) |

辅助只读命令的不存在路径、未匹配 shell glob、官方 PackagePart 文档不可达均已在对应报告记录并跳过，不作为产品问题证据。Bun 的失败组原文件和首跑 stdout/stderr 原样保留；完整门禁统计只取 Completed 的零失败组。
