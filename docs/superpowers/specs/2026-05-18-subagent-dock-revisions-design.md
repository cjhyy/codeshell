# Sub-Agent Dock Revisions — Design

**Date:** 2026-05-18
**Status:** Draft, awaiting user review
**Builds on:** `2026-05-17-subagent-dock-design.md`. This document records the deltas applied during the 2026-05-18 brainstorm; everything not mentioned here defers to the parent spec.

## 1. Why a revision

The parent spec was implemented partway: the registry has `transcript`/`subscribe`/`getSnapshot`, `viewMode` exists on `App.tsx`, and `VirtualMessageList` already swaps its data source by `viewMode`. What landed differently from the spec, or never landed:

1. `AgentDock` is rendered as a single horizontal status row (`flexDirection="row"`, `src/ui/components/AgentDock.tsx:51`) instead of the vertical, navigable list `§6.2` describes.
2. Arrow keys are never routed to the dock. `CommandInput.tsx:88-100` unconditionally claims `↑/↓` for input history, so the user has no way to focus the dock with the keyboard.
3. The dock is placed above the input (parent spec `§6.2`) — the user wants it at the very bottom of the UI instead.
4. Each row currently shows `[n] description elapsed` on one line. The user does not want the `latestToolName` field from `§6.1`. The row should be `name … elapsed` only.
5. `Ctrl-0..5` was implemented as the switching mechanism even though parent spec `§3` removed it. The revision drops it for real.
6. The 30 s linger of completed agents (parent spec `§2.7`) was never implemented; the dock disappears the instant `status !== 'running'`.

Both render modes — `fullscreen` (alt-screen) and `flow` (`CODESHELL_FULLSCREEN=0`, content streams into terminal scrollback) — must work. This is an explicit user requirement and constrains pulse animation choices below.

## 2. Goals (for this revision only)

1. Dock is vertical, one row per running-or-recently-finished sub-agent.
2. Dock sits at the **bottom of the UI** — below the InputBox, below the StatusLine. Last thing on the screen.
3. Row format: `[cursor]● [name]   …pad…   [elapsed]`. No tool name, no extra metadata.
4. Elapsed renders compactly: `23s`, `4m 23s`, `1h 4m 23s`.
5. Keyboard:
   - InputBox empty + dock has rows → `↓` moves focus into dock (row 0).
   - Dock focused → `↑/↓` cycle rows; pressing `↑` on row 0 returns focus to input.
   - Dock focused → `Enter` opens that agent's transcript (`viewMode = { kind: 'agent', agentId }`).
   - Dock focused → `Esc` returns focus to input (does not cancel a running query).
   - `viewMode.kind === 'agent'` → `Esc` returns to main.
6. Remove `Ctrl-0..5` shortcuts. `↑/↓ + Enter` is the only way to switch.
7. Finished / failed / cancelled agents linger in the dock for 30 s, then fade out.
8. Works in both `fullscreen` and `flow` modes without per-mode forks beyond the existing `FullscreenLayout` split.

## 3. Non-Goals (for this revision)

- The full `AgentCallRow` main-thread summary row (parent spec `§6.1`) — out of scope here.
- Single-source transcript isolation for sync sub-agents (parent spec `§5.1`).
- `Ctrl+T` to hide the dock (parent spec `§2.5`).
- 1 Hz pulse on the running indicator. Static dot only. Rationale: the dock already runs a 1 Hz tick to update elapsed text, but each tick redraws `FullscreenLayout.bottom`. In `flow` mode that region is *not* inside `<Static>` and each redraw is appended to terminal scrollback (the current render module already has `SIGCONT-style reset` workarounds for related issues — see commit `702edb7`). Adding a high-frequency opacity oscillation increases the risk of scrollback ghost rows in flow mode. The static dot (color-coded by status) carries the same information without the cost.
- Dock scroll for more than `MAX_VISIBLE` agents. Continue showing first `MAX_VISIBLE` + `+N more` overflow indicator. `↑/↓` only navigate within the visible window.

## 4. Data Model

### 4.1 `AsyncAgentEntry` (additive)

Existing fields from `src/tool-system/builtin/agent-registry.ts:29-40` stay. Add:

```ts
interface AsyncAgentEntry {
  // ... existing fields
  /** finishedAt + 30000. Dock filters rows past this. */
  finishedFadeAt?: number;
}
```

Set in `markCompleted` / `markFailed` / `cancel`:

```ts
e.finishedAt = Date.now();
e.finishedFadeAt = e.finishedAt + 30_000;
```

No other registry changes. `name` / `kind` / `latestToolName` from the parent spec are **not added in this revision** — we are not consuming them.

### 4.2 `viewMode` (no change)

`type ViewMode = { kind: 'main' } | { kind: 'agent'; agentId: string }` already lives at `App.tsx:165-166`. The auto-fallback effect at `App.tsx:172-179` currently snaps back to `main` when the agent leaves `running`. **Change**: relax the predicate to "exists in registry" instead of "status === running" so the user can open a just-finished agent's transcript during the 30 s linger window.

```ts
useEffect(() => {
  if (viewMode.kind === "agent") {
    const exists = agentsSnapshot.some((a) => a.agentId === viewMode.agentId);
    if (!exists) setViewMode({ kind: "main" });
  }
}, [agentsSnapshot, viewMode]);
```

## 5. Layout — Dock at the bottom

Today in `src/ui/App.tsx:1321-1324` the `bottomContent` is:

```
<AgentDock />                ← above separator
<Text>───────────</Text>     ← separator
<CommandInput />              ← input
<Text>───────────</Text>     ← separator
<Box>{ModeIndicator}{StatusLine}</Box>
```

After the revision:

```
<Text>───────────</Text>     ← top separator (was above input)
<CommandInput />              ← input
<Text>───────────</Text>     ← separator
<Box>{ModeIndicator}{StatusLine}</Box>
<AgentDock />                ← NEW position: below everything
```

The dock's own `Box` has `marginTop={0}` and no surrounding separator — visually it hangs off the bottom of the status line. When the dock has zero visible agents it returns `null`, the bottom of the screen becomes the StatusLine, and there is no vertical jitter on the last status row.

`FullscreenLayout.bottom` already pins this whole stack to the bottom in fullscreen mode and lets it flow inline in flow mode. No `FullscreenLayout` change.

## 6. Dock Component

### 6.1 Rewrite `src/ui/components/AgentDock.tsx`

```tsx
const MAX_VISIBLE = 5;

export interface AgentDockProps {
  viewMode: ViewMode;
  focusedIndex: number | null;   // null = dock is not the keyboard target
}

export function AgentDock({ viewMode, focusedIndex }: AgentDockProps) {
  const agents = useSyncExternalStore(
    asyncAgentRegistry.subscribe,
    asyncAgentRegistry.getSnapshot,
  );

  // 1 Hz tick — both for "elapsed" and to re-evaluate the fade window.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const visible = agents.filter((a) =>
    a.status === "running" ||
    (a.finishedFadeAt !== undefined && now < a.finishedFadeAt),
  );

  if (visible.length === 0) return null;

  const rows = visible.slice(0, MAX_VISIBLE);
  const overflow = visible.length - rows.length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dim>agents</Text>
      {rows.map((a, i) => (
        <AgentDockRow
          key={a.agentId}
          entry={a}
          focused={focusedIndex === i}
          active={viewMode.kind === "agent" && viewMode.agentId === a.agentId}
          now={now}
        />
      ))}
      {overflow > 0 && <Text dim>... +{overflow} more</Text>}
    </Box>
  );
}
```

The 1 Hz tick is unconditional once any row is rendered. We do not micro-optimise on `running.length === 0` because the linger window also depends on the clock; one cheap interval is simpler than two conditional ones.

### 6.2 `AgentDockRow`

```tsx
function AgentDockRow({ entry, focused, active, now }: {
  entry: AsyncAgentEntry;
  focused: boolean;
  active: boolean;
  now: number;
}) {
  const cursor = focused ? ">" : " ";
  const dotColor =
    entry.status === "running"   ? "ansi:cyan" :
    entry.status === "completed" ? "ansi:green" :
    entry.status === "cancelled" ? "ansi:yellow" :
    /* failed */                   "ansi:red";
  const elapsed = formatElapsed(
    (entry.finishedAt ?? now) - entry.startedAt,
  );
  const name = truncate(entry.description, 40);

  return (
    <Box flexDirection="row">
      <Text color={focused ? "ansi:cyanBright" : undefined} bold={focused}>
        {cursor}
      </Text>
      <Text color={dotColor}>{" ● "}</Text>
      <Text
        color={focused ? "ansi:cyanBright" : (active ? "ansi:cyan" : undefined)}
        bold={focused}
      >
        {name}
      </Text>
      <Box flexGrow={1} />
      <Text dim>{elapsed}</Text>
    </Box>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s % 60}s`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
```

`flexGrow={1}` on the spacer Box does the left-align name / right-align elapsed without manual padding.

## 7. Keyboard Routing

State lives on `ui/App.tsx`:

```ts
const [dockFocusIdx, setDockFocusIdx] = useState<number | null>(null);
```

`null` = focus is on InputBox or elsewhere. Integer `i` = dock row `i` is focused.

### 7.1 InputBox boundary: emit "down past end of input"

`CommandInput.tsx:88-100` claims `↑/↓` for history. To let `↓` escape the input we add an `onArrowOut` prop, fired only when **input is empty and history navigator is at the bottom**:

```ts
// CommandInput.tsx — extended useInput
if (key.downArrow) {
  const next = historyRef.current.down();
  if (next !== null) {
    setFromHistory(true);
    onChange(next);
    return;
  }
  // history is at the bottom AND input is empty → let parent handle
  if (value.length === 0) {
    onArrowOut?.("down");
    return;
  }
}
```

`onArrowOut?.("down")` is `App.tsx`'s signal to set `dockFocusIdx = 0` (only if `visible.length > 0`). Symmetric `↑` does **not** escape — keep input-history behaviour unchanged on `↑`.

### 7.2 App-level `useInput` (existing handler at `App.tsx:807`)

Add a branch BEFORE the existing `Ctrl-0..5` branch (which we delete) and BEFORE the transcript-mode branch. `getVisibleAgents` is a small helper exported from `AgentDock.tsx` and used by both the dock component and the keyboard branch so the filter stays in one place:

```ts
// in AgentDock.tsx
export function getVisibleAgents(all: AsyncAgentEntry[], now: number) {
  return all.filter((a) =>
    a.status === "running" ||
    (a.finishedFadeAt !== undefined && now < a.finishedFadeAt),
  );
}
```

```ts
// Dock focus has highest priority among non-overlay keys.
if (dockFocusIdx !== null) {
  const running = getVisibleAgents(asyncAgentRegistry.getSnapshot(), Date.now());

  if (key.upArrow) {
    if (dockFocusIdx === 0) {
      setDockFocusIdx(null);   // back to input
    } else {
      setDockFocusIdx(dockFocusIdx - 1);
    }
    return;
  }
  if (key.downArrow) {
    setDockFocusIdx(Math.min(running.length - 1, dockFocusIdx + 1));
    return;
  }
  if (key.return) {
    const target = running[dockFocusIdx];
    if (target) setViewMode({ kind: "agent", agentId: target.agentId });
    setDockFocusIdx(null);     // release focus after switching
    return;
  }
  if (key.escape) {
    setDockFocusIdx(null);
    return;
  }
}

// viewMode === 'agent' → Esc returns to main (placed BEFORE the existing
// "Esc cancels request" branch so transcript exit wins).
if (key.escape && viewMode.kind === "agent" && !overlayOpen) {
  setViewMode({ kind: "main" });
  return;
}
```

The dock focus index is clamped against the visible list each render via a separate effect (lives in `App.tsx`, runs after `useInput`):

```ts
useEffect(() => {
  if (dockFocusIdx === null) return;
  const len = getVisibleAgents(agentsSnapshot, Date.now()).length;
  if (len === 0) setDockFocusIdx(null);
  else if (dockFocusIdx >= len) setDockFocusIdx(len - 1);
}, [agentsSnapshot, dockFocusIdx]);
```

### 7.3 Source-of-truth precedence (updated from parent spec §7)

1. Modal overlays (permission prompt, model selector, onboarding, session picker) — keep current behaviour.
2. `dockFocusIdx !== null` — dock owns `↑/↓/Enter/Esc` (§7.2).
3. `viewMode.kind === 'agent'` — `Esc` returns to main (§7.2). Scroll keys still work in transcript.
4. Otherwise — existing behaviour, including `CommandInput` claiming `↑/↓` for input history.

### 7.4 Removed bindings

Delete the `Ctrl-0..5` block (`App.tsx:807-823`). No replacement; `↑/↓+Enter` is the only path.

## 8. Render-Mode Compatibility

`fullscreen=true`: alt-screen. `FullscreenLayout.bottom` pins the StatusLine + dock to the bottom of the alt-screen viewport. The 1 Hz tick redraws the dock in place — same mechanism as `SpinnerWithVerb`'s existing live area.

`fullscreen=false` (flow): no alt-screen, content streams into terminal scrollback. The dock is part of `FullscreenLayout.bottom`, which is **not** inside `<Static>` — it's redrawn each commit. The `log-update` based ink renderer overwrites the same screen region, so a stable region size keeps the dock in place. **Risk:** if the dock height changes between commits (agent finishes → row removed), the previous taller frame may leave residue. Mitigation: the existing `SIGCONT-style full frame reset` (commit `702edb7`) already handles this for sibling regions. We accept the risk; no additional flow-specific fork. Confirmed by manual smoke in §11 step 5.

No `pulse` (per §3) keeps per-second cost identical to today's dock (`AgentDock.tsx:35-39`).

## 9. Edge Cases

- **Dock disappears while focused.** All running agents finish and their fade windows pass. The clamp effect (§7.2 last block) flips `dockFocusIdx` to `null` and focus implicitly returns to input.
- **User opens a transcript, then the agent's fade window passes.** `viewMode` falls back to `main` via the existing effect (§4.2). Dock disappears. No popup.
- **User submits a message while dock is focused.** `Enter` is consumed by the dock branch (§7.2); submission does not fire. This is correct — the user is interacting with the dock, not composing.
- **Modal overlay opens (e.g. PermissionPrompt) while dock is focused.** Rule 1 wins. `dockFocusIdx` stays set but is ignored until overlay closes. On close, dock focus is still there. (No need to auto-clear — the overlay handlers never call into dock state.)
- **Many agents (>5).** `visible[5..]` are not navigable. The `+N more` text reflects the count. We do not implement scrolling inside the dock.
- **Terminal too narrow.** `Box flexGrow={1}` collapses the spacer; name and elapsed butt up. Acceptable.
- **`description` is multi-line / contains ANSI.** `truncate(s, 40)` operates on raw characters; ANSI codes inside count toward the length. Acceptable for v1 — descriptions are passed in by the parent agent at spawn and are typically short labels.

## 10. Tests

`tests/ui/agent-dock.test.tsx` (existing file is touched; cases updated):

1. Zero visible agents → dock renders `null`.
2. One running agent → row rendered with `name` and `elapsed` at the row edges; no tool-name text.
3. `markCompleted` + advance fake clock by 29s → row still rendered.
4. `markCompleted` + advance fake clock by 31s → row gone.
5. `focusedIndex === 0` → first row shows `>` cursor and bright cyan name.
6. `formatElapsed` covers `s`, `m s`, `h m s` boundaries.

`tests/ui/agent-dock-keyboard.test.tsx` (new):

7. InputBox empty + dock has 2 rows → `↓` sets `dockFocusIdx` to 0.
8. `dockFocusIdx === 0` + `↑` → `dockFocusIdx` becomes `null` (focus returns to input).
9. `dockFocusIdx === 0` + `↓` → `dockFocusIdx` becomes 1 (clamped at `len-1`).
10. `dockFocusIdx === i` + `Enter` → `setViewMode` called with that agent's id; `dockFocusIdx` reset to `null`.
11. `dockFocusIdx !== null` + `Esc` → `dockFocusIdx` becomes `null`; no `client.cancel()` call.
12. `viewMode === 'agent'` + `Esc` → `setViewMode({kind:'main'})`; no cancel.
13. Ctrl-1..5 no longer triggers `setViewMode` (sanity: regression guard for §7.4).

Manual smoke (`§11`):

14. Spawn two `run_in_background` agents from the shell. Verify the dock appears at the very bottom of the screen (below the status line) in fullscreen mode.
15. Switch to flow mode (`/fullscreen` toggle). Verify the dock still appears at the bottom of the most-recent terminal frame and updates elapsed each second without ghost rows in scrollback.
16. With InputBox empty, press `↓`. Cursor `>` appears on first dock row.
17. `↑/↓` cycle within visible rows. `↑` on row 0 returns to input.
18. `Enter` switches `viewMode` to that agent. `Esc` returns to main.
19. Let one agent finish — its row turns green and lingers 30 s, then disappears.

## 11. Rollout

Single PR. No env-flag gate — the previous dock state is a partial spec implementation, not a stable surface anyone relies on.

Touched files:
- `src/tool-system/builtin/agent-registry.ts` — add `finishedFadeAt`; set in `markCompleted/markFailed/cancel`.
- `src/ui/components/AgentDock.tsx` — rewrite per §6.
- `src/ui/components/CommandInput.tsx` — add `onArrowOut` prop, wire `↓` escape on empty input.
- `src/ui/App.tsx` — relocate `<AgentDock>` in `bottomContent`; replace `Ctrl-0..5` block with the dock-focus branch; relax `viewMode` exists predicate; add `dockFocusIdx` state and the focus-clamp effect.
- `tests/ui/agent-dock.test.tsx` — update.
- `tests/ui/agent-dock-keyboard.test.tsx` — new.

No data migration. No backward-compat shim. No env flag.

## 12. Open Questions

None blocking. Settled in the 2026-05-18 brainstorm:

- Dock at the **bottom of the UI**, below StatusLine (user override of parent spec §6.2).
- Row content: `name … elapsed` only (no `latestToolName`).
- No `●` pulse animation (flow-mode safety).
- `Ctrl-0..5` removed for real (parent spec §3 finally applied).
- Esc on dock = return focus to input; Esc on transcript view = return to main.
