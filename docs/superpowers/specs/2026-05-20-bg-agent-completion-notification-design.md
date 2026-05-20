# Background sub-agent completion notification

**Status:** Design
**Date:** 2026-05-20
**Owner:** —

## Problem

When the main agent spawns a sub-agent with `Agent(run_in_background: true)`, the
tool call returns immediately with placeholder text:

> "Async agent launched successfully. … You will be notified automatically when
> it completes."

The prompt instructs the LLM to **end its response** and wait. But there is no
machinery wired to deliver that promised notification. When the sub-agent
finishes, `asyncAgentRegistry.markCompleted(agentId, finalText)` records the
result, the dock badge turns green, and that is it. **The main agent never
sees the result.** From the LLM's perspective the background task is in
permanent limbo.

This breaks the contract the prompt establishes, and it makes
`run_in_background: true` effectively useless — the user has to either avoid
the parameter or manually switch to the dock detail view to read results that
should have flowed back into the conversation.

Secondary issue uncovered while diagnosing the above: result text lives in
**two** places — `AsyncAgentEntry.result` (read by the dock) and (for the
synchronous path) the tool_result string in the main agent's `messages`. For
the background path, the second copy is the placeholder, not the real result.
There is no single source of truth.

## Goals

1. When a background sub-agent completes (or fails), its final text reaches
   the main agent's `messages` as a new user turn, so the LLM can react.
2. The notification is delivered when the main agent is **idle** and the user
   is not actively interacting — never interrupts a turn in flight or competes
   with the user's keystrokes.
3. Multiple sub-agents finishing while the main agent is busy are
   **batched** into one notification turn, not delivered as a thundering
   herd.
4. The result text exists in exactly one canonical location: the main
   `messages` history (via `client.run` → engine). `asyncAgentRegistry` keeps
   metadata only.
5. **Cancelled** sub-agents do not generate notifications — the user
   explicitly cancelled, the main agent does not need a follow-up.

## Non-goals

- **Cross-process decoupling.** The Agent registry / notification queue stay
  as in-process module singletons that the UI subscribes to directly. This
  matches Claude Code's `AppState.tasks` pattern; it accepts that the UI
  cross-imports `tool-system/` state. An Electron / SDK port would require a
  separate effort to push these stores behind stream events. Out of scope.
- **Synchronous sub-agents.** `Agent(run_in_background: false)` already works
  correctly — final text comes back as the tool_result string. We do not
  change this path.
- **Sub-agent transcript view.** The per-agent dock detail view continues to
  render entries from `AsyncAgentEntry.transcript` (populated by
  `agent-transcript-translator.ts`). This is a separate concern — transcript
  is the *process* record (thinking, tool calls), notifications are the
  *result* hand-off. They serve different audiences (user vs LLM).
- **Auto-promotion to background after N seconds.** Listed in TODO P0 (E),
  separate spec.

## Reference: Claude Code's mechanism

Claude Code solves the same problem with a four-piece design:

1. **`LocalAgentTaskState`** in `AppState.tasks[agentId]` — task lifecycle
   state. Includes `messages[]` (transcript) and a `notified` flag for
   idempotency.
2. **`completeAgentTask(result, setAppState)`** — atomic state transition;
   `status` → `completed`, stores result.
3. **`enqueueAgentNotification(...)`** — pushes a
   `<task_notification_tag>...</task_notification_tag>` XML message into a
   global `commandQueue` (separate from chat history) at priority `later`.
   Uses `task.notified` atomic check-and-set to avoid double-enqueue.
4. **`useQueueProcessor`** hook — subscribes to `commandQueue` +
   `isQueryActive` + `hasActiveLocalJsxUI`. When idle and queue non-empty,
   calls `dequeueAllMatching({ mode: 'task-notification' })` (batches all
   completions), passes to `executeInput → onQuery` which submits as a new
   user turn.

We mirror this structure but reduce moving parts: idempotency comes from the
existing `markCompleted/Failed` `status === "running"` guard rather than a
separate `notified` flag.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ src/tool-system/builtin/                                            │
│                                                                     │
│   agent.ts                                                          │
│     .then(text => {                                                 │
│       asyncAgentRegistry.markCompleted(agentId)        // status   │
│       notificationQueue.enqueue({...completed, finalText})         │
│     })                                                              │
│     .catch(err => {                                                 │
│       if (aborted) markCancelled(agentId)   // no notification     │
│       else { markFailed(agentId); enqueue({...failed, error}) }    │
│     })                                                              │
│                                                                     │
│   agent-registry.ts        ← drop result/error fields              │
│     markCompleted(id)      ← no text param                         │
│     markFailed(id)         ← no error param                        │
│     markCancelled(id)      ← new                                   │
│                                                                     │
│   agent-notifications.ts   ← NEW                                   │
│     notificationQueue: NotificationQueue                            │
│     buildNotificationMessage(items) → XML string                    │
│                                                                     │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ subscribe (useSyncExternalStore)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ src/ui/App.tsx                                                      │
│                                                                     │
│   useNotificationProcessor() — inline effect:                       │
│     guards: idle + input empty + no overlays + queue non-empty      │
│     drainAll → buildMessage → submitToEngine(message)               │
│                                  │                                  │
│                                  ├─► client.run(xml, sessionId)     │
│                                  │   (LLM sees full XML)            │
│                                  │                                  │
│                                  └─► chatStore.append({type:        │
│                                        "system",                    │
│                                        subtype: "bg_agent_notification" │
│                                        text: brief summary})        │
│                                      (UI sees emoji summary only)   │
│                                                                     │
│   renderEntry case "system" subtype "bg_agent_notification":        │
│     → <BgNotificationRow text={...} />                              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. `agent-registry.ts` changes

**Remove fields** from `AsyncAgentEntry`:

- `result?: string`
- `error?: string`

**Keep fields**: `agentId`, `name`, `description`, `status`, `startedAt`,
`finishedAt`, `finishedFadeAt`, `abort`, `transcript`.

**Method signatures**:

```ts
markCompleted(agentId: string): void   // was: (agentId, result: string)
markFailed(agentId: string): void      // was: (agentId, error: string)
markCancelled(agentId: string): void   // NEW — explicit cancel semantics
```

All three preserve the existing `if (e.status !== "running") return`
idempotency guard.

**Why keep `transcript`**: it holds the sub-agent's intermediate stream
events translated to ChatEntry shape. The agent-detail dock view renders
this. Notifications are the *result* hand-off (for the LLM); transcript is
the *process* record (for the user). Distinct concerns, distinct stores.

### 2. `agent-notifications.ts` (new file)

```ts
// src/tool-system/builtin/agent-notifications.ts

export type NotificationItem = {
  agentId: string;
  name?: string;
  description: string;
  status: "completed" | "failed";   // cancelled never enqueues
  /** Final assistant text (completed only). */
  finalText?: string;
  /** Error message (failed only). */
  error?: string;
  enqueuedAt: number;
};

class NotificationQueue {
  private items: NotificationItem[] = [];
  private listeners = new Set<() => void>();

  enqueue(item: NotificationItem): void {
    this.items = [...this.items, item];
    this.notify();
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): NotificationItem[] => this.items;

  /** Atomic: returns all items and clears. */
  drainAll(): NotificationItem[] {
    const out = this.items;
    this.items = [];
    this.notify();
    return out;
  }

  reset(): void {
    this.items = [];
    this.notify();
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try { cb(); } catch { /* isolate */ }
    }
  }
}

export const notificationQueue = new NotificationQueue();

export function buildNotificationMessage(items: NotificationItem[]): string {
  // XML output, see "Notification message format" below.
}
```

**Notification message format** (the string fed to `client.run`):

```xml
<background-agents-completed>
  <agent id="abc12345" name="Explore" status="completed">
    <description>调研 AI 公司新闻</description>
    <result>
[finalText verbatim]
    </result>
  </agent>
  <agent id="def67890" name="Plan" status="failed">
    <description>制定迁移计划</description>
    <error>Engine call timed out after 60s</error>
  </agent>
</background-agents-completed>

Above are results from background agents that finished while you were idle.
Address them appropriately — summarize for the user, continue work, or
ignore if no longer relevant.
```

- Single root tag `<background-agents-completed>` so the LLM's parser/regex
  can detect "this is an injected notification, not user input."
- Per-agent `<agent>` element with `id` (for traceability),
  `name` (kind label), `status`.
- `<description>` is the task description the user/main-agent gave at spawn
  time — gives the LLM grounding context without needing to re-read the
  tool_call args.
- `<result>` body verbatim — no truncation here (history compaction is
  someone else's job).
- Trailing instructional sentence steers the model.

### 3. `agent.ts` background path

Current (`src/tool-system/builtin/agent.ts:191`):

```ts
.then((text) => asyncAgentRegistry.markCompleted(agentId, text))
.catch((err: Error) => {
  if (controller.signal.aborted) return;
  asyncAgentRegistry.markFailed(agentId, err.message);
});
```

Replace with:

```ts
.then((text) => {
  asyncAgentRegistry.markCompleted(agentId);
  notificationQueue.enqueue({
    agentId, name, description,
    status: "completed",
    finalText: text,
    enqueuedAt: Date.now(),
  });
})
.catch((err: Error) => {
  if (controller.signal.aborted) {
    asyncAgentRegistry.markCancelled(agentId);
    // No notification: user-initiated cancel doesn't warrant a follow-up
    // turn. Dock still shows "cancelled" badge for the fade window.
    return;
  }
  asyncAgentRegistry.markFailed(agentId);
  notificationQueue.enqueue({
    agentId, name, description,
    status: "failed",
    error: err.message,
    enqueuedAt: Date.now(),
  });
});
```

The placeholder tool_result text (`agent.ts:200-208`) stays unchanged — it
already promises "you will be notified automatically." That promise is now
real.

### 4. `useNotificationProcessor` in App.tsx

Inline effect, not a separate hook file:

```ts
const notificationSnapshot = useSyncExternalStore(
  notificationQueue.subscribe,
  notificationQueue.getSnapshot,
);

useEffect(() => {
  if (notificationSnapshot.length === 0) return;
  if (isQueryActive) return;
  if (input.trim() !== "") return;
  if (pendingApproval) return;
  if (pendingQuestion) return;
  if (modelManager || modelEntries || sessionEntries) return;
  if (showOnboarding) return;

  const items = notificationQueue.drainAll();
  if (items.length === 0) return;   // someone else drained, race-safe
  const message = buildNotificationMessage(items);
  submitToEngine(message, { asInjection: true });
}, [
  notificationSnapshot, isQueryActive, input,
  pendingApproval, pendingQuestion, modelManager,
  modelEntries, sessionEntries, showOnboarding,
]);
```

**`submitToEngine` extraction** from current `handleSubmit`:

The portion of `handleSubmit` from `chatStore.update(...append(user))` through
`await client.run(...)` is the engine-submission state machine
(queryGuard reserve, abortController, streaming reset, cleanup). Extract
this as a private function:

```ts
async function submitToEngine(
  message: string,
  opts: { asInjection: boolean },
): Promise<void> {
  // Same body as today's handleSubmit lines ~1103-1180, minus:
  //   - addToHistory(v)             [skipped when asInjection]
  //   - setInput("")                [no input was typed]
  //   - chatStore.update(...user)   [replaced when asInjection]
  // When asInjection: append a "system" entry with subtype
  //   "bg_agent_notification" + a short human summary instead of the
  //   raw XML.
}
```

`handleSubmit` becomes a thin wrapper that does the input-source-specific
parts (history, slash-command branch, input clearing) and delegates the
engine call to `submitToEngine(text, { asInjection: false })`.

### 5. UI rendering

**`src/ui/store.ts`** — add to `SystemSubtype` union:

```ts
export type SystemSubtype =
  | "compact_boundary"
  // ...existing subtypes...
  | "bg_agent_notification";
```

**`src/ui/App.tsx` renderEntry `case "system"`**: add a branch for the new
subtype rendering a small component (inline or in a new file
`src/ui/components/BgNotificationRow.tsx`):

```
📨 background agents completed
  └─ Explore  ·  调研 AI 公司新闻  ·  ✓
  └─ Plan     ·  制定迁移计划       ·  ✗ failed: Engine call timed out
```

Dim styling, no expansion. The full result text is in `messages` (visible
to the LLM) but **not** in the chatStore entry — the user gets only the
summary in the main feed. If the user wants details, they switch to that
sub-agent's dock detail view and read the transcript there.

The summary text is built by a small helper alongside
`buildNotificationMessage`:

```ts
export function buildNotificationSummary(items: NotificationItem[]): string {
  // emoji + name/description + status badge per agent, joined with newlines.
}
```

## Data flow (end-to-end)

```
Main agent calls Agent(run_in_background: true)
     │
     │ tool_result: "Async agent launched..."
     ▼
agent.ts background path:
  void runSubAgent(spawner, opts).then(...).catch(...)
     │
     │ (sub-agent runs detached, transcript translator
     │  populates AsyncAgentEntry.transcript along the way)
     │
     ▼
sub-agent completes with finalText
     │
     ├──► asyncAgentRegistry.markCompleted(agentId)
     │       └──► registry subscribers re-render
     │              (dock badge: running → completed)
     │
     └──► notificationQueue.enqueue({
              agentId, name, description,
              status: "completed",
              finalText, enqueuedAt
          })
             └──► queue subscribers re-render
                    │
                    ▼
App.tsx useNotificationProcessor effect:
  guards check (idle + input empty + no overlays)
     │
     │ pass
     ▼
  items = notificationQueue.drainAll()
  xml = buildNotificationMessage(items)
  summary = buildNotificationSummary(items)
     │
     ▼
  submitToEngine(xml, { asInjection: true })
     ├──► chatStore.append({type:"system", subtype:"bg_agent_notification", text: summary})
     └──► client.run(xml, sessionId)
            └──► engine: new turn with user message = xml
                   └──► main agent LLM sees the XML, reacts naturally
```

## Edge cases

**Race: two notifications enqueued back-to-back, both fire useEffect.** Effect
guards `notificationSnapshot.length === 0` early-returns when queue is empty;
`drainAll` is atomic. The second effect run sees an empty snapshot and exits.
No double-injection.

**User types while a notification is pending.** Guard `input.trim() !== ""`
holds the notification. As soon as the user submits or clears the input,
React re-runs the effect (the input state change triggers it) — notification
fires on the next idle moment.

**User submits a turn before notification fires.** Guard `isQueryActive`
holds. After the turn completes (`isQueryActive` transitions to false), the
effect fires and the notification is delivered. Sub-agent may have stacked
two completions during that time — both get batched into one XML in
`drainAll`.

**Main agent cancels mid-turn (ESC / Ctrl+C).** Existing cancellation logic
sets `isQueryActive` back to false. Effect fires, notification delivered as a
fresh turn. Acceptable: the user explicitly aborted, then learns a background
agent finished; they can decide what to do.

**Ctrl+C cancels all background agents** (existing behavior in `App.tsx:935`).
Cancellations don't enqueue (per the cancelled-no-notification rule), so no
pile-up.

**Sub-agent fails immediately after spawn (e.g. invalid model).** Same path as
success: `.catch` → `markFailed` + `enqueue({status: "failed"})`. Notification
delivers `<agent ... status="failed"><error>...</error></agent>`.

**Notification arrives during onboarding / first-run banner.** Guard
`showOnboarding` holds. Once onboarding completes, effect fires.

**Multiple overlays could open after enqueue.** Effect's deps include all
overlay states (`pendingApproval`, `pendingQuestion`, `modelManager`,
`modelEntries`, `sessionEntries`, `showOnboarding`). Any transition re-runs
the effect; guards re-evaluate; delivery happens at the first idle moment.

**Process exits with pending notifications.** Lost. Acceptable — same
contract as `asyncAgentRegistry` (process-local, no persistence). If durable
delivery becomes a requirement, `RunManager` is the right layer for it.

## Testing strategy

Unit tests:

- `agent-notifications.ts`: enqueue → getSnapshot reflects; drainAll empties;
  subscribers called.
- `buildNotificationMessage`: snapshot test against fixture
  `NotificationItem[]` — XML format stable.
- `buildNotificationSummary`: same pattern for the UI summary string.

Integration:

- Spawn a no-op background sub-agent in a test harness, await `markCompleted`,
  assert `notificationQueue.getSnapshot().length === 1` and the item's
  fields.

UI:

- React Testing Library on App.tsx (or smaller harness): mount with a fake
  registry/queue, simulate `notificationQueue.enqueue` from outside, assert
  `client.run` mock is called with the expected XML payload and
  `chatStore` gets a `bg_agent_notification` system entry.
- Guard tests: with `isQueryActive: true`, no submission; flip to false,
  submission fires.

## Migration / rollout

Single PR, all-or-nothing — the bug is currently zero-feedback (LLM stalls
silently), so partial rollout has no value.

After landing, watch:

- Smoke a background spawn, confirm main agent receives the notification
  after sub-agent completes.
- Confirm multi-agent batching by spawning 2-3 concurrent background agents
  with brief tasks; expect a single notification turn with all results.
- Confirm cancellation path: spawn, then `AgentCancel`; main agent should
  not receive any notification.

## Files touched

- `src/tool-system/builtin/agent-registry.ts` — drop `result/error` fields,
  add `markCancelled`, narrow method signatures.
- `src/tool-system/builtin/agent-notifications.ts` — new file.
- `src/tool-system/builtin/agent.ts` — `.then/.catch` body rewritten;
  imports `notificationQueue`.
- `src/ui/App.tsx` — extract `submitToEngine`; add
  `useNotificationProcessor` effect; renderEntry branch for new system
  subtype.
- `src/ui/store.ts` — extend `SystemSubtype` union.
- `src/ui/components/BgNotificationRow.tsx` (optional new file, or inline).
- Tests as above.

## Risks

- **submitToEngine extraction touches the hot input path.** Bug here would
  break user input. Mitigate with careful diff and a smoke test of plain
  `handleSubmit` path before / after.
- **Effect re-runs on every input keystroke** (since `input` is a dep).
  Effect body has a fast-path early-return when queue is empty, so the
  per-keystroke cost is O(1). Acceptable.
- **`drainAll` race with re-render.** React effects run after commit; two
  effects firing for the same snapshot is impossible because the state
  update from `drainAll → notify` schedules a re-render that runs after the
  current effect completes. The `items.length === 0` post-drain check
  defends against a stale snapshot anyway.

## Out of scope (future work)

- Cross-process registry (Electron / SDK port). Tracked separately.
- AgentStatus tool removal (TODO P0 (D)) — once notifications work, the
  tool serves only ad-hoc inspection; can be deprecated.
- Output-file mechanism (TODO P0 (D)) for in-flight progress visibility.
- Auto-promote synchronous agents to background after 120s (TODO P0 (E)).
