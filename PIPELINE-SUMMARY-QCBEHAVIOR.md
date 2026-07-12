# PIPELINE SUMMARY — Quick Chat Restricted Mode

## 结果

Quick chat 现在默认以真实受限模式运行，并在输入框左下角显示与实际权限一致的访问徽标：

- 默认权限为 `plan`，在 quick-chat UI 中显示为“受限访问”；
- restricted turn 注入 side-chat 行为边界，默认只回答问题并仅做轻量只读探索；
- 模型只看到 `Read`、`Glob`、`Grep`、`WebSearch`、`WebFetch`；
- executor 使用同一 allowlist fail closed，历史上下文即使直接点名 `Agent`、写工具或配置工具也不能执行；
- 用户在 quick chat 自己的权限徽标中选择默认权限、接受编辑或完全访问后，下一轮不再附加 restricted profile，按所选真实权限运行；
- quick-chat 提权只影响 child bucket，不改变主线程 Composer；quick-chat override 不持久化到 localStorage。

## 判断阶段摘要

详细证据见 `docs/research/quickchat-restricted-mode-gap.md`。实现前的五项结论是：

1. quick chat 没有专用 system/developer behavior 注入，普通 preset 会继续生效；
2. child 原样继承 owner override 或全局默认，可能直接得到接受编辑/完全访问；
3. `Agent` 在普通 preset 中可见且默认允许，quick chat 没有禁用路径；
4. 主 Composer 已有真实 `PermissionPill`，quick-chat footer 没有权限控件；
5. 最小修复应复用 per-run permission、tool visibility/executor gate、PromptComposer 与现有 pill，而不是新建一套平行权限系统。

## 已关闭缺口

- 系统提示：新增命名的 `quickChatRestricted` per-run profile，并通过 PromptComposer 的 append system prompt 注入行为边界。
- 权限：profile 强制本轮 permission snapshot 为 `plan`；普通/default 权限不足以替代该硬限制。
- 工具：新增通用 run-scoped `toolAllowlist`，Engine 与 ToolExecutor 共用；restricted 集合仅保留五个轻量读取工具。
- 子代理：`Agent` 不进入模型 tool definitions；直接点名也由 executor 在 hook/审批/handler 前拒绝。
- UI：复用 `PermissionPill`，只覆盖 quick-chat 中 `plan` 的显示标签为“受限访问”；完全访问仍显示现有真实文案。
- 提权：quick-chat bucket 的 pill 变更决定后续 run 是否携带 restricted profile；不是永久锁死，也不会反向修改 owner/main bucket。
- 生命周期：通用 override persistence 过滤 `__quick_chat__::*`，避免退出后残留 ephemeral 权限/模型/goal override。

## Commits

### `0144f78f` — `docs(quickchat): audit restricted mode gaps`

- `docs/research/quickchat-restricted-mode-gap.md`

### `bcaee1a6` — `test(quickchat): define restricted mode behavior`

- `packages/core/src/engine/engine.quick-chat-restricted.test.ts`
- `packages/core/src/tool-system/__tests__/tool-allowlist-execution-gate.test.ts`
- `packages/desktop/src/renderer/AppQuickChat.test.tsx`
- `packages/desktop/src/renderer/panels/QuickChatPanel.test.tsx`

红灯证据：依赖安装后首次定向运行得到 `15 pass / 5 fail`；失败分别覆盖缺失 restricted prompt/tool filter、executor 仍执行 Agent、quick chat 未默认 plan、两种真实徽标状态未渲染。

### `ab64be1e` — `feat(quickchat): enforce restricted side-chat mode`

Core runtime/protocol：

- `packages/core/src/engine/engine.ts`
- `packages/core/src/engine/run-types.ts`
- `packages/core/src/index.ts`
- `packages/core/src/protocol/chat-session.ts`
- `packages/core/src/protocol/client.ts`
- `packages/core/src/protocol/server.ts`
- `packages/core/src/protocol/types.ts`
- `packages/core/src/tool-system/context.ts`
- `packages/core/src/tool-system/executor.ts`
- `packages/core/src/engine/engine.quick-chat-restricted.test.ts`（格式化）

Desktop wiring/UI/lifecycle：

- `packages/desktop/src/preload/index.ts`
- `packages/desktop/src/preload/types.d.ts`
- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/chat/PermissionPill.tsx`
- `packages/desktop/src/renderer/i18n/ns/panels.ts`
- `packages/desktop/src/renderer/panels/QuickChatPanel.tsx`
- `packages/desktop/src/renderer/transcripts.ts`
- `packages/desktop/src/renderer/overridePersistence.test.ts`

## 测试与验证

- TDD 绿灯定向集：`20 pass / 0 fail`（restricted Engine、executor Agent gate、App 接线、QuickChatPanel 徽标）。
- 扩展相关回归：`56 pass / 0 fail / 191 expect()`，覆盖 permission boundary、ChatSession permission、plan Bash hard gate、i18n、override persistence 与全部 App quick-chat integration。
- `bun run --filter '@cjhyy/code-shell-core' build`：通过。
- `bun run --filter '@cjhyy/code-shell-cdp' build`：通过（desktop typecheck 的 workspace 类型依赖）。
- `bun run --filter '@cjhyy/code-shell-desktop' typecheck`：通过。
- 用户指定全量命令（使用 `pipefail` + 临时 tee 保存诊断日志）：

  ```text
  5833 pass
  6 skip
  0 fail
  14333 expect() calls
  Ran 5839 tests across 831 files. [71.09s]
  ```

已知 `ExternalAgentSessionStore concurrent writers` 基线失败本次没有复现。

## 复审修复

### MAJOR 1 — ephemeral quick chat 绕过工具 gate 写入持久记忆

- `288f7f5b` — `test(quickchat): reproduce ephemeral memory leak`
  - 新增 full-fork 快聊的端到端记忆隔离测试，父 transcript 预置 8 条消息以触发真实 pipeline。
  - 同时覆盖 restricted 轮次和显式 `bypassPermissions` 提权轮次，断言 extraction/summary 不调用、dream memory 不写入、quick-chat session summary 不持久化、auto-dream 状态不更新。
  - 补充 blank `qchat-*` 首次建会话必须落下 `ephemeral: true` 的断言。
  - 红灯：`5 pass / 3 fail / 19 expect()`；两种轮次均实际产生 dream memory/session summary/auto-dream 写入，blank quick chat 的 marker 为 `undefined`。
- `d0e60f08` — `fix(quickchat): skip durable memory for ephemeral sessions`
  - 复用 `SessionState.ephemeral` 作为与 behavior/permission 无关的 runtime 生命周期标记；现代 side fork 读显式 marker，历史/blank `qchat-*` 通过同一 helper fail closed。
  - `SessionManager.create()` 为 blank `qchat-*` 持久化 `ephemeral: true`；普通 marker 缺失 session 保持原行为。
  - Engine 在调用 `runMemoryPipeline()` 前按 session ephemeral 状态短路，整个 extraction/session-memory/auto-dream/dream-consolidation 持久化链都不运行；快聊提权不会清除该标记。

### MAJOR 2 — 安全边界测试过弱

- `57425e2e` — `test(quickchat): harden restricted mode boundaries`
  - 模型可见工具集改为排序后严格等于 `Glob/Grep/Read/WebFetch/WebSearch`，不再使用弱否定 `arrayContaining`。
  - executor 表驱动硬调 `Write/Edit/ApplyPatch/Bash/Config/Agent/Task/MCPTool/mcp__*`，每项都断言 `isError` 且 handler mock 为 0 次调用。
  - App 集成覆盖同一快聊 `restricted → default → acceptEdits → bypass → restricted` 往返，并断言第二个快聊与主线程权限全程不变。
  - 这组安全回归在当时实现上直接绿灯：它加固已有正确 gate，未伪造生产代码失败。

### 复审后验证

- 联合定向回归（ephemeral memory、restricted Engine、executor gate、side fork、MemoryOrchestrator、App quick-chat integration）：`36 pass / 0 fail / 193 expect()`。
- `bun run --filter '@cjhyy/code-shell-core' build`：通过。
- `bun test 2>&1 | tail -5`（使用 `pipefail` + 临时 tee 保留诊断日志）：

  ```text
  5836 pass
  6 skip
  0 fail
  14375 expect() calls
  Ran 5842 tests across 832 files. [69.78s]
  ```

`ExternalAgentSessionStore concurrent writers` 预存基线失败本次仍未复现，全量没有新增失败。

## 输入框对齐

### 现状差异

- 主线程 `ChatView` 是完整 Composer：附件、权限、Goal、ContextRing 用量、ModelPill、语音和发送均在同一控件栏。
- 实现前的 `QuickChatPanel` 没有复用该 Composer，而是独立简化 textarea，只提供权限 pill 和发送/停止；确实缺少模型、语音和附件，当时也没有误带 Goal/ContextRing。
- App 的运行层已会按 quick-chat bucket 读取 model override，但之前侧聊没有模型选择入口。

### 改法与 commit

- `d65b88f0` — `feat(quickchat): align side-chat composer`
  - `QuickChatPanel` 直接复用 `ChatView`/Composer，通过 `variant="quickChat"` 定义侧聊差异，不再维护第二套输入框。
  - 侧聊保留 ModelPill、语音输入、附件/粘贴/拖放、权限 pill、发送/停止与正常消息流；隐藏 GoalToggle、ContextRing 用量和新对话项目/分支选择。
  - 模型选择只写所属 quick-chat bucket，发送时将该 model 传入所属 side session；不更新全局默认、主线程或其他快聊。
  - 附件状态和 run payload 按 quick-chat bucket 隔离；关闭/重建时一并清理草稿、附件和模型 override。
  - 复用主 Composer 时显式禁止侧聊 prompt 写入持久 prompt history，并在 busy 且无队列管线时保留未发草稿。
  - 现有 `QUICK_CHAT_RESTRICTED_SYSTEM_PROMPT` 与 core 行为限制未修改。

改动文件：

- `packages/desktop/src/renderer/ChatView.tsx`
- `packages/desktop/src/renderer/panels/QuickChatPanel.tsx`
- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/ChatView.composer-variant.test.tsx`
- `packages/desktop/src/renderer/AppQuickChat.test.tsx`

### TDD 与验证

- 红灯：旧 quick-chat 真实渲染测试为 `3 pass / 1 fail / 7 expect()`，失败点是找不到侧聊 ModelPill，输出仅有权限与发送。
- 绿灯定向回归：`30 pass / 0 fail / 129 expect()`，覆盖 main/quickChat variant 控件显隐、受限/完全访问徽标、模型真实 run 参数、两个快聊/主线程模型隔离、附件路由与 transient override 不持久化。
- `bun run --filter '@cjhyy/code-shell-desktop' typecheck`：通过。
- `bun test 2>&1 | tail -5`（`pipefail` + 临时 tee）：

  ```text
  5839 pass
  6 skip
  0 fail
  14393 expect() calls
  Ran 5845 tests across 832 files. [70.12s]
  ```

全量无新增失败，`ExternalAgentSessionStore concurrent writers` 预存基线失败本次未复现。

## 终审修复

统一修复 commit：`ee287266` — `fix(quickchat): isolate composer async lifecycle`。

### MAJOR 1 — 快聊卸载后录音/转写继续

- Commit：`ee287266`。
- `ChatView` 新增 mounted generation 与显式 media stream ref。卸载时取消两分钟 timer，先解除 recorder `onstop/ondataavailable`，再停止 recorder 和全部 tracks。
- 麦克风授权、`getUserMedia`、blob 读取、STT 请求与结果回写每个 async 边界都检查 mounted generation；迟到结果不再 `setDraft`/toast/setState。
- 转写回写改为 functional draft update，避免捕获旧草稿。App quick-chat draft setter 再按 `quickChatSessionsRef` 验证 bucket 存活，旧 bucket fail closed。

### MAJOR 2 — 迟到附件 stage/mark 复活 ephemeral 目录

- Commit：`ee287266`。
- 复用 quick-chat `creationNonce`/claim：`QuickChatPanel → ChatView → preload → main` 的 stage payload 和 App mark-sent payload 都携带同一 `quickChatClaimId`。
- `QuickChatOwnershipRegistry` 在原 fork-in-flight 机制上增加 claim 内 auxiliary operation 计数。stage/mark 开始前校验 active claim；cleanup 先 tombstone，在途操作未 settle 时返回 deferred；最后一个操作 settle 后执行唯一删除。
- settle 后如 claim 已失效，main 丢弃结果并再次清理 payload 精确 cwd 下的旧 session 附件目录，覆盖 worktree cwd 不在通用 project scan 里的情况。
- `ChatView` 在 build/compress/stage 每个 await 后检查 mounted；App attachment/model setter 也拒绝已死 bucket。

### MINOR 1 — 无 handler 的 `/compact` 吞草稿

- Commit：`ee287266`。
- 只在实际传入 `onCompactCommand` 时注册 `/compact` slash item；侧聊不再显示该命令，裸 `/compact` 按普通文本发送，不会静默清空。

### MINOR 2 — 真实 wrapper 与异步竞态测试盲点

- Commit：`ee287266`。
- 恢复 `QuickChatPanel.test.tsx` 真实 wrapper 渲染，硬断言 `data-chat-variant="quickChat"`、权限徽标及 Goal/usage 不可见；包装层漏传 variant 会直接失败。
- 新增 `ChatView.ephemeral-lifecycle.test.tsx`，覆盖 prompt history 不持久化、`/compact` 不展示、卸载停 recorder/track/timer、迟到 STT 不回写、迟到 stage 不更新附件。
- App 集成测试覆盖关闭/替换后旧 draft/attachment/model callback 不能复活状态，且 mark-sent 真实携带所属 creation nonce。
- ownership 磁盘测试同时挂起 stage 与 mark-sent，断言 cleanup 延迟到两者 settle，然后旧附件目录不存在。

### TDD 与验证

- 红灯：首次生命周期/ownership 复现为 `5 pass / 4 fail / 21 expect()`，四个失败分别是 recorder 未停、迟到 STT 回写、迟到 stage 回写、registry 无 operation gate；`/compact` 单独红灯为 `0 pass / 1 fail`。
- 相关定向回归（ChatView/QuickChatPanel/App/override persistence/ownership/fork/attachment service）：`63 pass / 0 fail / 255 expect()`。
- `bun run --filter '@cjhyy/code-shell-desktop' typecheck`：通过。
- `bun test 2>&1 | tail -5`（`pipefail` + 临时 tee）：

  ```text
  5848 pass
  6 skip
  0 fail
  14424 expect() calls
  Ran 5854 tests across 834 files. [69.84s]
  ```

全量无新增失败，`ExternalAgentSessionStore concurrent writers` 预存基线失败本次未复现。现有 side-chat system prompt/行为限制未修改。

## 偏离与未决

- “明确提权”采用可审计的 UI 动作：用户必须切换 quick chat 自己的访问徽标。仅在自然语言里要求写入不会静默绕过 hard gate；模型会提示用户切换徽标。这避免模型自行判断一句话是否足以授权。
- restricted quick chat 不复用完整 plan toolset，因为 plan allowlist 仍包含 Agent、Bash、Skill 和任务工具；本实现刻意收窄为五个只读探索工具。
- 没有新增独立权限枚举或第二套 permission controller；`quickChatRestricted` 只是组合现有 plan snapshot、通用 allowlist gate 和 PromptComposer 注入的命名 per-run profile。
- 未做 Electron 端到端截图测试；UI 由真实组件 SSR 测试验证“受限访问/完全访问”两种状态，App integration 验证状态与发送到 core 的参数一致。
- 无 merge、push 或分支切换。
