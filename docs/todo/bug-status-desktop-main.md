# Bug 状态核实 — desktop main 进程区（codex 只读核实，2026-07-07）

> codex 沙箱只读无法自写，本文件由主 agent 代为落盘。依据均为 codex 报告的 文件:行号。

## 1. ✅已修 — DriveAgent `background:false` 120s 静默丢
- 实现不在 desktop main 而在 core：`packages/core/src/tool-system/builtin/drive-claude-code.ts:19-20` 定义 `110_000` 前台 handoff + `1_800_000` 工具超时。
- `tool-system/builtin/index.ts:488-497` 注册 `timeoutMs: DRIVE_AGENT_TOOL_TIMEOUT_MS`。
- `drive-claude-code.ts:299-315` 超前台阈值会 `trackBackgroundRun(...)` 并返回 jobId；`agent-notifications.ts:75-93` enqueue+publish；`protocol/server.ts:203-212` 转发完成事件。
- DriveAgent 不进 ListShells，但 `background-work.ts:135-146` 作为 `kind:"job"` 出现在 `agent/backgroundWork`。
- 结论：记忆过时，已修。

## 2. ✅已修 — 桌面自动更新缺 app-update.yml
- `packages/desktop/package.json:24-35` 已有 `build.publish`: github/cjhyy/codeshell。无额外覆盖配置。

## 3. ✅已修 — Windows NSIS artifactName 含空格
- `packages/desktop/package.json:26` productName=`code-shell`；`:92-93` artifactName=`${productName}-Setup-${version}.${ext}`，模板无空格。

## 4. ✅已修 — MCP stdio PATH 根治
- `index.ts:1436-1441` app.whenReady 早期 `await injectLoginShellPathAtStartup(...)`；`login-shell-path.ts:221-223` 用 login shell `-lic env` 探测；`:311-323` 写回 process.env.PATH。
- `agent-bridge.ts:149-152` worker spawn 继承 `{...process.env}`；`mcp-manager.ts:69-82` buildStdioEnv 从 process.env 继承 allowlist（含 PATH）。
- 是根治，非手动补绝对路径。注：只覆盖 darwin/linux。

## 5. ✅干净 — CDP remote-debugging-port
- `rg "remote-debugging-port|appendSwitch"` 无命中。本会话撤回后确认干净。

## 6. 🔶部分修 — workspace-IPC session guard
- `session-workspace-service.ts:49-56` requireKnownSession 已检查存在+readCwd 有效；switch(:84-85)/cleanup(:136-137) 已调用；测试覆盖 unknown/corrupt。
- **未收口**：`getSessionWorkspaceForUi()`/`listSessionWorktreesForUi()`(:58-67) 未调 requireKnownSession；`mainRootFor()`(:35-38) 对未知 session fallback 到 renderer 传入 cwd。读操作风险低，但"所有 workspace IPC 都有 guard"不成立。
- 修复方向：给 current/list 也加 known-session 校验；更严格时从 SessionManager.readCwd 派生 cwd，不信任 renderer。

## 发版 blocker（本区）
无明确未修 blocker。若发布标准要求所有 workspace IPC 拒绝未知/损坏 session，则第 6 条为发版前加固项。
