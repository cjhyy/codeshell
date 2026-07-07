# Bug 状态核实 — renderer + TUI 区（codex 复核，2026-07-07，HEAD 7e4b0470）

> 本文件保留已修条目用于追溯；TODO.md 只保留未完成项。

## 1. ✅已修 — usage_update reducer 丢单轮字段
- `packages/desktop/src/renderer/types.ts:866-914` 同一个 `usage_update` return 同时合并 context reading、single-turn cache 与 cumulative/session cache；`hasCumulative` 不再提前 return 丢单轮字段。
- 结论：记忆过时，当前 HEAD 仍为已修。

## 2. ✅已修 — panel session 删除泄漏
- `packages/desktop/src/renderer/App.tsx:1232-1242` 删除 session 时 `clearPanelState(deletedBucket)` 并从 `panelByBucket` 移除，隐藏的 PanelArea/webview/pty 会卸载。
- `packages/desktop/src/renderer/transcripts.ts:287-290` `clearPanelState()` 删除对应 localStorage key。

## 3. ✅已修 — panel state 写放大
- `packages/desktop/src/renderer/App.tsx:2652-2668` `savedPanelSnapshotsRef` 做快照对比，`get(bucket)===serialized` 时跳过，只写变化 bucket。
- `packages/desktop/src/renderer/transcripts.ts:296-307` `savePanelState()` 单 bucket 写入/清理。

## 4. ✅已修 — steer 前端渲染折叠
- `packages/desktop/src/renderer/messages/TurnProcessGroupCard.tsx:117-136` 已有 in-group user 分支：pending/空文本不画，confirmed steer 画右侧用户气泡。
- `packages/desktop/src/renderer/messages/streamGroups.ts:240-246` 把 pending 与 text length 纳入 user 签名，避免 memo 复用 stale group。

## 5. ✅已修 — 唤醒折叠 bug
- `packages/desktop/src/renderer/messages/streamGroups.ts:409-435` injected user 只有在 prior turn 已有 done assistant 时才作为新边界，防止已完成 turn 后的 wakeup 被折进旧卡片。
- 回归测试 `packages/desktop/src/renderer/messages/streamGroups.test.ts:302-318` 覆盖“completed turn 后 injected wakeup 开新 live segment”。

## 6. ✅已修 — TUI 上下文窗口 maxContextTokens
- `packages/tui/src/cli/commands/max-context-tokens.ts:3-8` 抽出 `resolveMaxContextTokens(llm, settingsMaxTokens)`，优先 `llm.maxContextTokens`，再 fallback `settings.context.maxTokens`，最后 `200_000`。
- 非 REPL 路径已修：`packages/tui/src/cli/commands/run.ts:105-120` 用 `resolveMaxContextTokens(llmConfig, settings.context.maxTokens)` 后传给 shared cfg；`packages/tui/src/cli/commands/runs.ts:42-50` RunManager executor 也用同一 helper。
- 测试覆盖：`packages/tui/src/cli/commands/max-context-tokens.test.ts:4-15` 验证 model connection 优先级与 fallback。
- REPL/状态栏仍正确：`packages/tui/src/ui/App.tsx:1615-1621` 应用 model configure 返回的 `maxContextTokens`；`packages/tui/src/ui/components/StatusLine.tsx:144-153` 用 active max 算 ctx 百分比。
- **发版 blocker 撤销。**

## 7. ✅已修 — TUI /logout 只清旧字段
- `packages/tui/src/cli/commands/builtin/extra-commands.ts:12-21` `AUTH_KEYS` 已含 legacy keys + `credentials`/`modelConnections`/`defaults`。
- `/logout` 会清用户级、项目级、项目 local 三个文件：`packages/tui/src/cli/commands/builtin/extra-commands.ts:123-130`。
- 测试 `packages/tui/src/cli/commands/builtin/extra-commands.test.ts:17-49` 覆盖 legacy + unified auth/model 字段被清除，`mcpServers` 保留。

## 发版 blocker（本区）
无。旧 #6 非 REPL run/runs 残留已修。
