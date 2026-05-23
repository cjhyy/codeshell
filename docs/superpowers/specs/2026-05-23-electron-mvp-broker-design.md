# Electron MVP (Phase 2) — Broker Architecture Design

> Status: Approved 2026-05-23. Implements task #69 (Electron Phase 2:
> main 接 Engine + preload 具名 API + renderer 真 UI). MVP scope — not
> a production desktop release.

## 1. Goal

Stand up a working Electron desktop client that demonstrates the full
agent flow end-to-end (prompt → streamed tokens → tool call display →
approval prompt) without committing to UI polish or production packaging.
"Sample / MVP" — proves the architecture, not the product.

The MVP is a **dev-mode-only** target. `bun run dev` from
`packages/desktop` opens a window, talks to a freshly spawned agent
worker over stdio JSON-RPC, and renders the stream. No `.app`/`.exe`
build, no config panel, no session list, no UI theme work.

## 2. Architectural decision: broker, not in-process

Researched openai/codex `codex-rs/app-server-protocol` and
`app-server-transport`. Codex Desktop spawns the codex Rust binary as a
subprocess and pipes stdio JSON-RPC into the Electron main; main is a
broker between renderer (contextBridge IPC) and agent subprocess (stdio).
We mirror that architecture because:

- The Engine runs in its own process. A crash takes down the worker, not
  the Electron window.
- Same architecture serves future hosts (VS Code extension, headless
  CLI, remote SDK over WebSocket) — they all spawn or connect to the
  same `AgentServer` shape, just over a different transport.
- The codeshell `protocol/` layer was already designed transport-agnostic.
  `StdioTransport` already exists at
  `packages/core/src/protocol/transport.ts:75`; `AgentServer` already
  takes a transport. The work is mostly a thin entry-point wrapper.

Rejected alternatives:

- **main directly instantiates Engine + AgentServer (in-process).** Less
  code, but Engine crashes take down Electron, doesn't extend to other
  hosts, and conflicts with the codex pattern we just studied.
- **Reuse `packages/core/src/run/`.** Wrong abstraction. `run/` is the
  batch/CI run system (RunManager, RunStore, checkpoints); it is offline
  by design. Desktop wants a long-lived interactive session, not a queued
  run snapshot.

## 3. Process topology

Three OS processes per running desktop app:

```
Electron Main Process (broker, ~120 lines)
├── BrowserWindow → Renderer Process (React DOM)
└── child_process.spawn(...) → Agent Worker Process
                              (Node, runs core's agent-server-stdio.js)

renderer ↔ main: contextBridge / ipcRenderer ↔ ipcMain
main ↔ agent: child.stdin / child.stdout (newline-delimited JSON-RPC)
```

The renderer never imports `@cjhyy/code-shell-core`. ESLint
`no-restricted-imports` in the root `eslint.config.js` (added during
monorepo batch 8) enforces this for renderer files.

The agent worker uses `process.execPath` + `ELECTRON_RUN_AS_NODE=1` so
the bundled Electron binary serves as the Node runtime — no system Node
required when we eventually ship a packaged build.

## 4. Where Agent Worker lives (no separate install)

The agent worker is *not* a separate package the user installs.
`@cjhyy/code-shell-core` is a `dependencies` entry of
`@cjhyy/code-shell-desktop`. In dev mode bun symlinks
`packages/desktop/node_modules/@cjhyy/code-shell-core` to
`packages/core/`. The desktop main process resolves the worker entry via
`require.resolve("@cjhyy/code-shell-core/dist/cli/agent-server-stdio.js")`
and spawns Node on that absolute path. No npm `bin` field is added in
MVP — the entry is reached by file path, not by command name. We may
add a `code-shell-agent` bin later if/when third-party integrators want
to spawn it from the command line.

For a future packaged build (out of MVP scope), electron-builder copies
core into `app.asar` automatically since it is a declared dependency,
and the same `require.resolve` works inside the asar.

## 5. Protocol scope

Agent protocol stays small. Use only what `core` already exposes:

**Client → Server (RPC, request/response):**
- `agent/run` — start a turn with a prompt
- `agent/approve` — resolve a pending approval
- `agent/cancel` — abort current turn
- `agent/configure` — runtime knobs (plan mode, bypass)
- `agent/query` — readonly queries (tool list, etc.)
- `agent/inject` — append context without triggering LLM

**Server → Client (notifications, one-way):**
- `agent/streamEvent` — every `StreamEvent` from Engine.run()
  (`text_delta`, `tool_use_start`, `tool_result`, `assistant_message`,
  `turn_complete`, `error`, plus 12 more — see
  `packages/core/src/types.ts:StreamEvent`)
- `agent/approvalRequest` — Engine asks for a tool approval
- `agent/status` — server lifecycle (started, shutting_down)

**Out of MVP protocol scope:**
- LSP-style `initialize` handshake + capability negotiation
- Fuzzy file search / file watcher RPCs (codex has these; we don't need them yet)
- `listSessions` / `getStatus` host conveniences (handled in main layer, not the agent protocol, when we get there)

Rationale: keep the agent protocol minimal and stable so other hosts
(VS Code, remote) can speak it without negotiating dozens of optional
features. Host-specific surfaces (file dialogs, settings panel, session
list) live in the main process and use a *separate* `ipcMain.handle`
channel — never carry them over stdio.

## 6. Component breakdown

### 6.1 `packages/core` — additions (~30 lines)

**`src/cli/agent-server-stdio.ts`** (new, ~25 lines)

```ts
import { Engine, type EngineConfig } from "../engine/engine.js";
import { AgentServer } from "../protocol/server.js";
import { StdioTransport } from "../protocol/transport.js";

export async function runAgentServerStdio(config: EngineConfig): Promise<void> {
  const engine = new Engine(config);
  const transport = new StdioTransport(process.stdin, process.stdout);
  const server = new AgentServer({ engine, transport });

  process.on("SIGTERM", () => server.close());
  process.on("SIGINT", () => server.close());

  await server.start();
}

// Direct-execute entry: `node dist/cli/agent-server-stdio.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = await buildEngineConfigFromSettings();
  await runAgentServerStdio(config);
}
```

**`buildEngineConfigFromSettings()`** is a small new helper in the same
file. It calls `SettingsManager.load()` (existing in
`src/settings/manager.ts`) to read `~/.code-shell/settings.json`, picks
the active provider/model (`settings.activeModel`) and API key
(`settings.providers[...].apiKey`), and assembles the minimal
`EngineConfig` shape: `{ llm: { provider, model, apiKey }, permissionMode: "interactive" }`.
Any additional EngineConfig fields use core's existing defaults. The
helper is roughly 15 lines — not a black box, but mechanical enough that
the plan can spell out the exact mapping.

**`src/index.ts`** — add `export { runAgentServerStdio } from "./cli/agent-server-stdio.js"`.

**`src/logging/logger.ts`** — when `process.env.CODESHELL_AGENT_STDIO === "1"`, force all log output to `stderr`. Avoids polluting stdout JSON-RPC stream.

**Build (`tsc`)** — `src/cli/agent-server-stdio.ts` is picked up by the existing `tsconfig.json` glob; no script changes needed.

**`package.json`** — no `bin` field in MVP. Adding the bin would require deciding the public command name, npm publish surface area, etc. Defer.

### 6.2 `packages/tui` — zero changes

The TUI CLI does not know about the desktop. `code-shell` bin still
launches React/Ink as before.

### 6.3 `packages/desktop` — rewrite placeholders (~250 lines)

**`src/main/agent-bridge.ts`** (new, ~80 lines)

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { BrowserWindow, ipcMain } from "electron";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const agentEntry = require.resolve("@cjhyy/code-shell-core/dist/cli/agent-server-stdio.js");

export class AgentBridge {
  private child: ChildProcess | null = null;
  private restartCount = 0;
  private restartWindowStart = Date.now();

  constructor(private window: BrowserWindow) {
    this.spawnChild();
    this.wireRendererToChild();
  }

  private spawnChild() {
    this.child = spawn(process.execPath, [agentEntry], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CODESHELL_AGENT_STDIO: "1" },
      stdio: ["pipe", "pipe", "inherit"],
    });

    const rl = createInterface({ input: this.child.stdout! });
    rl.on("line", (line) => {
      this.window.webContents.send("agent:msg", line);
    });

    this.child.on("exit", (code) => {
      this.window.webContents.send("agent:lifecycle", { type: "exited", code });
      if (this.shouldRestart()) {
        this.spawnChild();
        this.window.webContents.send("agent:lifecycle", { type: "restarted" });
      } else {
        this.window.webContents.send("agent:lifecycle", { type: "gave_up" });
      }
    });
  }

  private shouldRestart(): boolean {
    const now = Date.now();
    if (now - this.restartWindowStart > 60_000) {
      this.restartWindowStart = now;
      this.restartCount = 0;
    }
    this.restartCount++;
    return this.restartCount <= 3;
  }

  private wireRendererToChild() {
    ipcMain.on("agent:msg", (_e, line: string) => {
      this.child?.stdin?.write(line + "\n");
    });
  }

  kill() { this.child?.kill("SIGTERM"); }
}
```

**`src/main/index.ts`** — rewrite (~40 lines): create BrowserWindow, instantiate `AgentBridge`, wire `app.before-quit → bridge.kill()`.

**`src/preload/index.ts`** — rewrite (~50 lines), contextBridge:

```ts
import { contextBridge, ipcRenderer } from "electron";

let nextRpcId = 1;
const pending = new Map<number, (resp: unknown) => void>();
const streamListeners: Array<(event: unknown) => void> = [];
const approvalListeners: Array<(req: unknown) => void> = [];
const lifecycleListeners: Array<(evt: unknown) => void> = [];

const statusListeners: Array<(evt: unknown) => void> = [];

ipcRenderer.on("agent:msg", (_e, line: string) => {
  const msg = JSON.parse(line);
  if ("id" in msg && !("method" in msg)) {
    // response to a prior client→server request
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  } else if (msg.method === "agent/streamEvent") {
    streamListeners.forEach((cb) => cb(msg.params));
  } else if (msg.method === "agent/approvalRequest") {
    approvalListeners.forEach((cb) => cb(msg.params));
  } else if (msg.method === "agent/status") {
    statusListeners.forEach((cb) => cb(msg.params));
  }
});

ipcRenderer.on("agent:lifecycle", (_e, evt) => lifecycleListeners.forEach((cb) => cb(evt)));

function rpc(method: string, params?: unknown): Promise<unknown> {
  const id = nextRpcId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ipcRenderer.send("agent:msg", JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

contextBridge.exposeInMainWorld("codeshell", {
  run: (prompt: string, opts?: unknown) => rpc("agent/run", { prompt, ...opts as object }),
  cancel: () => rpc("agent/cancel"),
  approve: (id: string, decision: "approve" | "deny", reason?: string) =>
    rpc("agent/approve", { id, decision, reason }),
  onStreamEvent: (cb: (event: unknown) => void) => { streamListeners.push(cb); },
  onApprovalRequest: (cb: (req: unknown) => void) => { approvalListeners.push(cb); },
  onStatus: (cb: (evt: unknown) => void) => { statusListeners.push(cb); },
  onAgentLifecycle: (cb: (evt: unknown) => void) => { lifecycleListeners.push(cb); },
});
```

The other three client→server RPCs (`agent/configure`, `agent/query`,
`agent/inject`) are intentionally *not* exposed in MVP — renderer has
no UI for plan-mode toggles, tool introspection, or context injection.
They remain reachable via the protocol; when a renderer feature needs
them, add a contextBridge method then.

**`src/preload/types.d.ts`** — fill in `Window.codeshell` shape using core's exported types (`StreamEvent`, `ApprovalRequest`).

**`src/renderer/*.tsx`** — replace placeholder:

| File | Purpose |
|---|---|
| `App.tsx` | top-level; wires window.codeshell listeners on mount |
| `ChatView.tsx` | input box + scrolling message list |
| `MessageStream.tsx` | accumulates `text_delta` events into a coherent assistant message |
| `ToolCallBlock.tsx` | renders `tool_use_start` / `tool_use_args_delta` / `tool_result` for a single call |
| `ApprovalModal.tsx` | listens for `approvalRequest`, shows modal, calls `window.codeshell.approve` |
| `styles.css` | basic CSS, dark background, monospace font — not styled to codex |

## 7. Data flow: one prompt's round trip

1. User types in `ChatView`, presses Enter.
2. `window.codeshell.run("list files")` → preload `rpc()` → `ipcRenderer.send("agent:msg", '{"jsonrpc":"2.0","id":1,"method":"agent/run","params":{"prompt":"list files"}}')`.
3. main `ipcMain.on("agent:msg")` → `child.stdin.write(line + "\n")`.
4. Agent worker `StdioTransport` reads line → `AgentServer.handleMessage` → `engine.run()` starts.
5. Engine emits `StreamEvent` (e.g. `text_delta`) → `server.transport.send({ method: "agent/streamEvent", params: event })` → stdout line.
6. main `child.stdout` readline → `window.webContents.send("agent:msg", line)`.
7. preload `ipcRenderer.on("agent:msg")` → parse JSON → dispatch to `streamListeners`.
8. React state update in `MessageStream` → re-render → tokens appear.

Approval flow is similar but bidirectional: Engine emits an
`ApprovalRequest` notification with an id; renderer's `ApprovalModal`
calls `window.codeshell.approve(id, decision)`, which round-trips back
to Engine via `agent/approve` and unblocks the tool.

## 8. Configuration

Agent worker on startup reads `~/.code-shell/settings.json` via core's
existing `SettingsManager` — same path TUI uses. Desktop and TUI share
one account / one set of API keys.

No settings UI in MVP. Users edit `~/.code-shell/settings.json`
directly or use TUI's `/settings` command. A settings panel is planned
for Phase 3.

## 9. Error handling

| Failure | Behavior |
|---|---|
| Agent worker crashes | main auto-respawns, pushes `agent_restarted` lifecycle event. Renderer shows a banner; conversation state in renderer is preserved (we don't try to resume Engine state) |
| Crash loop (>3 in 60s) | main gives up, pushes `agent_gave_up`. Renderer shows error banner with "Quit and reopen" instruction |
| Renderer sends malformed JSON | Agent worker skips the line silently (StdioTransport already does this) |
| Stdout line is non-JSON garbage | Same — skipped. Caught by `CODESHELL_AGENT_STDIO=1 → logger writes stderr` discipline |
| Electron quits | `app.before-quit` → `bridge.kill("SIGTERM")` → 5s grace → SIGKILL (Node default) |

## 10. Out of scope (explicitly)

- Production packaging (`.app` / `.dmg` / `.exe`, code signing, auto-update)
- Multi-window / multi-session
- Session history / persistence in renderer
- Settings panel UI
- codex-desktop visual style (the renderer is intentionally ugly)
- Remote agent (WebSocket transport between main and a remote worker)
- LSP-style capability handshake
- Streaming UI optimizations (virtual list, message recycling)
- Tray icon, menu bar, keyboard shortcut customization
- DevTools auto-install, hot reload of main process source

These are tracked separately or deferred to Phase 3.

## 11. Acceptance criteria

```
✅ `bun run --filter @cjhyy/code-shell-core build` produces
   dist/cli/agent-server-stdio.js
✅ `cd packages/desktop && bun run dev` opens an Electron window
✅ Typing "what's 2 + 2" shows streamed tokens token-by-token
✅ Typing "list files in /tmp" shows a Bash tool block with args
✅ The Bash call triggers an approval modal; clicking Approve resumes
   the tool and the output appears
✅ Clicking Deny returns a tool error to the agent; conversation continues
✅ Closing the Electron window leaves no zombie agent process
   (verify: `ps aux | grep agent-server-stdio` returns empty)
✅ Manually killing the agent worker triggers an "agent restarted"
   banner in renderer; next prompt works
✅ Killing the agent worker 4× in 60s shows a "gave up" banner
```

## 12. Risks

1. **Module resolution in ESM `import.meta.url` style.** esbuild bundles
   main as ESM; `require.resolve` via `createRequire(import.meta.url)`
   works for top-level resolution but if esbuild inlines
   `@cjhyy/code-shell-core` into the main bundle, the resolve fails at
   runtime. **Mitigation**: add `--external:@cjhyy/code-shell-core` to
   `build:main` so core stays in node_modules at runtime.

2. **stdout pollution by Engine logs.** Any `console.log` or unguarded
   logger output in the agent worker corrupts the JSON-RPC stream.
   **Mitigation**: `CODESHELL_AGENT_STDIO=1` switches logger to stderr.
   Audit core for raw `console.log` (should be none — existing logger
   abstraction already used).

3. **First-prompt latency.** Worker startup (~300-600ms cold) plus
   Engine init (LLM client construction, settings load) means the first
   prompt has a noticeable delay. MVP accepts this. If unacceptable
   later, pre-warm worker on app launch (we already do this).

4. **Approval timeout.** `AgentServer` has a 5-minute approval timeout.
   If user takes longer to click Approve, the tool fails. MVP accepts.

5. **Renderer holds large transcripts in memory.** No persistence, no
   pagination. For MVP a few hundred messages is fine. Beyond that,
   virtualize. Phase 3.

## 13. Implementation batching (writing-plans will refine)

| Batch | Files | Hours |
|---|---|---|
| B1 | `packages/core/src/cli/agent-server-stdio.ts` + index export + logger stderr toggle + load-config helper | 1 |
| B2 | `packages/desktop/src/main/agent-bridge.ts` + rewrite `main/index.ts` | 2 |
| B3 | `packages/desktop/src/preload/index.ts` + `types.d.ts` | 1 |
| B4 | `packages/desktop/src/renderer/` (App, ChatView, MessageStream, ToolCallBlock, ApprovalModal, styles) | 4-6 |
| B5 | Dogfood + bug fixes + 9 acceptance checks pass | 2-4 |

Total: 1-2 working days. Same as #69 estimate in TaskList.

## 14. Open questions resolved during brainstorming

- **Where does main↔agent talk happen?** stdio JSON-RPC, broker pattern (codex-style).
- **Does the user install the worker separately?** No. core is a desktop dependency, ships in app bundle.
- **Does TUI change?** No. Zero edits.
- **Does the agent protocol grow?** No new methods in MVP. Future host-specific surfaces (settings, file ops) go on a separate ipcMain channel, not on the agent protocol.
- **Do we add a `bin` field to core?** Not in MVP. Desktop resolves the worker entry by file path. Bin can be added later for third-party command-line integrators.
- **What about generating a packaged build?** Out of MVP. Dev mode only.
- **What about a settings UI panel?** Phase 3.

## 15. Next step

Invoke `superpowers:writing-plans` to produce a step-by-step
implementation plan (`docs/superpowers/plans/2026-05-23-electron-mvp-broker.md`).
