# Desktop Subagent Isolation — Followup (TodoWrite, Elapsed, Ingress Batching)

**Date:** 2026-05-28
**Builds on:** `docs/superpowers/specs/2026-05-28-desktop-subagent-isolation-design.md`

## Problem

Manual verification of the first followup uncovered three residual issues:

1. **TodoWrite flicker.** Subagents calling TodoWrite produced rapid-fire `task_update` events that all overwrote the same global pinned task panel above the composer. With 4 parallel subagents writing their own todo lists, the panel rewrote with each agent's snapshot in turn, producing visible flicker. Root cause: `task_update` in `packages/core/src/types.ts` has no `agentId` field, so the desktop reducer cannot tell whose update it is and unconditionally updates the global `TaskListMessage`.

2. **Folded-card flicker.** Even when collapsed, every subagent stream event produced a new `AgentMessage` object via the reducer (per Task 3's per-event spread). `React.memo`'s shallow comparison invalidated every time. The header re-rendered, and inside the header `formatElapsed(message.startedAt)` called `Date.now()` on every render — so the elapsed text node ("3s" → "4s") changed and the browser actually repainted it on every event.

3. **Still feels laggy.** Each `text_delta` / `tool_use_args_delta` dispatched synchronously into the reducer, producing a new `messages` array per event. `MessageStream`'s `useMemo(() => buildStreamItems(messages), [messages])` re-ran on every dispatch, scanning the full transcript. With 4 agents and ~100 events/sec each, that is ~400 transcript scans per second.

## Goal

- Subagent `task_update` events do **not** appear in the desktop UI at all (user explicitly does not want to see subagents' todos).
- Folded-card elapsed text does not change on every reducer event.
- Subagent stream-event bursts are coalesced before reaching the reducer, matching the TUI's existing 50 ms batching contract.

## Non-Goals

- Showing subagent todos in their owning AgentMessage card. User explicitly does not want to see them anywhere.
- Throttling main-agent `text_delta` for any reason other than the batching itself. The 50 ms batch covers both.
- A general event-coalescing framework. We coalesce two specific event types (`text_delta`, `tool_use_args_delta`) the way the TUI does; everything else flushes immediately.

## Design

### A. `task_update` carries `agentId`; renderer drops subagent updates

**Core (`packages/core/src/types.ts`):**

```ts
| { type: "task_update"; tasks: TaskInfo[]; agentId?: string }
```

**Core (`packages/core/src/tool-system/builtin/task.ts`, `emitTaskUpdate`):**

The function reads the agent id from `ctx?.agentId` (already available — that's how every other event gets it). Add the field to the emit:

```ts
cb?.({ type: "task_update", tasks, agentId: ctx?.agentId });
```

For main-agent calls, `ctx.agentId` is `undefined`, so the emitted event remains backward-compatible.

**Desktop (`packages/desktop/src/renderer/types.ts`, `task_update` reducer case):**

Add an early-return at the top of the case, identical in spirit to `thinking_delta`'s subagent-drop:

```ts
case "task_update": {
  // Subagent task lists are intentionally not shown in the desktop UI.
  // Main agent's task panel stays uncluttered by subagent activity.
  if (event.agentId) return state;
  // ...existing logic finds/appends the global TaskListMessage unchanged...
}
```

No new fields on `AgentMessage`, no new rendering. The whole change is one line in the reducer plus the type/emit.

**Why not route to the agent card:** the user explicitly does not want to see subagent todos at all. Dropping is the simplest correct fix and keeps the AgentMessage data shape stable.

### B. Folded-card elapsed does not depend on `Date.now()` per render

**Component (`packages/desktop/src/renderer/messages/AgentMessageView.tsx`):**

Replace the `formatElapsed(startedAt, endedAt)` inline call with derived state that ticks on a 1 s interval only while the agent is running:

```ts
function useElapsed(startedAt: number, endedAt: number | undefined): string {
  const [now, setNow] = useState(() => endedAt ?? Date.now());
  useEffect(() => {
    if (endedAt !== undefined) {
      setNow(endedAt);
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [endedAt]);
  return formatElapsed(startedAt, now);
}
```

`formatElapsed` becomes a pure function of two timestamps (no internal `Date.now()`).

Behavior:
- Running agent: hook drives a 1 s interval; the elapsed text updates at most once per second regardless of how many events arrive. Sub-second visual flicker disappears.
- Completed agent: hook reads `endedAt` once and never updates again.
- On unmount or `endedAt` arrival: interval cleared.

The header still renders on every reducer event (memo still invalidates because `message` is a new ref), but the rendered DOM is bit-identical between events that fall in the same 1 s bucket and that don't change `toolCount` — React reconciles to a no-op, and no text node is rewritten. The visible flicker comes from a changing text node; without that change there is no flicker.

A future improvement is to add a `React.memo` custom comparator that ignores `textBuffer` for the folded view, since `textBuffer` never affects what the folded card displays — but that's a follow-up; the elapsed fix alone removes the user-visible symptom.

### C. App ingress coalesces `text_delta` and `tool_use_args_delta` (50 ms)

**App (`packages/desktop/src/renderer/App.tsx`):**

Before dispatching to the reducer, route every `text_delta` and `tool_use_args_delta` event through a buffer keyed by `(bucket, agentId, eventType, toolCallId)`. A timer set on first event flushes the buffer after 50 ms by emitting one merged event per key, then a single dispatch per bucket.

Flush triggers (immediate, no timer):
- `tool_use_start`, `tool_result` (a new tool starts or one finishes — the user needs to see the boundary)
- `turn_complete`, `agent_end`, `agent_start` (state transitions)
- `error` (user must see errors immediately)
- The 50 ms timer firing
- Component unmount / route change

The merged events:
- `text_delta` (same bucket + agentId + nothing else): concatenate `text` fields, sum `tokens` (if present), emit one event.
- `tool_use_args_delta` (same bucket + agentId + toolCallId): merge `args` objects via shallow assign (later wins), emit one event.

All other events pass through unbatched.

**TUI parity:** the TUI already does this with `textBufferRef` + 50 ms `flushTimerRef` (`packages/tui/src/ui/App.tsx:382-578`). The desktop pattern mirrors it but at a different layer: TUI buffers post-dispatch into a chat store, desktop buffers pre-dispatch into the reducer. The reducer remains unchanged — it receives whole merged events, not batches.

Practical impact: under a 4-agent / 100-event/sec storm, dispatch rate drops from ~400/sec to ~20/sec per type. `buildStreamItems` runs ~20× per second instead of 400×. `AgentMessageView` re-renders ~20× per second per active card instead of 100×. Combined with B (elapsed stops causing per-render text changes), the folded-card flicker is eliminated and the main feed scrolling stays smooth.

## Failure Modes and Edge Cases

- **`text_delta` followed immediately by `tool_use_start` within < 50 ms.** Flush triggers on `tool_use_start`, so the text appears in the correct order. No reordering.
- **Two `tool_use_args_delta` events for the same tool but with disjoint keys.** Shallow merge unions them. Same behavior as if dispatched separately.
- **`agent_end` arriving while a `text_delta` is buffered for that agent.** Flush first, then dispatch `agent_end`. The reducer's `agent_end` then promotes `textBuffer` → `text`, which now contains the just-flushed delta.
- **Component unmounts mid-batch.** Cleanup effect flushes the buffer to avoid lost text.
- **`task_update` with `agentId` from a future code path that does want to show subagent todos.** The reducer drops it. If a future requirement reintroduces subagent todo display, the reducer change is one branch swap.

## Testing

**Reducer tests (`packages/desktop/src/renderer/types.test.ts`, append):**

11. `task_update` without `agentId` updates the global `TaskListMessage` (regression for main-agent todo).
12. `task_update` with `agentId` returns `state` unchanged (subagent todos dropped).

**Component tests (`packages/desktop/src/renderer/messages/AgentMessageView.test.tsx`, append):**

The elapsed logic is `useEffect`-driven; SSR-only tests cannot observe the interval. Add one test that the *initial* render of a `done` agent produces a sensible elapsed string (no NaN, no negative), and one that a non-done agent's initial render uses a positive elapsed (Date.now() - startedAt at construction time, not later).

**App ingress batching tests (`packages/desktop/src/renderer/App.batching.test.ts`, new):**

Extract the batching logic into a pure helper `createEventCoalescer(onFlush)` returning `{ push(event), flush(), dispose() }`. Test the helper:

13. Two `text_delta` for the same agent merge into one flushed event with concatenated text.
14. Two `tool_use_args_delta` for the same toolCallId merge by shallow-assigning args.
15. `tool_use_start` flushes any pending `text_delta` for the same agent before passing through.
16. `text_delta` for agent A and agent B remain separate (different keys).
17. `dispose()` flushes any pending content.

Use fake timers (`bun:test` supports `mock.module` and similar; if necessary use `setTimeout` with a small interval).

## Out of Scope

- Custom `React.memo` comparator for `AgentMessageView` that ignores `textBuffer` in the folded view. Worth doing once we measure that elapsed-fix + ingress-batching isn't sufficient.
- Coalescing `thinking_delta` (already dropped for subagents; main-agent thinking is rare and the cost is bounded).
- Showing subagent todos anywhere.
