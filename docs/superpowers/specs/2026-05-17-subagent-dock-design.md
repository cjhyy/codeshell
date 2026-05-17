# Sub-Agent Dock — Design

**Date:** 2026-05-17
**Status:** Draft, awaiting user review
**Supersedes:** Section 9 (P3 — Background Agent Dock) of `2026-05-17-llm-ui-decoupling-design.md`. The original P3 spec narrowed scope to `run_in_background=true` and used `Ctrl+1..5` for switching. This document expands to all sub-agents (sync + background) and replaces Ctrl-digit with `↑/↓` + `Enter` to mirror Claude Code's UX.

## 1. Problem

Today every sub-agent invocation runs in one of two modes, each with a separate UX gap:

- **Sync mode** (default `Agent(...)` call). The sub-agent's full event stream (`tool_call` / `tool_result` / `assistant_text` events) is appended to the main `chatStore`. The main transcript is rendered as a nested `AgentBlock` that inlines every tool call. A long sub-agent (40+ tool uses) drowns the main conversation in detail noise — the parent agent only needs the *result*, not the trace.
- **Background mode** (`Agent(run_in_background=true)`). Stream events do not enter `chatStore`. The agent exists only in `asyncAgentRegistry` as a status row (running / completed / failed). There is no way to view what it is doing or what it produced beyond the final string returned to the parent.

Both gaps point to the same missing primitive: a per-sub-agent transcript decoupled from the main chat, plus a UI surface that lets the user browse and drill into running and recently-finished sub-agents.

## 2. Goals

1. Main `chatStore` shows **one compact summary row per sub-agent call**. No inline tool-call expansion.
2. Each sub-agent owns an **independent transcript** persisted on its registry entry. Single source of truth — no duplication into `chatStore`.
3. A bottom **dock** lists running and recently-finished sub-agents (sync + background, uniform treatment).
4. `↑/↓` navigates the dock; `Enter` switches the main view to that sub-agent's full transcript (full-screen, framed with the agent name in the upper-right border).
5. `Ctrl+T` toggles dock visibility.
6. Running indicator pulses (1 Hz `●` opacity flicker).
7. Finished agents linger in the dock for 30 s, then fade out.

## 3. Non-Goals

- Mouse click navigation in the dock (keyboard only).
- Cross-process persistence (registry remains process-local, matching `agent-registry.ts:9-13`).
- Scroll position sync between main and transcript view.
- Replacing `Ctrl+1..5` from the original P3 spec — that interaction is dropped, not preserved alongside.
- Filtering / search inside transcripts (future work).
- Resizable dock — fixed at up to 3 visible rows + overflow indicator.

## 4. Data Model

### 4.1 `AsyncAgentEntry` (extended)

```ts
type AsyncAgentKind = 'sync' | 'background';

interface AsyncAgentEntry {
  // existing
  agentId: string;
  description: string;          // the prompt summary / `description` arg to Agent()
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
  abort: () => void;

  // new
  kind: AsyncAgentKind;         // sync also enters the registry now
  name: string;                 // subagent_type, e.g. 'general-purpose'
  transcript: ChatEntry[];      // append-only event log for this sub-agent
  latestToolName?: string;      // most recent tool_call.name — drives the
                                // main-thread summary row's scrolling tail
  finishedFadeAt?: number;      // finishedAt + 30000; dock filters past this
}
```

### 4.2 `AsyncAgentRegistry` (extended)

```ts
class AsyncAgentRegistry {
  private agents = new Map<string, AsyncAgentEntry>();
  private listeners = new Set<() => void>();
  private snapshot: AsyncAgentEntry[] = [];

  subscribe = (cb: () => void): (() => void) => { /* ... */ };
  getSnapshot = (): AsyncAgentEntry[] => this.snapshot;  // stable reference

  // register / markCompleted / markFailed / cancel / setLatestTool /
  // appendTranscript each call notify() at the end
  private notify(): void {
    this.snapshot = [...this.agents.values()];           // rebuild on change
    for (const cb of this.listeners) cb();
  }
}
```

**Critical invariant:** `getSnapshot()` returns the same reference between mutations. Rebuilding inside read causes `useSyncExternalStore` infinite loops. Confirmed by spec 9.2 of the parent doc.

### 4.3 `ChatEntry` — new `agent_call` variant

```ts
interface AgentCallEntry {
  type: 'agent_call';
  id: string;
  agentId: string;              // foreign key into asyncAgentRegistry
  name: string;                 // subagent_type
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  result?: string;              // populated on completion
  error?: string;
  durationMs?: number;
  expanded: boolean;            // toggled by user; default false on completion
}
```

This entry **replaces** the existing inline `AgentBlock` representation in the main `chatStore` for sub-agent calls. The existing `agent_block_start` / `agent_block_end` / inline `tool_call` events for a sub-agent stop being appended to the main store entirely.

## 5. Data Flow

```
subAgentSpawner.spawn(opts)   // implemented in src/tool-system/builtin/agent.ts
  │
  ├─ id = uuid()
  ├─ asyncAgentRegistry.register({
  │     id, kind, name, description,
  │     status: 'running', transcript: [], startedAt: now
  │   })   →   notify()  →  dock re-renders
  │
  ├─ if kind === 'sync':
  │     chatStore.append({
  │       type: 'agent_call', id: callId,
  │       agentId: id, name, status: 'running', startedAt: now, expanded: false
  │     })
  │   // kind === 'background' skips chatStore — fire-and-forget;
  │   // the user sees it only in the dock until they Enter into the
  │   // transcript view. The parent agent gets its result via
  │   // AgentStatus / AgentResult tool calls, not via main chatStore.
  │
  └─ run() — for each stream event from the inner runtime:
       │
       ├─ event.kind === 'tool_call'?
       │    entry.latestToolName = event.toolName
       ├─ entry.transcript.push(event as ChatEntry)
       └─ registry.notify()
                          │
                          ▼
              dock summary row + main-thread agent_call row both re-read
              entry.latestToolName / entry.transcript.length

  on complete(result):
    registry.markCompleted(id, result)  →  finishedFadeAt = now+30000  →  notify
    chatStore.update(callId, { status:'completed', result, finishedAt, durationMs })

  on error / abort: symmetric (markFailed / markCancelled)
```

### 5.1 Single-source guarantee

Tool calls, assistant text, and tool results from inside a sub-agent live **only** in `entry.transcript`. They never enter `chatStore`. For **sync** calls the main store sees the `agent_call` placeholder plus the eventual `result` / `error` string. For **background** calls the main store is untouched — the parent retrieves the result through tool-side mechanisms (`AgentStatus` / `AgentResult` style tools); the user inspects the run through the dock.

### 5.2 Backward compatibility break

The current behaviour (sync sub-agents render as nested `AgentBlock` with every tool call inline) is intentionally removed. The summary row replaces it. Existing `AgentBlockStart` / `AgentBlockEnd` / `ToolCall` components are still used inside the full-screen transcript view (rendered from `entry.transcript`); they are no longer mounted as children of the main `VirtualMessageList` for sub-agent content.

## 6. UI Components

### 6.1 `AgentCallRow` (new, rendered in main `VirtualMessageList`)

One row per `agent_call` ChatEntry.

```
Running:
  ⏺ general-purpose · Read /foo.ts · 14m
    │              │   │              │
    │              │   │              └ elapsed (1 Hz)
    │              │   └ latestToolName (truncated to fit)
    │              └ entry.name
    └ ● cyan pulsing (1 Hz opacity)

Completed (expanded=false, default):
  ⏺ general-purpose · ✓ completed · 14m 23s
                                          ▶ press Enter to expand result

Completed (expanded=true):
  ⏺ general-purpose · ✓ completed · 14m 23s
  ┌─ result ────────────────────────────────┐
  │ <result text wrapped to viewport width> │
  └─────────────────────────────────────────┘

Failed (expanded=false):
  ⏺ general-purpose · ✗ error · 02m 11s     ▶ expand
Failed (expanded=true):
  ⏺ general-purpose · ✗ error · 02m 11s
  ┌─ error ─────────────────────────────────┐
  │ <error text>                            │
  └─────────────────────────────────────────┘
```

`Enter` while a main-store `agent_call` row is the keyboard cursor target toggles `expanded`. (The keyboard cursor target is the existing message-row selection driven by `selectedEntryId`.)

`⏺` is `●` when running (cyan, 1 Hz), `●` when completed (green, static), `●` when failed (red, static). The pulse is implemented via a 1 Hz local state tick on the row, identical to the dock's elapsed updater.

### 6.2 `AgentDock` (new, mounted in `FullscreenLayout.bottom` above input)

```tsx
function AgentDock() {
  const agents = useSyncExternalStore(
    asyncAgentRegistry.subscribe, asyncAgentRegistry.getSnapshot,
  );
  const visible = agents.filter(a =>
    a.status === 'running' ||
    (a.finishedFadeAt !== undefined && Date.now() < a.finishedFadeAt)
  );
  const focused = useFocusedAgentIndex(visible.length);

  if (visible.length === 0 || !dockVisible) return null;

  const rows = visible.slice(0, 3);
  const overflow = visible.length > 3 ? visible.length - 3 : 0;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dim>agents</Text>
      {rows.map((a, i) => (
        <AgentDockRow
          key={a.agentId}
          entry={a}
          focused={focused === i}
        />
      ))}
      {overflow > 0 && <Text dim>... +{overflow} more</Text>}
    </Box>
  );
}
```

Row format: `[cursor] [pulse●] [name] [latestTool? · ] [elapsed]`. Cursor is `>` on the focused row, space otherwise.

### 6.3 `viewMode` (new, in main `ui/App.tsx`)

```ts
type ViewMode = { kind: 'main' } | { kind: 'agent'; id: string };
const [viewMode, setViewMode] = useState<ViewMode>({ kind: 'main' });
```

`VirtualMessageList` selects its entry source by `viewMode`:

- `kind: 'main'` → `chatStore.entries` (current behaviour)
- `kind: 'agent'` → `asyncAgentRegistry.get(id)?.transcript ?? []`

When entering agent view, render the scroll area wrapped in a `Box` with `borderStyle='single' borderColor='ansi:cyan'` and a title in the upper-right (the agent name). The same `MessageRow` / `MessageContent` / `ToolCall` components render the transcript — visual parity with the main thread.

## 7. Keyboard Routing

Source-of-truth precedence (top wins):

1. **Modal overlays** (permission prompt, model selector, etc.) — keep current behaviour.
2. **Agent transcript view active** (`viewMode.kind === 'agent'`):
   - `Esc` → `setViewMode({ kind: 'main' })`
   - `↑/↓ PgUp/PgDn` → main scroll (existing scroll handler)
   - `Ctrl+T` → toggle dock visibility (state retained across view changes)
3. **Dock has at least one row AND input is empty**:
   - `↑/↓` → move dock focus (clamped to `[0, visible.length - 1]`)
   - `Enter` → `setViewMode({ kind: 'agent', id: visible[focused].agentId })`
   - `Ctrl+T` → toggle dock visibility
4. **Otherwise** (input has text, or dock empty/hidden):
   - `↑/↓` → input history (current behaviour)
   - `Enter` → submit input (current behaviour)
   - `Ctrl+T` → toggle dock visibility (always available)

The `dock focus` and `dockVisible` state live on `ui/App.tsx`. `dockVisible` defaults to `true`. The dock auto-hides itself when `visible.length === 0` regardless of `dockVisible` — the toggle only affects the case where there *are* agents.

## 8. Timers

Two 1 Hz tickers, each strictly local-scope:

- **`AgentDock`**: re-renders to update each row's elapsed. Started in a `useEffect` gated on `visible.some(a => a.status === 'running')`. Cleared when no running agent.
- **`AgentCallRow`**: each running row owns its own 1 Hz tick for elapsed + `●` opacity oscillation. Completed/failed rows have no timer.

Both tickers use `useState(0)` + `setInterval(1000)` + `clearInterval` on unmount or guard flip. Neither propagates into the app-level state, so they don't trigger `App.tsx` re-renders.

## 9. Edge Cases

- **Sub-agent finishes while user is viewing its transcript.** `viewMode` stays put. Transcript stops growing. Dock row transitions to completed with 30 s fade. `Esc` still returns to main.
- **Sub-agent that the user is viewing is removed by fade (Esc never pressed).** When `finishedFadeAt < Date.now()` and the user is still in agent view, fall back to main automatically on next tick.
- **Many concurrent agents (>3).** Dock shows first 3 in registration order + `+N more`. `↑/↓` can navigate only within the visible 3 — by design, no overflow scroll in v1.
- **Input box has text, user presses ↑.** Goes to history (rule 4). No accidental dock focus shift.
- **Cmd palette / model selector open while dock has runners.** Rule 1 wins; dock keys are ignored.
- **Agent registers but errors before first stream event.** `transcript` is empty. Agent view renders an empty bordered box with the name and a single dim `(no events)` placeholder line. Dock shows `✗ error` immediately. The main-thread `AgentCallRow` (sync only) transitions directly to `✗ error` with `expanded` showing the error text.
- **Process exits mid-run.** Existing behaviour: registry is lost. No new persistence — matches non-goal #2.

## 10. Tests

`tests/tool-system/agent-registry-subscribe.test.ts`:

1. `register` triggers `notify`; `getSnapshot()` reference changes.
2. Between two mutations `getSnapshot()` returns the same reference.
3. `appendTranscript` updates `latestToolName` when event kind is `tool_call`, otherwise leaves it.
4. `markCompleted` sets `finishedFadeAt = finishedAt + 30000`.

`tests/ui/agent-dock.test.tsx`:

5. Zero agents → dock renders null.
6. One running agent → dock renders the row with elapsed=`0s`.
7. `↑/↓` cycles focus within the visible 3.
8. `Enter` on focused row dispatches the `setViewMode` callback with that `agentId`.
9. Agent transitions running → completed → fadeAt-past: row disappears.

`tests/ui/agent-call-row.test.tsx`:

10. Running row shows `name · latestTool · elapsed`.
11. Completed row default `expanded=false` shows summary; `Enter` toggles expanded.
12. Failed row shows error on expand.

`tests/ui/view-mode.test.tsx`:

13. `viewMode='agent'` switches the `VirtualMessageList` data source to the agent transcript.
14. `Esc` returns to `viewMode='main'`.
15. Auto-fallback to main when fadeAt passes while viewing.

Manual P3 integration check:

16. Spawn one sync + one background agent. Both appear in dock. Main thread shows an `AgentCallRow` only for the **sync** one (background sub-agents are dock-only; the parent retrieves their result via tools, not the main store — see §5). `↑/↓ Enter` enters either agent's transcript; `Esc` returns. `Ctrl+T` toggles dock.

## 11. Migration / Rollout

Single PR or feature-flag-gated:

- All existing nested `AgentBlock` rendering inside `VirtualMessageList` is gated off. Existing `AgentBlock*` components remain in place for use *inside* the agent transcript view.
- A snapshot test of the main transcript needs updating: the inline tool-call rows for sub-agents are gone.
- No data migration — registry / chatStore are process-local.

If desired, gate behind `CODESHELL_SUBAGENT_DOCK=1` env for the first release, default on once verified.

## 12. Open Questions

None blocking. Settled during brainstorming:

- Dock cap: 3 + overflow indicator.
- Fade timeout: 30 s for both success and failure.
- Summary row content: `name · latestTool · elapsed` (running), `name · status · duration` (terminal).
- Sync sub-agents enter the dock too (deviation from spec 9.1).
- Inline `AgentBlock` rendering in main thread is removed.
