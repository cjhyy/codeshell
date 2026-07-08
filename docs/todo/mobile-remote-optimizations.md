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
