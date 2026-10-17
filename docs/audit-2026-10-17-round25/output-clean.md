# Output cleanup：CRLF 正文丢失

冻结提交 `8b9677c78d150abe9681a2f65ab8e55b1288be4b`，分支 `codex/audit/crlf-output-round25-20261017`。登记 **1 个正式 P2 / 0 候选 / 0 related**，分类见 [findings](evidence/output-findings.json)、[candidates](evidence/output-candidates.json)、[related](evidence/output-related.json)。产品未修改。

**OUTPUT-R25-01 — CRLF 完成行被误当成进度重绘，返回文本丢失正文。** [foldProgressLines](../../packages/core/src/runtime/output-clean.ts:32) 先按 LF 分段，再取每段最后一个 CR 后的文字。普通 `ready\r\n` 的分段为 `ready\r`，因此 [最后 CR 的切片](../../packages/core/src/runtime/output-clean.ts:36) 返回空串，再拼回 LF；实际 `cleanOutput` 结果只有 `"\n"`。清洗合同承诺移除 ANSI／过期进度帧后提供输出，普通已完成行的可见正文应保留。字符化使用 `"ready\n"` 表达可见正文预期，没有要求字节完全保留 CRLF。

普通 producer 接线已静态建立：[onData](../../packages/core/src/runtime/background-shell.ts:328) 把原 stdout/stderr Buffer 写入 ring；[RingFile.write](../../packages/core/src/runtime/ring-file.ts:96) 保留 Buffer，[readAll](../../packages/core/src/runtime/ring-file.ts:120) 只做 UTF-8 解码，[sliceFromAbsolute](../../packages/core/src/runtime/ring-file.ts:147) 返回 raw subarray，没有先归一化 CRLF。[all 模式](../../packages/core/src/runtime/background-shell.ts:461) 与 [incremental 模式](../../packages/core/src/runtime/background-shell.ts:499) 均调用真实 cleanOutput；[BashOutput 描述与工具体](../../packages/core/src/tool-system/builtin/background-shell-tools.ts:25) 读取该结果并返回 header/body。因此普通短 CRLF 输出可在 agent-facing 正文中变成空行。incremental 的 raw offset 在清洗前推进是静态源码事实，本轮没有运行 manager 来验证后续读取。剩余 LF 长度大于零，不能断言工具必然返回 `(no new output)`。

只有一次授权的 guarded 首跑：

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/runtime/output-clean.test.ts docs/audit-2026-10-17-round25/evidence/output-crlf.test.ts
```

[静态 preflight](evidence/output-preflight.json) 核冻结字节和零 runtime import 的实际叶子；[focused fixture](evidence/output-crlf.test.ts) 只直接导入此叶子及 `bun:test`，没有复写消费者或 mock。首份合并 stdout/stderr 与 exit 先落盘，后读取：[完整 raw](evidence/output-first.raw.log)、[exit](evidence/output-first.exit.json)、[wrapper](evidence/output-run-first.py)。结果 **exit 0 / Completed / 13 pass / 23 expect / 0 fail / 0 skipped**：7 既有叶子测试 + 6 focused，其中 4 项断言并打印当前错误结果、2 项普通控制。4 个字符化共用同一原因，只计一个问题。通过代表成功锁定当前错误行为，**不是已修复**。详见 [validation](evidence/output-validation.json)。

| 短输入（转义显示） | 可见文本预期 | 实际 cleanOutput | 证据性质 |
| --- | --- | --- | --- |
| `ready\r\n` | `ready\n` | `\n` | 当前错误字符化 |
| `ready\r\nnext\r\n` | `ready\nnext\n` | `\n\n` | 同因果、多行 |
| `first\nsecond\r\nlast` | `first\nsecond\nlast` | `first\n\nlast` | 同因果、混合行尾 |
| `10%\r100%\r\nready\r\n` | `100%\nready\n` | `\n\n` | 同因果、最后进度帧 |
| `ready\nnext\n` | 原样 | 原样 | LF 控制 |
| `10%\r100%\nready` | `100%\nready` | `100%\nready` | 裸 CR 重绘控制 |

raw 为 2477 bytes，SHA256 `3756561600256bdbd45f529d4a6b0d0936c1e6fb49710c36a79a08e6d02c80d0`，保持首份原样，0 重跑。现有 7 项 [测试全文](../../packages/core/src/runtime/output-clean.test.ts:1) 包含原有有界 ANSI 控制，这些通过不扩展成 ANSI／OSC／Unicode 正确性结论。新 fixture 只有普通短 ASCII CRLF、LF、裸 CR。

反证收窄影响：[源码合同](../../packages/core/src/runtime/output-clean.ts:12) 与 [设计](../superpowers/specs/2026-06-05-background-shell-design.md:125) 区分 raw retained output 与 agent-facing cleanup；[disk mirror](../../packages/core/src/runtime/ring-file.ts:170) 写的是原 Buffer，且为 best effort。因此本项不是磁盘正文损坏，也不声称落盘总会成功。没有 import、构造或运行 RingFile／BackgroundShellManager／BashOutput／Engine；没有真实后台进程、PTY、Windows、网络、模型、会话／权限／身份／custody 或实际日志文件实验。guarded Node/Bun 支撑进程是唯一测试运行；没有 VM／AST／eval、压力测试、cap／wrap／分片扩展或恢复旧失败方向。

[去重脚本](evidence/output-dedup.py) 更新扫描全部递归 docs/bugs MD 与 JSON 标量，包含 archives，排除 round25：2453 文件（1234 MD + 1219 JSON）、405166 string leaves / 575356 scalar leaves、0 JSON parse error；177 exact / 16 newline-mechanism matches，全部上下文保存在 [去重证据](evidence/output-dedup.json)。[逐项历史判断](evidence/output-history-decisions.json) 保留旧 frontmatter、LF patch、simplediff、NDJSON、largeburst pagination、ANSI、memory-sort、format 边界；它们是不同原因或已记录／失败方向，不新增 related，也未重跑。关键词命中和选段审查不是语义穷尽证明。

[来源清单](evidence/output-source-manifest.json) 固定 7 pins：6 个产品／合同来源共实际阅读 550 行（leaf 45、既有 test 34、ring-file 188 全文；manager 172、tool 79、设计 32 选段），另 CODESHELL 指令全文。每项列出 full/selected、行界、current/frozen SHA256 与 Git frozen blob。复制的 [prep](evidence/data-prep/proposal.json) 9 文件保持原样；其中 11 pins 本轮仅 hash 重核，不算 11 次新全文阅读。

唯一额外失败是静态导航 `rg` 的 literal LF regex exit 2，首响应的人工转录／退出码单独保留在 [metadata first responses](evidence/output-metadata-first-responses.json)，与产品首跑分离。随后直接静态全文读 RingFile，没有产品修复／重试／替代验证。prep 自身旧 metadata 失败也仍原样保留；详见 [metadata notes](evidence/output-metadata-notes.json)。[metadata check](evidence/output-metadata-check.json) 与 [author receipt](evidence/output-artifact-receipt.json) 核本作者 18 artifacts（另 receipt 自身排除）、raw、pins 和 31 个本地链接；并行审查者的两份 output-static 文件单独归属，未纳入作者 receipt。作者 0 产品改动、0 Git 写；主审单独负责记录集成。
