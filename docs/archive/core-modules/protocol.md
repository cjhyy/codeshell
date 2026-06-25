# protocol

**One-line role.** The wire protocol between the agent engine and any UI/host: a JSON-RPC-2.0 server/client pair, pluggable transports (in-process / stdio / TCP), and server→client event streaming.

## 职责 / Responsibility

This module decouples the agent **Engine** (server side) from its consumers — the desktop UI, the TUI REPL, headless CLI runs, and remote/automation hosts (client side). It defines a small JSON-RPC-style message envelope (`RpcMessage`), a fixed set of `Methods` (run / approve / cancel / configure / query / inject / goal*), and three interchangeable `Transport` implementations so the *same* `AgentServer` can run in-process (zero-overhead function calls), over a child process's stdin/stdout, or over a localhost TCP socket. The server (`AgentServer`) wraps a multi-session `ChatSessionManager` (or a single legacy `Engine`) and forwards engine `StreamEvent`s to the client as `sessionId`-tagged notifications. Its boundary stops at the engine: it does not implement agent logic, only marshals requests, manages per-session approval flow, and redacts secrets before any config snapshot leaves the process.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `types.ts` | Protocol envelope (`RpcRequest/Response/Notification`), `Methods`, `ErrorCodes`, param/result shapes (`RunParams`, `RunResult`, `ConfigureParams`, `QueryParams`…), and message factory/guard helpers (`createRequest`, `isResponse`…). The protocol contract. |
| `server.ts` | `AgentServer` — handles RPC requests, dispatches `agent/run` through `ChatSessionManager` (or legacy single engine), forwards stream events with a `sessionId` envelope, drives per-session approval flow, and implements config hot-reload (layer 2). Largest file in the module. |
| `client.ts` | `AgentClient` — consumer-facing handle. `run/approve/cancel/configure/query/inject`, plus `onStreamEvent/onApprovalRequest/onStatus` subscriptions. Resolves request promises against incoming responses; supports both new object-form and legacy positional-form calls. |
| `transport.ts` | `Transport` interface + `createInProcessTransport()` (linked EventEmitter pair) and `StdioTransport` (NDJSON over stdin/stdout). |
| `tcp-transport.ts` | `SocketTransport` (NDJSON over a TCP `Duplex`) + `listenTcp()` (one transport per accepted connection). localhost-only, no auth in v1. |
| `factories.ts` | Recommended public constructors: `createServer` (builds `Engine`+`AgentServer` from flat config) and `createClient`. Return `close()` lifecycle hooks. |
| `helpers.ts` | `createInProcessClient(engine, { onStream })` — wires an in-process server+client pair around an existing `Engine` and returns `{ client, close }`. Used by headless one-shot callers. |
| `chat-session-manager.ts` | `ChatSessionManager` — owns the live `ChatSession` map, `getOrCreate` with a `maxSessions` ceiling, idle sweeper, and awaitable `closeAllAsync` (reaps background shells). |
| `chat-session.ts` | `ChatSession` — one per UI chat tab; owns a single `Engine`, the active-turn `AbortController`, and a FIFO turn queue. |
| `redact.ts` | Secret redaction for query responses: `redactLlmConfig`, `maskSecretValue`, `makeApiKeyPreview`, `isSecretKeyPath`. Never lets raw apiKeys/tokens cross the wire. |

## 公开接口 / Public API

Re-exported from the package root (`@cjhyy/code-shell-core`) — consumers import from there, not from `./protocol` directly.

Transports:
```ts
interface Transport {
  send(message: RpcMessage): void;
  onMessage(handler: (message: RpcMessage) => void): void;
  close(): void;
}
function createInProcessTransport(): [Transport, Transport];
class StdioTransport implements Transport {
  constructor(input: Readable, output: Writable);
}
class SocketTransport implements Transport { constructor(socket: Duplex); }
function listenTcp(
  opts: { port: number; host?: string },
  onConnection: (transport: SocketTransport, socket: Socket) => void,
): Promise<TcpListenResult>; // { server, port, close(): Promise<void> }
```

Server / client:
```ts
class AgentServer {
  // Supply chatManager (multi-session) OR engine (legacy single); transport required.
  constructor(options: {
    chatManager?: ChatSessionManager;
    engine?: Engine;
    transport: Transport;
    settingsReader?: () => ValidatedSettings; // required for configure({ reloadSettings })
  });
  close(): void;
}

class AgentClient {
  constructor(options: { transport: Transport });
  run(taskOrParams: string | RunParams, sessionIdOrOptions?: string | AgentRunOptions): Promise<RunResult>;
  approve(sessionId: string, requestId: string, decision: ApprovalResult): Promise<void>; // legacy 2-arg form also accepted
  cancel(sessionId?: string, reason?: string): Promise<void>;
  configure(params: ConfigureParams): Promise<Record<string, unknown>>;
  query(type: QueryParams["type"], arg?: string | Record<string, unknown>, ...extra: unknown[]): Promise<QueryResult>;
  inject(sessionId: string, content: string): Promise<void>;
  goalClear(sessionId?: string): Promise<boolean>;
  onStreamEvent(handler: (envelope: { sessionId: string; event: StreamEvent }) => void): void;
  onApprovalRequest(handler: (requestId: string, request: ApprovalRequest) => void): void;
  onStatus(handler: (status: string, message?: string) => void): void;
  onBackgroundAgentCompleted(handler: BackgroundAgentCompletedHandler): void;
  close(): void;
}
```

Recommended factories + helper:
```ts
function createServer(options: {
  transport: Transport; llm: LLMConfig; cwd?: string;
  permissionMode?: EngineConfig["permissionMode"];
  engineOverrides?: Partial<EngineConfig>;
}): { server: AgentServer; engine: Engine; close(): void };

function createClient(options: { transport: Transport }): AgentClient;

function createInProcessClient(
  engine: Engine,
  options?: { onStream?: StreamCallback },
): { client: AgentClient; close(): void };
```

Multi-session manager:
```ts
class ChatSessionManager {
  constructor(opts: {
    runtime: EngineRuntime;
    engineFactory: (slice: EngineConfigSlice) => Engine;
    maxSessions?: number; // default 16
    idleTtlMs?: number;   // default 30 min
  });
  getOrCreate(sessionId: string, slice: EngineConfigSlice): ChatSession;
  forEachSession(fn: (s: ChatSession) => void): void;
  startIdleSweeper(intervalMs?: number): void;
  closeAll(): void;            // fire-and-forget
  closeAllAsync(): Promise<void>; // awaitable, reaps background shells
}
```

Constants/types: `Methods`, `ErrorCodes`, `RpcMessage`, `RunResult`, `ProtocolModelEntry`.

## 怎么用 / How to use

**1. In-process one-shot run** (as in `src/run/EngineRunner.ts`). Wrap an existing `Engine`, run a task, always `close()` in `finally`:

```ts
import { createInProcessClient } from "@cjhyy/code-shell-core";

const { client, close } = createInProcessClient(engine, {
  onStream: context.onStream, // every StreamEvent the server emits
});

// External abort → ask the server to cancel the underlying engine.run.
context.signal?.addEventListener("abort", () => {
  client.cancel().catch(() => { /* best-effort; server may be gone */ });
}, { once: true });

try {
  const result = await client.run(run.objective, {
    cwd: run.cwd,
    sessionId: run.sessionId ?? undefined,
  });
  // result: { text, reason, sessionId, turnCount, usage }
} finally {
  close(); // tears down server then client in the correct order
}
```

**2. Cross-process server over TCP** (as in `src/cli/agent-server-tcp.ts`). One `AgentServer` per accepted connection, all sharing one `ChatSessionManager`:

```ts
import { ChatSessionManager, AgentServer, listenTcp } from "@cjhyy/code-shell-core";

const chatManager = new ChatSessionManager({
  runtime,
  engineFactory: (slice) => new Engine({ /* …per-session config from slice… */ }),
});
chatManager.startIdleSweeper();

const servers = new Set<AgentServer>();
const listener = await listenTcp({ port: 4321, host: "127.0.0.1" }, (transport) => {
  servers.add(new AgentServer({ chatManager, transport }));
});

process.on("SIGTERM", () => {
  for (const s of servers) s.close();
  void listener.close().then(() => process.exit(0));
});
```

The stdio host (`src/cli/agent-server-stdio.ts`) is identical but uses `new StdioTransport(process.stdin, process.stdout)` and passes a `settingsReader` so `configure({ reloadSettings })` works.

## 注意 / Gotchas

- **`close()` order matters.** `createInProcessClient`/`factories` close the **server first** (it aborts the in-flight run and emits the final `"shutdown"` status through the still-open transport), **then the client**. Reversing this silently drops the shutdown notification because the client's transport end is already gone. Don't hand-roll your own close sequence — use the helper's `close()`.
- **`createInProcessTransport().close()` is one-sided.** Calling `close()` on one side only tears down that side's incoming listener; the peer keeps working until it closes too. This is intentional so a server shutdown notification still reaches a not-yet-closed client.
- **Transports are best-effort on bad input.** `StdioTransport` and `SocketTransport` parse one JSON value per line and **silently skip malformed lines** — no error surfaces. Framing is strict NDJSON (`JSON.stringify(msg) + "\n"`); a message containing a raw newline would break framing.
- **TCP has no auth (v1).** `listenTcp` defaults to `127.0.0.1`. Never bind `0.0.0.0` / a public interface without adding a token/TLS layer — use SSH tunneling for remote access.
- **Two server modes.** `AgentServer` requires *either* `chatManager` (multi-session, the modern path) *or* a legacy single `engine`; it throws if neither is given. Multi-session is preferred; the legacy engine path exists for backward compat.
- **`configure({ reloadSettings })` needs `settingsReader`.** The server must be constructed with a `settingsReader` closure that reads the **same** fresh disk settings the `engineFactory` uses, or the call returns an explicit error. A byte-identical reload patch is skipped to avoid hook-churn on debounced auto-saves.
- **Secrets never cross the wire raw.** Config/query responses pass through `redact.ts` (`maskSecretValue`/`redactLlmConfig`); clients receive `hasApiKey`/`apiKeyPreview`, not the key. If you add a new query type that returns config, route it through the redactor.
- **`ErrorCodes.Cancelled` (-32005) is not an error.** When a run is cancelled (ESC/Stop), the client rejects with this code — treat it as a clean terminal state (clear busy, stop streaming), not a red banner.
- **`maxSessions` ceiling.** `ChatSessionManager.getOrCreate` throws an `Overloaded` error (code -32001) once `maxSessions` (default 16) live sessions exist.
- **ESM `.js` imports.** This is an ESM package; all intra-module imports use explicit `.js` extensions (`./types.js`). Compiled output is consumed from `dist/` — rebuild core before tests/hosts pick up changes.
- **Consume from the package root.** Public surface is re-exported from `packages/core/src/index.ts` (`@cjhyy/code-shell-core`); prefer those imports over reaching into `./protocol/*` files directly.
