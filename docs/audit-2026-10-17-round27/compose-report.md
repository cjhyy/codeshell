# Round27：编辑片段合并静态审查

冻结基线由 Root 提供：`9b667863e8a8eb91db7b1f99eb9876169dcf19ec`。本方向 **0 正式发现、1 静态候选、0 新关联**。本作者只做源码和历史文档读取、JSON/hash 元数据检查；0 产品执行、0 import、0 测试、0 fixture、0 Git。Root 的首次验证失败另列，不能记为本作者通过的基线。

## COMPOSE-R27-C1：外层文本包含不能证明两次编辑位于同一位置

[可疑分支](../../packages/desktop/src/renderer/diff/composeFileEdits.ts:139) 用 `uniqueIndex(edit.oldText, snippet.newText)` 检查“之前的 after 片段在后来 old 片段中只出现一次”，随后把之前 old 片段嵌回后来 old 片段，形成一个推定的 before。这个局部唯一性不证明之前的 after 在整个文件中唯一，也不证明两次操作触及同一位置。

正常的短输入即可落入该分支，以下均为**静态源码推导，未实际执行**：

```text
初始文件：
before();
// later
shared();

Edit 1：before(); → shared();
Edit 2：// later\nshared(); → // later\nfinal();

按原始位置应用后的文件：
shared();
// later
final();
```

[真实 Edit 合同](../../packages/core/src/tool-system/builtin/edit.ts:19) 只要求 `old_string` 唯一，并建议用一两行上下文。实现 [82–94](../../packages/core/src/tool-system/builtin/edit.ts:82) 检查当前文件中 old 的首末索引；没有要求 new 唯一或禁止 new 复制文件里已有文本。第一次 old 只有一处；第一次成功后 `shared();` 有两处，但第二次带 `// later` 的两行 old 仍只有一处。因此这不是一个依赖歧义 old_string 被工具错误放行的输入。

合并器静态走向是：第一次保存 `before(); → shared();`；第二次的两行 old 不在这个单行 after 内，外层检查却发现 after 在后来 old 内唯一，重建成 `// later\nbefore(); → // later\nfinal();`。该 before 上下文从未在上述位置存在，并漏掉首处仍然存在的 `+shared();`；片段预览计数推为 `+1/-1`，两处正常替换原本应保留 `+2/-2`。这不是从实测 Git diff 推导行数。

生产接线明确：[aggregator](../../packages/desktop/src/renderer/messages/fileChangeAggregator.ts:155) 只收集 succeeded，保留 old/new 原始参数并将其转成 edit operations；[375–395](../../packages/desktop/src/renderer/messages/fileChangeAggregator.ts:375) 用合并结果覆盖 added/removed 和 sessionDiffs。[类型合同](../../packages/desktop/src/renderer/types.ts:290) 将其作为累计文件预览，[摘要消息](../../packages/desktop/src/renderer/types.ts:629) 计算总数；[FilesChangedCard](../../packages/desktop/src/renderer/messages/FilesChangedCard.tsx:83) 再从 sessionDiffs 构建审查快照。这些消费者只做静态接线核对，没有实际卡片、模型审查、文件修改或持久化实验。此 helper 不改写原始工具消息或磁盘文件，不声称源码数据丢失。

反证与边界同样保留：同一组参数也可来自初始 `// later\nbefore();`，此时确实是同一位置先变 shared、再变 final，外层扩展正确；已有 [57–69 测试声明](../../packages/desktop/src/renderer/diff/composeFileEdits.test.ts:57) 覆盖这种正例。Write 的 fullContent 禁止外层扩展，replace_all / opaque 阻断 replay，多次匹配会保留独立 hunk，inner replay 也不在本候选范围。源码明确片段行号是 synthetic 坐标；本项针对遗漏独立内容，不把该坐标声明本身当 bug。后续若单独重开验证，应要求真正的位置证据，或保守保留不能证明连续的操作；本轮没有实施修复。

## 首次验证失败：整个方向 SKIP

Root 保存了 [原始合并输出](evidence/root-containment-first.raw.log)（2272B，SHA `3419b38917c264fa865bcca06aa7160da25216f1b056c713ceb57a42f6a33a48`）和 [exit 收据](evidence/root-containment-first.exit.json)，随后才读取。Root 自有 fixture 的相对导入层级写错，先于三个聚焦测试体加载失败。这是测试夹具定位错误，不能报告成产品缺少模块。

同一个 failed shard 的已有 compose 测试实际报告 **16 pass / 54 expect / 1 fail / 1 error**；无 guarded `Completed`。三个聚焦测试和 owned exact-replacement model 均未执行，预定 console JSON 也没有产生，不能把 fixture 中的断言或本报告源码推导写成 observed 输出。按约定保留原 fixture、0 修复、0 重跑、0 替代执行；整个方向 SKIP，故候选不升级为正式发现。参见 [作者验证账本](evidence/compose-validation.json)。

## 范围、历史与副本

[源码清单](evidence/compose-source-manifest.json) 包含 7 pins：compose245、已有测试203、真实 Edit139、aggregator396 全文；Card70–140 和 types280–322/620–645 选段，共 **1123 行产品/合同**，另 CODESHELL217 行。完整 SHA 仅证明字节，没有把消费者其余范围算成已读。原中断任务的 20 项 inventory 保留原时点和 after-read 标记，不冒称 20 份源码全文已审。作者未执行 Git；Root 负责将文件 SHA 绑定冻结 Git blob。

[当前历史检索](evidence/compose-dedup.json) 扫描 docs/bugs 全部 MD 与递归 JSON value scalars，含 archive/_archive：**2596 = 1250 MD + 1346 JSON，468104 string / 676635 scalar，169 archive paths，0 parse error**。名称匹配5、聚合/快照匹配148、外层证明定向0、旧边界242；保留上下文分别5/148/0/160。名称命中只是旧检索模式和 Round26 并行主线文件库存，没有找到同因果的既有发现；关键词与有限上下文不证明语义穷尽。对照上一份 prep supplement 逐文件 hash 无漂移。

已全文核对 [R13 父报告](../audit-2026-10-17-round13/groups.md) 和 [旧执行账本](../audit-2026-10-17-round13/evidence/groups-validation.json)：Delete header、V4A 正负前缀、Move 与旧 parser 家族保持原 candidate/related/SKIP 边界，不重新计数或执行。旧 countLines 尾换行问题亦不复报。详见 [历史判断](evidence/compose-history-decisions.json)。

中断任务的4份 prep 文件逐字复制到 `evidence/compose-prep/`，原始路径/时间/计数不变；[副本收据](evidence/compose-prep-copy-receipt.json) 分别记 bytes/SHA，不将其当成产品运行日志或新的全文审查。[元数据说明](evidence/compose-metadata-notes.json) 记录输出截断后的补读和中断接续来源。
