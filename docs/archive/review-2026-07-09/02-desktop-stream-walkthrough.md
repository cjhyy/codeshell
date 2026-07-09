# 桌面流端到端步骤说明（A2）

本文只覆盖普通 Electron desktop renderer 聊天流：core worker 产出 `StreamEvent`，Electron main/preload 转发，renderer 路由、合并、归约、分组并渲染到 `MessageStream`。`packages/desktop/src/mobile/` 不展开；当前代码里 `packages/desktop/src/renderer/lib/streamReducer.ts` 被 mobile 与 CC Room 复用（`packages/desktop/src/mobile/hooks/useRemoteApp.ts:12`、`packages/desktop/src/renderer/cc-room/CCConversationView.tsx:8`），普通 desktop `MessageStream` 实际走 `transcriptsReducer.ts` 和 `types.ts` 的 `applyStreamEvent`。这点按源码校正，不把不经过的 mobile reducer 硬串进主链路。

上游背景沿用 A1 的校正：`StreamEvent` union 实际定义在 `packages/core/src/types.ts:429`，`packages/core/src/protocol/types.ts:313` 只是给它套多会话 envelope。

## 端到端步骤链

### 1. 模型 chunk 转成 `StreamEvent{text_delta}`
- 文件：`packages/core/src/engine/model-facade.ts:73`、`packages/core/src/engine/model-facade.ts:78`、`packages/core/src/engine/model-facade.ts:80`、`packages/core/src/types.ts:452`
- 输入：provider streaming chunk，例如 `{ type: "text", text, tokens }`。
- 输出：`StreamEvent`，典型形状是 `{ type: "text_delta", text, tokens? }`；工具流则可能输出 `tool_use_start` / `tool_use_args_delta`。
- 为什么需要：`protocol/types.ts` 的文件头说明协议要把 engine/server 与 UI/client 分开（`packages/core/src/protocol/types.ts:1`），所以 provider chunk 不能直接流向 UI，必须先归一为 core 的 UI 无关 `StreamEvent` 契约。

### 2. `TurnLoop` 给流事件加防护并发出请求边界
- 文件：`packages/core/src/engine/turn-loop.ts:329`、`packages/core/src/engine/turn-loop.ts:337`、`packages/core/src/engine/turn-loop.ts:605`
- 输入：`TurnLoopConfig.onStream` 与本 turn 的消息数组。
- 输出：先发 `{ type: "stream_request_start", turnNumber }`，后续所有直接 emit 与传给 `ModelFacade` 的 emit 都经过 try/catch 包装。
- 为什么需要：注释记录过一次 `onStream` handler 抛错导致 renderer 约 23 秒后不再收到事件、UI 看起来冻结；包装后错误进日志，不会切断整条 stream（`packages/core/src/engine/turn-loop.ts:329`）。

### 3. `TurnLoop` 调模型并转发被包装后的 token 流
- 文件：`packages/core/src/engine/turn-loop.ts:1276`、`packages/core/src/engine/turn-loop.ts:1280`、`packages/core/src/engine/turn-loop.ts:1286`、`packages/core/src/engine/turn-loop.ts:1308`
- 输入：`ModelFacade` 通过 `wrappedStream` 发回的 `StreamEvent`。
- 输出：仍是 `StreamEvent`，但 `TurnLoop` 同时记录已流式发出的 tool id、估算 streaming response token，并在接近 context limit 时写 reactive compaction warning。
- 为什么需要：tool id 记录用于避免后面 `response.toolCalls` 再次补发同一个 `tool_use_start`；token 估算用于中途发现上下文压力，但真正 compact 仍在 turn 间做（`packages/core/src/engine/turn-loop.ts:1282`、`packages/core/src/engine/turn-loop.ts:1289`）。

### 4. turn 结束或进入工具阶段时补齐终态事件
- 文件：`packages/core/src/engine/turn-loop.ts:879`、`packages/core/src/engine/turn-loop.ts:1005`、`packages/core/src/engine/turn-loop.ts:1034`、`packages/core/src/engine/engine.ts:2363`
- 输入：模型完整响应 `LLMResponse` 与工具执行结果。
- 输出：无工具时发 `assistant_message`；有工具时发缺失的 `tool_use_start` 和每个 `tool_result`；Engine run 收尾发 `turn_complete`。
- 为什么需要：renderer 需要 `assistant_message` / `turn_complete` 才能把 streaming bubble 标成 done、清掉 busy 和触发折叠；工具 start/result 则让工具卡片从 running 变为 succeeded/failed。`TurnLoop` 还显式跳过已 streaming 过的 tool id，避免重复 tool card（`packages/core/src/engine/turn-loop.ts:1005`）。

### 5. Protocol server 给事件套 session envelope
- 文件：`packages/core/src/protocol/server.ts:1`、`packages/core/src/protocol/server.ts:491`、`packages/core/src/protocol/server.ts:498`、`packages/core/src/protocol/types.ts:313`
- 输入：裸 `StreamEvent`。
- 输出：JSON-RPC notification 参数 `{ sessionId, event }`，method 为 `agent/streamEvent`。
- 为什么需要：`AgentServer` 文件头把职责写成“转发 StreamEvents 到 client，并带 sessionId envelope、防止多 session 串话”（`packages/core/src/protocol/server.ts:1`）；renderer 后续只能靠这个 `sessionId` 路由到正确 tab/bucket。

### 6. stdio transport 把 notification 写成一行 JSON
- 文件：`packages/core/src/cli/agent-server-stdio.ts:1`、`packages/core/src/cli/agent-server-stdio.ts:307`、`packages/core/src/protocol/transport.ts:72`、`packages/core/src/protocol/transport.ts:98`
- 输入：`RpcNotification{ method:"agent/streamEvent", params:{sessionId,event} }`。
- 输出：worker stdout 上的一行 NDJSON。
- 为什么需要：desktop 架构文档规定 Electron main 是 IPC service broker，不是 Engine host；core worker 通过 stdio NDJSON 被 main 驱动（`docs/architecture/10-desktop-and-mobile.md:9`、`docs/architecture/10-desktop-and-mobile.md:12`）。

### 7. Electron main 读取 worker stdout 并识别可快照事件
- 文件：`packages/desktop/src/main/agent-bridge.ts:178`、`packages/desktop/src/main/agent-bridge.ts:201`、`packages/desktop/src/main/parseStreamLine.ts:15`、`packages/desktop/src/main/parseStreamLine.ts:22`
- 输入：worker stdout 的 JSON-RPC line。
- 输出：`SnapshotAppend{ sessionId, event } | null`，非 `agent/streamEvent`、坏 JSON、缺 `sessionId` 的行都只转发不快照。
- 为什么需要：`parseStreamLine.ts` 注释说明它被抽出来是为了让“哪些行进入 snapshot”可测试；只有 stream notification 有值得保留的 `(sessionId,event)`（`packages/desktop/src/main/parseStreamLine.ts:1`）。`steer_injected` 被排除，是因为 core 已把 steered user message 持久化，快照再 replay 会双气泡（`packages/desktop/src/main/parseStreamLine.ts:26`）。

### 8. main 追加 session snapshot，同时把原 line 发给 renderer
- 文件：`packages/desktop/src/main/SessionSnapshotStore.ts:1`、`packages/desktop/src/main/SessionSnapshotStore.ts:10`、`packages/desktop/src/main/SessionSnapshotStore.ts:48`、`packages/desktop/src/main/agent-bridge.ts:203`、`packages/desktop/src/main/agent-bridge.ts:208`
- 输入：步骤 7 的 `SnapshotAppend` 和原始 JSON line。
- 输出：main 内存里带单调 `seq` 的 `SnapshotEntry`，以及发到 BrowserWindow 的 `"agent:msg"` IPC line。
- 为什么需要：renderer 的内存 route table/event buffer 会在刷新、HMR、crash recovery 时消失；main 不 remount，所以由 main 保存每 session 最近事件，renderer 可用 `sinceSeq` 补缺口且不重复（`packages/desktop/src/main/SessionSnapshotStore.ts:4`、`packages/desktop/src/main/SessionSnapshotStore.ts:10`）。

### 9. preload 把 `"agent:msg"` 解析成 renderer callback
- 文件：`packages/desktop/src/preload/index.ts:1`、`packages/desktop/src/preload/index.ts:135`、`packages/desktop/src/preload/index.ts:159`、`packages/desktop/src/preload/index.ts:467`
- 输入：main 发来的 JSON line。
- 输出：`window.codeshell.onStreamEvent` listener 收到 `{ sessionId, event }`。
- 为什么需要：preload 是 renderer 与 main 的 typed transport boundary；renderer 不 runtime import core，只通过 `window.codeshell` 面访问事件和 RPC（`packages/desktop/src/preload/index.ts:1`、`CODESHELL.md:51`）。

### 10. renderer 按 `sessionId` 路由到 UI bucket
- 文件：`packages/desktop/src/renderer/App.tsx:1463`、`packages/desktop/src/renderer/App.tsx:1472`、`packages/desktop/src/renderer/App.tsx:1481`、`packages/desktop/src/renderer/streamRouting.ts:21`
- 输入：`{ sessionId, event }` envelope。
- 输出：`bucket`，形如 `${repoKey}::${uiSessionId}`；未知且无 legacy fallback 时丢弃。
- 为什么需要：多 session/多 tab 可能同时有流；live route table 是快路径，但 renderer remount 会清空它，所以 `resolveBucket` 会从持久的 session index 反查 `engineSessionId`，避免恢复中的 worker output 被静默丢掉（`packages/desktop/src/renderer/streamRouting.ts:4`、`packages/desktop/src/renderer/streamRouting.ts:24`）。

### 11. 高频事件进入 coalescer
- 文件：`packages/desktop/src/renderer/App.tsx:1451`、`packages/desktop/src/renderer/App.tsx:1515`、`packages/desktop/src/renderer/App.tsx:1527`、`packages/desktop/src/renderer/streamCoalescer.ts:19`
- 输入：单个 `StreamEvent`。
- 输出：50ms 窗口内的 `StreamEvent[]` batch；`text_delta` 按 agent 合并，`tool_use_args_delta` 按 tool id 合并，其它边界事件按到达顺序并入 batch；`error` 立即单独 flush。
- 为什么需要：注释明确说目标是减少 renderer load：一个 50ms window 只 dispatch 一次，避免工具密集的子 agent 每秒几十次 `tool_use_start/tool_result` 触发未虚拟化 message list 全量重渲染（`packages/desktop/src/renderer/streamCoalescer.ts:20`、`packages/desktop/src/renderer/streamCoalescer.ts:27`、`packages/desktop/src/renderer/streamCoalescer.ts:30`）。

### 12. coalesced batch 归约成普通 desktop transcript state
- 文件：`packages/desktop/src/renderer/transcriptsReducer.ts:128`、`packages/desktop/src/renderer/transcriptsReducer.ts:133`、`packages/desktop/src/renderer/types.ts:425`、`packages/desktop/src/renderer/lib/streamReducer.ts:128`
- 输入：`stream_batch{ bucket, events }`。
- 输出：该 bucket 的 `MessagesReducerState`。主 desktop 路径是 `transcriptsReducer` 逐个调用 `types.ts` 的 `applyStreamEvent`；`lib/streamReducer.ts` 也能把 `StreamEvent` 折成 `ChatState`，但当前只在 mobile/CC Room 路径使用，不是本 `MessageStream` 链路。
- 为什么需要：batch 内循环只产生一个新 state，让列表“一窗一次”重渲染；`applyStreamEvent` 对 no-op 返回同引用，整批 no-op 可直接 bail out（`packages/desktop/src/renderer/transcriptsReducer.ts:129`）。

### 13. `stream_request_start` 创建 live assistant slot，`text_delta` 追加 token
- 文件：`packages/desktop/src/renderer/types.ts:443`、`packages/desktop/src/renderer/types.ts:448`、`packages/desktop/src/renderer/types.ts:486`、`packages/desktop/src/renderer/types.ts:500`
- 输入：`StreamEvent{ type:"stream_request_start" }` 与后续 `StreamEvent{ type:"text_delta", text }`。
- 输出：先追加 `{ kind:"assistant", text:"", done:false }` 并记录 `streamingAssistantId`；每个 token 合并进这条 assistant message 的 `text`。
- 为什么需要：UI 需要一个稳定的 live message 作为 token accumulator；子 agent 的 `text_delta` 不进主 feed，而是写到对应 `AgentMessage.textBuffer`，这是 hot path freeze 的修复点（`packages/desktop/src/renderer/types.ts:486`）。

### 14. `assistant_message` / `turn_complete` 封口并推进折叠 epoch
- 文件：`packages/desktop/src/renderer/types.ts:664`、`packages/desktop/src/renderer/types.ts:668`、`packages/desktop/src/renderer/types.ts:932`、`packages/desktop/src/renderer/types.ts:1020`
- 输入：`StreamEvent{ type:"assistant_message" }` 与 `StreamEvent{ type:"turn_complete", reason }`。
- 输出：assistant/thinking message 标 `done:true`，streaming ids 清空；clean `completed` 时 `turnEpoch += 1`。
- 为什么需要：`done` 决定 `StreamingMarkdown` 何时切完整 Markdown；`turnEpoch` 是 `ToolCard` / `TurnProcessGroupCard` 自动折叠的同步信号。异常结束不 bump epoch，是为了不在用户读错误现场时把卡片强行收起（`packages/desktop/src/renderer/types.ts:1020`）。

### 15. `MessageStream` 接收 messages 并维持滚动跟随
- 文件：`packages/desktop/src/renderer/App.tsx:3483`、`packages/desktop/src/renderer/MessageStream.tsx:88`、`packages/desktop/src/renderer/MessageStream.tsx:112`、`packages/desktop/src/renderer/chat/stickToBottom.ts:45`
- 输入：`messages`、`turnEpoch`、`engineSessionId`、`liveTurnActive`、`sendEpoch`。
- 输出：滚动容器 ref、`showJump`、`scrollToBottom`，并在发送、session 切换、stream 内容增长时决定是否贴底。
- 为什么需要：todo 背景记录了两个交互目标：流式时自动跟随，用户上滑时暂停，回到底部/点跳底/发新消息恢复（`docs/archive/todo/desktop-streaming-markdown-autoscroll-plan.md:9`）。当前实现用纯 follow reducer 处理 programmatic scroll race，原因是 renderer 测试没有 jsdom，滚动状态机必须能单测（`packages/desktop/src/renderer/chat/followState.ts:1`、`docs/archive/todo/desktop-streaming-markdown-autoscroll-plan.md:645`）。

### 16. `MessageStream` 把 raw messages 折成 render items
- 文件：`packages/desktop/src/renderer/MessageStream.tsx:127`、`packages/desktop/src/renderer/MessageStream.tsx:144`、`packages/desktop/src/renderer/messages/streamGroups.ts:172`、`packages/desktop/src/renderer/messages/streamGroups.ts:183`
- 输入：`Message[]` 和 `liveTurnActive`。
- 输出：`StreamItem[]`，可能包含原始 message、`ToolGroup`、`TurnProcessGroup`。
- 为什么需要：`streamGroups.ts` 的文件头定义了 Codex-style 两层折叠：相邻工具先折成“已处理 N 条命令”，含工具的 user turn 再折成一个“已处理 Xs” process card，让工具密集输出不把聊天流打碎（`packages/desktop/src/renderer/messages/streamGroups.ts:1`）。

### 17. Level 1：相邻工具折成 `ToolGroup`
- 文件：`packages/desktop/src/renderer/messages/streamGroups.ts:344`、`packages/desktop/src/renderer/messages/streamGroups.ts:347`、`packages/desktop/src/renderer/messages/streamGroups.ts:363`、`packages/desktop/src/renderer/messages/streamGroups.ts:369`
- 输入：过滤掉隐藏 task 工具后的 `Message[]`。
- 输出：两个及以上相邻 tool 变成 `ToolGroup{ items }`；单个 tool 仍内联；夹在工具之间的 thinking 可被吸收。
- 为什么需要：thinking 是非用户可见的透明项，不该把一个工具 run 视觉上打散；assistant text 是用户可见叙述，所以作为 hard boundary 保留，避免把“工具→文字→工具”揉成巨型命令组（`packages/desktop/src/renderer/messages/streamGroups.ts:41`、`packages/desktop/src/renderer/messages/streamGroups.ts:162`）。

### 18. Level 2：含工具的 user turn 折成 `TurnProcessGroup`
- 文件：`packages/desktop/src/renderer/messages/streamGroups.ts:385`、`packages/desktop/src/renderer/messages/streamGroups.ts:409`、`packages/desktop/src/renderer/messages/streamGroups.ts:447`、`packages/desktop/src/renderer/messages/streamGroups.ts:472`
- 输入：Level 1 后的 `Array<Message | ToolGroup>`。
- 输出：对每个含工具的 user turn，输出 user bubble + `TurnProcessGroup{ items, isLive, toolCount, durationMs }`；无工具 turn 保持内联。
- 为什么需要：规则明确：非 injected user 是 turn 边界，injected steer/goal wakeup 多数是当前 turn 的延续；closed turn 的 card 只包到最后一个真实工具，最后总结留在卡外；live turn 则扩到 turn 末尾，让进行中的叙述也待在 process card 内（`packages/desktop/src/renderer/messages/streamGroups.ts:409`、`packages/desktop/src/renderer/messages/streamGroups.ts:393`、`packages/desktop/src/renderer/messages/streamGroups.ts:401`）。这也是“最终折叠进 TurnProcessGroupCard”的判定核心。

### 19. Reconcile group 对象，避免每 50ms 破坏 memo
- 文件：`packages/desktop/src/renderer/messages/streamGroups.ts:192`、`packages/desktop/src/renderer/messages/streamGroups.ts:201`、`packages/desktop/src/renderer/messages/streamGroups.ts:262`、`packages/desktop/src/renderer/messages/streamGroups.ts:269`
- 输入：上一次 render 的 `StreamItem[]` 与本次新建的 `StreamItem[]`。
- 输出：结构签名相同的 `ToolGroup` / `TurnProcessGroup` 复用旧对象，变化的才用新对象。
- 为什么需要：`buildStreamItems` 每次都会分配新 group；如果不 reconcile，`React.memo` 的卡片 prop 每 50ms 都变，会强制重渲染整个 live-turn subtree，注释直接关联 `perf: scroll-jank-2026-06-02`（`packages/desktop/src/renderer/messages/streamGroups.ts:192`）。

### 20. `MessageStream` 选择组件渲染到屏幕
- 文件：`packages/desktop/src/renderer/MessageStream.tsx:157`、`packages/desktop/src/renderer/MessageStream.tsx:162`、`packages/desktop/src/renderer/MessageStream.tsx:242`、`packages/desktop/src/renderer/MessageStream.tsx:295`
- 输入：`StreamItem[]`。
- 输出：DOM：`TurnProcessGroupCard`、`ToolGroupCard`、`ToolCard`、`AssistantMessageView`、`AgentMessageView` 等；不在底部时显示跳底按钮。
- 为什么需要：render 层只根据 `kind` 分派组件，保持折叠逻辑集中在 `streamGroups.ts`；跳底按钮是 follow-state 的显式恢复入口。

### 21. streaming token 用 `StreamingMarkdown` 出现在屏幕上
- 文件：`packages/desktop/src/renderer/messages/AssistantMessageView.tsx:46`、`packages/desktop/src/renderer/messages/TurnProcessGroupCard.tsx:102`、`packages/desktop/src/renderer/messages/StreamingMarkdown.tsx:34`、`packages/desktop/src/renderer/messages/StreamingMarkdown.tsx:93`
- 输入：`AssistantMessage.text` 或 process card 内 assistant item 的 `text`，且 `done:false`。
- 输出：`StreamingMarkdownBody`：稳定前缀走窄 Markdown，活跃尾部走 `<pre>`。
- 为什么需要：流式 Markdown 的 todo 背景是“先显示原文，done 后突变”的体验问题，但不能每 token 全量重解析导致卡顿/抖动（`docs/archive/todo/desktop-streaming-markdown-autoscroll-plan.md:9`、`docs/archive/todo/desktop-streaming-markdown-autoscroll-plan.md:608`）。当前实现用 120ms throttle、按空行切 chunk、memo chunk，只让最新 chunk 重解析（`packages/desktop/src/renderer/messages/StreamingMarkdown.tsx:52`、`packages/desktop/src/renderer/messages/StreamingMarkdown.tsx:82`）。

### 22. `splitStreamingMarkdown` 把半成品留在 active tail
- 文件：`packages/desktop/src/renderer/markdown/splitStreamingMarkdown.ts:1`、`packages/desktop/src/renderer/markdown/splitStreamingMarkdown.ts:8`、`packages/desktop/src/renderer/markdown/splitStreamingMarkdown.ts:81`、`packages/desktop/src/renderer/markdown/splitStreamingMarkdown.ts:121`
- 输入：正在增长的 Markdown text buffer。
- 输出：`{ stablePrefix, activeTail }`。
- 为什么需要：切点只取最后一个空行边界，且不能切在未闭合 fenced code block 中；不确定时宁可推入 tail。这样避免 setext/list/paragraph 等 Markdown 块因下一行到来回头改结构，也避免未闭合 code fence 被丢给解析/高亮造成抖动（`packages/desktop/src/renderer/markdown/splitStreamingMarkdown.ts:8`、`docs/archive/todo/desktop-streaming-markdown-autoscroll-plan.md:615`）。

### 23. done 后切完整 Markdown 管线
- 文件：`packages/desktop/src/renderer/messages/StreamingMarkdown.tsx:40`、`packages/desktop/src/renderer/Markdown.tsx:160`、`packages/desktop/src/renderer/Markdown.tsx:170`、`packages/desktop/src/renderer/Markdown.tsx:179`
- 输入：同一条 assistant text，`done:true`。
- 输出：完整 `<Markdown>`：`remark-gfm`、`remarkPathLinks`、`rehypeRaw → rehypeSanitize → rehypeHighlight`、path/image 组件覆盖。
- 为什么需要：流式阶段推迟 highlight/raw/path IPC/图片加载等重能力，done 后内容稳定再启用完整功能；安全边界要求 raw HTML 一解析就立刻 sanitize，再 highlight，否则不可信 LLM/网页转述内容可能进入 DOM（`packages/desktop/src/renderer/Markdown.tsx:172`、`packages/desktop/src/renderer/messages/StreamingMarkdown.tsx:132`）。

### 24. `TurnProcessGroupCard` 最终呈现或折叠 process 内容
- 文件：`packages/desktop/src/renderer/messages/TurnProcessGroupCard.tsx:38`、`packages/desktop/src/renderer/messages/TurnProcessGroupCard.tsx:48`、`packages/desktop/src/renderer/messages/TurnProcessGroupCard.tsx:53`、`packages/desktop/src/renderer/messages/TurnProcessGroupCard.tsx:71`
- 输入：`TurnProcessGroup{ isLive, stopped, items, durationMs, firstToolStartedAt }`。
- 输出：live turn 默认展开并每秒更新 elapsed；closed turn 默认可折叠，clean turn boundary 后被 `turnEpoch` 强制收起；stopped turn 不显示折叠 header，内容平铺。
- 为什么需要：用户需要实时看当前 turn 在做什么，但历史工具过程应折成“已处理 Xs”让聊天流回到摘要密度；中断 turn 没有完整处理结果，不应藏在 elapsed header 后面（`packages/desktop/src/renderer/messages/TurnProcessGroupCard.tsx:44`、`packages/desktop/src/renderer/messages/TurnProcessGroupCard.tsx:50`、`packages/desktop/src/renderer/messages/TurnProcessGroupCard.tsx:71`）。

## 关键分支和边界

- 纯文本对话没有任何工具时，步骤 18 的 `lastTool < 0`，不会生成 `TurnProcessGroup`，token 最终停在普通 `AssistantMessageView`（`packages/desktop/src/renderer/messages/streamGroups.ts:465`）。
- 工具 turn 的 lead-in / mid-run assistant token 会进入 `TurnProcessGroupCard`；closed turn 最后一个真实工具之后的最终总结文本留在卡外，作为普通 assistant message 展示（`packages/desktop/src/renderer/messages/streamGroups.ts:393`、`packages/desktop/src/renderer/messages/streamGroups.ts:496`）。
- `SessionSnapshotStore` 不改变 live 数据形状；它是断线/重挂补偿层。renderer 可通过 `window.codeshell.subscribeSession` 获取 `{ events, nextSeq }`（`packages/desktop/src/preload/index.ts:666`），main handler 直接读 bridge snapshot（`packages/desktop/src/main/index.ts:3145`）。
- `lib/streamReducer.ts` 的形状是 `reduceStream(ChatState, raw) -> ChatState`（`packages/desktop/src/renderer/lib/streamReducer.ts:128`），并包含和 desktop 相似的 `assistant_message` / `turn_complete` 封口逻辑（`packages/desktop/src/renderer/lib/streamReducer.ts:350`），但主桌面聊天流不经过它。
- 本文未使用无据设计动机；没有标“推测”的 Why。

## 可视化分镜映射

```ts
[
  {
    节点名: "1 ProviderChunk -> StreamEvent",
    文件: "packages/core/src/engine/model-facade.ts:78",
    输入数据形状: "LLMChunk{text,tokens?}",
    输出数据形状: "StreamEvent{text_delta,text,tokens?}",
    一句话说明: "provider chunk 被归一成 core UI 无关事件。",
  },
  {
    节点名: "2 TurnLoop Stream Guard",
    文件: "packages/core/src/engine/turn-loop.ts:329",
    输入数据形状: "StreamCallback + turn messages",
    输出数据形状: "guarded StreamCallback + stream_request_start",
    一句话说明: "先发 turn 边界，并防止 stream handler 抛错切断后续事件。",
  },
  {
    节点名: "3 Wrapped Model Stream",
    文件: "packages/core/src/engine/turn-loop.ts:1280",
    输入数据形状: "StreamEvent",
    输出数据形状: "StreamEvent",
    一句话说明: "跟踪 tool id 与 streaming token 估算后继续转发。",
  },
  {
    节点名: "4 Turn Terminal Events",
    文件: "packages/core/src/engine/turn-loop.ts:879",
    输入数据形状: "LLMResponse + ToolResult[]",
    输出数据形状: "assistant_message/tool_use_start/tool_result/turn_complete",
    一句话说明: "补齐 UI 需要的消息封口、工具进度和 turn 边界。",
  },
  {
    节点名: "5 Protocol Envelope",
    文件: "packages/core/src/protocol/server.ts:498",
    输入数据形状: "StreamEvent",
    输出数据形状: "AgentStreamEventNotification{sessionId,event}",
    一句话说明: "给事件加 sessionId，支持多会话路由。",
  },
  {
    节点名: "6 Stdio NDJSON",
    文件: "packages/core/src/protocol/transport.ts:98",
    输入数据形状: "RpcNotification",
    输出数据形状: "JSON line",
    一句话说明: "worker 通过 stdout 把协议消息送到 Electron main。",
  },
  {
    节点名: "7 Main Parse Snapshot Candidate",
    文件: "packages/desktop/src/main/parseStreamLine.ts:15",
    输入数据形状: "JSON line",
    输出数据形状: "SnapshotAppend | null",
    一句话说明: "只识别可重放的 agent/streamEvent 行。",
  },
  {
    节点名: "8 Main Snapshot + IPC Forward",
    文件: "packages/desktop/src/main/agent-bridge.ts:203",
    输入数据形状: "SnapshotAppend + JSON line",
    输出数据形状: "SnapshotEntry{seq,event} + agent:msg line",
    一句话说明: "main 保存可补偿快照，同时把原 line 发给 renderer。",
  },
  {
    节点名: "9 Preload Fanout",
    文件: "packages/desktop/src/preload/index.ts:159",
    输入数据形状: "agent:msg JSON line",
    输出数据形状: "{sessionId,event}",
    一句话说明: "preload 解析 notification 并调用 renderer listener。",
  },
  {
    节点名: "10 Bucket Routing",
    文件: "packages/desktop/src/renderer/streamRouting.ts:30",
    输入数据形状: "{sessionId,event}",
    输出数据形状: "{bucket,event}",
    一句话说明: "按 engine sessionId 找到 UI session bucket。",
  },
  {
    节点名: "11 Event Coalescer",
    文件: "packages/desktop/src/renderer/streamCoalescer.ts:102",
    输入数据形状: "StreamEvent",
    输出数据形状: "StreamEvent[] batch",
    一句话说明: "50ms 合并 noisy delta，并批量 dispatch。",
  },
  {
    节点名: "12 Desktop Batch Reducer",
    文件: "packages/desktop/src/renderer/transcriptsReducer.ts:128",
    输入数据形状: "stream_batch{bucket,events}",
    输出数据形状: "MessagesReducerState",
    一句话说明: "普通 desktop 主链路逐个 applyStreamEvent，非 mobile reducer。",
  },
  {
    节点名: "13 Live Assistant Accumulator",
    文件: "packages/desktop/src/renderer/types.ts:443",
    输入数据形状: "stream_request_start + text_delta",
    输出数据形状: "AssistantMessage{done:false,text}",
    一句话说明: "创建 live bubble，并把 token 追加进同一条消息。",
  },
  {
    节点名: "14 Seal Turn",
    文件: "packages/desktop/src/renderer/types.ts:932",
    输入数据形状: "assistant_message/turn_complete",
    输出数据形状: "done messages + turnEpoch",
    一句话说明: "终态事件把 streaming 内容封口，并驱动历史卡片折叠。",
  },
  {
    节点名: "15 Stick To Bottom",
    文件: "packages/desktop/src/renderer/chat/stickToBottom.ts:54",
    输入数据形状: "messages/liveTurnActive/sendEpoch",
    输出数据形状: "ref/showJump/scrollToBottom",
    一句话说明: "决定内容增长时是否自动贴底，用户上滑则暂停。",
  },
  {
    节点名: "16 Build Stream Items",
    文件: "packages/desktop/src/renderer/messages/streamGroups.ts:183",
    输入数据形状: "Message[]",
    输出数据形状: "StreamItem[]",
    一句话说明: "把 raw transcript 变成可渲染的普通项和折叠项。",
  },
  {
    节点名: "17 ToolGroup Fold",
    文件: "packages/desktop/src/renderer/messages/streamGroups.ts:344",
    输入数据形状: "adjacent ToolMessage[]",
    输出数据形状: "ToolGroup | ToolMessage",
    一句话说明: "相邻工具折成一组，透明 thinking 不打断工具 run。",
  },
  {
    节点名: "18 TurnProcess Fold",
    文件: "packages/desktop/src/renderer/messages/streamGroups.ts:405",
    输入数据形状: "Message | ToolGroup items",
    输出数据形状: "TurnProcessGroup",
    一句话说明: "含工具的 user turn 折成一个 process card。",
  },
  {
    节点名: "19 Reconcile Groups",
    文件: "packages/desktop/src/renderer/messages/streamGroups.ts:269",
    输入数据形状: "prev StreamItem[] + next StreamItem[]",
    输出数据形状: "reused StreamItem[]",
    一句话说明: "复用未变 group 对象，让 memo 卡片跳过 50ms 重渲染。",
  },
  {
    节点名: "20 Component Dispatch",
    文件: "packages/desktop/src/renderer/MessageStream.tsx:157",
    输入数据形状: "StreamItem[]",
    输出数据形状: "React elements",
    一句话说明: "按 kind 渲染 AssistantMessageView 或 TurnProcessGroupCard 等组件。",
  },
  {
    节点名: "21 Streaming Markdown Paint",
    文件: "packages/desktop/src/renderer/messages/StreamingMarkdown.tsx:93",
    输入数据形状: "text + done:false",
    输出数据形状: "stable markdown chunks + active <pre>",
    一句话说明: "流式时富渲染稳定前缀，活跃尾部保持源码显示。",
  },
  {
    节点名: "22 Split Streaming Markdown",
    文件: "packages/desktop/src/renderer/markdown/splitStreamingMarkdown.ts:81",
    输入数据形状: "markdown text buffer",
    输出数据形状: "{stablePrefix,activeTail}",
    一句话说明: "只在安全空行边界切分，并避开未闭合 fence。",
  },
  {
    节点名: "23 Done Markdown Pipeline",
    文件: "packages/desktop/src/renderer/Markdown.tsx:170",
    输入数据形状: "text + done:true",
    输出数据形状: "full ReactMarkdown DOM",
    一句话说明: "完成后启用完整 Markdown、安全清洗、高亮和路径/图片能力。",
  },
  {
    节点名: "24 TurnProcessGroupCard",
    文件: "packages/desktop/src/renderer/messages/TurnProcessGroupCard.tsx:47",
    输入数据形状: "TurnProcessGroup",
    输出数据形状: "open live card | collapsed process header | flat stopped content",
    一句话说明: "live 展开显示进度，完成后按 turnEpoch 折叠历史过程。",
  },
]
```
