# Desktop Subagent Content Isolation & Folded Rendering

**Date:** 2026-05-28
**Scope:** `packages/desktop/src/renderer/` only. No core/engine changes.

## Problem

In session `s-mpo7fju0-7d6942b7` the desktop UI froze under load from concurrent subagents. Investigation found two layered defects in the renderer:

1. **Misattribution.** `applyStreamEvent` (`packages/desktop/src/renderer/types.ts:197-207`) handles `text_delta` without inspecting `event.agentId`. Subagent deltas are appended to whichever `AssistantMessage` `streamingAssistantId` points at, so 10566 subagent deltas were folded into the main assistant message.
2. **Unbounded re-render cost.** Each delta runs `state.messages.map()` to rebuild the whole messages array, producing a fresh `messages` reference. `MessageStream`'s `useMemo(() => buildStreamItems(messages), [messages])` re-scans the full transcript per delta, and no `React.memo` exists on message components. Cost is roughly O(messages × deltas).

Compare the TUI: `packages/tui/src/ui/App.tsx:543-561` drops `text_delta` events that carry an `agentId` from the main feed and routes them through `createTranscriptTranslator` into `asyncAgentRegistry`. The desktop renderer has no equivalent.

## Goal

Subagent stream events are attributed to their owning `AgentMessage` card, not the main feed. Per-event reducer cost is O(1) instead of O(messages). Folded cards render only a status row; expanding a card reveals the subagent's tool calls (using the existing `ToolCard` component) and final text.

## Non-Goals

- Throttling/batching `text_delta` for the main agent. (Independent optimization; defer.)
- Nested agent tree rendering. `agent_start` carries no parent id; adding it would require a core event schema change. Treat all agents as siblings.
- A full streaming-transcript detail view matching TUI's `AgentDock` expansion. The fold view shows tool calls + final text only; per-delta replay is not retained.
- Core/engine changes. The fix lives entirely in `packages/desktop/src/renderer/`.

## Data Model

`packages/desktop/src/renderer/types.ts`.

### `AgentMessage` extensions

```ts
export interface AgentMessage {
  kind: "agent";
  id: string;                  // === agentId
  name?: string;
  description: string;
  done: boolean;
  text?: string;               // Final assistant text, committed at turn_complete / agent_end
  error?: string;
  startedAt: number;
  endedAt?: number;
  // NEW
  toolCalls: ToolMessage[];    // Subagent's tool calls, in arrival order
  textBuffer: string;          // Accumulating text_delta payload; flushed to `text` on turn boundary
  toolCount: number;           // Cheap counter for the folded header
}
```

`expanded` is **not** part of `AgentMessage`. It lives in component-local state inside `AgentMessageView` so toggling one card does not invalidate sibling memoization.

### Reducer state extension

```ts
export interface MessagesReducerState {
  // ...existing fields...
  agentMessageIndex: Record<string, number>;  // agentId → index in `messages`
}
```

The index is populated on `agent_start`. AgentMessages are never removed mid-session and the messages array only grows by appending, so an index recorded at insertion remains valid for the agent's lifetime. Subagent events use the index for O(1) lookup instead of `messages.map`.

## Reducer Behavior

For every event carrying an `agentId`, the reducer follows this template:

1. Look up `idx = state.agentMessageIndex[event.agentId]`.
2. If undefined (no `agent_start` seen), drop the event and return state unchanged.
3. Otherwise `slice()` the messages array, patch only `msgs[idx]`, return new state. The main streaming pointers (`streamingAssistantId`, `streamingThinkingId`) are not touched.

Per event type:

**`text_delta`**
- `agentId` set: append to `msgs[idx].textBuffer`. Do not emit any DOM-visible change until flush.
- `agentId` absent: unchanged from current behavior (append to streaming `AssistantMessage.text`).

**`thinking_delta`**
- `agentId` set: drop. (TUI does the same; subagent thinking provides no user value in the folded card and renders are expensive.)
- `agentId` absent: unchanged.

**`tool_use_start`**
- `agentId` set: push a fresh `ToolMessage` onto `msgs[idx].toolCalls`, increment `toolCount`.
- `agentId` absent: unchanged (append as a top-level `ToolMessage`).

**`tool_use_args_delta`** / **`tool_result`** / **`tool_summary`**
- These events identify their tool by `toolCallId` (or by "most recent tool" for `tool_summary`). Resolution becomes:
  - If `agentId` is present, scope the lookup to that AgentMessage's `toolCalls`.
  - Otherwise, search the top-level messages as today.
- `tool_summary` carries `agentId` (verified in the failing session). Inside the subagent scope, "most recent tool" means the last entry in `toolCalls`.

**`stream_request_start`**
- This event does not carry `agentId`. Both main and subagent runtimes emit it. Currently the reducer unconditionally pushes a new `AssistantMessage` and sets `streamingAssistantId`, which means a subagent's request_start creates a phantom main-feed message.
- Fix: only push when no agent is currently active. Concretely:
  ```ts
  case "stream_request_start": {
    if (Object.keys(state.activeAgents).length > 0) return state;
    // ...existing behavior...
  }
  ```
- This relies on `activeAgents` being populated before the subagent's first `stream_request_start`. `agent_start` is dispatched on the same JSON-RPC channel and ordering within a session is preserved by the bridge. **Verification step during implementation:** confirm in the captured session log that `agent_start` for every agent precedes that agent's first `stream_request_start`. If any agent skips `agent_start` (the failing session had two such cases), the renderer fix alone cannot recover them — those events are dropped at step 2 above, which is acceptable: lost events are strictly better than misattributed events. The missing `agent_start` is a separate core-side bug tracked outside this spec.

**`turn_complete`**
- For each active agent, flush `textBuffer` → `text` (concatenate onto existing `text` if non-empty, since multiple turns may occur before `agent_end`) and clear the buffer.
- Then run the existing main-feed finalization (`done: true` on streaming assistant/thinking).

**`agent_end`**
- Flush any residual `textBuffer` before marking `done`.

All other event types are unchanged.

## Rendering

`packages/desktop/src/renderer/messages/AgentMessageView.tsx`.

**Folded state (default):**
```
[●] <name> · <description> · <elapsed> · <toolCount> tools  [▸]
```
Header is clickable; toggles local `expanded` state. No `toolCalls` or `text` are rendered while folded — this is where the React-tree size shrinks.

**Expanded state:**
- A `ToolCard` per `toolCalls` entry (component reused from main feed).
- The final `text`, rendered through the existing markdown pipeline.
- If `error`, the error card.

**Memoization:**
- Wrap `AgentMessageView` in `React.memo` with the default shallow comparison. Because the reducer produces a new `AgentMessage` object only when that agent's own event arrives, siblings will not re-render.
- `MessageStream`'s `useMemo(() => buildStreamItems(messages), [messages])` still re-runs per dispatch (the messages array reference still changes), but the per-message render is now memoized, so the heavy DOM work is skipped for unaffected cards.

## Why This Resolves the Freeze

| Path | Before | After |
|---|---|---|
| Subagent `text_delta` (~10k/run) | `messages.map()` rebuild → full `buildStreamItems` re-scan → all message components re-render | Index lookup + single-slot `slice` patch → only the owning `AgentMessage` reference changes → only that card's `React.memo` invalidates → folded card renders one header row |
| Subagent `tool_*` events | Same as above | Index lookup + scoped `toolCalls` mutation; folded card still renders one header row |
| Folded card DOM cost | All tool/text DOM present | Header only |
| Memory per agent | Unbounded (deltas accumulated in main `text`) | Bounded: `toolCalls.length` ≈ actual tool count; `textBuffer` ≤ final output length |

There is no remaining O(n²) path under load.

## Testing

Pure-function reducer tests in `packages/desktop/src/renderer/types.test.ts` (create if absent). All cases run synchronously against `applyStreamEvent`.

1. **Isolation.** Given a streaming main `AssistantMessage` and an active subagent, dispatching a `text_delta` with `agentId` leaves the main message text unchanged and appends to the subagent's `textBuffer`.
2. **Tool routing.** A sequence of `tool_use_start` → `tool_use_args_delta` → `tool_result` carrying the subagent's `agentId` produces one `ToolMessage` in that agent's `toolCalls`, fully populated, and zero top-level `ToolMessage`s.
3. **Concurrent agents.** Two `agent_start` events followed by interleaved `text_delta`s from each agent produce two `AgentMessage`s whose `textBuffer`s contain only their own content.
4. **Flush on turn_complete.** After streaming deltas into a subagent's `textBuffer`, dispatching `turn_complete` moves the buffer content to `text` and clears the buffer.
5. **Out-of-order events.** A `text_delta` arriving with an `agentId` that has no corresponding `agent_start` is dropped; state is returned unchanged (`Object.is` on the input).
6. **Phantom request_start guard.** With an active subagent, dispatching `stream_request_start` does not push a new `AssistantMessage` and does not change `streamingAssistantId`.
7. **Reference stability under load.** Dispatch 10000 `text_delta` events for a single subagent; assert that the reference to every non-target message (including the streaming main `AssistantMessage`) is stable across the run. This is the regression guard for the original freeze.

A lightweight rendering check in `AgentMessageView.test.tsx`: folded state renders the header and no `ToolCard`; expanding renders `toolCalls.length` `ToolCard`s.

## Out of Scope (Tracked Separately)

- Core-side bug: two of four subagents in the failing session emitted events without a preceding `agent_start`. The renderer-side mitigation here (drop unattributed events) is defensive; the root cause is in the core agent runtime and needs its own fix.
- Main-agent `text_delta` batching (~50ms coalesce, matching TUI).
- Parent/child agent relationship in the event schema and nested rendering.
