# Quick Chat restricted mode 缺口审计

> 调研日期：2026-07-12  
> 分支：`feat/quickchat-restricted-mode`  
> 范围：只判断 quick chat 相对 Codex `/side` 的运行时行为限制与输入框权限指示；既有 fork、ephemeral、快照、事件路由和 GC 语义不在本轮重做。

## 结论

当前 quick chat 已有 `/side` 的会话分叉与生命周期基座，但**没有** restricted behavior：没有 quick-chat 专用系统/开发者指令，权限模式会继承父 bucket 或全局默认，完整工具集仍包含写文件、shell、配置和子代理工具，输入框也没有权限模式控件。

需要补的最小闭环是：

1. quick chat 新建时默认采用一个真实的只读运行态，并给每一轮注入 quick-chat 行为边界；
2. 只读态的可见工具和执行门都只允许轻量读取，明确移除 `Agent` 等子代理工具；
3. 用户通过 quick-chat 自己的权限徽标显式切换模式后，后续轮次按所选真实权限运行；这就是受限态的显式提权出口，不永久锁死；
4. 复用现有 `PermissionPill`，接到 quick-chat bucket 的真实权限覆盖；主线程 Composer 维持现状。

## 1. 快聊创建路径、系统提示与角色

### 现状

- renderer 为 quick chat 生成独立 `qchat-*` session/bucket；有父 engine session 时选择 `full`，否则为 `blank`（`packages/desktop/src/renderer/App.tsx:3244-3269`）。
- full 路径调用 `forkSession({ mode: "full", forkKind: "side" })`，只处理 claim、fork、空 UI hydrate、model/permission override 与 workspace；没有传 preset、system prompt 或行为模式（`packages/desktop/src/renderer/App.tsx:3141-3217`）。
- blank 路径同样只建立 route、复制 model/permission override 并标为 ready，没有行为指令注入（`packages/desktop/src/renderer/App.tsx:3155-3175`）。
- quick-chat 发送只把 `cwd/sessionId/bucket/browserPartition/clientMessageId/permissionMode` 交给 `window.codeshell.run`，没有 quick-chat role/preset/system reminder（`packages/desktop/src/renderer/App.tsx:2487-2536`）。
- protocol `RunParams` 现有每轮控制项是 `permissionMode` 与 `planMode`，没有 quick-chat/restricted behavior 字段（`packages/core/src/protocol/types.ts:114-168`）；server 创建 session 的 slice 也只从本次请求取 `cwd/projectTrusted/goal`，然后把 permission/plan 转交 `enqueueTurn`（`packages/core/src/protocol/server.ts:684-707`、`:769-789`）。
- Engine 每轮用普通 session config 构造 `PromptComposer`；system prompt 只来自通用 preset、`customSystemPrompt`、`appendSystemPrompt` 和个性化设置（`packages/core/src/engine/engine.ts:1462-1483`；`packages/core/src/prompt/composer.ts:193-268`）。当前没有按 qchat ID 或 side fork 自动追加行为约束。

### 判断

**缺少“默认只回答问题、轻量只读探索、不主动修改”的指令。** fork 只复制 transcript/state；它不会把一个普通父 session 自动变成受限角色。应通过既有 PromptComposer 的 append/system section 注入点，在每个 restricted quick-chat turn 注入固定行为边界，而不是靠 UI 文案自述。

## 2. 权限模式、写操作和工具限制

### 现状

- quick chat 创建时会把 owner bucket 的显式 permission override 原样复制给 child；owner 没有 override 时不写 child override，child 随后回退到全局默认（blank：`packages/desktop/src/renderer/App.tsx:3163-3174`；full：`:3201-3211`）。这意味着父会话若为接受编辑/完全访问，quick chat 也直接得到该权限。
- 发送时再次以 `permissionOverrides[quickBucket] ?? defaultPermissionMode` 解析权限并透传 core（`packages/desktop/src/renderer/App.tsx:2491-2513`），没有“quick chat 默认受限”的分支。
- core 已有权限枚举 `default | acceptEdits | dontAsk | bypassPermissions | auto | plan`（`packages/core/src/types.ts:380-390`）。`acceptEdits` 会直接允许 Write/Edit，`bypassPermissions` 还直接允许 Bash（`packages/core/src/engine/permission-controller.ts:50-74`）；普通 preset 本身暴露 Write/Edit/ApplyPatch/Bash/Config 等完整工具（`packages/core/src/preset/index.ts:34-103`）。
- core 已有可复用的硬只读机制：plan mode 同时过滤模型可见 tool definitions（`packages/core/src/engine/engine.ts:1603-1610`）并在 executor 执行前拒绝非允许工具及写入型 Bash（`packages/core/src/tool-system/executor.ts:242-271`）。这证明限制不能只靠 prompt；模型可见集与执行门必须共用同一规则。
- 但现有 plan allowlist 不是 quick-chat 最终答案：它包含 `Agent`、计划生命周期、Skill、Todo/Task 与 Bash（`packages/core/src/tool-system/plan-mode-allowlist.ts:40-66`），范围比“轻量只读探索”更大。

### 判断

**需要默认限制，并应复用现有 per-run permission snapshot、tool-definition filter 和 executor fail-closed gate。** 不能仅把模式设为 `default`：default 仍允许 preset 中已放行的工具，并对其他写操作走审批；也不能原样套用 plan allowlist，因为它仍允许子代理和非轻量工具。

实现上应让 quick-chat restricted turn 使用 `plan` 作为真实只读 permission snapshot，同时在同一 per-run profile 上施加更窄的工具 allowlist。用户在 quick-chat 权限徽标中选择默认/接受编辑/完全访问后，后续 turn 不再附加 restricted profile；因此默认安全但可显式提权。

## 3. 子代理

### 现状

- 通用 preset 注册并默认允许 `Agent` 与 `AgentCancel`（工具集：`packages/core/src/preset/index.ts:69-79`；权限规则：`:151-168`）。
- Engine 每轮无条件创建 `subAgentSpawner` 并放入 ToolContext（`packages/core/src/engine/engine.ts:1034-1061`、`:1091-1098`）。当前 quick-chat 请求没有任何标志让这条路径失效。
- core 已有子 agent 自身的 allowlist/禁嵌套机制：`SubAgentSpawnRequest.toolAllowlist`（`packages/core/src/tool-system/context.ts:102-145`）以及 `NESTED_AGENT_TOOLS` 过滤（`packages/core/src/engine/subagent-spawner.ts:14-41`）。这说明 allowlist 是仓库既有隔离范式，可扩展到 quick-chat 的 per-run 工具面。

### 判断

**子代理当前可用，必须在 restricted quick chat 中禁用。** 应从该轮模型可见工具集中去掉 `Agent`/agent control tools，并用 executor 的同一 allowlist 做执行期拒绝，防止模型凭历史直接点名隐藏工具。提权后的 quick-chat turn 才恢复普通 session 工具集。

## 4. 输入框 UI 与权限徽标

### 现状

- 主线程 `ChatView` 已在 Composer 左下角渲染真实的 `PermissionPill`，值来自 active bucket 的权限状态，变更回写 per-bucket override（`packages/desktop/src/renderer/ChatView.tsx:1489-1515`；`packages/desktop/src/renderer/App.tsx:3941-3951`、`:4270-4273`）。
- `PermissionPill` 已支持计划、默认、接受编辑、完全访问四种真实模式，并负责标签、色调、popover 与可访问性文案（`packages/desktop/src/renderer/chat/PermissionPill.tsx:7-23`、`:64-146`）。中文“完全访问权限”已有翻译（`packages/desktop/src/renderer/i18n/ns/chat.ts:95-101`）。
- quick-chat 输入框是独立的简化 `Textarea`。其 footer 使用 `justify-end`，只渲染停止/发送按钮，左下角没有权限或访问指示（`packages/desktop/src/renderer/panels/QuickChatPanel.tsx:139-177`）。
- `QuickChatPanelHost` 目前也没有 permission value/change props，只有消息、draft、send/stop 和 approval 接线（`packages/desktop/src/renderer/App.tsx:277-355`）。

### 判断

**徽标无需新造，复用 `PermissionPill` 即可。** 把 quick bucket 的真实 permission mode 传入 `QuickChatPanel`，在 footer 左侧渲染 pill，选择结果只回写该 quick bucket。restricted 默认值显示受限/计划语义；用户选“完全访问权限”后，徽标与下一轮实际传给 core 的 `bypassPermissions` 一致，不能写死文案。

主线程保持现有 Composer 和默认权限逻辑；quick chat 使用自己的 bucket override，不能改变 owner/main 的 pill。

## 5. Codex `/side` 标杆

仓库既有调研确认：Codex `/side` 是带父历史的 ephemeral fork，并额外收到隐藏 developer instructions（`docs/research/codex-side-chat-history-behavior.md:116-130`）；side boundary 明确把 boundary 前内容定义为 inherited reference context，而非当前任务（同文件 `:120-124`）。这与附图中的行为自述一致：侧聊默认回答问题/轻量只读探索，不延续边界前计划，不改文件/git/配置/权限，且禁用子代理。

CodeShell 现有 full fork、空 UI hydrate、ephemeral/claim 生命周期已经覆盖“历史和隔离”部分；本轮只需补齐 developer behavior + hard runtime gate + truthful composer indicator，不应重做 fork 语义。

## 6. 拟实现的验收边界

1. 新建 full 或 blank quick chat 都把 child bucket 初始化为 restricted，而不继承 owner 的完整权限。
2. restricted turn 传递真实只读 permission snapshot，system prompt 含 quick-chat 行为边界。
3. restricted turn 的模型可见工具与执行门一致，只含轻量只读工具；`Agent`、写文件、git/shell 写、配置/权限修改均不可用。
4. quick-chat footer 显示复用的权限 pill；选择完全访问后该 bucket 后续 turn 传 `bypassPermissions`，不再施加 restricted profile。
5. quick-chat 提权不改变主线程 bucket；关闭 quick chat 后其 transient override 随既有清理路径丢弃。

