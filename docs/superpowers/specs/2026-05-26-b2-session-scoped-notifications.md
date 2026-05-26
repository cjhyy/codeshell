---
title: B2 — Session-scoped background-agent notifications
date: 2026-05-26
status: in-progress
gate: Gate 1 (Correctness) — "background-agent notifications cannot leak across sessions"
plan: ../plans/2026-05-26-core-stabilization.md#b2-background-agent-notification-as-protocol-feature
standard: ../../architecture/16-core-overall-design-standard.md#s3-all-runtime-state-is-either-runtime-scoped-or-session-scoped
---

# B2 — Session-scoped background-agent notifications

## Why

Standard §S3 forbids "process-global notification queue for session-specific
events". Today `packages/core/src/tool-system/builtin/agent-notifications.ts`
holds **one process-global FIFO** that every `Engine` reads and writes:

- Background sub-agents spawned from session A write to it
  (`agent.ts:211, 246`).
- Any `App` (only one exists today; tomorrow's multi-session host will have
  several) drains the *same* queue (`packages/tui/src/ui/App.tsx:1314-1335`)
  and submits the XML into *its* current session.

Concretely: if a desktop host opens two sessions and both spawn background
agents, the agent that finishes first delivers its result XML to whichever
session's `useEffect` happens to win the drain race. The wrong LLM sees the
`<background-agents-completed>` payload. That is the leak Gate 1 calls out.

This task plugs the leak with the minimum viable refactor. The larger B2
work — emitting completion as a protocol `StreamEvent` so the host doesn't
have to import a core singleton at all — is tracked separately as B2.2.

## Scope (in-scope)

1. `NotificationQueue` stores items keyed by `sessionId` instead of a flat
   array.
2. `enqueue/subscribe/getSnapshot/drainAll/reset` accept an optional
   `sessionId`.
   - With a `sessionId`, operate on that session's bucket only.
   - Without a `sessionId`, fall back to a synthetic `__legacy__` bucket so
     existing callers that haven't migrated keep working. This is a
     transitional accommodation so TUI doesn't need to change in the same
     PR; B2.2 will remove the legacy fallback once the protocol path lands.
3. `agent.ts` passes `ctx.sessionId` when enqueuing completion / failure
   notifications. Cancellations still skip the queue per the original
   design.
4. `ToolContext` gains an optional `sessionId: string`. Populated by
   `Engine.run()` once the session is resolved (after `sessionManager.resume`
   / cold-start sid generation, before the `toolCtx` is materialized for
   the turn).
5. Tests cover: session A enqueues do not appear in session B's snapshot;
   `drainAll(sessionA)` only drains A; subscribers are notified on any
   bucket change (TUI's `useSyncExternalStore` keeps working).
6. TUI consumer (`App.tsx`) **migrates in the same PR** — it has
   `sessionId` in scope already (used as `useChatSession`'s key). This
   removes the cross-session bleed in the only host that exists today.

## Out of scope (deferred)

- A new `StreamEvent` type for background-agent completion. Adding that
  requires touching `AgentServer`/`AgentClient` and the protocol type
  union — bigger surface, tracked as B2.2.
- Per-session listener routing inside the queue. Listeners stay
  process-wide; they're notified on any change and filter by `sessionId`
  themselves at `getSnapshot(sessionId)` time. Simple, and matches what
  `useSyncExternalStore` already wants.
- Desktop host integration. Desktop doesn't have a background-agent UI
  yet; B2.2 covers it.
- Removing the `__legacy__` bucket. Kept as a transitional shim; B2.2
  removes it.

## Design

### `NotificationQueue` shape

```ts
const LEGACY_BUCKET = "__legacy__";

class NotificationQueue {
  // sessionId → items
  private buckets = new Map<string, NotificationItem[]>();
  private listeners = new Set<Listener>();

  enqueue(item: NotificationItem, sessionId?: string): void {
    const key = sessionId ?? LEGACY_BUCKET;
    const next = [...(this.buckets.get(key) ?? []), item];
    this.buckets.set(key, next);
    this.notify();
  }

  // Stable identity per sessionId so React's useSyncExternalStore doesn't
  // re-tear-down between renders. `getSnapshot()` (no arg) returns the
  // legacy bucket only — same shape as today, so untouched callers see
  // a stable empty array once they migrate.
  getSnapshot = (sessionId?: string): NotificationItem[] => {
    return this.buckets.get(sessionId ?? LEGACY_BUCKET) ?? EMPTY;
  };

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  };

  drainAll(sessionId?: string): NotificationItem[] {
    const key = sessionId ?? LEGACY_BUCKET;
    const items = this.buckets.get(key);
    if (!items || items.length === 0) return [];
    this.buckets.delete(key);
    this.notify();
    return items;
  }

  reset(sessionId?: string): void {
    if (sessionId === undefined) {
      this.buckets.clear();
    } else {
      this.buckets.delete(sessionId);
    }
    this.notify();
  }
}
```

Notes:

- `EMPTY` is a module-level frozen array so `getSnapshot(sid)` returns a
  stable reference between renders when the bucket is empty.
  `useSyncExternalStore` re-renders on reference change; without this it
  would render-loop until something enqueues.
- Listeners are still process-wide. The wakeup signal is "something
  changed somewhere"; consumers compare their own bucket's snapshot
  identity to decide whether they care. This avoids a per-session
  listener map and matches how `useSyncExternalStore` is designed.

### `ToolContext.sessionId`

Add an **optional** field:

```ts
export interface ToolContext {
  // ...existing fields...
  /**
   * sessionId of the Engine.run() turn this context was built for.
   * Tools that emit session-scoped side effects (currently: background
   * agent completion notifications) use this to attribute the event.
   * Undefined for ad-hoc ToolContexts built outside Engine.run() (e.g.
   * memory.auto_dream's narrow context, standalone tests).
   */
  sessionId?: string;
}
```

`Engine.run()` populates it inside the `runWithSid` block, after
`session.state.sessionId` is known:

```ts
const toolCtx: ToolContext = {
  ...this.buildToolContext(),
  subAgentSpawner,
  sandbox: sandboxBackend,
  cwd,
  sessionId: session.state.sessionId,
  streamCallback: options?.onStream,
};
```

`buildToolContext()` itself doesn't get `sessionId` because it's used by
ad-hoc paths (memory dream loop) where no run-time session exists.
Tools tolerate `sessionId === undefined` by falling back to the legacy
bucket — equivalent to today's behavior.

### `agent.ts` enqueue sites

Two call sites (`agent.ts:211, 246`). Both already have `ctx?` in scope.

```ts
notificationQueue.enqueue(
  {
    agentId, name, description,
    status: "completed",
    finalText: text,
    enqueuedAt: Date.now(),
  },
  ctx?.sessionId,                // ← new
);
```

If `ctx?.sessionId` is undefined (legacy / test path), the item lands in
the legacy bucket — same observable behavior as before for the only
caller that drains without a sid.

### TUI consumer

`packages/tui/src/ui/App.tsx` has `sessionId` in scope already (line ~1314
region). Migrate both `useSyncExternalStore` and `drainAll`:

```ts
const notificationSnapshot = useSyncExternalStore(
  notificationQueue.subscribe,
  () => notificationQueue.getSnapshot(sessionId),
);
// ...
const items = notificationQueue.drainAll(sessionId);
```

The `getSnapshot` arrow has to be wrapped in a closure to capture
`sessionId`. That's fine — `useSyncExternalStore` re-subscribes when the
function identity changes if you wrap it without memoization; wrap it in
`useCallback` keyed on `sessionId` so it's stable per session.

```ts
const getSnapshot = useCallback(
  () => notificationQueue.getSnapshot(sessionId),
  [sessionId],
);
const notificationSnapshot = useSyncExternalStore(
  notificationQueue.subscribe,
  getSnapshot,
);
```

## Test plan

`tests/agent-notifications.test.ts` grows three new tests; the existing
ones stay valid (they exercise the legacy no-arg path).

```ts
describe("session scoping", () => {
  test("enqueue with sessionId is isolated per session", () => {
    notificationQueue.enqueue(fixture({ agentId: "a" }), "sess-1");
    notificationQueue.enqueue(fixture({ agentId: "b" }), "sess-2");
    expect(notificationQueue.getSnapshot("sess-1").map(i => i.agentId)).toEqual(["a"]);
    expect(notificationQueue.getSnapshot("sess-2").map(i => i.agentId)).toEqual(["b"]);
    // legacy bucket unaffected
    expect(notificationQueue.getSnapshot()).toEqual([]);
  });

  test("drainAll(sid) only drains that session", () => {
    notificationQueue.enqueue(fixture({ agentId: "a" }), "sess-1");
    notificationQueue.enqueue(fixture({ agentId: "b" }), "sess-2");
    const drained = notificationQueue.drainAll("sess-1");
    expect(drained.map(i => i.agentId)).toEqual(["a"]);
    expect(notificationQueue.getSnapshot("sess-1")).toEqual([]);
    expect(notificationQueue.getSnapshot("sess-2").map(i => i.agentId)).toEqual(["b"]);
  });

  test("subscribe fires for any bucket change", () => {
    let calls = 0;
    notificationQueue.subscribe(() => { calls += 1; });
    notificationQueue.enqueue(fixture(), "sess-1");
    expect(calls).toBe(1);
    notificationQueue.enqueue(fixture(), "sess-2");
    expect(calls).toBe(2);
  });

  test("getSnapshot(sid) returns stable empty reference", () => {
    const a = notificationQueue.getSnapshot("nope");
    const b = notificationQueue.getSnapshot("nope");
    expect(a).toBe(b); // identity, not just equality
  });

  test("reset(sid) clears only that bucket", () => {
    notificationQueue.enqueue(fixture(), "sess-1");
    notificationQueue.enqueue(fixture(), "sess-2");
    notificationQueue.reset("sess-1");
    expect(notificationQueue.getSnapshot("sess-1")).toEqual([]);
    expect(notificationQueue.getSnapshot("sess-2")).toHaveLength(1);
  });

  test("reset() with no arg clears everything", () => {
    notificationQueue.enqueue(fixture(), "sess-1");
    notificationQueue.enqueue(fixture()); // legacy
    notificationQueue.reset();
    expect(notificationQueue.getSnapshot("sess-1")).toEqual([]);
    expect(notificationQueue.getSnapshot()).toEqual([]);
  });
});
```

`beforeEach` keeps calling `notificationQueue.reset()` (no arg → clears
all buckets) so test isolation works the same.

## Risks / non-risks

- **Risk**: TUI's `getSnapshot` closure identity changes per render →
  unnecessary re-subscribes. Mitigated by `useCallback([sessionId])`.
- **Risk**: an old caller that drains without a sid drops a session-tagged
  item on the floor. Not possible — sid-tagged items live in their own
  bucket; no-arg `drainAll()` operates on `__legacy__` only.
- **Non-risk**: existing tests break. The legacy no-arg path is
  preserved; existing test bodies are untouched.

## Gate impact

Closes Gate 1 bullet "background-agent notifications cannot leak across
sessions" (standard §S3 / Gate 1). Does **not** close the protocol-event
bullets — those are B2.2.

## Implementation order

1. Refactor `agent-notifications.ts`.
2. Extend `ToolContext` + `Engine.run()`.
3. Update `agent.ts` two enqueue sites.
4. Migrate TUI consumer (same PR — single host today).
5. Add tests.
6. `bun run typecheck` + targeted tests.
7. Flip plan + standard checkboxes.
