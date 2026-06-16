# lsp

**One-line role.** Spawns and talks to external language servers over JSON-RPC/stdio so core tools can answer code-intelligence questions (definitions, references, hover, symbols, diagnostics).

## 职责 / Responsibility

This module is the Language Server Protocol integration layer for core. It owns the raw JSON-RPC framing over a language server's stdio (`LSPClient`), a process-level singleton that lazily spawns and reuses one server per language (`LSPServerManager`), the table of built-in server configs + extension→server detection, and a `file://` URI→filesystem-path helper. Its boundary stops at transport and lifecycle: it does **not** define the agent-facing tool. The actual `LSP` tool (`tool-system/builtin/lsp.ts`) sits on top, calling `getLSPManager()` / `detectLSPServer()` and issuing concrete `textDocument/*` requests.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `client.ts` | `LSPClient` — one language-server child process; JSON-RPC request/notify, byte-accurate `Content-Length` framing, init/shutdown lifecycle. |
| `manager.ts` | `LSPServerManager` + module singleton (`initializeLSPManager`/`getLSPManager`); lazy per-language start, command-availability check, status listing, shutdown-all. |
| `servers.ts` | `BUILTIN_LSP_SERVERS` config table (ts/python/go/rust/json/css) + `detectLSPServer(filePath)` extension matcher. |
| `root-path.ts` | `rootUriToPath` — `file://` URI → platform filesystem path (drive letters, percent-decode, UNC). |
| `manager.test.ts` | Tests for the manager / command-availability logic. |
| `root-path.test.ts` | Tests for `rootUriToPath`. |

## 公开接口 / Public API

```ts
// manager.ts — primary entry points
export function initializeLSPManager(cwd: string): LSPServerManager; // create + set singleton
export function getLSPManager(): LSPServerManager | undefined;       // read singleton
export function isCommandAvailable(command: string, env?: NodeJS.ProcessEnv): boolean;

export class LSPServerManager {
  constructor(cwd: string);
  getClient(serverName: string): Promise<LSPClient | undefined>; // lazy-start by name
  isConnected(): boolean;
  listServers(): Array<{ name: string; language: string; state: "stopped" | "starting" | "ready" | "error"; error?: string }>;
  shutdownAll(): Promise<void>;
}

// client.ts
export class LSPClient extends EventEmitter {
  constructor(command: string, args?: string[], cwd?: string);
  start(): Promise<void>;
  initialize(rootUri: string): Promise<unknown>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  shutdown(): Promise<void>;
  get isInitialized(): boolean;
  get isAlive(): boolean;
  // emits: "notification" (LSPNotification), "exit" (code)
}
export interface LSPRequest { method: string; params?: Record<string, unknown> }
export interface LSPResponse { id: number; result?: unknown; error?: { code: number; message: string } }
export interface LSPNotification { method: string; params?: Record<string, unknown> }

// servers.ts
export interface LSPServerConfig {
  name: string; language: string; extensions: string[];
  command: string; args: string[]; installHint: string;
}
export const BUILTIN_LSP_SERVERS: LSPServerConfig[];
export function detectLSPServer(filePath: string): LSPServerConfig | undefined;

// root-path.ts
export function rootUriToPath(rootUri: string): string;
```

## 怎么用 / How to use

**1. The real call site — the `LSP` builtin tool** (`tool-system/builtin/lsp.ts`). It reads the singleton, detects the server from the file extension, gets (lazily starting) the client, then issues a raw LSP request:

```ts
import { getLSPManager } from "../../lsp/manager.js";
import { detectLSPServer } from "../../lsp/servers.js";
import { pathToFileURL } from "node:url";

const manager = getLSPManager();
if (!manager) return "Error: LSP is not initialized.";

const serverConfig = detectLSPServer(filePath); // e.g. ".ts" -> typescript config
if (!serverConfig) return `Error: No language server configured for ${filePath}`;

const client = await manager.getClient(serverConfig.name);
if (!client) return `Error: server not available. Install: ${serverConfig.installHint}`;

const result = await client.request("textDocument/definition", {
  textDocument: { uri: pathToFileURL(filePath).href },
  position: { line, character },
});
```

**2. Host wiring (must be done once before the tool can work)** — create the singleton against the session cwd at startup, and tear it down on exit:

```ts
import { initializeLSPManager, getLSPManager } from "@codeshell/core/lsp/manager"; // path-per-build

initializeLSPManager(process.cwd()); // seed singleton; servers start lazily on first getClient()
// ... run session; LSP tool now finds the manager ...
await getLSPManager()?.shutdownAll(); // on shutdown
```

## 注意 / Gotchas

- **Singleton is currently never seeded.** Across the whole repo there is no caller of `initializeLSPManager` — only the tool's `getLSPManager()`. So today the `LSP` tool always returns `"LSP is not initialized."`. A host must call `initializeLSPManager(cwd)` at startup to enable it (see example 2). This is the single biggest thing that will bite a contributor.
- **Best-effort, never throws to the caller.** `getClient` returns `undefined` (not a throw) when the server binary is missing or fails to start; the manager records `state: "error"` + `error` message instead. Check the return value.
- **Byte-accurate framing is load-bearing.** `LSPClient.handleData` buffers `Buffer`s and slices by `Content-Length` **bytes**, never strings. Don't "simplify" it to `data.toString()` + string concat — that splits multibyte UTF-8 (CJK/emoji in identifiers or diagnostics) across chunks and desyncs the frame counter.
- **One server per language, reused; lazy start.** `getClient` returns the live client if `ready` & alive; if `starting` it just `await`s a fixed 2s and returns whatever's there (no proper readiness signal). First call to an unstarted server pays spawn + `initialize` cost.
- **30s per-request timeout.** `client.request` rejects with `LSP request "<method>" timed out` after 30s. Timers and the child are `unref()`'d so a hung server won't keep the Node event loop alive.
- **Command-availability is a security gate, not just a check.** `isCommandAvailable` rejects bare commands containing whitespace (so a config value can't smuggle shell syntax like `pylsp; touch /tmp/pwned`) and resolves PATH + `PATHEXT`-style candidates via `commandCandidateNames`. `spawn` is used directly with no shell.
- **Use `rootUriToPath`, not `rootUri.replace("file://", "")`.** The replace form leaves percent-encoding and breaks Windows drive paths (`file:///C:/x` → `/C:/x`). Note the tool's own `formatLocationResult` still uses the naive `.replace("file://","")` for display only.
- **Diagnostics are fire-and-forget.** The tool's `getDiagnostics` `didOpen`s the doc, waits 2s, and tells you to check `"notification"` events — it does not return the diagnostics inline. Subscribe to the `LSPClient` `"notification"` event if you need them.
- **ESM import paths** use `.js` suffixes (`./client.js`, `./servers.js`) per the project's ESM config; rebuild core after changes since downstream consumers run against `dist`.
