# 历史候选原记录（不是已确认问题或当前未解决数）

正式根 candidates.json 共55份，42条出现，按原id去重42项；无id原记录0条。不重判当前状态、旧SKIP或是否已晋升。

| 原ID | 来源批次 | 原status | 原title/summary/hypothesis |
|---|---|---|---|
| S-C1 | R6 | static-candidate-SKIP | Skill frontmatter may terminate on embedded triple dashes |
| S-C2 | R6 | static-candidate-SKIP | CRLF agent-definition delimiter may fail parsing |
| PACKAGE-C1 | R6 | static-candidate-unvalidated | Watch test script differs from required guarded test entry |
| FILES-R7-02 | R7 | observed-behavior-contract-unproven | （原字段缺失） |
| PROV-R7-C1 | R7 | observed-fake-input-reachability-unproven | （原字段缺失） |
| PROV-R7-C2 | R7 | SKIP-after-first-fixture-assertion-failure | （原字段缺失） |
| TUI-C1 | R7 | source-only-SKIP | （原字段缺失） |
| TUI-C2 | R7 | source-only-SKIP | （原字段缺失） |
| Q-R8-C1 | R8 | source-candidate-SKIP-contract-unproven | （原字段缺失） |
| Q-R8-C2 | R8 | source-candidate-SKIP-control-not-established | （原字段缺失） |
| TOOLS-R9-C1 | R9 | unconfirmed-contract-gap | 同名 definition-only 注册仍保留前次实现 |
| RUN-R10-C1 | R10 | observed-heuristic-semantics-contract-unproven | 否定测试状态文本被关键词检查点标成 tests_passing |
| HOOK-R11-C1 | R11 | observed-candidate | Registering a higher-priority hook during emit duplicates an existing handler |
| CHAT-R11-C1 | R11 | static-unconfirmed-skipped | 通用 Markdown button URL/标签仅转义右方括号，普通括号或反斜杠是否破坏 labelled link |
| TUI-R12-C1 | R12 | （原字段缺失） | ANSI Parser 的组合重音 grapheme 宽度 metadata 错误 |
| DESKTOP-R12-C1 | R12 | （原字段缺失） | Write 工具卡把字符串长度标为字节 |
| HIST-R13-C1 | R13 | candidate | 同 tick 撤销清空 pending 后，自动 flush 标记不复位 |
| SEARCH-R13-C1 | R13 | candidate | Content-query readiness differs from Main's trimmed 2-128 length gate |
| GROUPS-R13-C1 | R13 | （原字段缺失） | 合法 header-only Delete 补丁可能不生成 Desktop 文件摘要 |
| GROUPS-R13-C2 | R13 | （原字段缺失） | 合法 V4A ++/-- 内容可能被当作 unified diff header 排除 |
| UTIL-R14-C1 | R14 | static-candidate-runtime-skipped | sliceAnsi uses UTF-16 indexes where ordinary consumers pass display columns |
| UTIL-R14-C2 | R14 | static-candidate-runtime-skipped | sliceAnsi stops before a trailing SGR reset even for an entire basic styled string |
| WEB-R14-C1 | R14 | candidate | Ordinary user XML can be mistaken for internal attachment plumbing |
| BYTES-R14-C1 | R14 | （原字段缺失） | JPEG SOF3 识别与全局 DQT 前提可能不一致 |
| DOCINPUT-R15-C1 | R15 | static-candidate-runtime-skipped | Two-byte PK / %P prefix classification may reject ordinary supported UTF-8 text |
| MIG-R15-C1 | R15 | observed-pure-candidate-contract-incomplete | Source .git normalization edge observations |
| STEER-R15-C1 | R15 | candidate-no-severity | Default steer id derived from current queue length can reuse a still-pending id after revocation |
| IMAGE-R15-C1 | R15 | candidate-no-severity | Equal opening/closing tag counts do not ensure all malformed inline-image markup is rejected |
| TAB-R16-C1 | R16 | candidate | TUI tab measurement uses relative column zero while static screen writer uses absolute origin |
| TAB-R16-C2 | R16 | candidate | SGR boundary inside a hand-built ZWJ cluster changes tab padding |
| TASKNOISE-R16-C1 | R16 | candidate | BOX_RE does not recognize project-defined dashed border glyphs |
| TASKNOISE-R16-C2 | R16 | candidate | ANSI noise stripping does not cover locally supported colon SGR and OSC |
| BIDI-R16-C1 | R16 | candidate | Hard-coded RTL fast filter excludes Adlam strong RTL letters |
| BIDI-R16-C2 | R16 | candidate | No mirroring step visible in object-only bidi permutation |
| CATALOG-R17-C1 | R17 | candidate | Panel catalog default omits Core first-connection fallback |
| CATALOG-R17-C2 | R17 | candidate | Panel catalog trim rewrites configured connection identity |
| MAPPERS-R17-C1 | R17 | candidate | Snapshot tool start uses a positional id while later real-id room result retains original toolId |
| UNREAD-R18-C1 | R18 | candidate | List refresh may clear an unread background session that the browser does not select |
| COMPOSE-R27-C1 | R27 | candidate-static-direction-skipped | Outer containment is insufficient proof that two successful edits touch the same location |
| SEARCH-R31-C1 | R31 | （原字段缺失） | Per-cell lowercasing loses Greek final-sigma context |
| UTF8-R34-C1 | R34 | static-candidate | Incremental background output can consume an unfinished UTF8 tail before its remaining bytes arrive |
| STATIC-R135-C1 | R57 | Candidate retained, not formal: handler404 reproduced for owned space-named file; current default product resource producer unestablished. | 移动静态资源未解码编码文件名 |

原对象、canonical路径与JSON pointer完整保存在 [candidate-history-list.json](candidate-history-list.json)。缺失字段保留null，不以推断内容补题目或状态。其它staticNotPromoted/alias数组单列，不混计上述候选。
