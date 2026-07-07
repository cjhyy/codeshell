# Bug 状态核实 — desktop main 进程区（codex 复核，2026-07-07，HEAD 7e4b0470）

> 本文件保留已修条目用于追溯；TODO.md 只保留未完成项。

## 1. ✅已修 — DriveAgent `background:false` 120s 静默丢
- 实现不在 desktop main 而在 core：`packages/core/src/tool-system/builtin/drive-claude-code.ts:19-20` 定义 `110_000` 前台 handoff + `1_800_000` 工具超时。
- `packages/core/src/tool-system/builtin/index.ts:488-497` 注册 `timeoutMs: DRIVE_AGENT_TOOL_TIMEOUT_MS`。
- `packages/core/src/tool-system/builtin/drive-claude-code.ts:299-315` 超前台阈值会 `trackBackgroundRun(...)` 并返回 jobId；`packages/core/src/tool-system/builtin/agent-notifications.ts:75-93` enqueue+publish；`packages/core/src/protocol/server.ts:203-212` 转发完成事件。
- DriveAgent 不进 ListShells，但 `packages/core/src/tool-system/builtin/background-work.ts:135-146` 作为 `kind:"job"` 出现在 `agent/backgroundWork`。
- 结论：记忆过时，当前 HEAD 仍为已修。

## 2. ✅已修 — 桌面自动更新缺 app-update.yml
- `packages/desktop/package.json:24-35` 已有 `build.publish`: github/cjhyy/codeshell。无额外覆盖配置。

## 3. ✅已修 — Windows NSIS artifactName 含空格
- `packages/desktop/package.json:26` `productName="code-shell"`；`packages/desktop/package.json:92-93` `artifactName="${productName}-Setup-${version}.${ext}"`，模板无空格。

## 4. ✅已修 — MCP stdio PATH 根治
- `packages/desktop/src/main/index.ts:1436-1441` app ready 早期 `await injectLoginShellPathAtStartup(...)`。
- `packages/desktop/src/main/login-shell-path.ts:221-224` 用 login shell `-lic env` 探测；`:274-323` 合并 PATH 与安全 env key，并写回 `process.env`。
- `packages/desktop/src/main/agent-bridge.ts:149-152` worker spawn 继承 `{...process.env}`；`packages/core/src/tool-system/mcp-manager.ts:69-82` `buildStdioEnv` 从 `process.env` 继承 allowlist（含 PATH）。
- 是根治，非手动补绝对路径。注：只覆盖 darwin/linux。

## 5. ✅干净 — CDP remote-debugging-port
- `rg -n "remote-debugging-port|appendSwitch" packages/desktop/src packages/core/src packages/tui/src packages/cdp/src` 无命中。
- 现有 webview/browser 相关代码是 guest hardening 与 BrowserPanel 通信，例如 `packages/desktop/src/main/index.ts:1078-1113` 只设置 webview 安全参数和 `persist:browser` 分区白名单，没有启用 remote debugging port。

## 6. 🔶部分修 — workspace-IPC session guard
- 已有：`packages/desktop/src/main/session-workspace-service.ts:49-56` `requireKnownSession` 检查存在且 `readCwd` 有效；switch `:84-88` 与 cleanup `:136-138` 已调用；测试 `packages/desktop/src/main/session-workspace-service.test.ts:102-124` 覆盖 unknown/corrupt switch，`:126-138` 覆盖 unknown cleanup。
- 未收口：`getSessionWorkspaceForUi()`/`listSessionWorktreesForUi()` `packages/desktop/src/main/session-workspace-service.ts:58-76` 未调 `requireKnownSession`；`mainRootFor()` `:35-38` 对未知 session fallback 到 renderer 传入 cwd。
- IPC 入口 `packages/desktop/src/main/index.ts:2681-2697` 只校验 `sessionId`/`cwd` 参数非空并把 cwd 加入 `knownGitRoots`，然后调用 current/list；因此“所有 workspace IPC 都有 known-session guard”仍不成立。
- 修复方向：给 current/list 也加 known-session 校验；更严格时从 `SessionManager.readCwd` 派生 cwd，不信任 renderer。

## 发版 blocker（本区）
无明确未修 blocker。若发布标准要求所有 workspace IPC 拒绝未知/损坏 session，则第 6 条为发版前加固项。
