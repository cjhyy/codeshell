# Session Fork 与上下文迁移技术方案

### 1. 现状分析

- Core session 是 `~/.code-shell/sessions/<sessionId>/` 下的一组 `state.json` 与 `transcript.jsonl`；`SessionManager.create()` 先落盘两者，`resume()` 再恢复 `SessionState + Transcript`。
- `state.json` 保存 `cwd/model/provider/status/usage/parentSessionId/origin`，并以 `workspace` 指向 main 或 worktree；`cwd` 仍是主根目录，续跑优先采用 `workspace.root`。
- transcript 是追加式事件日志，不等同于 LLM 消息；`Transcript.toMessages()` 才把 `message/tool_result/summary` 投影为模型历史，其他 UI/审计事件不进入上下文。
- Renderer 另有 `bucket = <repoKey>::<uiSessionId>` 作为 UI 路由键；`SessionSummary.engineSessionId` 才是 core sessionId。localStorage transcript 只是最多 500 条的显示投影，不能作为 fork 的权威源。
- 当前 quick-chat 在面板挂载时生成 `qchat-*` 与独立 `__quick_chat__::*` bucket；第一次发送直接调用 `agent/run`，Engine 发现该 id 不存在后执行 `create()`，所以天然是空会话。
- quick-chat 的 claim/cleanup 已能在关 tab 时关闭 worker session、删除磁盘目录并清附件；缺口只是“创建时从哪个 source session 初始化”，不是独立运行或清理能力。
- 当前分支没有独立的 `Engine.init()` 或 `packages/core/src/engine/run/` 目录；初始化分布在 Engine constructor 与每次 `run()`。`run()` 已有正确注入口：目标 session 存在时 `resume()`，随后 `transcript.toMessages()`，再追加本次 user message。
- Core 已有未公开、除测试外无调用的 `SessionManager.fork()`：按 turn 复制事件并写 `parentSessionId`，但它会复制旧 `session_meta`，未复制 `workspace`，默认 fork 点错误依赖“单次 run turnCount”，也会把用户 fork 误标成 sub-agent。
- Engine factory 会按目标 cwd 重读项目设置；desktop 每次 run 又携带 permission/model key，所以同 cwd 的 preset、MCP、个性化配置可重建，model/permission 的当前 UI override 需要显式复制到新 bucket。
- worktree 已是 session workspace 指针，不必新建 worktree；把 source `workspace` 深拷贝给 target 即可复用同一路径。现有 worktree owner 检查能阻止一个 session 删除仍被另一个 session 使用的 worktree。
- cc-room/external-agent 采用“外部 session/thread id + cwd/worktree 绑定 + 独立 room 消息日志”的方式恢复和隔离；可借鉴显式 lineage/绑定，但其 JSONL 格式不是 core Transcript，不能直接挂给 CodeShell Engine。
- `/compact` 的 `ContextManager.forceSummarize()` 会清理旧 tool result、调用主模型生成结构化摘要并保留近期消息；`buildSummarizationPrompt()` 可作为上下文打包的摘要基建。
- 但 `Engine.forceCompact()` 仅更新 `compactedMessagesBySession` 内存缓存；`Transcript.appendSummary()` 目前只有测试调用，进程重启后仍从完整 transcript 恢复。因此复用摘要算法，不直接复用 `/compact` 的“整会话、仅内存替换”操作。

### 2. 方案设计

#### 阶段 1：带上下文分叉（quick-chat 升级）

- 增加协议 `agent/forkSession`，第一阶段参数为 `{ sourceSessionId, targetSessionId?, mode: "full", throughEventId? }`；quick-chat 传预生成的 `qchat-*`，普通调用可让 core 生成 id。
- 技术选型采用“复制 transcript 快照到新 session”，不采用只读挂载：现有 Engine、磁盘恢复、desktop transcript reader 都以单一自包含 transcript 为边界；复制后 source 删除、压缩或继续写入都不影响 target。
- 只读挂载会引入 composite transcript、固定 fork 游标、跨 session tool-use 配对、源删除/GC 与 UI replay 依赖，且与已有 `SessionManager.fork()` 重复，收益不足。
- server 先确认 source 存在；若 source ChatSession 正在运行，阶段 1 返回 `Overloaded`，UI 显示“当前回复结束后分叉”，避免复制半个 tool round 或与 append 并发。
- 增强 `SessionManager.fork()`：以 `source.transcript.turnNumber`/显式事件游标截取稳定快照；创建新 identity 后复制所有上下文与回放所需事件，但跳过 source `session_meta`，由 target 写唯一 meta 并记录 lineage。
- 不再用 `parentSessionId` 表示用户 fork：该字段现有语义是 sub-agent owner，desktop 磁盘重建会过滤非空值。新增 `forkedFrom: { sessionId, eventId?, mode }`，用户 fork 保持 `parentSessionId: null`。
- target 状态继承 `cwd`、深拷贝 `workspace`、model/provider 与 origin；usage、cost、turnCount/turnSeq、activeGoal/goalTerminal、运行状态全部重置。目标共享文件系统现状，但不继承 source 的运行控制与预算。
- fork 事件写入使用新 event id，并在 target meta 中保存 source event id 范围；这样两份 transcript 后续追加、compact、删除完全独立，同时仍可追溯来源。
- target 第一次 `Engine.run()` 不增加另一份 system prompt：现有 resume 分支会用 `toMessages()` 把复制历史作为 prefix，再追加新问题；额外注入会造成上下文重复。
- quick-chat 打开时从 `ownerBucket` 解析权威 `engineSessionId`，立即发起 fork；完成后用现有磁盘 transcript reader hydrate 新 bucket，因此用户能看到继承历史，而不是只在模型内部“暗带上下文”。
- `QuickChatSessionRef` 增加 `sourceSessionId/status/error/contextMode`；pending/error 时禁用发送，避免 fork 尚未落盘时 `agent/run` 抢先创建同名空 session。
- quick-chat 默认“携带当前上下文”，因为这是该入口相对“新对话”的核心价值；在新增 tab 菜单或 panel 空态提供次要操作“空白 quick-chat”。owner 尚无 engine session（草稿）时只能空白并明确提示。
- 创建 target bucket 时复制 owner 的 model、permission、plan override；首次 send 仍沿用 `runAfterModelSwitch()`，worker 按继承的 workspace/cwd 重读同一项目设置。goal 默认不复制，避免侧分支自动继续主线程的长期目标。
- 关闭 quick-chat 继续走现有 claim/cleanup；删除的只是 target session。source transcript、source workspace 指针与 source 后台任务不变。
- 阶段 1 验收：fork 前历史在面板可见；首问确实引用旧上下文；两边后续消息互不可见；重开 target 可恢复；关闭 panel 不影响 source；共享 worktree 时任一侧不能误删另一侧仍占用的 worktree。

#### 阶段 2：选段压缩打包

- `MessageStream` 增加“选择上下文”模式，按完整对话回合选择连续范围；排除正在流式输出的尾回合。工具卡默认随所属回合一起选中，避免只选 tool_result 丢失调用语义。
- 选择器从现有 `getSessionRawEvents()` 读取 core 原始事件，以稳定 `event.id` 形成 `{ fromEventId, toEventId }`；不传 renderer 临时 message id，也不上传 localStorage 的截断/折叠文本。
- 扩展同一 `agent/forkSession` 为判别联合：`mode: "summary"` 时必须带事件范围，可选 `targetSessionId`；server 校验两端事件存在、顺序正确、范围闭合，并冻结事件数组后再调用模型。
- 在 `Transcript` 抽出“events → Message[]/摘要输入”的纯函数；范围切片保留 message、tool_use、tool_result 与既有 summary，过滤 session_meta、goal_progress 等非上下文事件，并对边界做 tool pair 完整性校验。
- 在 Engine 新增公开的 `summarizeContextPackage(messages, signal)`；复用 `buildSummarizationPrompt()`、主模型 client 与累计 usage 记录，但使用面向迁移的一页式模板，明确保留问题、结论、失败尝试、文件/符号、命令、错误、未决项与下一步。
- 小范围单次摘要；超过输入预算时按完整回合分块做 map summary，再用既有 prior-summary/rolling 思路合并为最终约 1,500～2,000 token 的 background context，禁止静默截掉尾部。
- 摘要成功后才创建 target，保证失败不留下空目录；target 继承与阶段 1 相同的 cwd/workspace/model/provider/config 选择，并保持 top-level `parentSessionId: null` 与 `forkedFrom.mode: "summary"`。
- 把结果作为 target transcript 中 `session_meta` 后的首个 `summary` 事件持久化，扩展 `appendSummary()` 写 `trigger: "context_transfer"`、source session/event range、原始事件数与摘要版本/hash。
- `Transcript.toMessages()` 继续按现有约定把 summary 投影成 user-role `<system-reminder>`；Engine 的 system prompt 是独立参数，因此不写中途 `role: system`，也不使用 `injectContext()` 的 assistant 角色，避免把背景事实伪装成模型回答。
- 协议结果返回 `{ sessionId, summary, sourceRange, estimatedTokens }`。desktop 将其登记为普通 sidebar session、hydrate transcript、切换过去，并以可折叠“背景上下文包”卡展示摘要及来源；它不会像 `qchat-*` 一样随 panel 关闭清理。
- package session 的第一条真实 user message 随后走普通 resume 分支；摘要成为唯一历史 prefix，之后 transcript 独立增长。原始选段不复制进 target，达到跨任务复用与 token 降噪目的。
- 阶段 2 验收：跨重启仍只加载摘要；选段之外内容不进入模型；大范围会分块而非截尾；summary 失败不创建 session；target 使用相同 worktree/cwd/model；source/target 删除和续聊互不影响。

### 3. 关键代码锚点

| 文件锚点 | 现有职责 | 方案改动 |
|---|---|---|
| `packages/core/src/types.ts:156`、`:229` | TranscriptEventType、SessionState | 增加用户 fork lineage（不要复用 parentSessionId）；必要时给 transfer summary 的 stream/provenance 类型加字段。 |
| `packages/core/src/session/session-manager.ts:146`、`:470`、`:540` | create/resume/未公开 fork | 重写 fork 为显式 target/event 游标的自包含快照；复制 workspace、跳过旧 meta、重置运行态并原子保存。 |
| `packages/core/src/session/transcript.ts:29`、`:130`、`:153`、`:282` | append、appendSummary、toMessages、load | 增加 imported-event/范围切片纯函数；summary 支持 `context_transfer` provenance；保持目标事件 id 独立。 |
| `packages/core/src/protocol/types.ts:199`、`:385` | InjectParams、Methods | 新增 `ForkSessionParams/Result` 判别联合与 `Methods.ForkSession`。 |
| `packages/core/src/protocol/server.ts:414`、`:479`、`:1432` | 请求分派、多 session run、compact 先例 | 新增 async fork handler；检查 source busy/存在，选择 full-copy 或 summary pipeline，并返回可恢复错误。 |
| `packages/core/src/protocol/chat-session-manager.ts:58` | live session 查找/创建 | 复用 `get()` 判断 source 是否 busy，并取 source Engine；不要让 target 与 source 共用 ChatSession 实例。 |
| `packages/core/src/protocol/client.ts:296` | inject 等公开 client 方法 | 增加类型化 `forkSession()`，供 TUI/SDK 后续复用，不把能力做成 desktop 私有 IPC。 |
| `packages/core/src/engine/engine.ts:928`、`:1284`、`:1722` | run、resume→toMessages、上下文注入顺序 | run 无需专用 fork 分支；验证 copied/summary transcript 会在新 user prompt 前进入消息历史。 |
| `packages/core/src/engine/engine.ts:2354`、`:2869` | 摘要 LLM、手动 compact | 抽取可复用 client/usage 逻辑并新增 `summarizeContextPackage()`；不直接调用整会话 `forceCompact()`。 |
| `packages/core/src/context/compaction.ts:787`、`:884` | 9 段摘要 prompt、summary 压缩投影 | 复用消息序列化与 rolling summary，新增迁移模板及按回合分块；不要附 source transcript 路径到 target prompt。 |
| `packages/core/src/context/manager.ts:641`、`packages/core/src/engine/turn-loop.ts:738` | `/compact` 与自动 compact | 作为算法/阈值参考；不改变阶段 1 run loop，阶段 2 只复用摘要原语。 |
| `packages/core/src/tool-system/builtin/worktree.ts:169`、`:331` | workspace 持久化、共享 owner 检查 | 无需新建 worktree；补 fork 共用 workspace 的测试，确认 detach/discard 仍被其他 owner 阻止。 |
| `packages/core/src/cc-orchestrator/external-agent-session-store.ts:43`、`packages/core/src/cc-orchestrator/external-agent-bindings.ts:27` | 外部 id/cwd/worktree 持久绑定 | 仅借鉴显式绑定与原子落盘；不把 external session/room 日志混入 core fork。 |
| `packages/desktop/src/main/agent-bridge.ts:373`、`:395` | renderer RPC 转发、compact 冷启动 worker | 识别 fork 请求的 sourceSessionId，按 source cwd 拉起 worker，避免 worker 退出后 fork RPC 被丢弃。 |
| `packages/desktop/src/preload/index.ts:531`、`:756`；`packages/desktop/src/preload/types.d.ts:971` | agent RPC、quick-chat IPC 暴露 | 暴露类型化 `forkSession()`；沿用 claim/cleanup，阶段 2 沿用 raw-events API。 |
| `packages/desktop/src/main/rawTranscript.ts:31`、`:51`；`packages/desktop/src/main/index.ts:3516` | 保留 event.id 的磁盘读取 | 阶段 2 直接复用为选择范围数据源；仅需补范围/安全上限测试，无需从 renderer 文本反推事件。 |
| `packages/desktop/src/renderer/quickChatSession.ts:4`、`:13` | qchat ref 与安全 id | 增加 source/mode/pending/error；保留 qchat id 以兼容 ownership cleanup。 |
| `packages/desktop/src/renderer/App.tsx:2461`、`:3094`、`:4180` | quick send、ensure、panel host | ensure 改为异步 fork+hydrate；复制 model/permission/plan override；pending 前禁止 send，blank 为显式次选。 |
| `packages/desktop/src/renderer/transcripts.ts:528`、`:582` | sidebar session 创建、engine id 绑定 | 阶段 2 将返回的 target 登记成普通 top-level session 并绑定 engineSessionId；quick-chat 不进入此索引。 |
| `packages/desktop/src/renderer/panels/QuickChatPanel.tsx:11`、`:59` | 面板交互 | 显示 fork 来源/状态与空白入口；继承历史只读展示，分叉后的新消息正常交互。 |
| `packages/desktop/src/renderer/MessageStream.tsx:36`、`:161` | 消息流与各类消息渲染 | 阶段 2 增加完整回合范围选择、选中态和“总结并新建”；禁选 live 尾回合。 |
| `packages/desktop/src/main/transcript-reader.ts:245`、`packages/desktop/src/renderer/types.ts:130`、`packages/desktop/src/renderer/messages/ContextBoundaryView.tsx:7` | summary 回放、context UI | transfer summary 回放成可折叠背景包并携带来源，而不是只显示 before/after 为 0 的 compact 分隔线。 |
| `tests/session.test.ts:45`、`packages/core/src/protocol/server.compact.test.ts:35`、`packages/desktop/src/renderer/quickChatSession.test.ts:11` | 现有 fork/compact/qchat 测试 | 扩展为状态继承、事件隔离、busy/失败原子性、summary 重启恢复、UI pending/cleanup 与共享 worktree 回归测试。 |

### 4. 风险与取舍

- **Token 与磁盘放大**：full fork 会复制大 transcript（尤其历史图片）；阶段 1 应显示估算大小并依赖首轮 context management，超过硬上限时建议用户改用阶段 2。不能用 hard-link transcript，后续 append 会污染两边。
- **`/compact` 持久化错觉**：当前 anchored summary 只在 Engine 内存消息中，注释所称“resume 可恢复”与实际写盘不一致；本方案的 transfer summary 必须显式 `appendSummary()`，并补“杀 worker 后恢复”测试。
- **隔离边界**：不得复制 source `session_meta`、activeGoal、pending approval/steer、background job、cost/file-history 控制状态；subagent anchor 可作为只读历史显示，但 target 不能取得 source 子任务的控制权。
- **Lineage 兼容**：`parentSessionId` 已被 desktop 当作“是否 sub-agent”的过滤条件；继续复用会让普通 fork 从 sidebar 消失。新增字段比修改其既有语义更安全，旧 fork 数据无需迁移。
- **共享 worktree 冲突**：复用 workspace 满足需求，也意味着两个 session 可同时改同一文件；UI 应显示“共享工作区”警告，现有 owner guard 只防删除，不防并发写。需要真正隔离时由用户显式切换/创建另一 worktree。
- **选择边界**：renderer 折叠后的卡片不是权威数据；必须用 raw event id，限定连续、已完成范围，并由 core 再校验。否则 tool pair、图片或被折叠结果容易丢失。
- **摘要质量与成本**：一页 summary 是有损表示；使用主模型、结构化模板、分块合并和来源范围可降低风险，但精确代码仍应重新 Read 当前 worktree。UI 应保留查看 source session 的链接。
- **敏感数据**：打包会再次把所选 transcript 发给模型并把摘要明文落盘；沿用 transcript 已有敏感 tool-result 脱敏，选择确认页提示范围/估算 token，日志中只记 event id/hash，不记 summary 正文。
- **竞态与原子性**：target id 必须先校验不存在；summary 成功后再 create，create+meta+summary 任一步失败都清理未发布目录。阶段 1 对 busy source fail-fast，避免快照与 append 交错。
- **外部 agent 边界**：cc-room/Claude/Codex 的 resume id 只能在各自 adapter/RoomManager 内续跑；若未来支持从外部会话打包，应先经其 history parser 归一化，再走 summary mode，不能假装为 core transcript fork。
