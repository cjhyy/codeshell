# Bug 状态核实 — renderer + TUI 区（codex 只读核实，2026-07-07，HEAD 5459def9）

> codex 沙箱只读无法自写，本文件由主 agent 代为落盘。

## 1. ✅已修 — usage_update reducer 丢单轮字段
- `renderer/types.ts:866` 同一 return 同时合并 hasSingleTurn 与 hasCumulative，无 cumulative 提前 return。记忆过时。

## 2. ✅已修 — panel session 删除泄漏
- `App.tsx:1232` `clearPanelState(deletedBucket)` + 从 panelByBucket 移除；`transcripts.ts:287` `localStorage.removeItem(panelStateKey(bucket))`。

## 3. ✅已修 — panel state 写放大
- `App.tsx:2629` `savedPanelSnapshotsRef` 快照对比，`get(bucket)===serialized` 则 skip，只写变化的 bucket。

## 4. ✅已修 — steer 前端渲染折叠
- `TurnProcessGroupCard.tsx:117` 已有 user 分支（pending/空文本 return null）；`streamGroups.ts:240` 把 pending/text 纳入签名。

## 5. ✅已修 — 唤醒折叠 bug
- `streamGroups.ts:409` prior turn done 后 wakeup 算新边界；回归测试 `streamGroups.test.ts:306`。

## 6. 🔶部分修 — TUI 上下文窗口 maxContextTokens
- REPL 已修：`tui/cli/commands/repl.ts:144` `llmConfig.maxContextTokens ?? settings.context.maxTokens ?? 200_000`；状态栏用 active max（`ui/App.tsx:2032`、`StatusLine.tsx:144`）。
- 未修：非 REPL 路径 `run.ts:117`、`runs.ts:48` 仍 `settings.context.maxTokens`。
- 修复方向：两处改为优先 llmConfig.maxContextTokens 再 fallback，补优先级测试。
- 若 run/runs 属本版受支持入口 → blocker。

## 7. ✅已修 — TUI /logout 只清旧字段
- `extra-commands.ts:12` 已含 credentials/modelConnections/defaults；`:123` 清用户级+项目级+项目 local。

## 发版 blocker（本区）
仅 #6 的非 REPL run/runs 残留，若属受支持入口则为 blocker；其余 renderer 1-5、TUI logout 7 已修。
