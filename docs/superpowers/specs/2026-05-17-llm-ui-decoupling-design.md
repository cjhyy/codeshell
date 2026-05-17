# LLM/UI Decoupling Design — Stream Watchdog · QueryGuard · Abort Preservation · Background Agent Dock

**Date:** 2026-05-17
**Status:** Draft (pre-plan)
**Owner:** codeshell
**Reference:** Claude Code 2.1.88 — `services/api/claude.ts`, `screens/REPL.tsx`, `query.ts`

---

## 1. Problem Statement

codeshell freezes the entire UI while the main turn awaits LLM bytes: input is locked, scroll is locked, Esc/Ctrl+C is unresponsive. When the upstream gateway hangs (observed: deepseek-v4-pro stalled 7+ minutes with no `first_byte` event), nothing forces the turn to exit. The user's only option is to kill the process.

Sub-agents are **not** the root cause — the most recent freeze was a single turn, no sub-agent. The cause is a chain of three weaknesses:

1. **No network-level idle bound** — `for await (const chunk of stream)` in `src/llm/providers/openai.ts:249` will wait forever on a wedged HTTP/2 stream.
2. **`isRunning` is React `useState`** — subject to React 18 automatic batching, allowing 1–10 ms windows where UI and underlying state desync.
3. **No abort partial preservation** — even when cancel works, the partially streamed assistant text is discarded; users cannot see what the model said before they pressed Esc.

## 2. Design Principles (Borrowed from Claude Code)

CC solves the same problem with **four independent decoupling layers**. Any layer failing does not cascade into the others. We adopt the same architecture.

```
┌─────────────────────────────────────────────────────────┐
│ Layer 4 · Interaction  — AbortController + Esc preserves│
│   partial text, appends [Request interrupted by user]   │
├─────────────────────────────────────────────────────────┤
│ Layer 3 · UI State     — isLoading derived (multi-source │
│   OR): isLoading = isQueryActive || hasRunningBgAgents   │
├─────────────────────────────────────────────────────────┤
│ Layer 2 · Query State  — QueryGuard synchronous state    │
│   machine: reserve / tryStart / end / forceEnd           │
│   useSyncExternalStore subscription (bypasses batching)  │
├─────────────────────────────────────────────────────────┤
│ Layer 1 · Network      — Stream Idle Watchdog: reset      │
│   90 s timer on every chunk; on timeout abort + release   │
└─────────────────────────────────────────────────────────┘
```

**One-way dependency.** Layer 1 is the lifeline — even if the UI is broken and the AbortController is misrouted, the watchdog still guarantees a 90 s upper bound on a hung stream.

## 3. Scope

**In scope (in implementation order):**

- **P0** Stream Idle Watchdog in `src/llm/providers/openai.ts` (+ new `src/llm/stream-watchdog.ts`).
- **P1** `QueryGuard` synchronous state machine (`src/ui/query-guard.ts`) + migrate `src/ui/App.tsx` `isRunning` to `useSyncExternalStore`.
- **P2** Preserve partial assistant text on Esc/Ctrl+C with `[Request interrupted by user]` suffix; thinking is discarded.
- **P3** Background-agent dock — extend `asyncAgentRegistry` with subscribe/getSnapshot, add `AgentDock` component, give each background agent its own transcript, Ctrl-digit view switching.

> **Note**: P3 splits into two implementation phases (4 and 5) for delivery; see §11. P0–P3 here are design groupings, not phase numbers.

**Out of scope:**

- Default-backgrounding regular sub-agents — they keep current CC-style synchronous wait semantics.
- Anthropic provider watchdog — follow-up if it manifests; current pain is openai-compatible upstream (deepseek/qwen).
- Replacing ink renderer or alt-screen behavior — both are healthy.
- Cross-process persistence of background agents — `agent-registry.ts:9-13` declares in-process lifetime and stays that way.
- Mouse-click switching for the dock — Ctrl-digit only; mouse semantics in TUI are ambiguous.
- HTTP-layer connect/TLS timeouts — leave at SDK defaults.

## 4. Success Criteria

1. **Verifiable**: with a mock LLM that never emits bytes, a turn must reject and `isLoading` must return to false within `idleTimeoutMs + 2 s`.
2. **Regression-free**: `bun test` passes; render benches show no significant regression.
3. **Manual**: with deepseek upstream blocked at the network layer, Esc must yield control to the input box within 100 ms on at least 30/30 reproductions.
4. **Fast-path neutral**: each chunk adds at most one `clearTimeout` + one `setTimeout` (V8 timer wheel cost ≪ 1 μs/chunk).

---

## 5. Layer 1 — Stream Idle Watchdog

### 5.1 Location

`src/llm/providers/openai.ts:249` — the `for await (const chunk of stream)` loop. The anthropic provider is left untouched in P0.

### 5.2 Configuration

```ts
// src/llm/stream-watchdog.ts (new, ~60 lines)
export const STREAM_WATCHDOG_DEFAULTS = {
  enabled: process.env.CODESHELL_ENABLE_STREAM_WATCHDOG === "1",
  idleTimeoutMs:
    parseInt(process.env.CODESHELL_STREAM_IDLE_TIMEOUT_MS || "", 10) || 90_000,
  warningMs: undefined as number | undefined, // defaults to idleTimeoutMs / 2
  retries:
    parseInt(process.env.CODESHELL_STREAM_WATCHDOG_RETRIES || "", 10) || 2,
};
```

**Disabled by default**, opt-in via env (matches CC convention).

### 5.3 Data Flow

```
engine.run({ signal: turnSignal })
   │
   ▼
provider.stream(params, { signal: turnSignal })
   │
   ├── new watchdogController = new AbortController()
   ├── combinedSignal = AbortSignal.any([turnSignal, watchdogController.signal])
   ├── pass combinedSignal to openai SDK
   ├── enter for await:
   │     ├── before first iteration: idleTimer = setTimeout(timeout, 90s)
   │     ├── each chunk: clearTimeout(idleTimer) + setTimeout(timeout, 90s)
   │     └── on timeout:
   │           ├── watchdogController.abort(new StreamIdleTimeoutError(...))
   │           ├── logger.error('stream.idle.timeout')
   │           └── throw StreamIdleTimeoutError
   │
   ▼
catch (StreamIdleTimeoutError) → retryable (max 2 attempts, exponential backoff)
   │
   ▼  if all retries exhausted
turn throws → queryGuard.end() → UI restores
```

**Dual AbortController** — turn-level signal (user cancel) and watchdog signal (idle timeout) are separate controllers, merged via `AbortSignal.any` for the SDK. Inspecting `signal.reason` on catch distinguishes the source.

### 5.4 Error Type

```ts
export class StreamIdleTimeoutError extends Error {
  readonly kind = "stream-idle-timeout";
  constructor(public idleMs: number, public requestId?: string) {
    super(`Stream idle for ${idleMs}ms — aborted`);
    this.name = "StreamIdleTimeoutError";
  }
}
```

The engine catch path treats `StreamIdleTimeoutError` as retryable (using the existing retry framework). `APIUserAbortError` (or signal.reason === "user-cancel") is never retried.

### 5.5 Implementation Sketch

```ts
const watchdog = createStreamWatchdog({
  idleTimeoutMs,
  onTimeout: () =>
    watchdogController.abort(
      new StreamIdleTimeoutError(idleTimeoutMs, requestId),
    ),
  onWarning: (ms) =>
    logger.warn("stream.idle.warning", { idleMs: ms, requestId }),
});

try {
  for await (const chunk of stream) {
    watchdog.reset();          // ← only line added inside the hot loop
    // ... existing parse logic unchanged
  }
} finally {
  watchdog.dispose();          // ← cleanup
}
```

**Total invasion**: ~3 lines in `openai.ts`, ~60 lines in `stream-watchdog.ts`.

### 5.6 Tests

`tests/llm/stream-watchdog.test.ts` (unit):

1. `async function*` that never yields → watchdog aborts at `idleTimeoutMs`.
2. Generator yielding every 50 ms → no spurious timeout.
3. Generator yields once then stalls → watchdog resets, then fires at `idleTimeoutMs` after the chunk.
4. `dispose()` called → no late timer firing.

`tests/llm/openai-stream-watchdog.test.ts` (integration):

5. Mock fetch returning a hanging body stream → `StreamIdleTimeoutError` is thrown and retry fires.

Manual:

6. Block deepseek egress via local proxy for 90 s → `stream.idle.timeout` log entry appears within 90 ± 2 s and turn exits.

### 5.7 Explicit Non-Goals

- Do **not** mutate UI state from inside the watchdog — that is Layer 2's job.
- Do **not** change existing retry/fallback policy — only register `StreamIdleTimeoutError` as a retryable kind.
- Do **not** implement stall-gap detection (CC's 30 s warning logs). Current pain is deadlock, not slowness.

---

## 6. Layer 2 — QueryGuard

### 6.1 Why

`useState(isRunning)` is subject to React 18 batching, opening 1–10 ms windows where:

- A second Enter press can re-enter the submit path before `isRunning` becomes true in the renderer.
- An Esc press after engine has already aborted internally still sees `isRunning=true` and runs the cancel branch — which becomes a NOP — leading the user to perceive a stuck UI.

A synchronous external store with `useSyncExternalStore` eliminates the window: state writes take effect immediately for synchronous readers and synchronously schedule a UI update.

### 6.2 State Machine

```
        ┌──────────┐
        │  IDLE    │ ◄──────────────┐
        └────┬─────┘                │
             │ reserve()            │ end() / forceEnd()
             ▼                      │
        ┌──────────┐                │
        │RESERVED  │ ───────────────┤
        └────┬─────┘  cancelReserva │
             │ tryStart(controller) │
             ▼                      │
        ┌──────────┐                │
        │ RUNNING  │ ───────────────┘
        └──────────┘
```

The `RESERVED` state captures the synchronous prep phase of `processUserInput` (permission check, message assembly, tool resolution) — the slot is taken even before the AbortController is constructed. If preparation throws, `cancelReservation()` rolls back.

### 6.3 API

```ts
// src/ui/query-guard.ts (new, ~80 lines)
export type QueryState = "idle" | "reserved" | "running";

export class QueryGuard {
  private state: QueryState = "idle";
  private controller: AbortController | null = null;
  private listeners = new Set<() => void>();

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): boolean => this.state !== "idle";

  private notify() {
    for (const cb of this.listeners) cb();
  }

  /** Returns false if a query is already active. */
  reserve(): boolean {
    if (this.state !== "idle") return false;
    this.state = "reserved";
    this.notify();
    return true;
  }

  /** Attach AbortController; must follow reserve(). */
  tryStart(controller: AbortController): boolean {
    if (this.state !== "reserved") return false;
    this.controller = controller;
    this.state = "running";
    this.notify();
    return true;
  }

  /** Roll back reserve() if processUserInput failed before tryStart. */
  cancelReservation(): void {
    if (this.state !== "reserved") return;
    this.state = "idle";
    this.notify();
  }

  /** Normal completion. */
  end(): void {
    if (this.state === "idle") return;
    this.state = "idle";
    this.controller = null;
    this.notify();
  }

  /** Hard abort: abort the controller AND end. */
  forceEnd(reason: string = "force-end"): void {
    if (this.state === "running" && this.controller) {
      try {
        this.controller.abort(reason);
      } catch {
        /* swallow */
      }
    }
    this.state = "idle";
    this.controller = null;
    this.notify();
  }

  /** Current controller's signal — for nested operations sharing cancellation. */
  getSignal(): AbortSignal | null {
    return this.controller?.signal ?? null;
  }
}
```

### 6.4 UI Wiring

`src/ui/App.tsx`:

```tsx
// REMOVE: const [isRunning, setIsRunning] = useState(false);

const queryGuard = useRef(new QueryGuard()).current;
const isQueryActive = useSyncExternalStore(
  queryGuard.subscribe,
  queryGuard.getSnapshot,
);
const isRunning = isQueryActive; // P3 will OR in background-agent signal
```

All four `setIsRunning` call sites migrate (plan phase enumerates each):

| Current | Migrated |
|---|---|
| `setIsRunning(true)` (App.tsx:887) | `if (!queryGuard.reserve()) return;` and later `queryGuard.tryStart(ac)` |
| `setIsRunning(false)` (App.tsx:961, try/catch) | `queryGuard.end()` |
| Esc / Ctrl+C path | `queryGuard.forceEnd("user-cancel")` |

### 6.5 Hard Constraint

The guard exposes **only** the state-machine methods — no `setIsRunning`-style setter. All external mutation goes through `reserve`/`tryStart`/`end`/`forceEnd`. This eliminates the "state corrupted by an unknown writer" failure mode.

### 6.6 Coordination with Layer 1

Watchdog aborts its **inner** AbortController. It does **not** touch the QueryGuard. Engine's catch path runs the normal completion:

```ts
const controller = new AbortController();
queryGuard.tryStart(controller);
try {
  await engine.run({ signal: controller.signal });
  queryGuard.end();
} catch (err) {
  if (err instanceof StreamIdleTimeoutError) {
    pushSystemMessage(`Stream idle ${err.idleMs}ms — aborted`);
  }
  queryGuard.end();
}
```

**Invariant**: QueryGuard always returns to idle through engine's catch path. The watchdog never bypasses it.

### 6.7 Pitfalls

1. **`useRef(new QueryGuard()).current`** — `new` runs each render; the result is discarded. This is React-idiomatic and acceptable (~1 alloc per render, GC handles it).
2. **`useSyncExternalStore` third argument (SSR snapshot)** — not provided. codeshell is TUI; React 19 + bun verified compatible via the existing render reconciler usage.
3. **`forceEnd` during RESERVED** — sets to idle without abort (controller is null at that point). No-throw, no surprise.

### 6.8 Tests

`tests/ui/query-guard.test.ts` (~40 lines):

1. idle → reserve → tryStart → end happy path; `getSnapshot` correct at each step.
2. `reserve()` twice returns false the second time.
3. `tryStart()` without prior `reserve` returns false.
4. `forceEnd()` in running aborts the controller (spy).
5. `forceEnd()` in reserved is no-throw, returns to idle.
6. Listener notified exactly once per transition (no extra, no missed).
7. `subscribe` returns an unsubscribe that prevents future notifications.

No UI integration test at this layer — `useSyncExternalStore` contract is React-provided; UI integration is covered by Layer 4 tests.

---

## 7. Layer 3 — Derived UI Loading State

### 7.1 Current

A single `isRunning` source. Multi-source OR machinery is overkill today but cheap to install for P3.

### 7.2 Design

In `App.tsx`, after constructing the guard:

```tsx
const isQueryActive = useSyncExternalStore(...); // Layer 2

// P3 (added in Phase 4):
// const hasRunningBackgroundAgents = useSyncExternalStore(
//   asyncAgentRegistry.subscribe,
//   asyncAgentRegistry.hasRunning,
// );

const isRunning = isQueryActive; // becomes isQueryActive || hasRunningBackgroundAgents in Phase 4
```

The `isRunning` identifier stays — the rest of `App.tsx` already uses it. Only the source changes.

### 7.3 Non-Goals

- No `useLoadingSources()` hook abstraction — direct derivation in App.tsx.
- No global state library (redux/zustand). `useSyncExternalStore` on vanilla classes is sufficient.

---

## 8. Layer 4 — Esc Preserves Partial Text

### 8.1 Target Behavior

When Esc is pressed during an active query:

1. Read the current streaming entry from chatStore (synchronous).
2. If `streamingText.trim()` is non-empty, commit it as an assistant message with suffix `\n\n[Request interrupted by user]`.
3. Call `queryGuard.forceEnd("user-cancel")`.
4. Engine's catch path receives `AbortError`. By the end of Phase 3, engine must not write its own transcript entry on user-cancel — the UI has already committed it. If the current engine does write one (open question §14), Phase 3 removes that write.

`streamingThinking` is **discarded** — model scratch work, no user value, only noise.

### 8.2 Responsibility Split

Partial commit happens in **UI layer**, not engine. Reasons:

- Engine should not know UI strings like "interrupted by user".
- UI has the full UX context (when interruption fired, what was buffered).
- Engine's catch path must therefore **not** write a transcript entry on abort — UI already did it.

This implies an engine catch-path audit during Phase 3: any place that currently writes "request cancelled" or similar must be removed.

### 8.3 Abort Reasons

| Source | reason string |
|---|---|
| Esc / Ctrl+C | `"user-cancel"` |
| Stream watchdog | `"stream-idle-timeout"` |
| Engine fatal | `"engine-error"` |
| Session end | `"session-end"` |

Engine reads `signal.reason` (Node 18+) to distinguish. Only `"stream-idle-timeout"` is retryable. `"user-cancel"` is never retried.

### 8.4 chatStore Surface

Plan-phase task: read current `src/ui/store.ts` and decide whether to extend an existing finalize API or add a new `commitStreamingEntry({ status: "interrupted", suffix: string })`. If a stream-finalize path already writes the entry, the change is just an additional suffix parameter.

### 8.5 Boundary Cases

1. **Empty partial** — skip writing, just `forceEnd`.
2. **Esc during RESERVED** — partial is always empty (no bytes yet); `forceEnd("user-cancel")` only.
3. **Esc after the turn already ended** — `isQueryActive` returns false synchronously; Esc takes the not-running branch; no duplicate commit (engine already committed normally).
4. **Race: forceEnd called, then one more chunk arrives** — covered by test case 6 below.

### 8.6 Tests

`tests/ui/store-commit-streaming.test.ts`:

1. `commitStreamingEntry({status:"interrupted"})` with non-empty text → entry persisted with suffix.
2. Empty text → no entry persisted.
3. Thinking field is not in the final entry.

`tests/ui/abort-flow.test.ts`:

4. Stream in progress → `forceEnd` → `AbortError` caught → interrupted entry in chatStore + `isRunning === false`.
5. Watchdog timeout → engine writes system message (timeout source), **no** "user" wording in entry.
6. Race: `forceEnd` then one more chunk lands → no double partial write.

---

## 9. P3 — Background Agent Dock

### 9.1 Scope (Narrow)

Regular sub-agents keep current synchronous behavior and current `AgentBlock` rendering. The dock shows **only** agents launched with `Agent(run_in_background=true)`.

### 9.2 Registry Subscription

`src/tool-system/builtin/agent-registry.ts` gains:

```ts
class AsyncAgentRegistry {
  private agents = new Map<string, AsyncAgentEntry>();
  private listeners = new Set<() => void>();
  private snapshot: AsyncAgentEntry[] = [];

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): AsyncAgentEntry[] => this.snapshot;
  hasRunning = (): boolean => this.snapshot.some((e) => e.status === "running");

  private notify() {
    this.snapshot = [...this.agents.values()]; // new reference per change
    for (const cb of this.listeners) cb();
  }

  // register / markCompleted / markFailed / cancel / reset each call notify()
}
```

**Critical**: `getSnapshot` must return a stable reference between mutations. Rebuild the array only inside `notify`. Otherwise `useSyncExternalStore` causes infinite re-render.

### 9.3 AgentDock Component

`src/ui/components/AgentDock.tsx` (new):

```tsx
export function AgentDock() {
  const agents = useSyncExternalStore(
    asyncAgentRegistry.subscribe,
    asyncAgentRegistry.getSnapshot,
  );
  const running = agents.filter((a) => a.status === "running");
  if (running.length === 0) return null;

  return (
    <Box flexDirection="row" gap={1} paddingX={1}>
      <Text dim>agents:</Text>
      {running.slice(0, 5).map((a, i) => (
        <Text key={a.agentId} color="ansi:cyan">
          [{i + 1}] {a.description} {Math.floor((Date.now() - a.startedAt) / 1000)}s
        </Text>
      ))}
      {running.length > 5 && <Text dim>... +{running.length - 5} more</Text>}
    </Box>
  );
}
```

Mounted in `FullscreenLayout`'s `bottom` slot, above the input box.

### 9.4 1 Hz Local Timer

Elapsed text doesn't auto-refresh. A 1 Hz `setInterval` triggers a **local** `forceUpdate`, scoped to the dock only — does not re-render the app tree:

```tsx
const [, tick] = useState(0);
useEffect(() => {
  if (running.length === 0) return;
  const id = setInterval(() => tick((n) => n + 1), 1000);
  return () => clearInterval(id);
}, [running.length > 0]);
```

### 9.5 Ctrl-Digit View Switching

`Ctrl+1..Ctrl+5` switches the main scroll area between:

- `viewMode = "main"` — chatStore main transcript
- `viewMode = { kind: "agent", id: <agentId> }` — agent's own transcript

This **requires** each background agent to maintain its own transcript. `AsyncAgentEntry` gains:

```ts
interface AsyncAgentEntry {
  // existing fields ...
  transcript: ChatEntry[]; // append-only, written by subAgentSpawner stream callback
}
```

`subAgentSpawner.spawn(...)` writes a copy of its stream events into `entry.transcript` in parallel with the existing final-string return. Existing `AgentBlock` rendering is unchanged.

### 9.6 Non-Goals

- No mouse-click dock switching.
- No persistence across process restart (matches `agent-registry.ts:9-13` declared lifetime).
- No hard cap on background agent count; dock displays up to 5 with overflow indicator.

### 9.7 Tests

`tests/tool-system/agent-registry-subscribe.test.ts`:

1. `register` triggers `notify`.
2. `getSnapshot` returns a stable reference between mutations.
3. Snapshot reference changes on `markCompleted`.

`tests/ui/agent-dock.test.tsx`:

4. No running agents → `AgentDock` renders null.
5. One running agent → dock renders `[1] description 0s`.
6. Timer only ticks while at least one agent is running.

P3 integration (manual):

7. Spawn `Agent(run_in_background=true)`, main turn continues to take input; dock displays the agent; Ctrl+1 switches to agent transcript; Ctrl+0 returns to main.

---

## 10. Test Strategy Summary

| Layer | File | Critical Cases |
|---|---|---|
| L1 watchdog | `tests/llm/stream-watchdog.test.ts` | Idle timeout, reset on chunk, dispose, no late fire |
| L1 integration | `tests/llm/openai-stream-watchdog.test.ts` | Mock fetch hang → StreamIdleTimeoutError + retry |
| L2 guard | `tests/ui/query-guard.test.ts` | 7 cases (§6.8) |
| L4 store | `tests/ui/store-commit-streaming.test.ts` | Partial commit, empty skip, thinking dropped |
| L4 integration | `tests/ui/abort-flow.test.ts` | Force-end → interrupted entry; watchdog → system msg; race no double-write |
| P3 registry | `tests/tool-system/agent-registry-subscribe.test.ts` | notify + stable snapshot ref |
| P3 dock | `tests/ui/agent-dock.test.tsx` | Empty null, render, timer scoping |

**Manual acceptance** (must appear in each PR description):

- Upstream blocked → 90 s turn exit + UI restored.
- Esc mid-stream → transcript shows partial + interrupted marker.
- `Agent(run_in_background=true)` → main turn continues; dock visible; Ctrl-digit switches.

**Regression gates**: `bun test` green; render benches no significant regression.

---

## 11. Implementation Order

Each phase merges independently. A failure in any phase does not block earlier phases.

| Phase | Content | Effort | Value |
|---|---|---|---|
| **1 (P0)** | Stream Watchdog + error type + retry wiring + L1 tests | 0.5 d | **Immediately eliminates the multi-minute freezes**; 90 s upper bound |
| **2 (P1)** | QueryGuard class + App.tsx 4 site migration + L2 tests | 1.0 d | UI state machine consistent; Esc takes effect immediately |
| **3 (P2)** | chatStore commit API + Esc handler + L4 tests | 0.5 d | Partial assistant text preserved across interrupt |
| **4 (P3 base)** | Registry subscribe + AgentDock + 1 Hz timer | 0.5 d | Dock visible; not yet switchable |
| **5 (P3 full)** | Per-agent transcript + Ctrl-digit switching + integration | 1.5 d | Multi-agent navigation experience |

**Total: 4 days.**

**Required ordering**:

- Phase 1 must land first — only one that directly addresses the current freeze.
- Phase 4 → Phase 5 must come after Phase 2 (QueryGuard is infrastructure).
- Phase 3 can run in parallel with Phase 4 (no shared files).

Each phase = one PR. Each PR is independently testable and revertable.

---

## 12. Risks and Rollback

| Risk | Impact | Mitigation |
|---|---|---|
| Watchdog kills a slow "thinking" model | Cancels a request the user wanted | Default disabled; 90 s threshold; PR description includes measured thinking-phase durations for deepseek/qwen/anthropic |
| `useSyncExternalStore` inconsistency on bun + React 19 | UI tearing or infinite render | Phase 2 begins with `scripts/smoke-sync-store.ts` validating bun + React 19 + ink integration |
| chatStore commit API collides with existing stream-finalize | Duplicate or lost entries | Phase 3 first task: read store's stream-finalize path, decide reuse vs. add |
| Dock timer triggers full-tree re-render | Performance regression | Local `useState({})` forceUpdate scoped to dock; no `useSyncExternalStore` wired to time |
| Phase 5 per-agent transcript breaks existing AgentBlock | UI corruption | Phase 5 preserves AgentBlock's current synchronous path; background agents add a parallel transcript write path |

**Rollback**:

- Phase 1: leave env unset — code is dormant.
- Phase 2: full PR revert (all `setIsRunning` sites changed; no partial revert).
- Phase 3: revert `commitStreamingEntry` independently; Esc returns to no-partial behavior.
- Phase 4–5: delete `AgentDock` + drop registry subscribe fields; per-agent transcript writes become dead writes (harmless).

---

## 13. Out of Scope (Explicit)

- Watchdog on anthropic provider (follow-up if it manifests).
- HTTP-layer timeouts (connect/TLS) — SDK defaults.
- Modifying ink renderer / alt-screen.
- Default-backgrounding regular sub-agents — synchronous CC semantics preserved.
- Mouse-click dock switching.
- Cross-process agent persistence.

---

## 14. Open Questions for Plan Phase

1. **Engine catch-path audit** (§8.2) — does the current engine write a transcript entry on `AbortError`? If yes, Phase 3 must remove that write to avoid duplication with the new UI-side commit.
2. **chatStore stream-finalize shape** (§8.4) — extend existing or add new API?
3. **subAgentSpawner stream interface** (§9.5) — what callback does it currently expose; can `parentStream` be extended to also write `entry.transcript`?

These are documented for the plan phase, not blocking design approval.
