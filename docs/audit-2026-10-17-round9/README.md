# CodeShell 第九批审查记录

冻结源码：`248d091202869c07274adedf4fd50403105f1b1f`。本批从会话序列化、输入附件、工具目录检索与统计数据开展独立查重和验证，确认 **3 项 P3**，另保留 **1 个 API 契约候选**与 2 个未升级的附件静态观察。只记录，没有修产品；全仓持续审查仍未完成。

| ID | 问题 | 实际证据与影响范围 |
| --- | --- | --- |
| [ATT-R9-01](attachments.md) | 工作区路径含空格时，产物卡得到截断的错误路径 | 生产 detector + 自有临时文件；正确原路径仍在结果文本，生成器/UI/native 传播只静态追踪 |
| [COST-R9-01](usage.md) | 独立 CostTracker 丢失完整模型标识，累计与持久化采用错误估价 | 公共 standalone SDK + 冻结数据；绑定 UsageLedger 的正常对照正确，排除主流程账本和实际账单 |
| [SESSION-R9-01](session.md) | 超过工具调用上限后，持久化留未配对调用并阻断 full fork | 实际 Facade/TurnLoop/Transcript/SessionManager + fake client/executor；25 调用对照正常，排除 resume/send 必失败 |

[工具目录报告](tools.md)保留同名 definition-only 注册继续使用旧 executor 的候选。fake executor 能复现组合，但没有“省略 executor 必须清理旧实现”的明确替换契约，当前所读生产调用又显式传 executor，所以不计为确认。附件 Windows 兼容、目录深度与 truncated 标志也仅作静态观察。

**首次验证：9 个 clean guarded shards，123 pass、431 expect、0 fail、0 skipped；106 项既有 baseline + 17 项 focused observations/controls。** 所有首次合并 stdout/stderr 与退出码先保存再检查，没有失败的 Bun shard、产品修复或产品重跑。错误行为的 characterization 测试通过不代表产品已修复。查看[验证汇总](validation.json)、[正式缺陷](findings.json)、[候选与静态观察](candidates.json)、[冻结源码 SHA](source-manifest.json)、[全部材料索引](evidence-index.json)。

一次 root 猜测 renderer 源文件名失败，已保留[首次工具响应转录并跳过](evidence/root-navigation-skip.md)。静态旧路径、依赖预检、audit metadata 字段/文件名与来源行号纠正分别记在 [session lookup notes](evidence/session-candidates.json)、[tools preflight note](evidence/tools-preflight-note.md)、[root metadata note](evidence/root-metadata-note.md)与附件交叉复审；这些都不是失败产品测试，也没有用来恢复旧失败路线。

历史结构化去重覆盖 `docs/`、`bugs/` 的旧 audit/review/archive/_archive。root、附件、工具方向的全量 inventory 为 1,019 Markdown、471 parsed JSON（109,734 string leaves，0 parse errors）。Session 保存了 1000 个相关历史文件的 selected corpus，root 又对全量历史补做了[工具上限/持久化/fork 定向查重](evidence/root-session-dedup.json)。旧错误 flag、synthetic duplicate、CTX-1/CTX-2、Write heuristic、ArtifactTracker shell parser、重复 lookup 性能建议等分别排除；没有把关键词查重当作绝对语义穷尽证明。

四份独立只读交叉复审：[附件](evidence/cross-review-attachments.md)、[统计](evidence/cross-review-usage.md)、[工具候选](evidence/cross-review-tools.md)、[会话](evidence/cross-review-session.md)。复审没有新增测试；来源行号、标题精度与 metadata 校验字段的纠正均保留说明。

审查期间 main 前进至 `6e4b663dc0c6e538a8b754aa53874e4926134b80`，17 个变化路径属于其他任务的 Desktop 验收 harness/native transport、CI 与文档。已快进当前任务分支并静态核对本批直接缺陷源码未变，见 [main source review](evidence/main-source-review.json)。不以这些变化声称已执行原生验收。原先 CI 未提交修改已由其他任务提交，保存[初始快照](evidence/integration-before.json)与[最终整合前快照](evidence/integration-before-final.json)，保留当前主工作区删除项、全部 4 个原有未跟踪文件和其字节。

本批没有真实模型、付费 API、账号、用户数据、外部消息、原生应用/PTY、认证/权限/安全/custody/watchdog 实验，没有共享 dist/依赖重建或全仓 build/typecheck/lint/test 声明。另一个 `codeshell-panel-apps` 仓库没有在本批全量审查。
