# mac 端可视化客户端调研

> Generated on 2026-05-16. Local Codex app inspected on macOS from `/Applications/Codex.app`.

This document focuses on whether CodeShell should add a mac visual client, what technology to use, and what we can infer from the installed Codex desktop app.

## Recommendation

建议优先做 **Electron + Web frontend + local CodeShell app-server**，而不是一开始上 SwiftUI 或 Tauri。

Reasoning:

- CodeShell 现有核心是 TypeScript/Node/Bun 生态，Electron 可以最大化复用协议、状态模型、React/Web UI、调试工具和工程经验。
- 本机 Codex 桌面端明确使用 Electron shell，并把 `codex app-server` 作为独立后端进程运行。这条路线和 CodeShell 的“核心服务 + 可视化 client”很契合。
- Tauri 更轻，但会引入 Rust bridge、系统 WebView 差异和 mac 打包/权限复杂度；适合后续追求体积和原生感时再评估。
- SwiftUI 原生体验最好，但对当前仓库复用最低，需要另建 Swift/macOS 工程和跨语言协议层；适合作为长期 native client，而不是第一版。

## What Codex Desktop Uses

本机观察结论：当前安装的 Codex 桌面端是 **Electron 应用 + app.asar 前端包 + bundled `codex app-server` 后端进程**。

Local evidence:

| Evidence | Observation |
|---|---|
| App bundle | `/Applications/Codex.app` |
| Electron framework | `/Applications/Codex.app/Contents/Frameworks/Electron Framework.framework` exists |
| Process list | `chrome_crashpad_handler` args include `_productName=Codex`, `_version=26.513.20950`, `prod=Electron`, `ver=42.0.1` |
| Renderer process | `Codex Helper (Renderer)` runs with `--app-path=/Applications/Codex.app/Contents/Resources/app.asar` |
| Info.plist | `ElectronAsarIntegrity` references `Resources/app.asar`; `CFBundleIconFile` is `electron.icns`; `NSPrincipalClass` is `AtomApplication` |
| Resources | `app.asar` is present, plus bundled `codex`, `node`, `node_repl`, `rg`, `native/`, `plugins/` |
| Backend process | A child process runs `/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled`; tool sessions also spawn `codex app-server --listen stdio://` |
| Update/signing | `Sparkle.framework`, `Squirrel.framework`, notarized Developer ID signature |
| Frontend packaging | `app.asar` contains `.vite/build/...` entries, so the renderer is a web bundle packaged into Electron |
| Electron ecosystem deps | `THIRD_PARTY_NOTICES.txt` includes `@sentry/electron`, `electron-context-menu`, `electron-dl`, `electron-is-dev` |

Inference:

```text
Codex.app
  -> Electron main process
  -> Electron renderer loads app.asar web bundle
  -> bundled codex binary runs app-server
  -> renderer talks to backend over local/stdout-style protocol
  -> Sparkle/Squirrel handle desktop update plumbing
```

这不是说 CodeShell 必须照抄 Codex，但它说明“AI coding desktop client + local agent server”这类产品用 Electron 是现实可行的。

## Product Scope For CodeShell mac UI

第一版 mac UI 不应该复刻 TUI 的每个细节，而应该承接 TUI 不擅长的可视化工作：

| Product area | Why GUI helps |
|---|---|
| Session Browser | 历史会话、搜索、筛选、工具调用时间线、成本统计 |
| Runs Dashboard | queued/running/waiting_approval/completed 状态、checkpoint、artifact、失败恢复 |
| Arena Reports | 多模型观点对比、claim ledger、证据树、最终报告导出 |
| Model Manager | provider/model/API key 状态、context window、cost、fallback 配置 |
| Approval Center | 待审批 tool calls、风险说明、diff preview、批量 allow/deny |
| Log / Perf Viewer | engine traces、render frame stats、tool result previews、错误定位 |
| Settings UI | preset、permissions、sandbox、MCP、hooks、project local settings |

TUI 继续负责：

- terminal-native coding loop；
- SSH/远程开发；
- 快速输入、工具审批、流式结果查看；
- 无 GUI 环境和 headless 场景。

## Architecture Proposal

Recommended shape:

```text
CodeShell core packages
  -> Engine / RunManager / Arena / ModelPool / SessionStore
  -> local app-server
     -> HTTP + WebSocket or stdio bridge
     -> auth token bound to localhost
     -> streams Agent Protocol events
  -> Electron mac client
     -> renderer: Web UI
     -> main: window, menu, update, file dialogs, deep links
     -> preload: narrow typed bridge
```

Key rule: GUI should share **protocol/state contracts** with TUI, not renderer primitives.

## Technology Options

| Option | Strengths | Weaknesses | Fit |
|---|---|---|---|
| Electron | Mature desktop shell, Chromium consistency, Node integration, rich menus/tray/update ecosystem, easiest web UI reuse | App size and memory higher; security hardening required | Best first choice |
| Tauri 2 | Smaller binaries, native OS WebView, Rust command backend, good security posture | Rust bridge, WebView differences, fewer AI-desktop precedents in this repo, more native packaging decisions | Good second-stage option |
| SwiftUI/AppKit | Best mac-native feel, system controls, accessibility, menu/window integration | Lowest reuse with TypeScript app, separate Swift codebase, bridge/protocol complexity | Good only if mac-native polish becomes top product priority |
| Browser-only local web | Lowest desktop packaging cost, fastest prototype | No native menu/tray/update/file integration; less “app” feel | Good prototype before Electron |

Official references:

- Electron describes itself as a framework for desktop apps using JavaScript, HTML, and CSS, embedding Chromium and Node.js for Windows/macOS/Linux apps: [Electron docs](https://www.electronjs.org/docs/latest/).
- Tauri positions itself as a way to create small, fast, secure cross-platform apps, using OS native web renderers and allowing any frontend stack: [Tauri 2.0 docs](https://v2.tauri.app/).
- SwiftUI is Apple’s declarative UI framework for Apple platforms: [Apple SwiftUI](https://developer.apple.com/swiftui/).

## Electron First Implementation Plan

Phase 0: protocol and app-server

- Define `codeshell app-server` command.
- Expose sessions/runs/models/settings/logs over local API.
- Use WebSocket or server-sent events for stream events.
- Add localhost auth token and origin checks from day one.

Phase 1: browser prototype

- Build local Web UI served from Vite dev server or static bundle.
- Implement Session Browser, Runs Dashboard, Model Manager.
- Keep all data access through the app-server contract.

Phase 2: Electron shell

- Add Electron main process, preload bridge, renderer bundle.
- Spawn or connect to `codeshell app-server`.
- Implement native menu, deep link, file/folder open, notifications.
- Package and sign mac app.

Phase 3: production polish

- Auto-update.
- Crash/error reporting.
- Secure permission model.
- Settings migration.
- Workspace trust and per-project isolation.
- E2E tests with Playwright/Electron.

## Security Requirements

Electron is the practical choice, but only if we keep the attack surface tight:

- `contextIsolation: true`
- `nodeIntegration: false` in renderer
- strict `preload` API with typed allowlist
- Content Security Policy
- no arbitrary remote content in privileged windows
- local app-server binds to `127.0.0.1` only
- per-launch auth token for API requests
- validate all tool approval actions server-side
- never let renderer directly execute shell commands
- workspace trust before exposing file/diff operations

## Data Contracts Needed Before GUI

| Contract | Needed fields |
|---|---|
| Session list | id, cwd, title, createdAt, updatedAt, status, model, cost, tags |
| Transcript stream | message entries, tool calls, tool results, deltas, turn boundaries |
| Run list | runId, status, product, preset, phase, checkpoint, approvals, artifact refs |
| Approval item | tool, args preview, risk, diff refs, cwd, timeout, decision result |
| Model/provider state | providers, model list, active key, context window, costs, credential status |
| Log/perf events | sid/runId, timestamp, subsystem, level, payload, frame stats |
| Settings | merged settings view, source layer, editable project/user/local fields |

## UI Surfaces

First usable mac client:

- Left sidebar: workspaces, sessions, runs.
- Main view tabs: Chat, Runs, Arena, Models, Logs, Settings.
- Inspector panel: selected tool call, approval, artifact, diff, model usage.
- Global command palette.
- Native menu actions: open folder, new session, resume, settings, reload app-server.

Avoid in v1:

- Reimplementing terminal rendering.
- Embedding a pseudo terminal as the primary experience.
- Coupling GUI components to `src/ui` TUI components.
- Building SwiftUI native screens before protocol contracts settle.

## Decision

Build the mac visual client as:

```text
Electron shell
  + Web renderer
  + local CodeShell app-server
  + shared Agent Protocol/event schema
```

Keep `src/render` focused on TUI. Let GUI use normal Web layout and components. This mirrors the observed Codex desktop shape closely enough to reuse the product architecture lesson, while keeping CodeShell’s implementation incremental.
