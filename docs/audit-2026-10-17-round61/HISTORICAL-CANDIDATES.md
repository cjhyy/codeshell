# 42条历史候选记录

这些记录包含未证实、SKIP与后来可能已处理的方向；不是42条已确认bug，也不认证当前仍未解决。原对象完整保留在[机器目录](historical-candidates.json)。本次仅元数据汇总，不重新运行失败方向。

| ID | 历史候选 | 原状态 |
| --- | --- | --- |
| [RUN-R10-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round10/candidates.json) | 否定测试状态文本被关键词检查点标成 tests_passing | observed-heuristic-semantics-contract-unproven |
| [HOOK-R11-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round11/candidates.json) | Registering a higher-priority hook during emit duplicates an existing handler | observed-candidate |
| [CHAT-R11-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round11/candidates.json) | 通用 Markdown button URL/标签仅转义右方括号，普通括号或反斜杠是否破坏 labelled link | static-unconfirmed-skipped |
| [TUI-R12-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round12/candidates.json) | ANSI Parser 的组合重音 grapheme 宽度 metadata 错误 | 原对象未设status |
| [DESKTOP-R12-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round12/candidates.json) | Write 工具卡把字符串长度标为字节 | 原对象未设status |
| [HIST-R13-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round13/candidates.json) | 同 tick 撤销清空 pending 后，自动 flush 标记不复位 | candidate |
| [SEARCH-R13-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round13/candidates.json) | Content-query readiness differs from Main's trimmed 2-128 length gate | candidate |
| [GROUPS-R13-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round13/candidates.json) | 合法 header-only Delete 补丁可能不生成 Desktop 文件摘要 | 原对象未设status |
| [GROUPS-R13-C2](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round13/candidates.json) | 合法 V4A ++/-- 内容可能被当作 unified diff header 排除 | 原对象未设status |
| [UTIL-R14-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round14/candidates.json) | sliceAnsi uses UTF-16 indexes where ordinary consumers pass display columns | static-candidate-runtime-skipped |
| [UTIL-R14-C2](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round14/candidates.json) | sliceAnsi stops before a trailing SGR reset even for an entire basic styled string | static-candidate-runtime-skipped |
| [WEB-R14-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round14/candidates.json) | Ordinary user XML can be mistaken for internal attachment plumbing | candidate |
| [BYTES-R14-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round14/candidates.json) | JPEG SOF3 识别与全局 DQT 前提可能不一致 | 原对象未设status |
| [DOCINPUT-R15-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round15/candidates.json) | Two-byte PK / %P prefix classification may reject ordinary supported UTF-8 text | static-candidate-runtime-skipped |
| [MIG-R15-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round15/candidates.json) | Source .git normalization edge observations | observed-pure-candidate-contract-incomplete |
| [STEER-R15-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round15/candidates.json) | Default steer id derived from current queue length can reuse a still-pending id after revocation | candidate-no-severity |
| [IMAGE-R15-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round15/candidates.json) | Equal opening/closing tag counts do not ensure all malformed inline-image markup is rejected | candidate-no-severity |
| [TAB-R16-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round16/candidates.json) | TUI tab measurement uses relative column zero while static screen writer uses absolute origin | candidate |
| [TAB-R16-C2](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round16/candidates.json) | SGR boundary inside a hand-built ZWJ cluster changes tab padding | candidate |
| [TASKNOISE-R16-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round16/candidates.json) | BOX_RE does not recognize project-defined dashed border glyphs | candidate |
| [TASKNOISE-R16-C2](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round16/candidates.json) | ANSI noise stripping does not cover locally supported colon SGR and OSC | candidate |
| [BIDI-R16-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round16/candidates.json) | Hard-coded RTL fast filter excludes Adlam strong RTL letters | candidate |
| [BIDI-R16-C2](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round16/candidates.json) | No mirroring step visible in object-only bidi permutation | candidate |
| [CATALOG-R17-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round17/candidates.json) | Panel catalog default omits Core first-connection fallback | candidate |
| [CATALOG-R17-C2](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round17/candidates.json) | Panel catalog trim rewrites configured connection identity | candidate |
| [MAPPERS-R17-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round17/candidates.json) | Snapshot tool start uses a positional id while later real-id room result retains original toolId | candidate |
| [UNREAD-R18-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round18/candidates.json) | List refresh may clear an unread background session that the browser does not select | candidate |
| [COMPOSE-R27-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round27/candidates.json) | Outer containment is insufficient proof that two successful edits touch the same location | candidate-static-direction-skipped |
| [SEARCH-R31-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round31/candidates.json) | Per-cell lowercasing loses Greek final-sigma context | 原对象未设status |
| [UTF8-R34-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round34/candidates.json) | Incremental background output can consume an unfinished UTF8 tail before its remaining bytes arrive | static-candidate |
| [STATIC-R135-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round57/candidates.json) | 移动静态资源未解码编码文件名 | Candidate retained, not formal: handler404 reproduced for owned space-named file; current default product resource producer unestablished. |
| [S-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round6/candidates.json) | Skill frontmatter may terminate on embedded triple dashes | static-candidate-SKIP |
| [S-C2](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round6/candidates.json) | CRLF agent-definition delimiter may fail parsing | static-candidate-SKIP |
| [PACKAGE-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round6/candidates.json) | Watch test script differs from required guarded test entry | static-candidate-unvalidated |
| [FILES-R7-02](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round7/candidates.json) | Returned subset is sorted; no explicit global-newest-200 contract found. Downgraded after review, not counted. | observed-behavior-contract-unproven |
| [PROV-R7-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round7/candidates.json) | Late identity fake reproduces behavior, but no valid normal producer/protocol ordering proof; final TurnLoop also backfills start. Not counted. | observed-fake-input-reachability-unproven |
| [PROV-R7-C2](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round7/candidates.json) | Thinking roundtrip first shard fails due to unaccounted automatic cache_control. Partial observations are not confirmation; no repair/retry/alternate validation. | SKIP-after-first-fixture-assertion-failure |
| [TUI-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round7/candidates.json) | Diff classification fixture import over-traverses path. No product assertion executed; no repair/retry/alternate validation. | source-only-SKIP |
| [TUI-C2](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round7/candidates.json) | Same failed Diff fixture; terminal-column padding prediction has no successful renderer/width observation. | source-only-SKIP |
| [Q-R8-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round8/candidates.json) | Mobile fixture import failed; hosts may ignore additive hints, no explicit Mobile multiSelect acceptance contract established. | source-candidate-SKIP-contract-unproven |
| [Q-R8-C2](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round8/candidates.json) | Batched and flushed TUI fixture cases both failed; no batch-specific observed defect. No timing repair/retry/alternate validation. | source-candidate-SKIP-control-not-established |
| [TOOLS-R9-C1](/Users/admin/Documents/个人学习/代码学习/codeshell/docs/audit-2026-10-17-round9/candidates.json) | 同名 definition-only 注册仍保留前次实现 | unconfirmed-contract-gap |
