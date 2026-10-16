# CodeShell 审查记录（2026-10-17 checkpoint）

本轮从当前冻结源码重新建立证据，确认 **26 项：11 P2、15 P3**。只记录问题，未修改产品代码。完整问题索引见 [findings.json](findings.json)，逐项触发、预期/实际、影响和证据边界见下表分报告。

冻结基线：`ab8b03f86ad38835939d4125b56bf4513cae7f15`。任务分支：`codex/audit/remaining-20261017`。独立 worktree 中审查，主目录既有改动不参与本任务；没有推送或发布。旧 [2026-10-16 审查](../audit-2026-10-16/README.md) 保持冻结，新旧问题不能直接相加为当前仍存在数。本轮有限查重未发现与旧确认项相同实现/根因的条目，不能宣称穷尽历史记录。

| 编号 | 优先级 | 问题 | 详细报告 |
| --- | --- | --- | --- |
| R2-01 | P2 | Claude 项目编码碰撞导致会话归属错误 | [root.md](root.md) |
| R2-02 | P2 | Codex 列表选新 rollout，历史定位选旧文件 | [root.md](root.md) |
| R2-03 | P3 | Markdown 导出围栏被工具正文提前闭合 | [root.md](root.md) |
| R2-04 | P3 | Claude null 记录中止该会话健康历史 | [root.md](root.md) |
| R2-05 | P3 | 复制为纯文本会修改 fenced code 正文 | [root.md](root.md) |
| R2-06 | P3 | TUI 将 fenced 表格示例当成真实表格 | [root.md](root.md) |
| R2-07 | P3 | TUI 转义管道符导致表格错列并隐藏后列 | [root.md](root.md) |
| R2-08 | P3 | Codex patch rename 变更归属遗漏新路径 | [root.md](root.md) |
| R2-09 | P2 | Review 将 hunk 正文误判为文件头并丢失改动 | [root.md](root.md) |
| R2-10 | P3 | Review 纯重命名丢失两个文件路径 | [root.md](root.md) |
| R2-11 | P2 | Review 未解码 Git quoted 中文路径 | [root.md](root.md) |
| S01 | P2 | Office 关系路径拼接静默遗漏 sheet/slide | [sources.md](sources.md) |
| S02 | P3 | Office 写死 r:id 前缀导致标签和顺序错误 | [sources.md](sources.md) |
| S03 | P2 | ReadSource 单文件查询脱敏破坏已序列化 JSON | [sources.md](sources.md) |
| OM1 | P2 | 全局记忆 ADD 按名称覆盖项目另一条 dream | [operations-memory.md](operations-memory.md) |
| OM3 | P3 | Session summary 对有效时区时间按字符串排序 | [operations-memory.md](operations-memory.md) |
| OM4 | P3 | 并行工具进度复制另一工具的开始时间 | [operations-memory.md](operations-memory.md) |
| OM5 | P2 | 不同自然项目路径共用持久 memory 根 | [operations-memory.md](operations-memory.md) |
| UI-01 | P3 | 多行本地评论显示截断并误分类续行 | [desktop-data.md](desktop-data.md) |
| UI-02 | P2 | Web/Mobile 对 cwd 转小写合并不同项目 | [desktop-data.md](desktop-data.md) |
| UI-03 | P2 | 历史尾窗口选择新任务却匹配旧 raw turn | [desktop-data.md](desktop-data.md) |
| PET-01 | P3 | Pet JSON 原文预筛漏掉引号代码和反斜杠路径 | [pet-data.md](pet-data.md) |
| TIME1 | P3 | Cron 多余分隔符被截断且 update 接受错误计划 | [scheduling-data.md](scheduling-data.md) |
| TIME2 | P3 | CronCreate 的 Host 钟面时间贴上 job 时区 | [scheduling-data.md](scheduling-data.md) |
| CHD01 | P2 | Slack thread 身份丢失使回复落到频道顶层 | [chat-data.md](chat-data.md) |
| CHD02 | P3 | 长附件标签截断拆开 Unicode 代理对 | [chat-data.md](chat-data.md) |

验证收据：[validation.json](validation.json)。34 个完整成功 guarded shard，实际 **227 pass / 777 expect**；另有 26 个过滤测试。共享收据只计一次，候选和正常对照不是额外 bug；断言错误现象的测试通过也不代表产品已修复。

**3 组首次失败实验独立保留，均未修支架重跑。** OM3 的排序观察来自其中一组的首项通过与明确源码契约，整组仍失败、无 Completed；摘要 JSON 两个临时编号和 Discord 长回复线索不计确认。其余候选、只读检索缺口和已知边界见 [候选与跳过账本](candidates-and-skips.md)。

独立只读交叉复核：[Root/OM/UI/Pet](evidence/quality-ui-review.md)、[Sources/UI/失败收据](evidence/quality-ops-review.md)、[最终时区/Chat/汇总](evidence/quality-final-review.md)。这些复核没有新增动态测试，不可计作第二次独立复现。

[覆盖范围](coverage.md)、[源码哈希](source-manifest.json)、[证据哈希](evidence-index.json)、[仓库清单](inventory.json)。所有关键发现区分纯函数、真实 reader/renderer/handler 和静态调用链；未执行真实平台发送、付费模型、用户真实数据操作或完整 Electron/跨平台验收。

材料检查：源码/证据 SHA、问题行号、唯一编号与本地 Markdown 链接核对通过。原始 Bun 失败日志中一行诊断自带尾空格，完整 diff --check 因此有一条例外，保留原始字节；排除原始日志后的材料空白检查通过。被 .gitignore 忽略的42份日志已在本审查目录显式纳入版本控制。

这是持续审查的一个可复核 checkpoint，**并非全仓逐行审查或全部行为覆盖完成**。原目标仍在进行；本轮未重验旧 25 项是否已修复，也未覆盖独立 `codeshell-panel-apps` 仓库全部业务。
