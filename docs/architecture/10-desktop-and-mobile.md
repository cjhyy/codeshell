# 10 · Desktop & Mobile

> The headline product: an Electron desktop client, a phone-remote web app, and the environment-agnostic CDP browser layer. Source-mapped against `packages/desktop/` and `packages/cdp/`.

## 1. The three-process model

The defining architecture: **the Electron main process is an IPC service broker — it does NOT run the `Engine`**. Instead it spawns a per-session **core agent worker** (`agent-server-stdio`), pipes its stdout to the renderer, and provides system capabilities. The renderer is a thin React client that talks to main only through `window.codeshell.*`.

```
┌──────────────────────────────────────────────────────────────┐
│ Electron Main  (src/main/index.ts ~2,739 LOC)                  │
│  ipcMain service layer · spawns worker · provides files/term/  │
│  creds/browser-host/memory/automation/updater/mobile-WS        │
└───────────┬───────────────────────────────┬────────────────────┘
   stdio JSON-RPC                       ipcMain send/on
┌───────────▼────────────┐      ┌───────────▼──────────────────┐
│ Worker (agent-server-  │      │ Renderer (React 19 + shadcn   │
│ stdio): Engine, turns, │      │ + Tailwind v4) — NO core      │
│ StreamEvents           │      │ imports; window.codeshell.*   │
└────────────────────────┘      └───────────────────────────────┘
```

- **Worker spawn** (`main/agent-bridge.ts`): on `agent/run`, `spawnChild(cwd)` launches the core stdio server with `ELECTRON_RUN_AS_NODE=1` (Electron binary running Node). Crash tracking: 3 restarts in 60 s ⇒ "gave_up". Session snapshots survive worker exit so a remount can replay them.
- **Preload RPC** (`main/../preload/index.ts`): `rpc()` has a 30 s timeout — **except `agent/run`, which passes 0 (no timeout)** so long turns aren't killed. Worker death rejects pending calls; a wedged worker is handled by the user's Stop button. (This is the rpc-30s-timeout-freeze fix.)

Isolation is enforced by the build: the renderer **cannot** import `@cjhyy/code-shell-core` (Vite alias), main cannot import React/DOM (esbuild node platform), preload is stateless transport only.

## 2. Main-process services (`src/main/`)

~60 service modules. A representative slice:

| Service | Role |
|---------|------|
| `agent-bridge.ts` | worker spawn, stdio piping, event routing, `__browser_action__`/`__credential_action__` intercepts |
| `desktop-services.ts` | git/files/terminal/undo via native tools |
| `pty-service.ts` | node-pty terminal backend (rebuilt for Electron ABI, asarUnpack) |
| `credentials-service.ts` + `credentials-login/` | cookie capture/restore, OAuth login window |
| `browser-driver/` (6 files) | implements core's `BrowserBridge` on CDP (no Playwright) |
| `mobile-remote/` (~20 files) | phone-remote WS host, rooms, pairing, optional Cloudflare tunnel |
| `automation-service.ts`, `automationMemory.ts` | cron scheduler bridge → renderer UI |
| `sessions-service.ts`, `runs-service.ts`, `transcript-reader.ts` | list/replay sessions and runs |
| `settings-service.ts` | read/write settings (also takes the shared lockfile so worker + main don't clobber `settings.json`) |
| `plugins-service.ts`, `marketplace-service.ts`, `skills-service.ts`, `github-skill-service.ts` | extensions install/discovery |
| `memory-service.ts`, `dream-service.ts` | memory approve/promote, manual Dream |
| `model-meta-service.ts`, `mcp-probe-service.ts` | model lists/pricing, MCP introspection cache |
| `updater.ts`, `menu.ts`, `window-state-store.ts` | electron-updater, app menu, window geometry |

A discipline that recurs: main must avoid synchronous fs (`cpSync` etc.) — it blocks the event loop and freezes the UI (the main-sync-fs-freeze memory note).

## 3. Renderer (`src/renderer/`, ~11 K LOC, 283 files)

React 19 + shadcn/ui + Tailwind v4 (zinc + blue). `App.tsx` (~3,188 LOC) routes `StreamEvent`s by `sessionId` into per-session buckets and drives a reducer. Surfaces:
- **Chat** with streaming, image attachments, and the steering/queue model (queue = non-interrupting step-gap insertion; "steer" = interrupt-and-resend — see [01](01-engine-and-turn-loop.md)).
- **Panel dock**: read-only **Files**, **Browser** (CDP, selection-anchor sync), interactive **Terminal** (node-pty), **Diff/Review**, plus a background-shell panel.
- **Connections & catalog** (full provider/model CRUD, key reuse by company), **Extensions/marketplace**, **Automation**, **persistent goals**, **memory management** (pin/edit/clear, manual Dream), **hooks** config, **i18n** (zh/en via `useT`).
- Command palette ⌘K, cross-project session search ⌘P, in-transcript ⌘F; onboarding wizard, trust gate, app updater.

The **shared `streamReducer`** (`renderer/lib/streamReducer.ts`) is used by *both* desktop and mobile, keeping CC rendering identical across the two (the cc-room-render-alignment memory note). UI conventions: a `DialogProvider` (`useConfirm`/`useAlert`/`usePrompt`, no native dialogs) and a `ToastProvider` (the dialog-unification / desktop-toast notes). Tool cards expand inline (no separate inspector pane). When debugging "clicked, nothing happened" here, suspect a stale `out/` bundle before the source (the verify-mobile-ui-on-fresh-bundle note).

## 4. Mobile (`src/mobile/`)

A separate Vite build of the same React codebase (no sidebar, full chat area), served by the main process over a local WebSocket and reached via QR pairing (device token + desktop token). It reuses `streamReducer`, `MessageStream`, composer/tool/approval components. **Rooms** (`mobile-remote/room-manager.ts`, `resident-agent.ts`, `codex-room-agent.ts`) are long-lived stream-json sessions persisted under `~/.code-shell/mobile-remote/rooms/`, mirrored to the phone over WS; approval requests route through an `ApprovalBridge` to both desktop and phone. The optional public tunnel (`tunnel-manager.ts`, Cloudflared) is off by default and gated by an access passcode. CC/Codex rooms are device-keyed, not room-accumulated (the beta1-feedback-batch-fixes note on phone remote).

The phone-remote UI was rebuilt from inlined strings into a proper React app reusing the desktop shadcn components (the mobile-ui-react-rebuild note: `secretHash` is not hashed; event names follow core's `StreamEvent`).

## 5. The CDP layer (`packages/cdp/`, 6 files, ~400 LOC)

An **environment-agnostic** CDP browser-action layer with zero runtime deps and no Playwright. `CdpActionsDriver` is stateless — it takes only an injected `CdpSender = (method, params) => Promise<unknown>`. It exposes `snapshot()`, `clickNode()`, `typeNode()`, `pressKey()`, `scroll()`, `waitSelector()`, `extractContent()`, working from raw `Accessibility.getFullAXTree` nodes and dispatching **real** input events (`isTrusted: true`, not synthetic JS). Caps: 12 KB content, 200 links, 1568 px max image dim.

The desktop adapter (`main/browser-driver/electron-cdp.ts`) wraps `webContents.debugger.sendCommand` as the `CdpSender`, and `cdp-driver.ts` implements core's `BrowserBridge` (which `flattenAxTree` and the browser tools in [02](02-tool-system.md) consume). The worker emits `__browser_action__` lines on stdout; `agent-bridge` intercepts them (doesn't forward to the renderer), executes via the driver, and writes the reply back to the worker's stdin. The browser-panel architecture (single Anchor source of truth, session-bucketed markers, main-hub broadcast) is covered by the browser-selection-echo and browser-panel-nav memory notes.

## 6. Build

The desktop has its **own** build and typecheck — the root checks do not cover it:
- `build:main` / `build:preload` via esbuild (ESM main, CJS preload), `build:renderer` / `build:mobile` via Vite.
- `typecheck`: `tsc --noEmit` for main+preload, plus a mobile tsconfig.
- node-pty is rebuilt for the Electron ABI and `asarUnpack`'d (can't live in asar); the renderer Vite output stays outside asar too. `webviewTag` is enabled for the embedded browser. (The desktop-four-panels and desktop-shadcn notes.)

## 7. Where to read next
- The worker's engine and the StreamEvents it emits: [01 · Engine & turn loop](01-engine-and-turn-loop.md)
- The protocol the worker speaks over stdio: [04 · Protocol & sessions](04-protocol-and-sessions.md)
- The `BrowserBridge` contract and browser tools: [02 · Tool system](02-tool-system.md)
- The same reducer/renderer ideas in the terminal: [09 · TUI package](09-tui.md)
