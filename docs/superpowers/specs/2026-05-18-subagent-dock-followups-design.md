# Sub-Agent Dock Follow-ups — Design

**Date:** 2026-05-18
**Status:** Draft, awaiting user review
**Builds on:** `2026-05-18-subagent-dock-revisions-design.md`. Records four user-facing fixes found after smoke-testing the dock-revisions branch.

## 1. Problems

1. **No `main` row in the dock.** With sub-agents running, the user has no keyboard target to return to the main conversation other than `Esc` from inside a transcript. They want a dedicated `main` row at the top of the dock so the dock IS the view-switcher.
2. **↑ leaks into input history.** When the user has dock focus and presses `↑` to move up between agents, `CommandInput`'s `useInput` *also* fires, populating the input box from history. The two `useInput` handlers run independently — `return` in App.tsx only ends its own handler.
3. **Dock order is non-deterministic.** Four agents spawned concurrently appear in the dock in an order like `1, 4, 3, 2`. `agent-registry.ts:67` rebuilds the snapshot via `[...this.agents.values()]`, which preserves Map *insertion* order; concurrent `register()` calls don't insert in `startedAt` order if their awaits race.
4. **Rows are visually cramped.** The vertical column has no inter-row spacing, so multiple agents look like one block of text.

There is also a related ask from the user — automatically return to `main` view when the agent currently being inspected finishes — which we treat as part of #1 since it shares the "the dock is the source of truth for view switching" model.

This document covers only these four items. The bigger ask — collapse sub-agent stream events into a one-line summary in the main transcript — is parent spec §5.1 / §6.1 (`AgentCallRow`) and stays out of scope here.

## 2. Goals

1. Dock has a `main` row at the top when there is at least one visible sub-agent. No agents → dock is `null` (no `main` row floating alone).
2. `↑/↓` while dock-focused never bleeds into input-history scrolling.
3. Agent rows appear in stable `startedAt` ascending order (oldest at top, newest at bottom).
4. Each row gets one blank line above it (except the first).
5. While viewing a sub-agent's transcript, if that agent transitions out of `running`, the view returns to main immediately. The dock row still lingers for 30 s so the user can re-enter from the dock.

## 3. Non-Goals

- Collapsing sub-agent activity into a one-line `AgentCallRow` in the main transcript (parent spec §5.1 / §6.1) — separate PR.
- Wrap-around dock navigation (`↓` past the last row → back to main row). Discussed and dropped; clamping at the ends is fine.
- `Ctrl+T` to hide the dock. Still out.
- A separate `main` view source for the dock when there are zero agents — the dock is `null` when nothing's running.
- Configurable row spacing.

## 4. Data Model

No registry shape change. The only invariant added: `getVisibleAgents` returns rows sorted by `startedAt` ascending.

`AgentDock`'s `focusedIndex` semantics widen:
- `0` → the `main` row.
- `1..MAX_VISIBLE` → the corresponding agent row (`agents[focusedIndex - 1]`).
- `null` → input owns focus.

`MAX_VISIBLE` (currently `5`) continues to mean "how many agent rows we render"; the dock therefore renders up to `MAX_VISIBLE + 1` lines (1 `main` + 5 agents) plus the optional `+N more` indicator.

## 5. Components

### 5.1 `getVisibleAgents` — stable sort

In `src/ui/components/AgentDock.tsx`:

```ts
export function getVisibleAgents(
  all: AsyncAgentEntry[],
  now: number,
): AsyncAgentEntry[] {
  return all
    .filter(
      (a) =>
        a.status === "running" ||
        (a.finishedFadeAt !== undefined && now < a.finishedFadeAt),
    )
    .sort((a, b) => a.startedAt - b.startedAt);
}
```

Sort is stable enough — `startedAt` is a `Date.now()` value; ties at the same millisecond will preserve relative order through Array.prototype.sort's spec-mandated stability.

### 5.2 `AgentDock` — render `main` row + spacing

The dock now renders:

```
agents
  ◆ main                                   <- magenta diamond, no time
  ● review render module          4m 23s   <- marginTop=1
  ● fix render bug                3m 12s   <- marginTop=1
  ● review slice anchor           1m 02s
  ... +2 more
```

Logical layout:

```tsx
return (
  <Box flexDirection="column" paddingX={1}>
    <Text dim>agents</Text>
    <MainDockRow
      focused={focusedIndex === 0}
      active={viewMode.kind === "main"}
    />
    {rows.map((a, i) => (
      <AgentDockRow
        key={a.agentId}
        entry={a}
        focused={focusedIndex === i + 1}
        active={viewMode.kind === "agent" && viewMode.agentId === a.agentId}
        now={now}
      />
    ))}
    {overflow > 0 && <Text dim>{`... +${overflow} more`}</Text>}
  </Box>
);
```

`AgentDockRow` gets `marginTop={1}` always (the `main` row sits above without a margin since it's the first row after the "agents" label).

### 5.3 `MainDockRow` — new component

```tsx
function MainDockRow({
  focused,
  active,
}: {
  focused: boolean;
  active: boolean;
}) {
  return (
    <Box flexDirection="row">
      <Text color={focused ? "ansi:cyanBright" : undefined} bold={focused}>
        {focused ? ">" : " "}
      </Text>
      <Text color="ansi:magenta">{" ◆ "}</Text>
      <Text
        color={focused ? "ansi:cyanBright" : active ? "ansi:magenta" : undefined}
        bold={focused}
      >
        main
      </Text>
    </Box>
  );
}
```

No elapsed timestamp on the `main` row. No `marginTop`.

### 5.4 `AgentDockRow` — add `marginTop={1}`

```tsx
return (
  <Box flexDirection="row" marginTop={1}>
    {/* …same as before… */}
  </Box>
);
```

## 6. Keyboard Routing

### 6.1 App-level branch (extends 2026-05-18 §7.2)

The dock-focus branch must be rebased onto the new index space. `focusedIndex === 0` means the `main` row.

```ts
if (dockFocusIdx !== null) {
  const visible = getVisibleAgents(
    asyncAgentRegistry.getSnapshot(),
    Date.now(),
  );
  // Total selectable rows = 1 main row + min(visible.length, MAX_VISIBLE) agents.
  const agentRows = Math.min(MAX_VISIBLE, visible.length);
  const maxIdx = agentRows;  // 0..agentRows inclusive; main row is 0.

  if (key.upArrow) {
    setDockFocusIdx((cur) => {
      if (cur === null) return cur;
      if (cur === 0) return null;       // ↑ on main → input
      return cur - 1;
    });
    return;
  }
  if (key.downArrow) {
    setDockFocusIdx((cur) => {
      if (cur === null) return cur;
      return Math.min(maxIdx, cur + 1);
    });
    return;
  }
  if (key.return) {
    if (dockFocusIdx === 0) {
      setViewMode({ kind: "main" });
    } else {
      const target = visible[dockFocusIdx - 1];
      if (target) setViewMode({ kind: "agent", agentId: target.agentId });
    }
    setDockFocusIdx(null);
    return;
  }
  if (key.escape) {
    setDockFocusIdx(null);
    return;
  }
}
```

### 6.2 InputBox `↓`-out — still lands on the `main` row

`App.tsx`'s `onArrowOut` handler currently sets `dockFocusIdx = 0`. With the new index space, **that is still correct**: index 0 is the `main` row, which is the visible top of the dock. The user can then press `↓` to step into the first agent.

```ts
onArrowOut={(dir) => {
  if (dir !== "down") return;
  const visible = getVisibleAgents(
    asyncAgentRegistry.getSnapshot(),
    Date.now(),
  );
  if (visible.length > 0) setDockFocusIdx(0);
}}
```

(`visible.length > 0` keeps the dock from claiming focus when there are no agents — the dock itself is `null` in that case so a `>` cursor would float in empty space.)

### 6.3 Stop ↑ from leaking into history (problem #2)

Add a `disabled` prop to `CommandInput`:

```ts
interface CommandInputProps {
  // …
  /** When true, skip ALL key handling. Used while another part of the UI
   *  (e.g. the AgentDock) owns the keyboard. */
  disabled?: boolean;
}
```

In `CommandInput.useInput`, gate the entire body:

```ts
useInput((ch, key) => {
  if (disabled) return;
  // …existing logic…
});
```

Wire from `App.tsx`:

```tsx
<CommandInput
  // …
  disabled={dockFocusIdx !== null}
  onArrowOut={…}
/>
```

When `disabled`, the input still renders (the text remains visible), but neither autocomplete navigation nor history navigation fires. Esc/Enter/typing inside the input is also blocked — *intentionally*: while dock-focused, the user is not editing the prompt.

A side effect: typing letters while dock-focused does nothing. The user must `Esc` back to release focus before typing. This matches the spec invariant "dock owns the keyboard while focused" and avoids a more complex per-key filter.

### 6.4 `Ctrl+C` and the other top-level handlers

Unchanged. They live in `App.tsx`'s `useInput`, which still runs when `dockFocusIdx !== null` (we only `return` after handling a key we own). `Ctrl+C` to cancel a running query still works while dock-focused.

## 7. Auto-return to main on finish (problem #5 / user follow-up)

Today, `App.tsx:172-179` falls back to `main` only when the agent disappears from the snapshot — which now happens 30 s after finish thanks to the linger window. The user wants to fall back **the moment the agent leaves `running`** while keeping the dock row visible for 30 s.

Adjust the effect:

```ts
useEffect(() => {
  if (viewMode.kind !== "agent") return;
  const entry = agentsSnapshot.find((a) => a.agentId === viewMode.agentId);
  if (!entry || entry.status !== "running") {
    setViewMode({ kind: "main" });
  }
}, [agentsSnapshot, viewMode]);
```

The dock row's 30 s linger is independent: `getVisibleAgents` keeps the entry visible until `finishedFadeAt`, so the user can re-enter from the dock with `↓ ↓ … Enter` to inspect the final transcript.

## 8. Edge Cases

- **Dock contains only the `main` row.** Cannot happen by §2.1: dock is `null` when `visible.length === 0`.
- **MAX_VISIBLE agents + main = 6 rows displayed, dock-focus at row 5.** `↓` clamps at 5 (the 5th agent). The overflow tail still reads `+N more` and is unreachable by keyboard, matching the existing parent-spec §9 behaviour.
- **User has focus on agent N, agent N's row scrolls into overflow (N becomes 6th).** Cannot happen — sort is by `startedAt`, new agents append to the bottom, existing positions are stable. New agents can only push *later* agents into overflow, not earlier ones.
- **User has focus on agent N, agent N finishes.** Focus stays. Row turns green. Counter freezes. After 30 s the row disappears; if focused, the clamp effect (already in place from the revisions PR) moves focus to the new end of the list. The transcript view (if open) returns to `main` immediately per §7.
- **All agents finish, all fade.** Dock becomes `null`. Focus auto-clears (existing clamp effect).
- **Typing while dock-focused.** Keys are silently swallowed (per §6.3 trade-off). Documented; not a bug.
- **Focus on `main` row, ↑.** Returns focus to input (existing convention from row 0 of the old layout — now applies to the new row 0, which *is* the `main` row).
- **Focus on `main` row, Enter, but you were already in `viewMode === 'main'`.** No-op effective behaviour — `setViewMode({kind:'main'})` writes the same value, no transcript reload. Fine.
- **Two agents share the same `startedAt`.** Stable Array.sort preserves their pre-sort order, which is registry insertion order — predictable enough.

## 9. Tests

`tests/ui/agent-dock.test.tsx` — extend (do NOT replace):

1. `dock with one running agent → renders main row above agent row` — `plainText(h)` contains `◆ main` AND the agent description; `main` appears before the agent's description in the output string.
2. `dock with no agents → renders nothing (no orphan main row)` — already covered by existing "no agents" test; add an explicit `not.toContain("main")` assertion.
3. `agents render sorted by startedAt ascending` — register three agents with `startedAt = 30, 10, 20`; expect output order `10, 20, 30` (matched by checking substring positions).
4. `MainDockRow renders without cursor when not focused` — `viewMode={kind:'main'}`, `focusedIndex=null`; assert plainText contains `main` but NOT `> ◆ main`. (Color is stripped by `plainText`; we only verify the cursor glyph.)
5. `focused main row shows '>' cursor` — `focusedIndex=0`, assert regex `/>\s*◆\s*main/`.
6. `agent row has top margin` — render one agent + main, assert plainText has the agent description on a separate line from `◆ main`. (We assert via finding a blank-content line between the two rendered descriptions in `dumpFrames(h)` after stripping ANSI.)

`tests/ui/agent-dock-keyboard.test.tsx` — extend the existing `DockHost` fixture's keyboard logic to mirror §6.1, then add:

7. `↓ from input with 2 agents → dockFocusIdx 0 (main row), not 1` — confirms the entry point is main.
8. `dockFocusIdx 0 + ↓ → 1` — into first agent.
9. `dockFocusIdx 0 + Enter → setViewMode main, focus released` — Enter on main commits no-op `main` switch.
10. `dockFocusIdx 0 + ↑ → null` — exit to input.
11. `dockFocusIdx N (last agent) + ↓ → still N` — clamp at last agent.
12. `viewMode=agent + agent.status flips to completed → viewMode auto-reverts to main` — this requires testing the App.tsx effect at §7. Do it in a new `tests/ui/agent-view-auto-return.test.tsx` that mounts a minimal host with the same effect inline (matching the existing `DockHost` pattern).
13. `disabled CommandInput swallows ↑/↓` — render `<CommandInput disabled value="" onChange ... />` then send `↑`; assert `onChange` was never called.

`tests/tool-system/` or `tests/ui/agent-view-switching.test.ts` — extend:

14. `getVisibleAgents returns rows sorted by startedAt ascending` — pure-function test against the helper.

## 10. Touched files

- `src/ui/components/AgentDock.tsx` — add `MainDockRow`, add `marginTop={1}` to `AgentDockRow`, sort in `getVisibleAgents`. Re-export nothing new.
- `src/ui/components/CommandInput.tsx` — add `disabled` prop, gate `useInput` body.
- `src/ui/App.tsx` — extend dock-focus branch to handle the `main` row at idx 0, change auto-fallback predicate to "not running", thread `disabled={dockFocusIdx !== null}` to `<CommandInput>`. The `<AgentDock>` JSX itself stays put — it already lives at the bottom.
- `tests/ui/agent-dock.test.tsx` — extend per §9.
- `tests/ui/agent-dock-keyboard.test.tsx` — extend `DockHost` for new index space + new cases.
- `tests/ui/agent-view-auto-return.test.tsx` — new, covers §7.

## 11. Rollout

Single PR, no flag. The dock revisions branch is the only consumer of this surface.

## 12. Open Questions

None. Settled in the 2026-05-18 follow-up brainstorm:
- `main` row uses `◆` (magenta) to differentiate from agent `●`.
- Sort by `startedAt` ascending.
- One blank-line gap per agent row, none above `main`.
- Auto-return to `main` fires the moment the focused agent leaves `running` (not on fade-out).
- Disabled-CommandInput swallows all keys, not just arrows — user accepts the typing-into-void trade-off.
