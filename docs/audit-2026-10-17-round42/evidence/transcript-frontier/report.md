# Future44 — background transcript tombstone consumer

作者记录 **0 新 formal / 1 source-only proposal `TRANSCRIPT-R44-C1`（P3）/ 0 新 related**。实际后台子代理的流式回退会撤销 partial assistant 内容，但 [translator](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/tool-system/builtin/agent-transcript-translator.ts:163) 把 tombstone 当作普通封口，保留该行。实际 TUI 后台详情消费这些行，因此可继续显示本应撤销的 partial 文本。Root 拟正式归为同一项 `TRANSCRIPT-R42-01`；别名与正式项只能计一次，作者 proposal 与 Root 最终分类分开。未运行产品、模型、事件 fixture 或 UI。

普通条件为：后台子代理正常输出了至少一段 text delta，随后一次可恢复的非 abort streaming failure 进入内置非流式 fallback，用户查看仍活跃的子代理详情。人工沿源码推导：partial delta 建立 bg-counter assistant 行；tombstone 仅把 streaming 改 false 并清本地指针；重开的 stream_request_start/text_delta 会另建 replacement 行。旧 partial 行没有被删除，也未被 replacement 覆盖。这是实际 producer 条件下的静态路径推理，没有手喂任意 StreamEvent 或执行语言样例。

[TurnLoop](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/engine/turn-loop.ts:2103) 2103–2115/2197–2228 明确先 revokePartialStream，再调用 fallback，随后为成功 replacement 发相同 messageId 的 start 与 text delta；1119–1141 是普通循环的实际调用点。后台 [agent.ts](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/tool-system/builtin/agent.ts:507) 517–520/580 的 detailSink 先喂 translator；runSubAgent 将它作为 streamOverride 交 spawner。subagent-spawner85–112 的 wrapper 只滤 usage_update/session_started/context_compact，tombstone 保留加 agentId，376/414–426 传给子执行。Engine2637–2645 的默认 childRunner 实际 new Engine().run(childOptions)，3546 把 onStream 送进普通 TurnLoop，未建立子代理绕过该 producer 的反证。

Translator 全195行没有 assistant_message case，最终消息落入 default；164–174 的 tombstone 分支仅 finalize，未使用 event.messageId。registry append/touch 保存这些实际行并通知 observer，所读 completeTerminal/markFinished 终态写入只更新状态、时间和控制/progress元数据，没有 replacement transcript 清理。这里只评普通数据效果，不评 lease、identity 或授权机制。

当前 [ui/App](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/ui/App.tsx:2145) 2145–2169 在 agent view 直接取 registry transcript 传给 VirtualMessageList；app-helpers232–246 为 assistant_text 渲染对应 text，列表按 entries 的行和 id 渲染，没有把旧 partial 当 tombstone 再处理。AgentDock 本身只是列表，不被误认成内容 consumer。静态入口也已核：tui package bin→cli/main 默认/repl→replCommand→ui/index.startInkRepl→这个 ui/App；REPL 的257–281创建 in-process transport/server/client，registry不是跨 worker 的空表。公共 tui/index 只导 VERSION 与真实 CLI bin 是不同入口。

影响仅限后台子代理详情保留已撤销文字，尤其 fallback 等待或后续工作仍在继续时。没有实际 UI 帧/时序观察，不声称每次 fallback 都触发、不声称成功后 Dock 一定继续可见，也不声称原始/持久 session transcript 损坏。初看同名并发工具可能互清运行标记，但普通 producer 在1668 drain整批后才发结果，这个初猜撤回，不另报工具问题。

历史 gate 先排两个旧全文目标：codex-parse137行当前 SHA 在 R23 有 explicit full1–137；web/lib/format140行当前 SHA 的 R20 root-source-manifest.scope 写明 Full static module。旧 ranking 对后者显示 pin-only 不可当未审证据，本次直接读该 scope 后排除，未打开两者产品正文。最终选择 translator195行，读前 pin 后在同3696库存重新查 selected-path84 /selected-SHA1（cap100均保留）；唯一显式当前SHA行是 R28 package inventory，没有在此 bounded gate 建立 current-SHA full-semantic receipt，不称历史从未读过。旧 loadedWorkspaceModules/native-failed 路径只是元数据，旧失败方向始终 skip。

新全历史 [inventory/method](history.json) 纳冻结40，排41/42/43/44，含 archive/_archive：3696=1379 MD+2317 JSON，1130742 JSON strings/1704078 scalar leaves，169 exact archive paths，0 parse错误。MD全文与所有递归JSON value scalars参与初查，keys不作文本匹配。之后 [same-cause gate](cause-history.json) 在相同库存对MD按段/JSON值查询，16/3/23命中均未达80cap；只将实际读取的21个 bounded windows与旧F01直接8行算阅读，不把42 retained、巨JSON scalar或全部84路径命中当语义穷尽。

[旧 F-01](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/archive/review-2026-07-09/03-optimization-findings.md:20)20–27 针对 desktop freshId 与 core turn_N 不对应、最终 assistant_message 又只封口；位置/影响面明确 desktop MessageStream。当前 producer 已使用 stable messageId 并为 replacement 补发 delta，而当前 TUI translator 是另一条真实 consumer，完全忽略该 revocation语义，仍需独立修改 leaf。保留同族关系，不重报旧 desktop ID/补偿问题。Root 另读的 F01 intro与R20报告不借为作者自己的全文覆盖；本文自己的精确旧因边界与所读窗口见 [decisions](decisions.json)。

[source manifest](source-manifest.json) 有16个实际语义 rows：15个当前产品/入口路径749行 +旧F01报告8行=757；1791行显示含相邻 native/model/权限/identity代码，只有列出普通范围算语义。另2 navigation-only与2 old-full hash-only分列，测试源码阅读0、运行0。peer和Root重复阅读不相加为新独有覆盖。读前 pins与结束时20个源/元数据路径全同，3696历史集合/bytes全不变，见 [finish checks](finish-checks.json)。后续 formal41切换/正式42意图仅为Root时点信息，不回写原冻结40 history或假称本 reviewer读过Git HEAD。

0 产品 import/函数/helper、Buffer/事件/语言/timer/Promise fixture、测试、真实流/输出文件、Bash/CLI/进程/native/模型/网络/React/browser/DOM/身份权限实验，Git0，repo写入0，只本tmp。唯一诊断是猜错 `packages/cli/src` 的 rg locator exit2，已在 [metadata notes](metadata-notes.json) 保存并用真实库存定位 TUI CLI；它不是 CLI/产品运行失败。分类见 [proposal](classification.json)，终态材料见 [artifact receipt](artifact-receipt.json)。
