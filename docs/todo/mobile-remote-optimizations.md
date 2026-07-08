## 2026-07-08 只读探查：mobile remote 两个 UI 优化点

### 1. 移动端 remote 前端整体文件结构

- 移动端独立 Vite 入口在 `packages/desktop/src/mobile/index.html:13-14` 和 `packages/desktop/src/mobile/main.tsx:1-16`，根组件是 `packages/desktop/src/mobile/App.tsx:18`。
- mobile bundle 配置在 `packages/desktop/vite.mobile.config.ts:17-54`：`root` 指向 `src/mobile`，`base` 是 `/mobile/`，产物输出到 `out/mobile`；`@ui` 复用桌面 renderer 的 shadcn 组件，`@protocol` 指向 `src/main/mobile-remote/types.ts`。
- `/mobile/` 路由由主进程 mobile remote 服务承载：`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:144-152` 匹配 `/mobile` route family，静态/开发代理逻辑在 `packages/desktop/src/main/mobile-remote/mobile-static.ts`。
- 移动端主要组件在 `packages/desktop/src/mobile/components/`：消息流 `MessageStream.tsx`，Markdown `Markdown.tsx`，普通会话列表 `SessionList.tsx`，CC/Codex 会话列表 `CcSessionList.tsx`，输入框 `Composer.tsx`，审批卡片 `ApprovalCard.tsx`。
- 移动端状态和数据源集中在 `packages/desktop/src/mobile/hooks/useRemoteApp.ts`；WebSocket 封装在 `packages/desktop/src/mobile/hooks/useRemoteSocket.ts`。
- mobile WebSocket 协议类型在 `packages/desktop/src/main/mobile-remote/types.ts`，普通会话 `MobileSessionMeta` 见 `:187-193`，CC/Codex 会话 `CcDiscoveredSession` 见 `:30-35`。
- mobile i18n 文案在 `packages/desktop/src/renderer/i18n/ns/mobile.ts`，中文和英文都在同一文件；已有 `mobile.cc.*` 见 `:43-52` / `:186-195`，已有 `mobile.sessionList.*` 见 `:94-110` / `:238-254`。
- mobile 前端未共用桌面聊天 UI 组件，但会复用桌面 renderer 的纯工具/样式资源：`@ui/button`、`@/i18n`、`@/lib/streamReducer`、`@/lib/messageMappers`。修改 `packages/desktop/src/mobile/**` 基本只影响 mobile；修改 `packages/desktop/src/renderer/lib/**`、`packages/core/src/cc-orchestrator/**` 会影响桌面端相关功能。

### 2. 优化点 1：assistant 消息“超出长度”显示不全

#### 现状

- 用户标注的气泡来自 `packages/desktop/src/mobile/components/MessageStream.tsx:64-72`，assistant 外层是 `div.mobile-message-assistant.max-w-[92%]`。
- assistant 正文渲染在 `packages/desktop/src/mobile/components/MessageStream.tsx:32-45`：完成态走 `<Markdown text={item.text} />`，流式态直接渲染 `{item.text}` 并显示光标。
- mobile Markdown 渲染器在 `packages/desktop/src/mobile/components/Markdown.tsx:22-42` 定义排版 class，在 `:47-64` 把完整 `text` 交给 `ReactMarkdown`。这里没有 `max-height`、`line-clamp`、`truncate`、`overflow-hidden` 或手动截断。
- `.mobile-message-assistant` CSS 在 `packages/desktop/src/mobile/styles.css:124-127`，只设置左边框和背景渐变；没有高度限制或裁切规则。消息流容器在 `MessageStream.tsx:157` 使用 `overflow-y-auto`，是正常纵向滚动。
- 普通桌面会话历史没有发现单条文本裁剪：`packages/desktop/src/main/mobile-remote/mobile-history.ts:14-24` 直接把 transcript reader 的 FoldItems 转成 reducer events；`packages/desktop/src/main/transcript-reader.ts:139-145` 把 assistant 内容作为 `text_delta` 原样回放。
- mobile reducer 对实时文本没有截断：`packages/desktop/src/renderer/lib/streamReducer.ts:164-175` 对 `text_delta` 做字符串追加；`assistant_text` 在 `:491-516` 直接保存 `event.text`。
- 明确的数据层截断点在 CC/Codex 历史回放：
  - Claude Code 历史：`packages/core/src/cc-orchestrator/session-history.ts:56` 把 user text 切到 4000 字符，`:61` 把 assistant text 切到 4000 字符。
  - Codex 历史：`packages/core/src/cc-orchestrator/codex-session-history.ts:54-58` 把 user/assistant text 切到 4000 字符。
  - mobile 打开 CC 会话时在 `packages/desktop/src/mobile/hooks/useRemoteApp.ts:373-380` 请求 `ccRoom.readHistory`，主进程在 `packages/desktop/src/main/index.ts:1055-1066` 直接把上述 reader 的 `messages` 回传给手机。
- 需要区分：`packages/desktop/src/mobile/components/ToolCard.tsx:83-84` 会把工具结果显示截到 4000 字符并追加 `mobile.tool.truncated`，但这只影响工具卡片，不影响 assistant 正文。

#### 根因判断

这不是 `mobile-message-assistant` 气泡的 CSS 视觉截断：气泡和 Markdown 都没有行数/高度裁切。对普通实时会话和普通桌面会话历史，代码路径也没有发现 assistant 正文长度上限。

如果用户是在打开已有 CC/Codex 会话历史时看到长 assistant 回复缺尾，根因是数据层在 `packages/core/src/cc-orchestrator/session-history.ts:61` 和 `packages/core/src/cc-orchestrator/codex-session-history.ts:57` 预先把单条消息切成 4000 字符；mobile 端收到的字符串已经不完整。

#### 推荐修法

- 最小修法：移除或显著提高 `readRecentHistory` / `readCodexRecentHistory` 中 user/assistant `text.slice(0, 4000)` 的限制，至少 assistant 文本不要裁剪。保留列表标题/工具 summary 的短摘要截断，例如 `session-discovery.ts:61` 的 `firstMessage` 和工具 summary 裁剪不属于正文显示。
- 如果担心一次性 WebSocket payload 太大，改成显式协议而不是静默截断：在 `CcHistoryMessage` 增加 `truncated/fullTextAvailable` 或新增按消息读取完整内容的 RPC，并在 mobile `MessageStream`/`Markdown` 上做“展开完整回复”。这个方案更复杂，但用户体验更可控。
- 作为保险可在 `MessageStream.tsx:70` 给 assistant 气泡补 `min-w-0`，并继续依赖现有 `break-words` / Markdown 内部横向滚动处理长 URL、代码块、表格；但这不是本次“长回复缺尾”的主根因。

#### 涉及文件

- `packages/core/src/cc-orchestrator/session-history.ts`
- `packages/core/src/cc-orchestrator/codex-session-history.ts`
- 可能新增/调整测试：`packages/core/src/cc-orchestrator/session-history.test.ts`、`packages/core/src/cc-orchestrator/codex-session-history.test.ts`
- 如做显式展开协议，还会涉及 `packages/desktop/src/main/mobile-remote/types.ts`、`packages/desktop/src/main/index.ts`、`packages/desktop/src/mobile/hooks/useRemoteApp.ts`、`packages/desktop/src/mobile/components/MessageStream.tsx`

#### 量级

- S：只移除/提高 4000 字符截断并补单元测试。
- M：做“截断标记 + 展开完整回复/懒加载完整消息”的协议和 UI。

#### 建议测试

- 单元测试：构造超过 4000 字符的 Claude Code/Codex assistant 历史，断言 `readRecentHistory` / `readCodexRecentHistory` 返回完整文本。
- mobile 组件测试：用超长中文段落、长英文单词、长 URL、代码块、表格渲染 `MessageStream`，确认普通文本不丢失，代码块/表格横向滚动。
- 手工回归：手机宽度打开 `/mobile/`，分别验证普通会话实时回复、普通会话历史、CC 历史、Codex 历史的长 assistant 回复都能完整看到。

### 3. 优化点 2：普通会话和 CC 会话拆成左右两个按钮/两个 tab

#### 现状

- 用户标注的全屏 overlay 是 `packages/desktop/src/mobile/App.tsx:65-72`：手机上 `drawerOpen` 时渲染 `div.fixed.inset-0`，左侧抽屉是 `mobile-drawer`，右侧遮罩是 `div.flex-1.bg-black/55`。
- 抽屉内容在 `SidePane`：`packages/desktop/src/mobile/App.tsx:196-258`。
- 当前并不是同一个数组混渲染：
  - 普通会话组件 `SessionList` 在 `App.tsx:198-217` 创建，数据来自 `app.sessions`。
  - CC/Codex 组件 `CcSessionList` 在 `App.tsx:218-230` 创建，数据来自 `app.ccSessions`。
- 但当前视觉上被放进同一个抽屉并上下堆叠：`App.tsx:249-255` 注释写明“chat sessions on top, external CC sessions below”，实际布局是 `flex-col`，普通会话占上半 `:253`，CC 会话占下半 `:254`。手机窄屏上用户会感知为一个混在一起的会话面板。
- 普通会话数据来源：
  - `useRemoteApp.ts:153` 保存 `sessions`，`useRemoteApp.ts:235-243` 收到 `session.list.ok` 后 `setSessions(event.sessions)`。
  - 协议类型 `session.list` / `session.list.ok` 在 `packages/desktop/src/main/mobile-remote/types.ts:82-84`、`:140-142`。
  - 主进程处理在 `packages/desktop/src/main/index.ts:793-808`，从 `listDiskSessions({ limit: 100 })` 映射出 `MobileSessionMeta`。
  - `SessionList.tsx:43-53` 已有按项目 group/filter，`:144-161` 已有项目 pill filter，但没有“普通/CC”tab。
- CC/Codex 会话数据来源：
  - `useRemoteApp.ts:174-175` 保存 `ccSessions/ccProbe`，`useRemoteApp.ts:350-354` 收到 `ccRoom.listSessions.ok` 后 `setCcSessions(event.sessions)`。
  - 自动发现逻辑在 `useRemoteApp.ts:732-743`：按当前项目 cwd 和 `ccCliKind` 发送 `ccRoom.probe`、`ccRoom.listSessions`。
  - 协议类型在 `packages/desktop/src/main/mobile-remote/types.ts:111-117`、`:169-172`。
  - 主进程处理在 `packages/desktop/src/main/index.ts:1032-1041`，按 `kind` 调 `discoverCodexSessions` 或 `discoverSessions`。
  - `CcSessionList.tsx:55-67` 已有 Claude Code / Codex 内部切换按钮，`:93-119` 是 CC 会话自己的渲染循环。
- 可复用概念：`packages/desktop/src/mobile/styles.css:82-86` 已有 `.mobile-tab-strip`，目前 `PermissionModeControl.tsx` 使用它做 segmented control；但 `SidePane` 没有普通/CC tab state。

#### 根因

数据层已经分成 `sessions` 和 `ccSessions` 两条流，问题不在 hook 把两类 session 合并到同一数组，而在 `SidePane` 的组合方式：两个列表被塞进一个单列抽屉里上下各占一半，缺少一个明确的“左 = 普通会话，右 = CC 会话”的入口。

#### 推荐修法

- 在 `packages/desktop/src/mobile/App.tsx` 的 `SidePane` 内新增 tab state，例如 `const [tab, setTab] = useState<"sessions" | "cc">(app.activeRoom ? "cc" : "sessions")`。
- 在 `SidePane` 顶部加一个两段式 tab/segmented control：左按钮普通会话，右按钮 CC 会话。样式优先复用 `.mobile-tab-strip`，按钮 active 状态沿用现有 primary/outline token，不要新建桌面端样式。
- 把 `SidePane` 返回结构从当前两个 `flex-1` 上下堆叠改为：tab strip + 一个 `min-h-0 flex-1 overflow-hidden` 内容区；`tab === "sessions"` 时渲染 `SessionList`，`tab === "cc"` 时渲染 `CcSessionList`；footer 继续放底部。
- tab label 文案建议新增在 `packages/desktop/src/renderer/i18n/ns/mobile.ts`，例如：
  - `mobile.sidePane.localTab`: zh `会话` / en `Sessions`
  - `mobile.sidePane.ccTab`: zh `CC 会话` / en `CC`
  - 如要显示数量，可用 `localTabWithCount` / `ccTabWithCount`，分别取 `app.sessions.length` 和 `app.ccSessions.length`。
- 切换逻辑不要改 `useRemoteApp` 的数据来源；`SessionList` 和 `CcSessionList` 已经是两个独立组件。保留 `CcSessionList` 内部 Claude Code / Codex 切换，它是 CC tab 内的二级选择。
- 可选细节：当 `app.activeRoom` 存在时默认打开 CC tab；选择普通 session 后可切回普通 tab；打开抽屉时也可按当前 active 状态初始化，避免用户进入 CC 会话后还要再点一次 CC tab。

#### 涉及文件

- `packages/desktop/src/mobile/App.tsx`
- `packages/desktop/src/renderer/i18n/ns/mobile.ts`
- 测试建议放在 `packages/desktop/src/mobile/components/Lists.test.tsx` 或为可测试的 SidePane/tab 子组件新增测试文件；如果 `SidePane` 保持不导出，建议抽一个小的 `SidePaneTabs`/`MobileSessionSwitcher` 方便测试。

#### 量级

- M：主要是 `SidePane` 布局状态和 i18n，数据层无需重写；但需要兼顾手机抽屉、820px 以上常驻侧栏、activeRoom 默认态和现有 CC 内部 CLI 切换。

#### 建议测试

- 组件测试：渲染 tab 子组件，断言默认显示普通会话，点击 CC 后只显示 `CcSessionList` 内容，再点普通会话恢复 `SessionList`。
- 状态测试：`activeRoom` 存在时默认选中 CC tab；普通 session 选中后 tab/内容不串。
- 手工回归：手机宽度打开抽屉，确认顶部是左右两个按钮；左侧按钮显示普通会话/新建/项目 filter，右侧按钮显示 CC 会话和 Claude Code/Codex 二级切换；820px 以上侧栏也不再上下挤压两个列表。

### 4. 共用组件和误伤风险

- `packages/desktop/src/mobile/components/MessageStream.tsx`、`SessionList.tsx`、`CcSessionList.tsx`、`App.tsx` 是 mobile 专用 UI，改这些文件不会直接改桌面端 UI。
- `packages/desktop/src/renderer/i18n/ns/mobile.ts` 虽位于 renderer 目录，但命名空间是 mobile；新增 mobile key 风险较低，需要同时补 zh/en。
- `packages/desktop/src/renderer/lib/streamReducer.ts`、`packages/desktop/src/renderer/lib/messageMappers.ts` 放在 renderer/lib 下并被 mobile 复用；本次不建议为这两个优化点改它们，除非后续要做通用消息展开能力。
- `packages/core/src/cc-orchestrator/session-history.ts` 和 `codex-session-history.ts` 被桌面 CC room IPC 同时使用：桌面端 `CCConversationView.tsx:109-115` 也通过 `readHistory/readCodexHistory(..., 50)` 回放同一批历史。因此修复 4000 字符截断会同时影响桌面 CC/Codex 历史显示；这是合理的共享修复，但要跑桌面 CC room 回归，确认长历史不会造成明显卡顿。

总结：优化点 1 是 S（若只去掉/提高 CC/Codex 历史 4000 字符截断）或 M（若要做展开完整回复）；优化点 2 是 M（SidePane tab 化，不改数据层）。需要编排者再决策的只有优化点 1 是否接受更大历史 payload，还是走“截断标记 + 展开加载完整内容”的交互方案。

## 2026-07-08 移动端远程控制：审批卡片和重连补流

### 问题 A：AskUserQuestion 审批卡片不会自动消失

#### 现状

- 手机端卡片挂载点是 `packages/desktop/src/mobile/App.tsx:76-78` 的 `<ApprovalsArea app={app} />`。
- `ApprovalsArea` 在 `packages/desktop/src/mobile/App.tsx:262-310` 渲染 `div.mobile-approval-stack`，逐个把 `app.approvals` 渲染成 `ApprovalCard`。
- `ApprovalCard` 在 `packages/desktop/src/mobile/components/ApprovalCard.tsx:23-25` 注释说明同一张卡承载普通审批、记住范围、路径范围和 AskUser；`ApprovalCard.tsx:34` 用 `approval.options?.length` 判断 AskUser；`ApprovalCard.tsx:84-140` 渲染选项按钮、自定义回答和取消按钮。
- 手机端审批状态在 `packages/desktop/src/mobile/hooks/useRemoteApp.ts:159-161`：`approvals` + `approvalsRef`。
- 普通 desktop session 的 AskUser/审批来自 worker raw line：`useRemoteApp.ts:463-487` 处理 `agent/approvalRequest`，用 `extractAskUserOptions(rq.args)` 把 `__ask_user__` 的 `options/optionsOnly` 转成 `PendingApproval`。
- 手机端也支持 typed 旧协议 `approval.request`：`useRemoteApp.ts:330-340`；对应协议类型在 `packages/desktop/src/main/mobile-remote/types.ts:127-138`。
- CC room 的 AskUser/审批来自 typed `ccRoom.approvalRequest`：`useRemoteApp.ts:393-424`；对应协议类型在 `types.ts:157-173`。CC resolved 会在 `useRemoteApp.ts:427-431` 清卡。
- 普通 session typed resolved 会在 `useRemoteApp.ts:261-266` 清卡；普通 live stream 的 `turn_complete` / `error` 也会在 `useRemoteApp.ts:515-523` 粗粒度清空当前卡。
- 手机自己点卡时会乐观清卡：普通审批在 `useRemoteApp.ts:648-678`，CC room 审批在 `useRemoteApp.ts:603-617`。

#### 根因

- 用户标注的是 AskUserQuestion 选项卡，最像普通 desktop session 的 `__ask_user__` 路径，不是 CC room 路径。普通 AskUser 在手机端是从 raw `agent/approvalRequest` 建卡，但手机端 `onRawLine` 只处理 `agent/approvalRequest` 和 `agent/streamEvent`，没有处理 raw `agent/approvalResolved`：见 `useRemoteApp.ts:460-527`。
- 桌面端普通 AskUser 被单独路由为聊天内联卡：`packages/desktop/src/renderer/App.tsx:1749-1808`。用户在桌面端回答时，`handleAskUserAnswer` 只调用 `window.codeshell.approve(...)` 并本地 `ask_user_answered`：`App.tsx:3084-3118`，没有像普通审批 `decideEnvelope` 那样调用 `window.codeshell.mobileRemote.notifyApprovalResolved(...)`。
- 普通审批弹卡在桌面端做了手机通知：`App.tsx:2521-2525`。bypass 自动批准也会通知手机：`App.tsx:1836-1840`。AskUser 内联回答缺这一步，所以“桌面已处理，手机还挂着”成立。
- core 的普通 approve handler 也不会在用户回答时主动发 resolved：`packages/core/src/protocol/server.ts:656-674` 只是删除 pending、清 timer、resolve，并返回 RPC ok。
- goal-active AskUser 的 10 分钟超时会发 raw `agent/approvalResolved`：`server.ts:1941-1968`，桌面 preload 在 `packages/desktop/src/preload/index.ts:130-135` 分发给 renderer，renderer 在 `App.tsx:1847-1870` 把内联 AskUser 标记为超时并移除 pending approval。但手机端没有处理这个 raw method，因此即使收到同一条 worker line，也不会清 `approvals`。
- 如果手机断线/后台挂起期间桌面已回答或 AskUser 已超时，当前 mobile 也没有 pending approvals hydrate/snapshot；重连后本地 `approvals` 不会按 server 当前 pending 状态对齐。

#### 桌面端已有机制对照

- core 工具审批默认 5 分钟：`packages/core/src/protocol/server.ts:145-146` 定义 `APPROVAL_TIMEOUT_MS`，`server.ts:1857-1884` 在 `requestApprovalFromClient` 里超时 resolve `{ approved:false, reason:"approval timed out" }`。
- core 普通交互 AskUser 明确无 wall-clock timeout：`server.ts:1894-1900`；只有 goal-active AskUser 使用 10 分钟：`server.ts:147-154` 和 `server.ts:1941-1968`。
- Stop/cancel 会 drain session pending approvals，但不广播 resolved：`server.ts:699-729` 调 `cancelSessionApprovals`，实现见 `server.ts:2228-2248`。
- 桌面 renderer 的普通审批卡会在 `agent/approvalResolved` 时移出 queue：`packages/desktop/src/renderer/App.tsx:1847-1870`；AskUser 内联卡也在同一 handler 中标为 `msg.ask.timedOut`。
- CC room 已经有完整 resolved 广播：`packages/desktop/src/main/cc-room/approval-bridge.ts:43-55` 超时 auto-deny，`:58-66` 用户响应 resolved；main 在 `packages/desktop/src/main/index.ts:384-400` 同时推桌面 IPC 和手机 WS；桌面 CC 在 `packages/desktop/src/renderer/cc-room/CCConversationView.tsx:132-135` 清 pending；手机在 `useRemoteApp.ts:427-431` 清 pending。这个路径相对完整。

#### 推荐修法

- 最小修法 S：在 `packages/desktop/src/renderer/App.tsx` 的 `handleAskUserAnswer` 中，`window.codeshell.approve(...)` 后补一条与普通审批一致的 `window.codeshell.mobileRemote.notifyApprovalResolved({ requestId, sessionId: engineSessionId, approved: true })`。这直接修复“桌面端已回答 AskUser，手机还挂着”。
- 最小修法 S：在 `packages/desktop/src/mobile/hooks/useRemoteApp.ts` 的 `onRawLine` 增加 `obj.method === "agent/approvalResolved"` 分支，读取 `params.requestId` 后从 `approvals` 过滤掉。这样 goal AskUser 10 分钟超时的 raw resolved 即使没有 typed `approval.resolved`，手机也能清卡。
- 可选 S：在 `packages/desktop/src/main/index.ts:1336-1338` 的 mobile raw tap 旁解析 `agent/approvalResolved`，复用 `broadcastApprovalResolved(...)` 推 typed `approval.resolved`。手机已有 typed handler，且重复清卡是幂等的。
- 稍完整 M：main 侧维护 mobile pending approval registry。收到 `agent/approvalRequest` / `ccRoom.approvalRequest` 时登记，收到 `agent/approvalResolved`、`mobileRemote:approvalResolved`、`ccRoom.approvalResolved`、turn terminal、cancel/close 时删除；手机 auth/reconnect 后下发 `approval.snapshot`，`useRemoteApp` 用 server pending 列表替换/对齐本地 `approvals`。这能覆盖“手机后台断线期间已在别处应答/超时”的情况。
- 不建议只给 `ApprovalCard` 自己加超时：普通交互 AskUser 在 core 里是刻意无超时的，UI 自行消失会制造“卡没了但 engine 仍在等回答”的假象；它也不能解决“桌面端已在别处应答”的跨端一致性。

#### 涉及文件

- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/mobile/hooks/useRemoteApp.ts`
- 可选：`packages/desktop/src/main/index.ts`
- 如做 pending snapshot：`packages/desktop/src/main/mobile-remote/types.ts`、`packages/desktop/src/main/index.ts`、`packages/desktop/src/mobile/hooks/useRemoteApp.ts`

#### 量级

- S：补桌面 AskUser answer 的 mobile resolved 通知 + mobile raw `agent/approvalResolved` handler。
- M：增加 pending approvals server snapshot/hydrate，解决断线期间 resolved 丢失。
- 不建议做纯 UI timeout。

#### 建议测试

- renderer 单测或集成测试：触发 `handleAskUserAnswer` 后断言调用 `mobileRemote.notifyApprovalResolved({ requestId, sessionId, approved:true })`。
- mobile hook 单测：先注入一个 AskUser `agent/approvalRequest`，再注入 raw `agent/approvalResolved`，断言 `approvals` 清空。
- main/mobile WS 集成测试：模拟桌面普通审批、桌面 AskUser 回答、goal AskUser timeout、CC room timeout，断言手机都收到 resolved 或本地 pending 被清掉。
- 回归：手机打开 `/mobile/`，桌面端回答 AskUser；手机卡应自动消失。再测手机后台 10 分钟 goal AskUser timeout，回来后不应还显示可回答卡。

#### 桌面端影响

- 改 `packages/desktop/src/mobile/**` 只影响 mobile。
- 在 `packages/desktop/src/renderer/App.tsx` 给 AskUser answer 补 `mobileRemote.notifyApprovalResolved` 会影响桌面 renderer 的 AskUser 回答路径，但行为只是额外通知 mobile，不应改变桌面 UI。
- 如果改 core 的 `server.ts` 让用户回答/取消/工具超时都发 `agent/approvalResolved`，会同时影响桌面 renderer，因为桌面已经订阅 `onApprovalResolved`；必须确认不会让已回答的内联 AskUser 被二次标成 timeout。
- CC room 的 `ApprovalBridge` / `RoomManager` 是桌面 CC room 和 mobile 共用；改这里会同时影响桌面 `CCConversationView`。

### 问题 B：手机端切走再回来只看到最新，中间内容丢失

#### 现状：重连和 hydrate 数据流

- `packages/desktop/src/mobile/hooks/useRemoteSocket.ts:196-204` 只监听 `online` 和 `visibilitychange`；没有 `pagehide/pageshow/focus`，也没有 heartbeat。
- `reconnectNow` 在 `useRemoteSocket.ts:79-84` 如果 `ws.readyState === WebSocket.OPEN` 就直接返回。手机后台后 socket 可能看起来仍 open，但中间广播已经错过；切回可见时不会强制 resync。
- socket 断开时只 `setStatus("offline")` 并 backoff：`useRemoteSocket.ts:178-184`；连接成功 auth 后只 `setStatus("online")`：`useRemoteSocket.ts:155-160`。
- `App.tsx:36-43` 在 status online 时只 `refreshSessions()`；`useRemoteApp.ts:717-724` 在 online/activeCwd 变化时拉 `room.list` 和 `room.projects`。没有针对当前 active session / active room 的断点补流。
- 手动选择普通 session 才会 reset 并拉历史：`useRemoteApp.ts:562-574`；`session.history.ok` 用 `dispatchChat({ kind:"replay", events })`：`useRemoteApp.ts:245-249`。
- mobile chat reducer 的 `replay` 是全量覆盖：`useRemoteApp.ts:143-147` 从 `initialChatState()` reduce，而不是在现有状态后 append。
- server 普通 session history 是磁盘 transcript 全量折叠：`packages/desktop/src/main/mobile-remote/mobile-history.ts:14-24`；main handler 在 `packages/desktop/src/main/index.ts:821-824` 返回 `{ type:"session.history.ok", events }`。协议没有 cursor。
- 普通 live stream 只是 main 把 worker raw line 广播给手机：`packages/desktop/src/main/index.ts:1332-1338`；断线期间广播不会缓冲到设备。
- main 已有普通 session in-memory snapshot：`packages/desktop/src/main/agent-bridge.ts:98-102` 保存，`agent-bridge.ts:193-196` 追加 stream event，`agent-bridge.ts:520-526` 可按 `sinceSeq` 读取。但它只通过桌面 IPC `agent:subscribe` 暴露：`packages/desktop/src/main/index.ts:2947-2956` 和 `packages/desktop/src/preload/index.ts:546-552`，mobile WS 协议没接上。
- 桌面 renderer 已使用这套 snapshot 修复 remount/reconnect：`packages/desktop/src/renderer/App.tsx:794-810` 读取 `subscribeSession(engineId, 0)` 并 replay main-held snapshot。
- room 协议已经有 `sinceSeq`：`packages/desktop/src/main/mobile-remote/types.ts:110`，server 在 `packages/desktop/src/main/index.ts:988-991` 用 `roomManager.getMessages(event.roomId, event.sinceSeq ?? 0)` 返回 `latestSeq`。
- `RoomManager` 的消息有单调 seq：`packages/desktop/src/main/mobile-remote/room-manager.ts:111-129`，`getMessages` 在 `room-manager.ts:313-327` 支持 `sinceSeq`。
- mobile 目前打开 CC room 时仍发送不带 since 的 `room.history`：`useRemoteApp.ts:382`；`room.history.ok` 对普通 room 是全量 replay reset：`useRemoteApp.ts:280-291`；对 CC session 因 `ccHistorySessionRef.current` 直接跳过，避免 clobber CC backlog：`useRemoteApp.ts:282-288`。
- CC session 打开时 `ccRoom.readHistory` 只拉最近 50 条：`useRemoteApp.ts:373-380`；server 返回 `hasMore/totalCount` 但 mobile 不提供续拉：`packages/desktop/src/main/index.ts:1055-1066`；`ccRoom.readHistory.ok` 也是全量 replay reset：`useRemoteApp.ts:384-390`。
- 手机消息流默认会贴底：`packages/desktop/src/mobile/components/MessageStream.tsx:121-125` 的 `stickRef` 初始 true 且 items 变化就 `scrollIntoView`；只有用户触发 scroll 后才按 `MessageStream.tsx:127-130` 更新是否贴底。全量 replay 后很容易跳到最新。

#### 根因

- mobile 当前是“在线时收 live broadcast，手动打开时拉 latest snapshot/full history”的模型；没有 per-device 事件缓冲，也没有 active view 的 reconnect resume。
- 普通 session 的断点续传能力已经存在于 desktop IPC 的 `AgentBridge.SessionSnapshotStore`，但 mobile WS 协议没有 `session.snapshot/sync`，live raw event 也没有携带 main 分配的 seq，手机无法知道自己最后应用到哪个 seq。
- room/CC live 消息本身有 seq 和 `sinceSeq`，但 mobile hook 没保存 `latestSeq`，重连也不主动请求 `room.history(sinceSeq)`；对 CC 还跳过了 `room.history.ok`，导致 room 侧断线期间消息无法补到当前 feed。
- hydrate/replay 使用全量 reset，会把用户当前阅读位置和中间 streaming 过程替换成折叠后的最新状态；如果只拉最近 50 条 CC 历史，较早可见内容也会被裁掉。
- 浏览器后台恢复时 `readyState === OPEN` 的半死 socket 不会触发 reconnect/resync；即使后续 close/reconnect，也只刷新列表，不补当前内容。

#### 最小改法 vs 完整改法

- 最小改法 S：在 `useRemoteApp` 里记录 socket 从 offline/authenticating 回到 online 或页面 visible/focus 后的“需要 resync”信号；如果 `activeSessionId` 存在，重新发 `session.history`；如果 `activeRoomId` 存在，发 `room.history`。这不能保留细粒度 streaming delta，但能至少用磁盘/room 日志恢复最终可见内容。
- 最小改法 S：给 `MessageStream` 增加 active conversation key 和滚动锚点保存。`visibilitychange hidden/pagehide` 时记录 `scrollTop/scrollHeight` 或首个可见 message id；replay 后如果用户原本不在底部，按锚点恢复，而不是默认跳到最新。只有原本贴底时继续贴底。
- 最小改法 S：CC `ccRoom.readHistory` 的 mobile limit 从 50 提到 150/200，或加“加载更早”入口；`hasMore/totalCount` 已有返回值但未用。这样降低“回来只剩最新几十条”的概率。
- 最小改法 S/M：利用 room 现有 `sinceSeq`。mobile 保存每个 active room 的 `lastRoomSeq`，live `room.message` 和 `room.history.ok.latestSeq` 都更新它；重连后发 `room.history({ sinceSeq:lastRoomSeq })`，收到后 append，而不是全量 reset。CC session 不要无条件跳过 `room.history.ok`，应只把 `sinceSeq` 之后的 room live log append 到 CC backlog 后面。
- 较完整改法 M：给 mobile WS 增加普通 session 的 `session.snapshot` / `session.sync`：server 调 `bridge.getSnapshot(sessionId, sinceSeq)`，返回 `{ entries:[{seq,event}], nextSeq }`；mobile 像桌面 `snapshotReplay.ts` 一样维护 `appliedSeq` 并增量 apply。为了让 live 和 snapshot 对齐，main 广播给 mobile 的 live event 需要携带同一个 seq，或新增 typed `session.stream` 事件替代纯 raw broadcast。
- 较完整改法 M/L：增加长断线 fallback。main 已有 `rawTranscript.ts:1-8` 的 `sinceId` 设计和 `sessions:rawEvents` IPC：`packages/desktop/src/main/index.ts:2985-2988`，但 mobile 没协议。可以给 mobile 增加 `session.rawEvents` 或增强 `session.history` 支持 `sinceId`，在 snapshot 窗口被 2000 条上限淘汰后从磁盘 transcript 补齐。
- 完整改法 L：为 mobile remote 做统一事件日志/ack。所有 mobile server events（普通 stream、approval request/resolved、room.message、room approval、session title）都有 monotonically increasing cursor；客户端 auth/reconnect 时带 last cursor，server 补发缺口。这样才能同时解决中间 stream、审批 resolved、room 消息和多设备一致性。

#### 涉及文件

- 最小：`packages/desktop/src/mobile/hooks/useRemoteSocket.ts`、`packages/desktop/src/mobile/hooks/useRemoteApp.ts`、`packages/desktop/src/mobile/components/MessageStream.tsx`
- 普通 session 增量续传：`packages/desktop/src/main/mobile-remote/types.ts`、`packages/desktop/src/main/index.ts`、`packages/desktop/src/main/agent-bridge.ts` 或 `SessionSnapshotStore.ts`、`packages/desktop/src/mobile/hooks/useRemoteApp.ts`
- room/CC 增量续传：`packages/desktop/src/main/mobile-remote/room-manager.ts`、`packages/desktop/src/main/index.ts`、`packages/desktop/src/mobile/hooks/useRemoteApp.ts`
- 长断线 fallback：`packages/desktop/src/main/rawTranscript.ts`、`packages/desktop/src/main/mobile-remote/mobile-history.ts`、`packages/desktop/src/main/mobile-remote/types.ts`

#### 量级

- S：重连/可见时重新 hydrate 当前会话 + 保持滚动位置 + 提高 CC history limit。
- M：room 利用已有 `sinceSeq` 做增量 append；普通 session 暴露 `AgentBridge` snapshot 给 mobile 并跟踪 `appliedSeq`。
- L：统一 mobile event cursor/ack + durable replay，覆盖长断线和审批状态。

#### 建议测试

- `useRemoteSocket` 测试：模拟 `visibilitychange` / `online` / 半开 open socket，断言会触发 resync callback 或 force reconnect 策略。
- `useRemoteApp` 测试：断线期间注入多条 stream/room message，重连后用 `session.snapshot` 或 `room.history(sinceSeq)` 补齐，断言 reducer append 不重置、不重复。
- `MessageStream` DOM 测试：用户不在底部时 replay 后滚动位置保持；用户在底部时新消息继续贴底。
- main WS 集成测试：普通 session snapshot `sinceSeq` 返回缺口；room `sinceSeq` 只返回增量；CC history limit/hasMore 行为可见。
- 手工回归：手机切到后台 1-3 分钟，桌面持续输出多段流式内容；切回 `/mobile/` 后应看到中间内容，且阅读位置不被强制拉到底。

#### 桌面端影响

- `packages/desktop/src/mobile/**` 和 `packages/desktop/src/main/mobile-remote/types.ts` 的 mobile-only 协议扩展不会直接影响桌面 UI。
- 如果复用/调整 `AgentBridge`、`SessionSnapshotStore`、`parseStreamLine`，会影响桌面 renderer 的 `agent:subscribe` 恢复路径；必须保持现有 IPC 返回 shape 和 seq 语义。
- `RoomManager` 和 `ApprovalBridge` 同时服务桌面 CC room 与 mobile CC room；任何 room history/seq 或 approval resolve 语义变化都要回归 `packages/desktop/src/renderer/cc-room/CCConversationView.tsx`。
- `rawTranscript.ts` / `transcript-reader.ts` 是桌面 session history 共用能力；如果为 mobile 增强长断线 fallback，避免改变 `sessions:transcript` 当前折叠输出，优先新增 mobile 专用接口。

总结：问题 A 的直接修复是 S；若要覆盖手机断线期间已 resolved 的卡片，需要 M 级 pending snapshot。问题 B 的止血是 S（重连 hydrate + 滚动保持 + 更长历史），真正不丢中间流需要 M（普通 session/room 按 cursor 增量续传），跨长断线和审批一致性的一体化方案是 L。需要编排者决策的是：B 是否先接受“回来后恢复最终内容但不保证完整 streaming 过程”的 S 方案，还是直接投入 M/L 做 cursor-based replay。

## 2026-07-08 只读探查：mobile remote loading 圈与未读圆点

### 1. 桌面端参照实现

#### Loading 圈 / 运行中指示

- 桌面端真正的“会话正在跑”spinner 在会话侧边栏行内：`packages/desktop/src/renderer/Sidebar.tsx:589-593` 对 `status === "running"` 渲染 `Loader2` + `animate-spin`，文案 aria 是 `sidebar.sessionRunning`。
- 这个 `status` 来自 `Sidebar` 的 `sessionStatuses`：`packages/desktop/src/renderer/Sidebar.tsx:31-39` 声明 prop，项目会话行在 `Sidebar.tsx:268` 用 `bucketKey(repo.id, sid)` 查状态，无项目会话在 `Sidebar.tsx:290` 查状态。
- `sessionStatuses` 由 `App` 计算：`packages/desktop/src/renderer/App.tsx:238` 是 `busyKeys`，`App.tsx:245` 是 interrupt relay 用的 `relayingBuckets`，`App.tsx:473-519` 把 asking / running / unread 解析成每个 bucket 的状态。状态优先级在 `packages/desktop/src/renderer/sessionStatus.ts:10-25`：`asking > running > unread`。
- `busyKeys` 的主要置位/清除点：
  - 用户发送时先插入 user bubble 并 `setBusyForKey(bucket, true)`：`packages/desktop/src/renderer/App.tsx:2020-2028`。
  - 收到 `session_started` 时也置 busy，覆盖 core 主动唤醒或重挂载路由场景：`App.tsx:1498-1510`。
  - 顶层 `turn_complete` / `error` 清 busy，子代理事件因有 `agentId` 不清：`App.tsx:1544-1553`。
  - run promise 兜底清 busy：`App.tsx:2100-2108`；异常 reject 也清：`App.tsx:2130-2139`；手动 stop 清：`App.tsx:2398-2405`。
  - automation/mobile session announce 也会先点亮 running：`App.tsx:1655-1664`、`App.tsx:1737-1740`。
- 桌面端消息流内不是 spinner 圈，而是 live activity line：`packages/desktop/src/renderer/MessageStream.tsx:291` 在 `liveTurnActive` 时渲染 `LiveActivityLine`；`packages/desktop/src/renderer/messages/LiveActivityLine.tsx:4-9` 明确说明是“正在思考/正在读取”的脉冲文字，`LiveActivityLine.tsx:21-24` 只给文字加 `animate-pulse`，没有 spinner icon。
- `liveTurnActive` 的驱动是 active bucket 的 `busy` + reducer streaming 状态：`packages/desktop/src/renderer/App.tsx:901-913`。其中 `state.streamingAssistantId` 在 reducer 里由 `stream_request_start` 设置：`packages/desktop/src/renderer/types.ts:282-289`、`:443-456`，由 `turn_complete` 清空：`types.ts:968-1033`，`error` 也清空：`types.ts:1036-1053`。桌面 assistant bubble 本身只渲染文本/Markdown：`packages/desktop/src/renderer/messages/AssistantMessageView.tsx:16-21`、`:46-49`。
- 需要排除的非生成态 spinner：`packages/desktop/src/renderer/ChatView.tsx:872-878` 是历史 hydrate 的居中 spinner；`ChatView.tsx:1338-1342` 是语音转写 spinner。它们不是 assistant 生成中的参照。

结论：桌面端“loading 圈”主要是会话级 running spinner；当前活跃消息流内对应的是 `LiveActivityLine` 的脉冲文字，不是圈形 spinner。

#### 未读圆点

- 桌面端未读是“会话级未读”，不是消息级未读。`App.tsx:246-249` 注释写明 `unreadBuckets` 是“bucket finished a turn while the user was viewing a different session”，不持久化，只是 live 提示。
- 触发条件：顶层 `turn_complete` / `error` 到来后，如果事件所属 `target !== activeBucketRef.current`，就把 target 加入 `unreadBuckets`：`packages/desktop/src/renderer/App.tsx:1552-1573`。子代理 `agentId` 的 terminal 事件不会触发：`App.tsx:1544-1551`。
- 清除条件：用户选择该 session 时清除对应 bucket：`packages/desktop/src/renderer/App.tsx:1050-1059`。没有看到按“滚到底”清除的消息级 unread 逻辑。
- UI 落点：`unreadBuckets` 参与 `sessionStatusMap`：`App.tsx:457-519`；`SessionRow` 在 `status === "unread"` 时渲染一个静态圆点：`packages/desktop/src/renderer/Sidebar.tsx:600-605`。同一位置的 `asking` 是脉冲圆点：`Sidebar.tsx:594-599`，`running` 是 spinner：`Sidebar.tsx:589-593`。
- 搜索 `unread/unseen/badge/dot/hasNew/newMessage` 未发现桌面消息流内“某条消息未读点”的实现；与本问题相关的是 sidebar 会话行状态点。

### 2. 移动端现状与缺口

#### Loading 圈

- `packages/desktop/src/mobile/components/MessageStream.tsx:60-72` 已经在 streaming assistant bubble 里显示 `▋` 光标，`!item.done` 时 `animate-pulse`。这能表示“这个 assistant bubble 未完成”，但不等于桌面侧边栏的 `Loader2 animate-spin` running spinner，也不是“agent busy 但还没吐字”的整体 loading 圈。
- mobile assistant 行左侧永远是 Bot 图标：`MessageStream.tsx:92-100`，不会根据 `item.done` 或 `chat.run` 换成 spinner。
- mobile 只有空消息列表加载态：`MessageStream.tsx:198-210` 在 `chat.items.length === 0` 且 `loading` 时显示一个脉冲小点 + loading 文案；`App.tsx:108-115` 传入的是 `app.loading.sessionHistory || app.loading.roomHistory`。这只是历史/room 读取态，不是正在生成态。
- 会话列表也有 loader，但只表示列表刷新或 CLI 探测：`packages/desktop/src/mobile/components/SessionList.tsx:72-81`、`:163-168`，`packages/desktop/src/mobile/components/CcSessionList.tsx:74-86`。
- mobile 已有可用的运行状态：`ChatState.run` 定义在 `packages/desktop/src/renderer/lib/streamReducer.ts:25`、`:51-63`；`stream_request_start` 设置 `run: "running"`：`streamReducer.ts:143-161`，`text_delta` / `thinking_delta` 保持 running：`:164-226`，`tool_use_start` 设置 running：`:229-257`，CC/room 的 `assistant_text` 也设置 running：`:491-516`；顶层 `turn_complete` 把 run 设成 completed/idle/error：`:368-384`，`error` 设成 error：`:463-474`。
- `App.tsx:116-120` 用 `app.chat.run === "running" || app.chat.run === "waiting"` 控制 Composer 的 Stop 按钮；`packages/desktop/src/mobile/components/StatusBar.tsx:45-67` 顶栏也把 running 显示为脉冲小点。缺口是 MessageStream 内没有桌面同类的 running spinner/活跃行。

#### 未读圆点

- `SessionList` 当前没有 unread/running/asking 状态点，列表行只显示标题、automation badge、cwd 和相对时间：`packages/desktop/src/mobile/components/SessionList.tsx:190-218`。
- `MobileSessionSwitcher` 只有“会话 / CC”两个 tab，没有 tab badge 或圆点：`packages/desktop/src/mobile/components/MobileSessionSwitcher.tsx:50-77`。
- `CcSessionList` 当前也没有 unread badge；每行只显示 firstMessage、messageCount、lastModified：`packages/desktop/src/mobile/components/CcSessionList.tsx:93-116`。`CcDiscoveredSession` 类型也只有 `sessionId/firstMessage/lastModified/messageCount`：`packages/desktop/src/main/mobile-remote/types.ts:29-35`。
- 普通 session 的协议和数据层已经有增量 seq：client 可发 `session.sync`：`packages/desktop/src/main/mobile-remote/types.ts:82-85`，server 回 `session.snapshot` / live `session.stream`：`types.ts:145-150`。main 侧 `session.sync` 调 `bridge.getSnapshot`：`packages/desktop/src/main/index.ts:833-844`；live stream 广播带 `seq`：`main/index.ts:1345-1356`。mobile hook 已用 `appliedSeqRef` 去重并 append 当前绑定 session：`packages/desktop/src/mobile/hooks/useRemoteApp.ts:338-363`。
- 但这些 seq 目前只用于“当前绑定会话”的补流/去重。`useRemoteApp.ts:350-363` 对非当前 session 的 `session.stream` 直接跳过，没有维护 per-session unread 集合；`MobileSessionMeta` 也没有 unread/running 字段：`packages/desktop/src/main/mobile-remote/types.ts:194-201`。
- room/CC 侧也有 seq：client 可发 `room.history(sinceSeq)`：`types.ts:99-111`，RoomManager 消息带 `seq`：`packages/desktop/src/main/mobile-remote/room-manager.ts:111-130`，`getMessages(id, sinceSeq)` 支持增量：`room-manager.ts:313-327`。mobile hook 维护 `lastRoomSeqRef` / `appliedRoomSeqsRef`：`useRemoteApp.ts:208-211`、`:241-249`、`:402-412`、`:656-665`。但它同样只服务当前 `activeRoomId`，不会给 `CcSessionList` 的非当前 session 标 unread。
- `useRemoteSocket` 已会在 auth online、visible、focus、pageshow 触发 resync：`packages/desktop/src/mobile/hooks/useRemoteSocket.ts:179-186`、`:224-244`；这能补当前会话内容，但不是未读状态本身。

结论：mobile 目前没有桌面同款“会话级未读圆点”。普通 session 有足够的 live `session.stream seq` 能在 hook 内做会话级 unread；CC session 只有 active room 的 seq 和 discovery 的 `lastModified`，做精确 per-CC-session unread 需要额外映射/状态。

### 3. 推荐修法

#### Loading 圈

- 对齐桌面端时，先做 MessageStream 内的 active-run 指示，而不是改会话列表。建议给 `MessageStream` 增加 `running?: boolean`，由 `App.tsx:116-120` 已经使用的同一条件传入：`app.chat.run === "running" || app.chat.run === "waiting"`。
- UI 落点建议放在“正在生成的 assistant 气泡处”：
  - 如果最后一个 assistant item 是 `done:false`，在 `MessageStream.tsx:92-100` 的 Bot 头像位置或 `AssistantBubble` 文本前加 `Loader2 size-3/3.5 animate-spin text-status-running`。
  - 如果 `running === true` 但还没有 assistant item 或最后一条还是 user，可在 `MessageStream.tsx:224-227` 列表尾部渲染一个轻量 assistant placeholder（Bot + spinner + `mobile.stream.thinking`），避免用户发送后到 `stream_request_start` 之间没有反馈。
- 保留现有 `▋` 光标：它表达“当前 bubble 正在流式补字”，spinner 表达“turn/agent busy”。二者语义不同。
- 量级：S。主要改 `MessageStream.tsx` + `App.tsx` 传参 + `mobile.ts` 增加一条可选文案；如做更接近桌面的 live activity 文案（正在读文件/正在执行工具）再升到 M，因为要复用/移植 `topbar/liveActivity` 或 mobile mapper。

#### 未读圆点

- 先对齐桌面端为“会话级未读”，不要做消息级 unread。桌面触发/清除都是 session bucket 维度：完成于非当前会话时标记，选择该会话时清除。
- 普通 session 推荐在 `useRemoteApp` 增加 `unreadSessionIds: Set<string>` 和可选 `runningSessionIds: Set<string>`：
  - 在 `session.stream` 分支收到非当前 `event.sessionId` 时，不 reduce 到当前 chat，但可以检查 `event.event.type`。`stream_request_start` 标 running；顶层 `turn_complete` / `error` 清 running 并把该 session 加 unread；如果是当前 bound session，只更新当前 chat，不加 unread。
  - `selectSession` 时清除该 id 的 unread：对应当前 `useRemoteApp.ts:714-727`。
  - `session.list.ok` 可用来裁剪不存在的 unread id：`useRemoteApp.ts:321-330`。
- UI 落点：
  - `SessionList` 增加 `statusFor?: (id:string) => "running" | "unread" | undefined` 或 `unreadSessionIds/runningSessionIds` prop，在 `SessionList.tsx:200-209` 标题行右侧加 `Loader2 animate-spin` 或 `h-2 w-2 rounded-full bg-primary`，样式可直接模仿桌面 `Sidebar.tsx:589-605`。
  - `MobileSessionSwitcher` 可加 tab 级小圆点/count：当 sessions tab 下存在 unread 普通会话，或未来 CC tab 下存在 unread CC 会话时，在 `MobileSessionSwitcher.tsx:56-71` 的 label 旁渲染小圆点。这个是可选，但手机抽屉关闭时更容易发现另一个 tab 有新内容。
- CC session 的策略建议分两档：
  - S/M 档先用 `CcDiscoveredSession.lastModified` 和本机 `lastSeenCcSessionAt` 做弱 unread：打开某 CC session 时记录 seen time；列表刷新后若 `lastModified > seenAt` 且不是当前 active room，则显示 unread。数据点在 `types.ts:29-35` 和 `CcSessionList.tsx:112-114` 已存在。
  - 更精确的 M 档需要服务端把 CC discovered session 与 roomId/lastSeq 对齐，或让 `ccRoom.listSessions.ok` 带 per-session latest cursor；mobile 才能像普通 session 一样用 seq 判断 unread。现有 `lastRoomSeqRef` 只适用于当前 active room，不足以判断所有 `CcSessionList` 行。
- 清除时机：与桌面对齐，选择/打开该会话即清除；如果后续要更像消息阅读器，可在当前会话内“滚到底”再清，但这会偏离桌面当前机制，建议不作为第一版。
- 量级：普通 session 会话级 unread 是 M（hook 状态 + list UI + 测试）；只给 `SessionList` 加 dot 不碰 CC 是 S/M。CC 精确 unread 是 M；用 `lastModified > seenAt` 的弱提示是 S/M。

### 4. 涉及文件清单

- Mobile UI：`packages/desktop/src/mobile/components/MessageStream.tsx`、`packages/desktop/src/mobile/App.tsx`、`packages/desktop/src/mobile/components/SessionList.tsx`、`packages/desktop/src/mobile/components/MobileSessionSwitcher.tsx`、可选 `packages/desktop/src/mobile/components/CcSessionList.tsx`。
- Mobile 状态：`packages/desktop/src/mobile/hooks/useRemoteApp.ts`、已有 helper/test 可扩展 `packages/desktop/src/mobile/hooks/remoteAppSync.ts`、`packages/desktop/src/mobile/hooks/remoteAppSync.test.ts`。
- Mobile i18n：`packages/desktop/src/renderer/i18n/ns/mobile.ts`。它位于 renderer 目录但只 owns `mobile` namespace：`mobile.ts:1-18`、`:53-56`、`:98-114`、`:200-203`、`:246-262`。
- 协议/主进程仅在做 CC 精确 unread 或 server-side session status 时需要：`packages/desktop/src/main/mobile-remote/types.ts`、`packages/desktop/src/main/index.ts`、`packages/desktop/src/main/mobile-remote/room-manager.ts`。

### 5. 建议测试

- `MessageStream` 组件测试：复用 `packages/desktop/src/mobile/components/MessageStream.test.tsx`，覆盖 `running=true` 且无 assistant item 时出现 placeholder/spinner；`done:false` assistant 出现 spinner + 保留 `▋`；`done:true` 不显示 spinner。
- `useRemoteApp`/helper 测试：扩展 `packages/desktop/src/mobile/hooks/remoteAppSync.test.ts` 或新增 hook 测试，模拟非当前 session 的 `session.stream(stream_request_start)`、`session.stream(turn_complete)`，断言 running/unread 集合变化；模拟 `selectSession` 清除 unread。
- `SessionList`/`MobileSessionSwitcher` 测试：扩展 `packages/desktop/src/mobile/components/Lists.test.tsx` 和 `MobileSessionSwitcher.test.tsx`，断言 session row dot、running spinner、tab badge/count 渲染，active/点击后状态清除由上层回调驱动。
- 主进程集成测试（仅做 server-side unread/CC seq 时需要）：模拟 `session.stream` 广播和 `room.history(sinceSeq)`，断言 mobile 能收到足够 cursor 信息但不会重复 append。
- 手工回归：手机打开 `/mobile/`，A 会话运行时切到 B 会话，A 完成后列表应显示未读圆点；点 A 后圆点消失。发送后到首 token 前应看到 spinner；流式中 spinner/`▋` 不互相遮挡；完成后 spinner 消失。

### 6. 共用代码与误伤风险

- 改 `packages/desktop/src/mobile/**` 基本是 mobile 专用，不会直接改桌面聊天 UI。
- `packages/desktop/src/renderer/i18n/ns/mobile.ts` 虽在 renderer 下，但是 mobile namespace；只新增 `mobile.*` key 风险低，需要 zh/en 同步。
- `packages/desktop/src/renderer/lib/streamReducer.ts`、`packages/desktop/src/renderer/lib/messageMappers.ts` 被 mobile 复用，也可能被桌面 renderer/lib 相关测试覆盖；本次 loading/unread 不建议改 reducer 语义，优先在 `useRemoteApp` 外围派生状态，避免影响消息折叠/完成态。
- 如果为了更精确的 CC unread 改 `RoomManager` 或 mobile protocol，会碰到桌面 CC room 共用路径；需要回归 `packages/desktop/src/renderer/cc-room/CCConversationView.tsx`。
- 如果改 `AgentBridge` snapshot/seq 语义，会影响桌面 renderer 的 `agent:subscribe` 恢复路径：`packages/desktop/src/main/index.ts:2975-2978`。

### 7. 量级与编排者决策

- Loading 圈：S。状态已在 `chat.run` 和 `done:false` assistant item 里，主要是 UI 补齐。
- 普通 session 未读圆点：M。需要 `useRemoteApp` 增加 per-session 状态、`SessionList`/可能 `MobileSessionSwitcher` 增加 UI、补测试。
- CC session 未读：S/M（弱 `lastModified > seenAt`）或 M（精确 latestSeq/cursor）。
- 需要编排者决策：未读是否第一版只对齐桌面的“普通会话级未读”，CC 先用弱提示/暂不做；以及 mobile 是否要把 loading 指示做成“assistant 气泡 spinner”还是同时做“列表行 running spinner + tab badge”。建议先做普通会话级 unread + active MessageStream spinner，CC 精确 unread 延后。
