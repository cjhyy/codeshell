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

## 偏离与未决

- “明确提权”采用可审计的 UI 动作：用户必须切换 quick chat 自己的访问徽标。仅在自然语言里要求写入不会静默绕过 hard gate；模型会提示用户切换徽标。这避免模型自行判断一句话是否足以授权。
- restricted quick chat 不复用完整 plan toolset，因为 plan allowlist 仍包含 Agent、Bash、Skill 和任务工具；本实现刻意收窄为五个只读探索工具。
- 没有新增独立权限枚举或第二套 permission controller；`quickChatRestricted` 只是组合现有 plan snapshot、通用 allowlist gate 和 PromptComposer 注入的命名 per-run profile。
- 未做 Electron 端到端截图测试；UI 由真实组件 SSR 测试验证“受限访问/完全访问”两种状态，App integration 验证状态与发送到 core 的参数一致。
- 无 merge、push 或分支切换。

