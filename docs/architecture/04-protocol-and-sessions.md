# 04 · Protocol & Sessions

> The transport-agnostic RPC seam between clients and the engine, and the on-disk session layer that makes runs durable and resumable. Source-mapped against `packages/core/src/protocol/`, `packages/core/src/session/`, and `packages/core/src/state.ts`.

## 1. Why a protocol at all

The engine never talks to a UI directly. Every client — the TUI REPL, headless CLI, the desktop renderer, the phone remote — speaks JSON-RPC to an `AgentServer` through a `Transport`, and the server drives the `Engine`. This is an **architectural decision, not an accident**: routing all `engine.run` through `AgentServer` + `AgentClient` means the permission allowlist and lifecycle are enforced at one seam. (The one exception is sub-agents in the `asyncAgentRegistry`, which spawn their own `Engine` with their own allowlist per agent definition.)

| File | Role | ~LOC |
|------|------|------|
| `protocol/types.ts` | `RpcMessage`, `Methods`, `ErrorCodes`, `RunParams`/`RunResult` | ~375 |
| `protocol/server.ts` | `AgentServer` — request dispatch, approval routing, background wakeup | ~950 |
| `protocol/client.ts` | `AgentClient` — request builder, stream/approval/status events | ~300 |
| `protocol/transport.ts` | `Transport` iface, `InProcessTransport`, `StdioTransport` | ~111 |
| `protocol/tcp-transport.ts` | `SocketTransport`, `listenTcp` (NDJSON over TCP) | ~91 |
| `protocol/factories.ts` | `createServer`/`createClient` — the stable construction contract | ~122 |
| `protocol/chat-session-manager.ts` | `ChatSessionManager` — multi-session container, idle TTL | ~147 |
| `protocol/chat-session.ts` | `ChatSession` — one per UI tab, run queue, pending approvals | ~250 |

## 2. Three transports, one protocol

- **`InProcessTransport`** — a pair of linked `EventEmitter`s; synchronous delivery, shared memory. Used when the TUI/headless CLI embeds the engine in-process (the model pool and tool registry are shared, not serialized).
- **`StdioTransport`** — readline NDJSON over stdin/stdout. Used when the desktop main process spawns the core agent as a child worker (`agent-server-stdio`).
- **`SocketTransport`** — the same NDJSON framing over a TCP socket. v1 has no auth — localhost / SSH-tunnel only.

`createServer({transport, llm, cwd?, permissionMode?})` and `createClient({transport})` (`factories.ts`) are the stable way to wire these; the caller picks the transport and the factories build the Engine/Server/Client. Close ordering matters: server first (so the shutdown notification is sent), then client (`helpers.ts`).

## 3. The request path

```
AgentClient.run(task, sessionId)
  → RpcRequest { method: Methods.Run, params: { sessionId, task, cwd, permissionMode, goal } }
  → Transport.send
  → AgentServer.handleRequest                         server.ts
      → ChatSessionManager.getOrCreate(sessionId)     chat-session-manager.ts
          → engineFactory(slice) → ChatSession{engine}
      → ChatSession.enqueueTurn(task, {onStream})      chat-session.ts (FIFO; one active turn)
          → engine.run(...)  → emits StreamEvent
              → Transport.notify(Methods.StreamEvent, {sessionId, event})
                  → AgentClient emits "stream" → UI listener
```

`Methods` also covers `Approve`, `Cancel`, `Configure`, `Query`, `Inject`, `Steer`/`Unsteer`, `CloseSession`, `GoalGet`/`GoalClear`, `BackgroundShells`, `BackgroundWork`. The `ChatSessionManager` caps live sessions (default 16, throws `Overloaded`), tracks idle timestamps, and can reap idle sessions after a TTL.

### Approvals
`AgentServer.requestApprovalFromClient` stores a timeout-guarded promise in a `pendingApprovals` map; the client's `Approve` response resolves it. This is the seam the TUI's permission prompt and the desktop's approval card both ride.

### Background-work wakeup
When a background sub-agent or shell completes, `agentNotificationBus` fires a synchronous subscriber → `maybeWakeIdleSession` (guards: session exists, idle, not headless, not post-cancelled) → `notificationQueue.drainAll` injects the result as a synthetic `injected:true` task → `enqueueTurn`. Being synchronous, a burst of completions collapses into one wakeup. (The memory notes on background-shell wakeup record this design — completion *wakes an idle engine*, it doesn't poll.)

### Config hot-reload
`Configure({reloadSettings:true})` reads fresh settings, computes a patch, bumps `configVersion`, and (skipping if the patch JSON is identical to the last broadcast — debounce churn) calls `engine.refreshRuntimeConfig` on each live session. In-flight turns are untouched; reloads land at turn boundaries (see the config-hotreload-layer2 memory note).

## 4. Sessions on disk (`session/`)

Each session lives at `~/.code-shell/sessions/<sessionId>/`:
```
state.json        SessionState: cwd, model, turnCount, tokenUsage, activeGoal, parentSessionId, origin
transcript.jsonl  append-only TranscriptEvent[] — one JSON object per line
file-history/     FileHistory snapshots for undo/redo
```

| File | Role | ~LOC |
|------|------|------|
| `session/session-manager.ts` | `SessionManager` — create/resume/fork, atomic state writes, id validation | ~350 |
| `session/transcript.ts` | `Transcript` — append-only event log; `toMessages()` derives LLM context | ~270 |
| `session/file-history.ts` | `FileHistory` — content-hashed backups, `turnSeq`-tagged | ~260 |
| `session/undo-target.ts` | pure undo/redo target selection (turn-level) | ~145 |
| `session/simple-diff.ts` | LCS line diff for `/undo` previews (CRLF-normalized) | ~90 |

Key behaviors:
- **Atomic, crash-safe writes**: `state.json` is written to `.tmp` then renamed; the transcript flushes after each event.
- **Safe session ids**: `assertSafeSessionId` rejects path separators, `..`, and over-long ids (no `../../etc/passwd` escape).
- **Transcript is the source of truth, not chat history.** `toMessages()` is the boundary where events become LLM messages: `message`/`tool_result`/`summary` map through; `turn_boundary`/`session_meta`/`file_history`/`error` are dropped. On load, `repairToolResultPairs` removes orphaned results and synthesizes missing ones — the same `tool_use`/`tool_result` pairing invariant the turn loop guards (see [01](01-engine-and-turn-loop.md)).
- **Tasks and goals rehydrate from the transcript / state**, not from normal message events — the memory notes on goal-rehydrate-on-load and replay record that a `TodoWrite` snapshot lives in its args and the persistent goal lives in `state.json`.

### Turn-level undo
`FileHistory` snapshots carry a `turnSeq` (one user send = one turn) and an `undone` flag. `latestTurnUndoTargets` selects each file's earliest snapshot within the latest *live* turn; undoing sets `undone` and records a `RedoRecord`. Subsequent `/undo` peels the prior turn ("onion peeling"). This matches Claude Code's turn-level model (Codex has no undo — see the memory note on /undo turn-level).

### Disk as authoritative recovery
The desktop can rebuild its session list purely from disk, applying three filters — `parentSessionId` (hide sub-agents), `origin` (user-initiated vs auto), `isNoRepoCwd` (deprioritize unbound) — so clearing localStorage loses nothing (the disk-authoritative-recovery memory note).

## 5. Runtime singletons (`state.ts`)

`state.ts` holds *process-level* (not per-session) singletons: the default `sessionId` for early logs, `originalCwd`/`projectRoot` (lazy-fallback to `process.cwd()`, overridable by non-CLI hosts), interactivity/trust flags, and per-process cost counters. Most analytics counters are no-ops (sinks removed from core). The system-prompt section cache also lives here, reused across turns.

## 6. Where to read next
- What the server drives: [01 · Engine & turn loop](01-engine-and-turn-loop.md)
- The desktop's worker-per-session model that rides `StdioTransport`: [10 · Desktop & mobile](10-desktop-and-mobile.md)
- Memory persistence (a sibling of sessions under `~/.code-shell/`): [07](07-plugins-capabilities-credentials-memory.md)
