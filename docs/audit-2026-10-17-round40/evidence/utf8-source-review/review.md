# UTF8-R34-C1 独立源码反证

建议仅为原候选补充阶段说明：**source-addressed at037 / runtime not revalidated**。当前选读源码直接处理旧项“live peek 消耗尚未完成的 UTF-8 尾部”条件；在有效逻辑流、字符边界起点且相关字节未被 ring 淘汰的范围内，未建立剩余同条件 ordinary gap。0 新 formal、0 新 candidate、0 新 related，不另建 ID，不改原 R34 分类。当前改动不是本 reviewer 实现；我在 R34 负责 memoize，非 UTF8-R34-C1 作者。

旧 [proposal](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round34/evidence/utf8-frontier/proposal.md) 与 [独立 review](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round34/evidence/utf8-review/review.md) 全文共 28 行保持其原边界：完整有效逻辑流的多字节字符跨 data event，peek 恰落在未完成处；旧小于等于 16 KiB 分支立即解码并推进全部当前 bytes。原项没有真实宿主 chunk/peek 时序观察，仍是候选；本次没有补运行证据。

[background-shell.ts:57](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/runtime/background-shell.ts:57) 的新 helper 在尾部最多回溯至 UTF-8 字符 lead。有效未完成字符只有 1–3 个已到达字节，available 小于 required 时返回该字符的开始位置；ASCII 或完整字符返回全长。无效、overlong、surrogate 与超范围前缀的前进分支有明确源码，不以任意无效 Buffer 构造本轮问题。此处是人工沿条件推理，没有执行任何字节样例。

同文件 509–535 的 running/starting 分支先计算该完整前缀，rawBuf 与 consumedBytes 都受此值限制，才解码并推进 cursor。因此旧项所需的“未完成尾立即解码且全推进”在当前链上不成立。[RingFile](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/runtime/ring-file.ts:96) 96–112 的 raw 拼接与 147–151 的 absolute slice 表明，在相关 bytes 保留时，下一次写入会与未消费尾拼接，同一 cursor 能再次取得它及后到 continuation。原 producer 358–372 仍把 data chunks 原样写 ring；没有把 port 检测的单独解码误当输出消费链。

完整前缀大于 16384 时仍走 [utf8SafeCutLength](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/runtime/utf8-cut.ts) 全文 21 行的原 safe cut：有效且从边界开始的输入，正 16384 cap 最多退回 3 bytes，不触发零切点 fallback，cursor 按实际 cut 前进。terminal/orphan 则有意消费 EOF；all snapshot 不推进 incremental cursor。[实际 BashOutput](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/tool-system/builtin/background-shell-tools.ts:25) 25–62 仍明确支持 STILL-RUNNING on-demand peek，默认 incremental 并直连 manager。没有只凭新增 helper/test 文件名认定处理完成。

这不是整个输出链的正确性结论。没有重开 ring wrap/eviction、stdout/stderr 交织、all snapshot surrogate 切片、旧 cleanOutput CRLF 或 D03 JSON-lines decoder 原因；不声称修复能恢复此前已被旧 reader 消耗的 bytes。当前测试源码未由我阅读或执行，作者的 334 行测试声明与 815 观察行不算我的覆盖，也不算运行 pass。

[source manifest](source-manifest.json) 的 6 个实际源/旧报告 rows 中，当前产品为 1 full + 3 selected，语义范围 256 行；435 行显示含相邻注释/import/native/身份分支，仅计已列的普通 byte/entry 范围。旧报告另 28 行全文；旧 source manifest 只 hash。所有 23 个初始 pins 在结束时 bytes/SHA 不变。[精确显示快照](source-excerpts.json) 保留这些范围，SHA 本身不代表其他内容已审。

[checks](checks.json) 核对作者 16 文件集合及 self-excluded 15 receipt rows。我的四个产品读前 filesystem SHA 与作者记录的固定 `037c2afbb05f2fcb3b2f3f3588be2b4a980032a1` Git blob bytes/SHA 一致；作者实际 7 条 Git 只读单独归属作者，我执行 Git 0 条。没有独立声称当前 HEAD，正式 round40 合包、baseline 与新历史差集留给 Root，future41 prep 口径不倒填。

作者历史 3509 文件、15/20/0 查询及 35 contexts 阅读只作为其 dated metadata；我没有重扫或借为自己的历史语义阅读。其包含冻结38、排39/40/41与单 release TODO byte drift 保持原时点，不改旧库存。0 产品 import/函数/helper/Buffer/语言 fixture/测试/真实流或输出文件/Bash/native/network/模型/权限身份实验；0 运行 passes/expectations，0 旧失败方向恢复。结束收据见 [reviewer receipt](reviewer-receipt.json)。

本 review 首次链接元数据检查把编辑器支持的 `:57` 行号后缀当物理文件名而 exit 1；[原诊断](link-check.first.exit.json) 保留。仅规范化链接后缀再核文档元数据，没有产品重试或扩大源码范围。
