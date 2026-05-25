# Multi-Session Chat Runtime — Design

Date: 2026-05-26
Status: Draft (awaiting user review)
Scope: `packages/core/src/protocol/`, `packages/core/src/engine/`, `packages/core/src/tool-system/{permission,builtin/plan}`, `packages/desktop/src/{preload,renderer}`, `packages/tui/src/cli/commands/`.

## 1. Background and problem statement

### 1.1 Observed symptom

On the Electron client, when a chat session is still running and the user opens a second chat tab and sends a message, the second message vanishes silently. The UI shows nothing — no error, no echo of the user message, just a spinner that never resolves. The first session itself also eventually appears to stall (no `turn_complete`, UI keeps spinning), even though the underlying worker subprocess exits cleanly.

### 1.2 Root causes (three independent bugs, in three layers)

1. **Server layer — single-flag rejection.**
   `packages/core/src/protocol/server.ts:115` rejects every concurrent `agent/run` with `ErrorCodes.AlreadyRunning (-32003)` using a single boolean `this.running`. The `sessionId` parameter that the client sends is not consulted at all. This is the only reason "two different chat tabs cannot run at the same time", and the rejection is silent on the renderer.

2. **Renderer layer — single-ref event routing.**
   `packages/desktop/src/renderer/App.tsx:425-460` stores the "currently running bucket" in a single `runningBucketRef.current`. All inbound stream events are routed to whatever bucket that ref points to. The first `turn_complete` (or `error`) clears the ref. After that, `if (!target) return;` on line 427 silently discards every subsequent event. In the captured trace, the bridge forwarded 8,107 stream events over six minutes while the renderer recorded only ~100 — a 98.8% drop rate.

3. **Subagent layer — events outlive parent turn.**
   Subagent events (`agentId: ...`) share the same `streamToClient` callback as the parent run. When a parent run emits `turn_complete` while a subagent is still working, the subagent's later events have no place to land. This compounds bug 2 by producing events that the renderer cannot attribute to any bucket.

### 1.3 What is NOT a root cause (clarified during exploration)

- **`sessionId` is not the issue.** UI, preload bridge, and the JSON-RPC wire format all already carry `sessionId` per request. Only `server.ts` ignores it.
- **`permissionMode` / `planMode` module singletons** (`tool-system/permission.ts:472`, `tool-system/builtin/plan.ts:47`) are not actively biting today, but they will the moment a second concurrent session uses a different mode. They must be removed as part of this work.
- **`RunManager` is not the answer for chat.** The existing `packages/core/src/run/RunManager.ts` already implements multi-run, queueing, approval, and attach, but it is targeted at *managed runs* (persisted to `~/.code-shell/runs/<runId>/`, queued, recoverable). Chat runs are ephemeral; writing every chat turn to disk via `RunStore` is the wrong cost model. See §2.3 for the precedent in Claude Code (`query.ts` vs `QueryEngine.ts`).

### 1.4 Industry baseline

Verified during exploration:

| Project | Process model | Concurrency model |
|---|---|---|
| Codex (`codex-rs/app-server`) | single long-lived process | multiple threads in parallel; **single-turn exclusivity per thread**; bounded queues + backpressure (`-32001`) |
| Claude Code | two engines: `query.ts` (REPL), `QueryEngine.ts` (SDK/background) | multiple conversations concurrent; per-conversation turn sequential |
| opencode (sst) | client–server | multiple SQLite-backed sessions; event bus via SSE |
| Claude Agent SDK | in-process | `asyncio.gather()` of independent `query()` calls |

The consensus is unambiguous: **multi-session concurrent + per-session turn sequential**, with `chat` and `managed/background` paths kept as separate subsystems.

## 2. Goals and non-goals

### 2.1 Goals

- Allow N concurrent chat sessions in one worker process (N = number of UI tabs). Different sessions run truly in parallel.
- Within a single chat session, turns are FIFO-serialized. A second `agent/run` for the same session queues behind the first.
- Restore at-most-once delivery and correct attribution of every stream event, including subagent events.
- Remove the module-level singletons for permission/plan mode; route those through per-session state.
- Keep `RunManager` and the `run/*` protocol untouched. Chat path and managed path remain two parallel subsystems.
- TUI behavior unchanged: TUI uses exactly one chat session, which is the degenerate case of the multi-session runtime.

### 2.2 Non-goals

- No persistence for chat runs. Conversation history continues to live in `SessionManager` as it does today; we do not write `RunSnapshot` per turn.
- No new "managed run" features. `RunManager` is out of scope.
- No multi-worker / multi-process renderer model. Still one Electron worker, one TUI in-process server — the unit of multiplexing is the *chat session*, not the OS process.
- No turn-level parallelism within a session.
- No protocol backward-compat shim. The user has explicitly opted out of compatibility — see §4 for the new wire format.

### 2.3 Why a new subsystem (not RunManager)

This mirrors Claude Code's split between `query.ts` (interactive, fast, no required persistence) and `QueryEngine.ts` (SDK, structured, persistent). Forcing chat through `RunManager` would either (a) write every chat turn to disk, paying I/O for ephemeral state, or (b) bolt an `ephemeral: true` mode onto `RunManager` that branches every method — strictly more code than a focused `ChatSessionManager`. The existing spec `2026-05-24-codex-grade-run-control-recovery-design.md` describes `run/*` as a *separate* protocol surface for managed runs, which is consistent with this split.

## 3. Architecture

### 3.1 Component map

```
                            ┌──────────────────────────────────┐
                            │ AgentServer (protocol/server.ts) │
                            │  • dispatches agent/* methods    │
                            │  • dispatches run/*  methods     │
                            └────────┬───────────────┬─────────┘
                                     │               │
                                     ▼               ▼
                ┌────────────────────────────┐   ┌─────────────┐
                │ ChatSessionManager  (NEW)  │   │ RunManager  │
                │  Map<sessionId, ChatSess>  │   │ (untouched) │
                └─────────┬──────────────────┘   └─────────────┘
                          │
                          ▼ one per chat tab
                ┌──────────────────────────────────┐
                │ ChatSession                      │
                │  • engine: Engine                │
                │  • turnQueue: FIFO (active≤1)    │
                │  • controller: AbortController   │
                │  • pendingApprovals: Map<id,...> │
                │  • permissionMode, planMode      │
                └──────────────────────────────────┘
```

`Engine` is now instantiated per `ChatSession` (one Engine per chat tab). The `EngineRuntime` shared-resources object (model pool, tool registry, settings, MCP pool) is hoisted out of `Engine` so multiple `Engine` instances can share read-only resources cheaply.

### 3.2 Lifecycle

- A `ChatSession` is created lazily the first time a `sessionId` is seen on `agent/run`.
- Sessions are kept warm in memory; they are evicted only when (a) the client explicitly closes (`agent/closeSession`) or (b) idle longer than `chatSessionIdleTtlMs` (default 30 min, matching Codex's thread eviction).
- A worker restart wipes all in-memory sessions. Chat sessions are NOT recoverable across worker restarts — that is what `RunManager` / `run/recover` is for. After a worker restart the renderer starts fresh (any pending UI turns become orphaned and should be marked stale).
- Cancelling a turn (`agent/cancel`) aborts only that session's `AbortController`; other sessions are unaffected.
- Worker shutdown drains all sessions, then exits.

### 3.3 Subagent attribution

Today, subagent events flow through the *parent* `streamToClient`. Going forward:

- The wrapping `agent/streamEvent` notification always carries `sessionId` (required) — this is the only thing the renderer needs for routing.
- Each `StreamEvent` payload optionally carries `parentTurnId` (the turn that spawned this subagent) and `agentId` (the subagent identifier). Both are absent on plain top-level events.

`turn_complete` for the parent does NOT remove the per-session route — the route is keyed on `sessionId`, not on the turn lifecycle. The route only goes away on session close / idle eviction. Subagent events that arrive after the parent `turn_complete` are still routed correctly because they belong to the same `sessionId`.

## 4. Protocol

No backward compatibility. New wire format:

### 4.1 Client → server

```jsonc
// Begin a turn in a chat session.
{ "method": "agent/run", "params": {
    "sessionId": "...",          // required; client-minted ULID
    "task": "...",
    "cwd": "...",
    "permissionMode": "...",     // optional; defaults to session's existing mode
    "planMode": false            // optional
}}

// Cancel a turn (must specify which session).
{ "method": "agent/cancel", "params": { "sessionId": "..." } }

// Approve / deny a tool call.
{ "method": "agent/approve", "params": {
    "sessionId": "...",
    "requestId": "...",
    "decision": { "approved": true } | { "approved": false, "reason": "..." }
}}

// Close a session (frees Engine + history).
{ "method": "agent/closeSession", "params": { "sessionId": "..." } }

// Per-session or global configure.
{ "method": "agent/configure", "params": {
    "sessionId": "..." | null,   // null = worker-global
    "planMode": ..., "permissionMode": ..., "model": ..., ...
}}
```

### 4.2 Server → client (notifications)

Every notification carries `sessionId`:

```jsonc
{ "method": "agent/streamEvent", "params": {
    "sessionId": "...",
    "event": { ...StreamEvent }   // event keeps existing shape (text_delta, tool_use_start, ...)
}}

{ "method": "agent/approvalRequest", "params": {
    "sessionId": "...",
    "requestId": "...",
    "request": { ...ToolApprovalRequest }
}}

{ "method": "agent/sessionStatus", "params": {
    "sessionId": "...",
    "status": "running" | "idle" | "queued" | "closed",
    "queueDepth": 0
}}
```

### 4.3 Server → client (responses)

`agent/run`'s response carries the engine-side conversation/session id (today this is generated inside Engine on first turn). It must echo the client's `sessionId` back:

```jsonc
{ "id": ..., "result": {
    "sessionId": "...",       // echoes request
    "text": "...",
    "reason": "completed" | "cancelled" | "max_turns" | "error",
    "turnCount": N,
    "usage": { ... }
}}
```

### 4.4 Errors

| Code | Meaning |
|---|---|
| `-32602` `InvalidParams` | missing `sessionId`, malformed |
| `-32001` `Overloaded` | global ceiling exceeded (see §6.3); replaces old `-32003` `AlreadyRunning` |
| `-32004` `SessionClosed` | targeting a session that has been closed/evicted |

`-32003 AlreadyRunning` is removed.

### 4.5 Stream events: subagent fields

`StreamEvent` (defined in `packages/core/src/types.ts`) gains:

```ts
parentTurnId?: string;   // present on every event; identifies the originating turn
agentId?: string;        // already exists; identifies subagent (if any)
```

`sessionId` does NOT need to be on the StreamEvent itself — it lives on the wrapping `agent/streamEvent` notification.

## 5. Data flow

### 5.1 Happy path: tab A sends, then tab B sends

```
T0  renderer A → run(sessionId=A, task=...)
T0  AgentServer:
      sessionA = ChatSessionManager.getOrCreate(A)
      sessionA.queue.enqueue(turnA)
      turnA starts immediately (queue was empty)
      streams events with sessionId=A
T1  renderer B → run(sessionId=B, task=...)
T1  AgentServer:
      sessionB = ChatSessionManager.getOrCreate(B)
      sessionB.queue.enqueue(turnB)
      turnB starts immediately (independent queue)
      streams events with sessionId=B
T2  events from both interleave on the JSON-RPC pipe
T2  renderer routes by sessionId from envelope, no global ref
```

### 5.2 Same-session second send (queued)

```
T0  run(sessionId=A, task=task1) → enqueued, starts
T1  run(sessionId=A, task=task2) → enqueued, queue depth = 1
    AgentServer immediately notifies:
      agent/sessionStatus { sessionId=A, status="queued", queueDepth=1 }
T2  task1 finishes → turn_complete with sessionId=A
T2  agent/sessionStatus { sessionId=A, status="running" }, task2 starts
```

The UI is now able to show "queued (1 ahead)" instead of silently dropping the message.

### 5.3 Cancellation

```
renderer A → cancel(sessionId=A)
AgentServer:
  sessionA.controller.abort()
  drain sessionA.queue → emit cancelled events for queued turns
  sessionB untouched
```

### 5.4 Renderer routing

Renderer maintains:

```ts
const sessionIdToBucket = new Map<string, BucketId>();
const busyBySession    = new Map<string, boolean>();
```

The preload bridge (`packages/desktop/src/preload/index.ts`) parses each incoming `agent/streamEvent` notification and invokes the listener with the envelope `{ sessionId, event }`. On every callback:

```ts
window.codeshell.onStreamEvent(({ sessionId, event }) => {
  const bucket = sessionIdToBucket.get(sessionId);
  if (!bucket) return;                  // session is closed/unknown — discard intentionally
  dispatch({ type: "stream", bucket, event });
  if (event.type === "turn_complete" || event.type === "error") {
    busyBySession.set(sessionId, false);
  }
});
```

`runningBucketRef` is deleted. `setBusyForKey` is replaced by `busyBySession` updates keyed on `sessionId`, so each tab tracks its own busy state independently.

## 6. Components in detail

### 6.1 `EngineRuntime` (new file: `packages/core/src/engine/runtime.ts`)

Holds the *read-only / shared* resources that all `Engine` instances in a worker can share:

```ts
class EngineRuntime {
  readonly modelPool: ModelPool;
  readonly toolRegistry: ToolRegistry;
  readonly settings: SettingsStore;
  readonly mcpPool: McpConnectionPool;
  readonly costTracker: CostTracker;
}
```

Constructed once per worker. Engine takes it via constructor.

### 6.2 `Engine` (modified: `packages/core/src/engine/engine.ts`)

- Constructor now takes `runtime: EngineRuntime` plus per-instance config.
- `permissionMode`, `planMode`, `askUser` become instance fields (not module singletons).
- `engine.run()` signature unchanged on the outside; inside it uses `this.runtime.*` for shared resources.
- Subagent spawn (`engine.ts:473` `new Engine(...)`) reuses the same runtime: `new Engine({ runtime: this.runtime, ... })`.

### 6.3 `ChatSessionManager` (new file: `packages/core/src/protocol/chat-session-manager.ts`)

```ts
class ChatSessionManager {
  constructor(opts: {
    runtime: EngineRuntime;
    maxSessions: number;          // default 16 — global ceiling for backpressure
    idleTtlMs: number;            // default 30 * 60 * 1000
  });

  /**
   * `engineConfig` is the per-session slice from the agent/run params
   * (permissionMode, planMode, model overrides, etc.) — i.e. the subset of
   * EngineConfig that the client controls on a per-request basis. Shared
   * resources (modelPool, toolRegistry, settings, mcpPool) come from `runtime`.
   */
  getOrCreate(sessionId: string, engineConfig: EngineConfigSlice): ChatSession;
  get(sessionId: string): ChatSession | undefined;
  close(sessionId: string): void;
  closeAll(): void;
  sessionCount(): number;
}

class ChatSession {
  readonly id: string;
  readonly engine: Engine;
  enqueueTurn(task: string, opts: TurnOpts): Promise<RunResult>;
  cancel(): void;
  isBusy(): boolean;
  queueDepth(): number;
  pendingApprovals: Map<string, (decision: ApprovalDecision) => void>;
}
```

Global ceiling: when `sessionCount() >= maxSessions` and `getOrCreate` is called with a *new* sessionId, return `-32001 Overloaded`. Existing sessions are never rejected.

### 6.4 `AgentServer` (modified: `packages/core/src/protocol/server.ts`)

- Constructor takes `chatManager: ChatSessionManager` (required, for `agent/*`) and `runManager?: RunManager` (optional, for `run/*`). If `runManager` is absent, any `run/*` request returns `-32601 MethodNotFound`. The `engine` field is removed — Engines are created lazily by `ChatSessionManager`.
- `handleRun` looks up the session, enqueues the turn, awaits.
- `handleApprove`, `handleCancel` route by `sessionId`.
- `handleConfigure` supports per-session and worker-global config.
- `agent/closeSession` is added.
- `this.running` and `this.abortController` are deleted.
- Per-session `pendingApprovals` lives on `ChatSession`; the server-level map is removed.

### 6.5 `cli/agent-server-stdio.ts` (modified)

```ts
const runtime = new EngineRuntime(config);
const chatManager = new ChatSessionManager({ runtime, maxSessions, idleTtlMs });
const runManager  = new RunManager({ ... });
const server = new AgentServer({ chatManager, runManager, transport });
```

### 6.6 TUI `repl.ts` / `run.ts` (modified)

Same change: build a `EngineRuntime`, build a `ChatSessionManager`, wire into `AgentServer`. TUI uses a single sessionId (`"tui-main"`), so it is degenerate multi-session. No TUI UI code changes.

### 6.7 Preload (`packages/desktop/src/preload/index.ts`)

`run`, `cancel`, `approve` all take/forward `sessionId`. Stream-listener API changes to deliver `{ sessionId, event }` envelopes instead of raw `event` — listeners now key on sessionId for routing.

### 6.8 Renderer (`packages/desktop/src/renderer/App.tsx`)

Single ref `runningBucketRef` is removed. Replace with `sessionIdToBucket: Map<sessionId, bucket>` and `busyBySession: Map<sessionId, boolean>`. Stream handler routes by `env.sessionId`. When a tab is created, its sessionId is registered; when closed, it's unregistered and `agent/closeSession` is sent.

### 6.9 Permission / plan modules

- `packages/core/src/tool-system/permission.ts`: delete module-level `runtimeBypass` let and `setRuntimeBypass`/`isRuntimeBypass` exports. All call sites read from `ToolContext.permissionMode` (sourced from the owning Engine).
- `packages/core/src/tool-system/builtin/plan.ts`: delete module-level `inPlanMode` let and helpers. Plan tool reads from `ToolContext.planMode`.
- `ToolContext` already exists (`tool-system/context.ts`); it gains `permissionMode` and `planMode` fields populated by Engine at tool dispatch time.

## 7. Error handling and backpressure

- **Global ceiling**: `ChatSessionManager.maxSessions` (default 16). Beyond this, *new* `sessionId`s get `-32001 Overloaded`. Existing sessions are unaffected. Renderer surfaces this as a toast.
- **Per-session queue**: unbounded by default but `agent/sessionStatus` notifies `queueDepth` each enqueue so the UI can warn.
- **Worker crash**: same as today — bridge respawns, all in-memory sessions are lost. (Recovery is out of scope; if needed it goes through the existing `RunManager`/`run/recover` path.)
- **Cancel race**: if `agent/cancel` arrives while a turn is mid-stream, abort triggers, but events already in the JSON-RPC pipe may still reach the client. Client treats post-cancel events as informational and stops them at the bucket boundary by checking session status.
- **Session-closed event**: a stream event for a closed sessionId is dropped at the renderer (intentional — `sessionIdToBucket.get` returns undefined). No error to user.

## 8. Testing strategy

### 8.1 Core unit tests

- `tests/chat-session-manager.test.ts`
  - `getOrCreate` is idempotent.
  - Two concurrent sessions don't interfere (different abort signals, different histories).
  - Same-session turns serialize (turn 2 waits for turn 1).
  - `maxSessions` ceiling returns `-32001` for the (N+1)-th new sessionId, but existing sessions still work.
  - Idle eviction at `idleTtlMs`.
  - `close()` aborts in-flight turn, drains queue, fires cancelled events.

- `tests/engine-runtime.test.ts`
  - Two `Engine` instances over one `EngineRuntime` don't share mutable state.
  - `permissionMode` is per-instance.
  - `planMode` is per-instance.

- Update `tests/protocol/agent-server.test.ts` (and `in-process-client-drift.test.ts`) to the new wire shape:
  - `agent/run` without `sessionId` → `-32602`.
  - `agent/run` for two different `sessionId`s in parallel → both complete; events tagged correctly.
  - `agent/run` for same `sessionId` twice → second one queues; `agent/sessionStatus` fires.
  - `agent/cancel` only affects the targeted session.

### 8.2 Integration (in-process transport)

- `tests/multi-session-integration.test.ts`: start `AgentServer` with in-process transport, fire two `run` calls on different `sessionId`s, assert event streams are well-formed, independent, and the renderer-style routing reconstructs each session's transcript losslessly.

### 8.3 TUI regression

- `tests/tui-repl.test.ts` (or extend existing TUI tests): single-session behavior is unchanged; the new wire format with `sessionId="tui-main"` produces identical Ink output.

### 8.4 Desktop manual smoke

Documented in the plan, not a unit test:
1. Open Electron app, open two project tabs.
2. In tab A, send a long task ("review repo X").
3. While A is running, in tab B send another task.
4. Verify: both run concurrently, both tabs show their own stream, neither stalls, `turn_complete` arrives for each.
5. In tab A, send a second message before the first completes.
6. Verify: UI shows "queued"; second runs after first finishes.
7. Cancel tab A mid-turn.
8. Verify: A stops, B unaffected.

## 9. Migration / rollout

Single landing PR per phase (see implementation plan for breakdown). No flags, no shims — the user has explicitly waived backward compatibility. Old `-32003` callers will see `-32602` (missing sessionId) or `-32001` (overload); both are clearer than the old single-flag rejection.

## 10. Out of scope (deferred)

- Multi-worker process model (one OS process per session) — current design keeps one worker per Electron app and one in-process server per TUI.
- Cross-session history sharing or fork — each session is a sealed conversation.
- Persistent chat (recovering chat sessions after worker crash) — chat is ephemeral by design; managed recovery stays in `RunManager` / `run/recover`.
- Renderer-side queue visualization beyond a simple "queued" badge.

## 11. Open questions

None at write time. All previously open decisions were resolved during brainstorming:

- two paths (chat + managed run): keep both ✅
- same-session second send: queue, not parallel ✅
- backward compatibility: not required ✅
- runId vs sessionId on the wire: `sessionId` only (`runId` was a phantom; the actual existing field is `sessionId`) ✅
