# CodeShell 第二十批审查

冻结点 `d40dd06987a2e0c20c377e243cf5c4e4b549c9ec`。本批 **0 新确认、0 新候选、1 处旧机制关联**；四组首次 guarded shards 共 **46 pass / 127 expect / 0 fail / 0 skip**，7 个既有测试加 39 个 focused。只记录，没有产品修改，不据零项宣称全仓或这些子系统无 bug。

| 分区 | 新确认 / 候选 / related | 首次 tests / expect | 报告 |
| --- | --- | --- | --- |
| CLI 正整数 | 0 / 0 / 0 | 13 / 36 | [positiveint](positiveint.md) |
| 工具摘要 | 0 / 0 / 1 | 14 / 42 | [toolsummary](toolsummary.md) |
| TUI StreamAttempt | 0 / 0 / 0 | 12 / 28 | [streamattempt](streamattempt.md) |
| 媒体类型标签 | 0 / 0 / 0 | 7 / 21 | [mediaKind](media-kind.md) |

`TOOLSUMMARY-R20-R1`：工具摘要 catch 对捕获值直接读取 `.message`；手工 callback 拒绝为 null/undefined 时，实际 leaf 再次抛 TypeError。普通 Error 对照返回 null。May30 已有同类非 Error catch 机制；这里未建立普通 provider 产生该值的证据，下游 catch 也仅静态阅读，因此只记关联，没有新增严重级别或运行失败/进程崩溃结论。此处 logger 按精确模块路径预导入替换为内存 warn spy，callback 也为自有替身；其余 helper 真实运行。

其他分区补查普通数值 grammar/wrapper/error class、回撤 ID/数组及 child 过滤、MIME/短文件名分类。两个既有 baseline 分别在 round15/round7 已运行，本批如实算作 existing；没有把重复控制称为新复现。真实 CLI、App/renderer、Engine/TurnLoop/provider、日志文件、网络/媒体字节/下载/发送没有运行。

所有 first combined raw 与 exit 都先保存再检查；无失败 Bun shard、修复、重试或替代验证。导航猜测、历史输出截断、读取上界 metadata 修订有单独记录。旧 CLI data、JSON summary repair、TUI Diff/Question、recorder、MIME 冲突/Unicode 名称/alias 大小及 authority 等方向继续排除。详见 [coverage](coverage.md)、[validation](validation.json)、[分类](findings.json)、[关联](related.json)、[源码清单](source-manifest.json)、[证据索引](evidence-index.json)。

全历史索引扫描 prior docs/bugs（含 archives、排除本批）**2,109 文件 = 1,176 MD + 933 JSON，267,491 string leaves / 373,239 scalar leaves，0 parse errors**。计数、匹配和 capped 上下文分开；这是读取时的库存，关键词不是语义穷尽证明。宽泛 extension/MIME 模式中的无关规划命中也有说明。

结束前已刷新 origin；合并前 main 仍为冻结点，没有外部新增提交。原有删除和四个未跟踪文件的 status/字节 hash 与初始快照相同，只允许本批 docs disjoint fast-forward，见 [integration plan](evidence/integration-plan.json)。没有 push、build/typecheck/lint/full suite/E2E，保留独占工作树继续全仓审查。
