# Electron MVP (Phase 2) — Broker Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the codex-style desktop POC end-to-end: an Electron app whose main process is a broker that spawns a Node subprocess running `@cjhyy/code-shell-core`'s `AgentServer` over stdio JSON-RPC, with a typed contextBridge preload and a React DOM renderer that handles streaming tokens, tool calls, and approval prompts.

**Architecture:** Three-process model (Electron Main / Renderer / Agent Worker). Main is a broker — it spawns the worker via `process.execPath` + `ELECTRON_RUN_AS_NODE=1`, pipes renderer ipc messages to child stdin, and forwards child stdout lines to the renderer. Agent Worker runs core's `AgentServer + Engine` over `StdioTransport`. Renderer never imports core.

**Tech Stack:** Electron 33, React 19, vite, esbuild, bun workspaces. Core JSON-RPC protocol already exists in `packages/core/src/protocol/`. Approved spec at `docs/superpowers/specs/2026-05-23-electron-mvp-broker-design.md`.

**Reality-check corrections to spec §6.1** (verified against the actual codebase before writing this plan; the plan is the source of truth where they differ):

| Spec claim | Reality | Plan response |
|---|---|---|
| `await server.start()` keeps worker alive | `AgentServer` has no `start()`; constructor wires transport immediately | Plan keeps the process alive by awaiting a Promise that resolves on stdin close + on SIGTERM |
| `await loadConfigFromSettings()` | `SettingsManager.load()` is synchronous; settings shape uses `settings.model.{provider, name, apiKey, baseUrl}` (see `packages/tui/src/cli/main.ts:117-134`) — NOT `settings.providers[]` | Plan defines `buildEngineConfigFromSettings()` mapping the real fields |
| "core logger pollutes stdout" risk | Logger writes JSONL **files**, never stdout. But ~10 `console.warn`/`console.error` exist in `plugins/`, `permission.ts`, `hooks/shell-runner.ts` | Plan adds a stdout-guard at worker startup that redirects `console.*` to stderr — simpler than auditing every callsite |

---

## File Structure

### `packages/core` — new files only

| File | Purpose |
|---|---|
| `src/cli/agent-server-stdio.ts` (new) | `runAgentServerStdio(config)` + `buildEngineConfigFromSettings()` + direct-execute entry. Wires `Engine` + `AgentServer` + `StdioTransport`, redirects `console.*` → stderr, waits for stdin EOF |
| `src/index.ts` (modify) | Add `export { runAgentServerStdio } from "./cli/agent-server-stdio.js";` |

No `bin` field added. No script changes. No `package.json` changes.

### `packages/desktop` — replace placeholders

| File | State | Purpose |
|---|---|---|
| `src/main/agent-bridge.ts` (new) | new | `AgentBridge` class: spawn worker, readline stdout → renderer, ipcMain → child stdin, exit/restart policy, lifecycle events |
| `src/main/index.ts` (rewrite) | placeholder → ~50 lines | createWindow + new AgentBridge + before-quit hook |
| `src/preload/index.ts` (rewrite) | placeholder → ~60 lines | contextBridge with `run/cancel/approve/onStreamEvent/onApprovalRequest/onStatus/onAgentLifecycle` |
| `src/preload/types.d.ts` (rewrite) | placeholder → real types | `Window.codeshell` shape using core's `StreamEvent` and `ApprovalRequest` |
| `src/renderer/App.tsx` (rewrite) | placeholder → orchestrator | top-level, wires listeners on mount, holds messages + pendingApproval state |
| `src/renderer/ChatView.tsx` (new) | — | input box + scrolling message list (renders `Message[]`) |
| `src/renderer/MessageStream.tsx` (new) | — | accumulates `text_delta` events into a coherent assistant message |
| `src/renderer/ToolCallBlock.tsx` (new) | — | renders `tool_use_start` / `tool_result` per tool call id |
| `src/renderer/ApprovalModal.tsx` (new) | — | modal that surfaces an `ApprovalRequest` and posts the decision |
| `src/renderer/types.ts` (new) | — | renderer-local `Message` discriminated union (user / assistant / tool); helpers that map `StreamEvent`s into `Message`s |
| `src/renderer/styles.css` (rewrite) | minimal placeholder → basic CSS | dark background, monospace, vertical stack |
| `src/renderer/main.tsx` (no change) | — | already mounts `<App/>` |

### `packages/tui` — zero changes.

---

## Task 1: core — `agent-server-stdio.ts` skeleton + direct-execute entry

**Files:**
- Create: `packages/core/src/cli/agent-server-stdio.ts`
- Modify: `packages/core/src/index.ts` (add export at end)

**Why this task:** Establishes the worker entry point. The whole desktop spawn-tree dies without this file. We start with the smallest possible thing that can be `node`-executed and a smoke check that proves it.

- [ ] **Step 1: Create the file**

Write `packages/core/src/cli/agent-server-stdio.ts`:

```ts
/**
 * Headless agent server over stdio (newline-delimited JSON-RPC).
 *
 * Spawned as a Node subprocess by hosts that want to embed code-shell's
 * Engine without linking against the engine in-process. Reads RPC
 * messages from stdin, writes responses + stream notifications to
 * stdout. All log/console output goes to stderr so stdout stays a clean
 * JSON-RPC channel.
 *
 * Hosts:
 *   - packages/desktop (Electron main spawns this)
 *   - third-party IDE/CLI integrators in the future
 */

import { Engine, type EngineConfig } from "../engine/engine.js";
import { AgentServer } from "../protocol/server.js";
import { StdioTransport } from "../protocol/transport.js";
import { SettingsManager } from "../settings/manager.js";
import type { LLMConfig } from "../types.js";

/**
 * Run the agent server on this process's stdin/stdout. Resolves when
 * stdin closes (parent disconnected) or on SIGTERM/SIGINT.
 */
export async function runAgentServerStdio(config: EngineConfig): Promise<void> {
  // Redirect console.* to stderr so stray plugin/permission warnings
  // can't corrupt the JSON-RPC stdout stream. Engine's own logger
  // already writes to ~/.code-shell/logs/, not stdout.
  console.log = (...args) => process.stderr.write(args.map(String).join(" ") + "\n");
  console.info = console.log;
  console.warn = console.log;
  console.error = console.log;

  const engine = new Engine(config);
  const transport = new StdioTransport(process.stdin, process.stdout);
  // Constructor wires transport.onMessage and sends a "ready" status
  // notification. There is no separate start() — see protocol/server.ts.
  const server = new AgentServer({ engine, transport });

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close();
      resolve();
    };
    process.stdin.on("end", shutdown);
    process.stdin.on("close", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
}

/**
 * Build a minimal EngineConfig from ~/.code-shell/settings.json.
 * Mirrors the field mapping that packages/tui/src/cli/main.ts uses
 * for its REPL launch (settings.model.{provider, name, apiKey, baseUrl}).
 */
export function buildEngineConfigFromSettings(): EngineConfig {
  const settings = new SettingsManager(process.cwd()).get();
  const llm: LLMConfig = {
    provider: settings.model.provider ?? "openai",
    model: settings.model.name ?? "anthropic/claude-opus-4-6",
    apiKey: settings.model.apiKey,
    baseUrl: settings.model.baseUrl ?? "https://openrouter.ai/api/v1",
    enableStreaming: true,
  };
  if (!llm.apiKey) {
    throw new Error(
      "agent-server-stdio: no API key in settings.json. Run `code-shell` once " +
        "in a terminal to configure, or set settings.model.apiKey directly.",
    );
  }
  return { llm, permissionMode: "default" };
}

// Direct-execute entry: `node dist/cli/agent-server-stdio.js`.
// Detect "I'm the main module" the ESM-safe way.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = buildEngineConfigFromSettings();
  runAgentServerStdio(config).catch((err) => {
    process.stderr.write(`agent-server-stdio fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Add the export**

Open `packages/core/src/index.ts`. Find the line near the bottom that
exports `createInProcessClient` (`export { createInProcessClient } from "./protocol/helpers.js";`).
Add directly after it:

```ts
export { runAgentServerStdio, buildEngineConfigFromSettings } from "./cli/agent-server-stdio.js";
```

- [ ] **Step 3: Build core**

Run from repo root:

```bash
bun run --filter @cjhyy/code-shell-core build
```

Expected: completes with no TypeScript errors. Output includes
`packages/core/dist/cli/agent-server-stdio.js`.

Verify the file exists:

```bash
ls -la packages/core/dist/cli/agent-server-stdio.js
```

Expected: a file appears (non-zero bytes).

- [ ] **Step 4: Smoke test — does it parse and respond to a ping?**

This is a manual integration check, not a unit test, because we're
verifying a process spawn + stdin/stdout protocol.

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"agent/query","params":{"type":"tools"}}' \
  | timeout 3 node packages/core/dist/cli/agent-server-stdio.js \
  2>/dev/null | head -1
```

Expected output (single line of JSON, possibly preceded by a `status: ready` notification):

```
{"jsonrpc":"2.0","method":"agent/status","params":{"status":"ready"}}
```

…followed by, on the second line:

```
{"jsonrpc":"2.0","id":1,"result":{"type":"tools","data":[...]}}
```

If stdout is empty or contains non-JSON garbage, something is polluting
the stdout channel — fix that before continuing.

If it errors with "no API key", set one in `~/.code-shell/settings.json`
first (or `OPENROUTER_API_KEY` env var, depending on how `SettingsManager`
resolves keys — check the file if needed).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli/agent-server-stdio.ts packages/core/src/index.ts
git commit -m "feat(core): agent-server-stdio entry for headless hosts"
```

---

## Task 2: desktop main — `AgentBridge` (spawn + pipe + restart)

**Files:**
- Create: `packages/desktop/src/main/agent-bridge.ts`
- Modify: `packages/desktop/src/main/index.ts` (rewrite from placeholder)
- Modify: `packages/desktop/package.json` (add `build:main` `--external:@cjhyy/code-shell-core`)

**Why this task:** The broker is the architecture's spine. It must spawn the worker with the right Node mode, pipe both directions, and survive (or recover from) worker crashes.

- [ ] **Step 1: Add `--external` to esbuild so the worker isn't bundled into main**

Open `packages/desktop/package.json`. Find the `build:main` script:

```json
"build:main": "esbuild src/main/index.ts --bundle --platform=node --format=esm --outfile=out/main/index.mjs --external:electron --loader:.md=text --banner:js=\"import { createRequire as __ccr } from 'node:module'; const require = __ccr(import.meta.url);\"",
```

Add `--external:@cjhyy/code-shell-core` before `--loader:.md=text`. The
line becomes:

```json
"build:main": "esbuild src/main/index.ts --bundle --platform=node --format=esm --outfile=out/main/index.mjs --external:electron --external:@cjhyy/code-shell-core --loader:.md=text --banner:js=\"import { createRequire as __ccr } from 'node:module'; const require = __ccr(import.meta.url);\"",
```

Also update `packages/desktop/scripts/dev.ts` and
`packages/desktop/scripts/build.ts` — both have an esbuild config for
main that needs `external: ["electron", "@cjhyy/code-shell-core"]`:

In `scripts/dev.ts` find:
```ts
external: ["electron"],
loader: { ".md": "text" },
```
and change to:
```ts
external: ["electron", "@cjhyy/code-shell-core"],
loader: { ".md": "text" },
```

In `scripts/build.ts` find:
```ts
external: ["electron"],
```
(under `buildMain`) and change to:
```ts
external: ["electron", "@cjhyy/code-shell-core"],
```

**Rationale:** If esbuild bundles core into the main `.mjs`, then
`require.resolve("@cjhyy/code-shell-core/dist/cli/agent-server-stdio.js")`
fails at runtime because the symlink target isn't present where the
bundle expects it. Marking core external forces main to resolve it via
the normal `node_modules` symlink (workspace), where the dist file does
exist.

- [ ] **Step 2: Create `agent-bridge.ts`**

Write `packages/desktop/src/main/agent-bridge.ts`:

```ts
/**
 * AgentBridge — Electron main ↔ agent worker subprocess broker.
 *
 * Responsibilities:
 *   - Spawn a Node subprocess running @cjhyy/code-shell-core's
 *     agent-server-stdio.js with ELECTRON_RUN_AS_NODE=1 so the
 *     Electron binary serves as the Node runtime.
 *   - Pipe child stdout (readline-split) → renderer via
 *     window.webContents.send("agent:msg", line).
 *   - Pipe ipcMain "agent:msg" lines from renderer → child stdin.
 *   - Watch for child exit. Auto-respawn up to 3 times per 60s window;
 *     emit "agent:lifecycle" events to the renderer.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { BrowserWindow, ipcMain } from "electron";

const require = createRequire(import.meta.url);
const agentEntry = require.resolve(
  "@cjhyy/code-shell-core/dist/cli/agent-server-stdio.js",
);

const RESTART_WINDOW_MS = 60_000;
const RESTART_LIMIT = 3;

export class AgentBridge {
  private child: ChildProcess | null = null;
  private restartCount = 0;
  private restartWindowStart = Date.now();
  private ipcListenerAttached = false;

  constructor(private window: BrowserWindow) {
    this.spawnChild();
    this.attachIpcListener();
  }

  private spawnChild(): void {
    this.child = spawn(process.execPath, [agentEntry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        CODESHELL_AGENT_STDIO: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!this.child.stdout || !this.child.stdin || !this.child.stderr) {
      throw new Error("AgentBridge: child stdio not piped");
    }

    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      this.safeSend("agent:msg", line);
    });

    // Mirror child stderr into the Electron main console so logs and
    // crashes are visible during dev.
    this.child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[agent] ${chunk.toString()}`);
    });

    this.child.on("exit", (code) => {
      this.safeSend("agent:lifecycle", { type: "exited", code });
      if (this.shouldRestart()) {
        this.spawnChild();
        this.safeSend("agent:lifecycle", { type: "restarted" });
      } else {
        this.safeSend("agent:lifecycle", { type: "gave_up" });
      }
    });
  }

  private shouldRestart(): boolean {
    const now = Date.now();
    if (now - this.restartWindowStart > RESTART_WINDOW_MS) {
      this.restartWindowStart = now;
      this.restartCount = 0;
    }
    this.restartCount++;
    return this.restartCount <= RESTART_LIMIT;
  }

  private attachIpcListener(): void {
    if (this.ipcListenerAttached) return;
    this.ipcListenerAttached = true;
    ipcMain.on("agent:msg", (_event, line: string) => {
      if (!this.child?.stdin || this.child.stdin.destroyed) return;
      this.child.stdin.write(line + "\n");
    });
  }

  private safeSend(channel: string, payload: unknown): void {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send(channel, payload);
  }

  kill(): void {
    this.child?.kill("SIGTERM");
  }
}
```

- [ ] **Step 3: Rewrite `main/index.ts`**

Replace the entire contents of `packages/desktop/src/main/index.ts` with:

```ts
/**
 * Electron main entry — broker between renderer (ipcMain) and the
 * agent worker subprocess (stdio JSON-RPC). See agent-bridge.ts.
 */

import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { AgentBridge } from "./agent-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let bridge: AgentBridge | null = null;
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: resolve(__dirname, "..", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs node APIs (electron contextBridge)
    },
  });

  const devUrl = process.env.VITE_DEV_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(resolve(__dirname, "..", "renderer", "index.html"));
  }

  bridge = new AgentBridge(mainWindow);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  bridge?.kill();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
```

- [ ] **Step 4: Build main + preload (preload still placeholder)**

```bash
cd packages/desktop && bun run build:main
```

Expected: emits `packages/desktop/out/main/index.mjs`, no esbuild errors,
no warning about unresolved `@cjhyy/code-shell-core` (because it's
external).

- [ ] **Step 5: Smoke — spawn but don't open window (sanity check the resolve)**

```bash
node -e "import('./packages/desktop/out/main/index.mjs').catch(e => { console.error(e); process.exit(1); })"
```

Expected: this **will** fail (because `electron` module isn't available
outside an electron runtime), but the error must be "Cannot find module
'electron'" — NOT "Cannot find module '@cjhyy/code-shell-core/dist/cli/agent-server-stdio.js'".
The latter would mean step 1's `--external` didn't take effect.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/main/agent-bridge.ts \
        packages/desktop/src/main/index.ts \
        packages/desktop/package.json \
        packages/desktop/scripts/dev.ts \
        packages/desktop/scripts/build.ts
git commit -m "feat(desktop/main): AgentBridge broker spawns core agent worker"
```

---

## Task 3: desktop preload — contextBridge typed API

**Files:**
- Modify: `packages/desktop/src/preload/index.ts` (rewrite)
- Modify: `packages/desktop/src/preload/types.d.ts` (rewrite)

**Why this task:** Preload defines the renderer's *only* way to reach
the agent. Get the typed shape right — renderer code is much harder to
unwind once the API leaks via untyped `unknown`.

- [ ] **Step 1: Replace `preload/index.ts`**

```ts
/**
 * Preload — bridges the renderer (browser context) to Electron main's
 * ipcMain via contextBridge. The renderer never imports core; it sees
 * only the typed `window.codeshell` surface defined here.
 *
 * Wire format on the IPC channel "agent:msg" is the full JSON-RPC
 * line (string) we relay verbatim to/from the agent worker's stdio.
 * That keeps the preload a true transparent transport — no protocol
 * interpretation in main, only in here (to fan out to listeners).
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

let nextRpcId = 1;
const pending = new Map<number, (resp: unknown) => void>();
const streamListeners: Array<(event: unknown) => void> = [];
const approvalListeners: Array<(req: unknown) => void> = [];
const statusListeners: Array<(evt: unknown) => void> = [];
const lifecycleListeners: Array<(evt: unknown) => void> = [];

ipcRenderer.on("agent:msg", (_e: IpcRendererEvent, line: string) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // malformed — skip
  }
  // Response: has id, no method
  if ("id" in msg && !("method" in msg)) {
    const id = msg.id as number;
    const resolver = pending.get(id);
    if (resolver) {
      pending.delete(id);
      resolver(msg);
    }
    return;
  }
  // Notification: has method
  const method = msg.method as string | undefined;
  const params = msg.params;
  if (method === "agent/streamEvent") streamListeners.forEach((cb) => cb(params));
  else if (method === "agent/approvalRequest") approvalListeners.forEach((cb) => cb(params));
  else if (method === "agent/status") statusListeners.forEach((cb) => cb(params));
});

ipcRenderer.on("agent:lifecycle", (_e: IpcRendererEvent, evt: unknown) => {
  lifecycleListeners.forEach((cb) => cb(evt));
});

function rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const id = nextRpcId++;
  const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ipcRenderer.send("agent:msg", line);
  });
}

contextBridge.exposeInMainWorld("codeshell", {
  run: (prompt: string, opts?: Record<string, unknown>) =>
    rpc("agent/run", { prompt, ...(opts ?? {}) }),
  cancel: () => rpc("agent/cancel"),
  approve: (id: string, decision: "approve" | "deny", reason?: string) =>
    rpc("agent/approve", { id, decision, reason }),
  onStreamEvent: (cb: (event: unknown) => void): (() => void) => {
    streamListeners.push(cb);
    return () => {
      const i = streamListeners.indexOf(cb);
      if (i >= 0) streamListeners.splice(i, 1);
    };
  },
  onApprovalRequest: (cb: (req: unknown) => void): (() => void) => {
    approvalListeners.push(cb);
    return () => {
      const i = approvalListeners.indexOf(cb);
      if (i >= 0) approvalListeners.splice(i, 1);
    };
  },
  onStatus: (cb: (evt: unknown) => void): (() => void) => {
    statusListeners.push(cb);
    return () => {
      const i = statusListeners.indexOf(cb);
      if (i >= 0) statusListeners.splice(i, 1);
    };
  },
  onAgentLifecycle: (cb: (evt: unknown) => void): (() => void) => {
    lifecycleListeners.push(cb);
    return () => {
      const i = lifecycleListeners.indexOf(cb);
      if (i >= 0) lifecycleListeners.splice(i, 1);
    };
  },
});
```

Note the listener registration returns an unsubscribe function — React
`useEffect` callers will use it for cleanup on unmount.

- [ ] **Step 2: Replace `preload/types.d.ts`**

```ts
/**
 * Renderer-visible types for window.codeshell. Imports `type`-only from
 * core; nothing at runtime crosses the boundary (the lint rule that bans
 * core imports in renderer source explicitly allows `import type`).
 */

import type { StreamEvent, ApprovalRequest } from "@cjhyy/code-shell-core";

export interface RpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export type AgentStatusEvent = { status: "ready" | "shutting_down" | string };

export type AgentLifecycleEvent =
  | { type: "exited"; code: number | null }
  | { type: "restarted" }
  | { type: "gave_up" };

export type Unsubscribe = () => void;

export interface CodeshellApi {
  run(prompt: string, opts?: Record<string, unknown>): Promise<RpcResponse>;
  cancel(): Promise<RpcResponse>;
  approve(id: string, decision: "approve" | "deny", reason?: string): Promise<RpcResponse>;
  onStreamEvent(cb: (event: StreamEvent) => void): Unsubscribe;
  onApprovalRequest(cb: (req: ApprovalRequest) => void): Unsubscribe;
  onStatus(cb: (evt: AgentStatusEvent) => void): Unsubscribe;
  onAgentLifecycle(cb: (evt: AgentLifecycleEvent) => void): Unsubscribe;
}

declare global {
  interface Window {
    codeshell: CodeshellApi;
  }
}

export {};
```

- [ ] **Step 3: Build preload**

```bash
cd packages/desktop && bun run build:preload
```

Expected: emits `packages/desktop/out/preload/index.cjs`. No esbuild
errors. The `import type` of `StreamEvent` / `ApprovalRequest` is erased
at compile time so it doesn't show up as a runtime dep.

- [ ] **Step 4: Typecheck**

```bash
cd packages/desktop && bun run typecheck
```

Expected: 0 errors. If renderer files still reference placeholders and
fail typecheck, that's fine — we rewrite them in Task 4. Make a note of
any error so the next task can address it; do not paper over.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/preload/index.ts \
        packages/desktop/src/preload/types.d.ts
git commit -m "feat(desktop/preload): typed contextBridge surface (run/approve/stream/...)"
```

---

## Task 4: desktop renderer — types + state shape

**Files:**
- Create: `packages/desktop/src/renderer/types.ts`

**Why this task:** Define the renderer-local message shape before
writing components, so they all agree. This is the source of truth for
how `StreamEvent`s collapse into a UI-displayable conversation.

- [ ] **Step 1: Create the file**

```ts
/**
 * Renderer-local message model. The agent worker streams individual
 * StreamEvents; the renderer accumulates them into a list of Message
 * objects that React renders. One assistant text reply is one
 * Message; one tool call (start → result) is one Message.
 */

import type { StreamEvent, ApprovalRequest } from "@cjhyy/code-shell-core";

export type Message =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; done: boolean }
  | {
      kind: "tool";
      id: string;
      toolName: string;
      args: string; // serialized
      result?: string; // serialized; undefined while running
      error?: string;
    }
  | { kind: "system"; id: string; text: string };

export interface MessagesReducerState {
  messages: Message[];
  /**
   * Track which assistant message id is currently streaming. Set on
   * `stream_request_start` (we open a fresh assistant message),
   * cleared on `turn_complete`.
   */
  streamingAssistantId: string | null;
}

export const INITIAL_STATE: MessagesReducerState = {
  messages: [],
  streamingAssistantId: null,
};

let _counter = 0;
function freshId(prefix: string): string {
  _counter += 1;
  return `${prefix}-${Date.now()}-${_counter}`;
}

/**
 * Fold a single StreamEvent into the message list. Pure — returns a
 * new state. Unknown event types are no-ops so future Engine event
 * additions don't break the renderer.
 */
export function applyStreamEvent(
  state: MessagesReducerState,
  event: StreamEvent,
): MessagesReducerState {
  switch (event.type) {
    case "stream_request_start": {
      const id = freshId("assistant");
      return {
        messages: [...state.messages, { kind: "assistant", id, text: "", done: false }],
        streamingAssistantId: id,
      };
    }
    case "text_delta": {
      if (!state.streamingAssistantId) return state;
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.kind === "assistant" && m.id === state.streamingAssistantId
            ? { ...m, text: m.text + event.text }
            : m,
        ),
      };
    }
    case "tool_use_start": {
      const id = event.toolCall.id;
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            kind: "tool",
            id,
            toolName: event.toolCall.name,
            args: JSON.stringify(event.toolCall.input ?? {}),
          },
        ],
      };
    }
    case "tool_result": {
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.kind === "tool" && m.id === event.result.toolCallId
            ? {
                ...m,
                result: typeof event.result.output === "string"
                  ? event.result.output
                  : JSON.stringify(event.result.output),
                error: event.result.isError ? "tool reported error" : undefined,
              }
            : m,
        ),
      };
    }
    case "turn_complete": {
      return {
        ...state,
        streamingAssistantId: null,
        messages: state.messages.map((m) =>
          m.kind === "assistant" && m.id === state.streamingAssistantId
            ? { ...m, done: true }
            : m,
        ),
      };
    }
    case "error": {
      return {
        ...state,
        messages: [
          ...state.messages,
          { kind: "system", id: freshId("err"), text: `Error: ${event.error}` },
        ],
        streamingAssistantId: null,
      };
    }
    default:
      return state; // unknown / unhandled events — ignore
  }
}

export function appendUserMessage(
  state: MessagesReducerState,
  text: string,
): MessagesReducerState {
  return {
    ...state,
    messages: [...state.messages, { kind: "user", id: freshId("user"), text }],
  };
}

export type ApprovalState = ApprovalRequest | null;
```

- [ ] **Step 2: Typecheck**

```bash
cd packages/desktop && bun run typecheck
```

Expected: this file alone typechecks (renderer placeholder may still
error — fine).

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/renderer/types.ts
git commit -m "feat(desktop/renderer): message state + StreamEvent reducer"
```

---

## Task 5: desktop renderer — components

**Files:**
- Create: `packages/desktop/src/renderer/MessageStream.tsx`
- Create: `packages/desktop/src/renderer/ToolCallBlock.tsx`
- Create: `packages/desktop/src/renderer/ApprovalModal.tsx`
- Create: `packages/desktop/src/renderer/ChatView.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx` (rewrite placeholder)
- Modify: `packages/desktop/src/renderer/styles.css` (rewrite minimal CSS)

**Why this task:** All the UI surface in one go. They depend on each
other and are tiny — splitting into per-component tasks would mean
half-broken intermediate states. Each component is ≤ 60 lines.

- [ ] **Step 1: `ToolCallBlock.tsx`**

```tsx
import React from "react";
import type { Message } from "./types";

export function ToolCallBlock({ message }: { message: Extract<Message, { kind: "tool" }> }) {
  return (
    <div className="msg msg-tool">
      <div className="msg-tool-head">
        <span className="msg-tool-name">⚙ {message.toolName}</span>
        {message.result === undefined && !message.error && <span className="msg-tool-spin">running…</span>}
      </div>
      <pre className="msg-tool-args">{message.args}</pre>
      {message.result !== undefined && (
        <pre className={message.error ? "msg-tool-err" : "msg-tool-out"}>
          {message.error ?? message.result}
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 2: `MessageStream.tsx`**

```tsx
import React, { useEffect, useRef } from "react";
import type { Message } from "./types";
import { ToolCallBlock } from "./ToolCallBlock";

export function MessageStream({ messages }: { messages: Message[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  return (
    <div className="stream">
      {messages.map((m) => {
        if (m.kind === "tool") return <ToolCallBlock key={m.id} message={m} />;
        if (m.kind === "user")
          return (
            <div key={m.id} className="msg msg-user">
              <pre>{m.text}</pre>
            </div>
          );
        if (m.kind === "assistant")
          return (
            <div key={m.id} className={`msg msg-assistant ${m.done ? "done" : "streaming"}`}>
              <pre>{m.text || (m.done ? "" : "…")}</pre>
            </div>
          );
        return (
          <div key={m.id} className="msg msg-system">
            <pre>{m.text}</pre>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
```

- [ ] **Step 3: `ApprovalModal.tsx`**

```tsx
import React, { useState } from "react";
import type { ApprovalRequest } from "@cjhyy/code-shell-core";

interface Props {
  request: ApprovalRequest;
  onDecide: (decision: "approve" | "deny", reason?: string) => void;
}

export function ApprovalModal({ request, onDecide }: Props) {
  const [denyReason, setDenyReason] = useState("");
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Tool approval needed</h3>
        <div className="modal-body">
          <div><strong>Tool:</strong> {request.toolName}</div>
          <pre className="modal-args">
            {JSON.stringify(request.toolInput ?? {}, null, 2)}
          </pre>
          {request.reason && (
            <div className="modal-reason"><em>Reason: {request.reason}</em></div>
          )}
        </div>
        <div className="modal-actions">
          <input
            type="text"
            placeholder="optional deny reason"
            value={denyReason}
            onChange={(e) => setDenyReason(e.target.value)}
          />
          <button onClick={() => onDecide("deny", denyReason || undefined)}>Deny</button>
          <button className="primary" onClick={() => onDecide("approve")}>
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
```

Note: `ApprovalRequest` fields used (`toolName`, `toolInput`, `reason`)
must exist on core's type. If a field name differs at compile time, the
typecheck step will catch it — adjust to the real field names from
`packages/core/src/types.ts` (this is a known minor risk; see Risk #2).

- [ ] **Step 4: `ChatView.tsx`**

```tsx
import React, { useState } from "react";
import { MessageStream } from "./MessageStream";
import type { Message } from "./types";

interface Props {
  messages: Message[];
  onSend: (text: string) => void;
  busy: boolean;
}

export function ChatView({ messages, onSend, busy }: Props) {
  const [draft, setDraft] = useState("");

  const submit = (): void => {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div className="chat">
      <MessageStream messages={messages} />
      <div className="input-row">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={busy ? "agent is working…" : "ask anything (Enter to send, Shift+Enter for newline)"}
          rows={3}
          disabled={busy}
        />
        <button onClick={submit} disabled={busy || !draft.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Rewrite `App.tsx`**

```tsx
import React, { useEffect, useReducer, useState } from "react";
import type { StreamEvent, ApprovalRequest } from "@cjhyy/code-shell-core";
import { ChatView } from "./ChatView";
import { ApprovalModal } from "./ApprovalModal";
import {
  applyStreamEvent,
  appendUserMessage,
  INITIAL_STATE,
  type MessagesReducerState,
  type ApprovalState,
} from "./types";
import type { AgentLifecycleEvent } from "../preload/types";

type Action =
  | { type: "user_message"; text: string }
  | { type: "stream"; event: StreamEvent };

function reducer(state: MessagesReducerState, action: Action): MessagesReducerState {
  if (action.type === "user_message") return appendUserMessage(state, action.text);
  return applyStreamEvent(state, action.event);
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const [approval, setApproval] = useState<ApprovalState>(null);
  const [lifecycle, setLifecycle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const offStream = window.codeshell.onStreamEvent((event: StreamEvent) => {
      dispatch({ type: "stream", event });
      if (event.type === "turn_complete") setBusy(false);
      if (event.type === "error") setBusy(false);
    });
    const offApproval = window.codeshell.onApprovalRequest((req: ApprovalRequest) => {
      setApproval(req);
    });
    const offLifecycle = window.codeshell.onAgentLifecycle((evt: AgentLifecycleEvent) => {
      if (evt.type === "restarted") setLifecycle("Agent restarted.");
      else if (evt.type === "gave_up") setLifecycle("Agent crashed too many times. Quit and reopen.");
      else if (evt.type === "exited") setLifecycle(`Agent exited (code ${evt.code}).`);
    });
    return () => {
      offStream();
      offApproval();
      offLifecycle();
    };
  }, []);

  const send = (text: string): void => {
    dispatch({ type: "user_message", text });
    setBusy(true);
    void window.codeshell.run(text);
  };

  const decide = (decision: "approve" | "deny", reason?: string): void => {
    if (!approval) return;
    void window.codeshell.approve(approval.requestId, decision, reason);
    setApproval(null);
  };

  return (
    <>
      {lifecycle && <div className="banner">{lifecycle}</div>}
      <ChatView messages={state.messages} onSend={send} busy={busy} />
      {approval && <ApprovalModal request={approval} onDecide={decide} />}
    </>
  );
}
```

Note: `approval.requestId` is the assumed field name. If `ApprovalRequest`
in core uses a different field for its id (likely `id`), adjust here —
typecheck catches it.

- [ ] **Step 6: Rewrite `styles.css`**

```css
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #0f1115;
  color: #d4d8de;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", monospace;
}
#root { display: flex; flex-direction: column; height: 100vh; }
pre { margin: 0; white-space: pre-wrap; font-family: inherit; }

.banner {
  background: #4a3a00;
  color: #ffd76b;
  padding: 6px 12px;
  font-size: 12px;
}

.chat { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.stream { flex: 1; overflow-y: auto; padding: 12px; }
.msg { margin-bottom: 10px; padding: 8px 10px; border-radius: 6px; }
.msg-user { background: #1b2230; }
.msg-assistant { background: #161b22; }
.msg-assistant.streaming { border-left: 2px solid #7aa2f7; }
.msg-system { background: #2a1717; color: #ff8888; }

.msg-tool { background: #14191f; border: 1px solid #2a2f36; }
.msg-tool-head { display: flex; justify-content: space-between; font-size: 12px; color: #88a; }
.msg-tool-args { background: #0a0d12; padding: 6px; font-size: 12px; margin-top: 4px; }
.msg-tool-out { background: #0a1410; padding: 6px; font-size: 12px; margin-top: 4px; color: #b8e0c0; }
.msg-tool-err { background: #1a0a0a; padding: 6px; font-size: 12px; margin-top: 4px; color: #ff9090; }
.msg-tool-spin { color: #ddc870; }

.input-row { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #2a2f36; }
textarea {
  flex: 1; background: #0a0d12; color: #d4d8de; border: 1px solid #2a2f36;
  border-radius: 4px; padding: 6px; font: inherit; resize: none;
}
button {
  background: #1f2937; color: #d4d8de; border: 1px solid #2a2f36;
  border-radius: 4px; padding: 6px 12px; cursor: pointer;
}
button.primary { background: #2a4a8a; }
button:disabled { opacity: 0.5; cursor: not-allowed; }

.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.6);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  background: #1b2230; border: 1px solid #2a2f36; border-radius: 8px;
  padding: 16px; min-width: 480px; max-width: 80vw;
}
.modal h3 { margin: 0 0 12px; }
.modal-body { font-size: 13px; }
.modal-args { background: #0a0d12; padding: 8px; max-height: 240px; overflow: auto; }
.modal-reason { margin-top: 8px; color: #aaa; }
.modal-actions { margin-top: 12px; display: flex; gap: 8px; align-items: center; }
.modal-actions input { flex: 1; background: #0a0d12; color: #d4d8de; border: 1px solid #2a2f36; border-radius: 4px; padding: 6px; }
```

- [ ] **Step 7: Typecheck**

```bash
cd packages/desktop && bun run typecheck
```

Expected: 0 errors. If `ApprovalRequest` has different field names than
assumed (`toolName`/`toolInput`/`requestId`), fix `ApprovalModal.tsx`
and `App.tsx` to use the real names. Run typecheck again until clean.

- [ ] **Step 8: Renderer build**

```bash
cd packages/desktop && bun run build:renderer
```

Expected: vite emits to `packages/desktop/out/renderer/`. No build errors.

- [ ] **Step 9: Commit**

```bash
git add packages/desktop/src/renderer/
git commit -m "feat(desktop/renderer): chat view, message stream, tool blocks, approval modal"
```

---

## Task 6: end-to-end dogfood + acceptance checks

**Files:** none modified; this is a manual verification task. Fixes
discovered here get small follow-up commits.

**Why this task:** Code compiling is not the same as the system
working. Run the 9 acceptance criteria from spec §11 by hand. Anything
that fails turns into a follow-up step here.

- [ ] **Step 1: Full build**

```bash
bun run --filter @cjhyy/code-shell-core build
cd packages/desktop && bun run build
```

Expected: both complete without error.

- [ ] **Step 2: Dev launch**

```bash
cd packages/desktop && bun run dev
```

Expected: vite starts on 5173, esbuild builds main + preload, electron
window opens and loads the renderer. Renderer shows the empty chat view
with the textarea.

- [ ] **Step 3: First prompt — streaming text**

In the chat input, type `what's 2 + 2?` and press Enter.

Expected: assistant message appears, streaming token-by-token. Once
done, `done` border-left styling switches off, busy state clears,
textarea re-enabled.

If the message never appears: open Electron DevTools (Cmd-Opt-I), look
at the console for parse errors; look at the terminal where `bun run
dev` is running for `[agent] ...` stderr from the worker. Most likely
causes: settings.json missing API key (worker crashes immediately),
or stdout pollution (look for any `[agent] ` line containing
non-JSON garbage).

- [ ] **Step 4: Tool call — Bash**

Type `list files in /tmp using ls`.

Expected: assistant message appears, then a tool block for `Bash` (or
whatever shell tool the agent picks) showing args. An approval modal
appears.

- [ ] **Step 5: Approval — approve**

Click `Approve` in the modal.

Expected: modal closes; the tool block updates with the command output
(green-tinted `.msg-tool-out` block); assistant resumes streaming a
summary; busy clears.

- [ ] **Step 6: Approval — deny**

Run another prompt that triggers a tool (e.g. `delete /tmp/foo.txt`).
When the modal appears, type a deny reason and click `Deny`.

Expected: modal closes; tool block shows an error styling; assistant
acknowledges the denial and continues.

- [ ] **Step 7: Clean shutdown**

Close the Electron window (Cmd-Q on macOS, or window close button on
Linux/Windows).

Expected: Electron exits cleanly. In a terminal:

```bash
pgrep -fa agent-server-stdio
```

Expected: no output (no zombie process).

- [ ] **Step 8: Crash recovery**

Relaunch `bun run dev`. Once the window is up and you've sent at least
one prompt, in another terminal kill the worker:

```bash
pkill -f agent-server-stdio.js
```

Expected: a yellow banner appears at the top of the renderer ("Agent
restarted."). Sending a new prompt works again.

- [ ] **Step 9: Give-up**

In quick succession (within 60 seconds), `pkill -f agent-server-stdio.js`
four times.

Expected: after the fourth kill, banner reads "Agent crashed too many
times. Quit and reopen." Sending a prompt now does nothing (worker is
dead and not respawning).

- [ ] **Step 10: Fix anything that broke**

For each failed step, write a focused fix commit. Examples of likely
fixes you may need:

- `ApprovalRequest` field names differ from what App.tsx assumed →
  update App.tsx and ApprovalModal.tsx, recompile, retest steps 5 and 6
- Some `StreamEvent` types render badly (e.g. `assistant_message`
  duplicating `text_delta`) → either filter that event in
  `applyStreamEvent` or render it differently
- Auto-restart triggers immediately on clean shutdown → check that
  `app.before-quit` fires before `child.on("exit")`; if not, gate the
  restart on a `bridge.quitting` flag set in `kill()`

- [ ] **Step 11: Final commit — verification log**

```bash
git add -A
git commit -m "chore(desktop): MVP dogfood pass — 9/9 acceptance checks green"
```

(If no fixes were needed and there's nothing to commit, skip this and
leave a note in the next task tracker update.)

---

## Self-Review (run after writing)

**1. Spec coverage:** Every spec section is implemented:
- §3 process topology → Task 1 (worker), Task 2 (main + bridge), Task 3 (preload)
- §4 module resolution / no install → Task 2 step 1 (--external), Task 2 step 5 smoke
- §5 protocol scope → Task 3 surfaces only the 3 RPCs and 4 listeners (3 server-notifications + lifecycle) listed in spec; deliberately omits `agent/configure/query/inject` per spec
- §6.1 core changes → Task 1
- §6.3 desktop changes → Tasks 2, 3, 4, 5
- §7 data flow → exercised in Task 6 steps 3-6
- §8 configuration → Task 1's `buildEngineConfigFromSettings` uses `~/.code-shell/settings.json` exactly as TUI does
- §9 error handling → Task 2's restart policy + Task 6's recovery tests
- §10 out of scope → no tasks for packaging, multi-window, etc.
- §11 acceptance → Task 6 verbatim
- §12 risks → Risk #1 (require.resolve / external) → Task 2 step 1+5; Risk #2 (stdout pollution) → Task 1 step 1's console redirect; Risk #4 (approval timeout 5 min) accepted, no task

**2. Placeholder scan:** Searched for TBD/TODO/etc — clean. Every step has either code or an exact command.

**3. Type consistency:**
- `Message` discriminated union: used same shape in `types.ts`, `MessageStream`, `ToolCallBlock`, `ChatView`, `App` ✓
- `Unsubscribe = () => void` and listener registrations all return it ✓
- `agentEntry` path string: same in spec §6.1 and Task 2 ✓
- `ApprovalRequest` fields: noted as assumed (toolName/toolInput/requestId); Task 5 Step 7 explicitly says "fix to real names if typecheck complains" — making the assumption visible rather than hidden

**4. One known unknown:** Real `ApprovalRequest` field names. We could
verify pre-implementation, but the cost (1 grep) equals the cost of
catching at typecheck, so left to implementation time.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-23-electron-mvp-broker.md`.

Recommended: **Subagent-Driven Development** — fresh subagent per task with two-stage review. Total estimate matches spec §13: ~1-2 working days.

Each task is sized to a single subagent invocation:

- Task 1 (core entry): ~1h, cheap model OK
- Task 2 (main + bridge + esbuild externals): ~2h, standard model
- Task 3 (preload): ~1h, cheap model
- Task 4 (renderer types/reducer): ~1h, standard model
- Task 5 (renderer components): ~3-5h, standard model (most integration risk)
- Task 6 (dogfood + fixes): ~2-4h, standard model (judgment-heavy)
