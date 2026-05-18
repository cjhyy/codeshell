# Sub-Agent Dock Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the five fixes from `docs/superpowers/specs/2026-05-18-subagent-dock-followups-design.md` — stable agent sort, `main` row in the dock, inter-row spacing, `↑`-leak fix via `CommandInput.disabled`, and auto-return-to-main when the focused sub-agent leaves `running`.

**Architecture:** Each fix is a small, independent edit to an existing file. The dock's index space widens by one (idx 0 = `main` row, 1..N = agents); the keyboard branch in `App.tsx` is rebased onto the new space. A new `disabled` prop on `CommandInput` gates its entire `useInput` body when the dock owns focus, fixing the dual-listener leak. The auto-return effect's predicate changes from "agent disappeared" to "agent not running".

**Tech Stack:** Bun + React + custom Ink-style renderer. Tests use `bun:test` with the `mount`/`plainText`/`flush` harness in `tests/render-fixtures.ts`.

---

## File Map

- Modify: `src/ui/components/AgentDock.tsx` — sort in `getVisibleAgents`, add `MainDockRow`, `marginTop={1}` on `AgentDockRow`
- Modify: `src/ui/components/CommandInput.tsx` — add `disabled` prop, gate `useInput` body
- Modify: `src/ui/App.tsx` — extend dock-focus keyboard branch for `main`-row idx 0, change auto-fallback predicate, thread `disabled={dockFocusIdx !== null}` to `<CommandInput>`
- Modify: `tests/ui/agent-dock.test.tsx` — extend with sort + main-row + spacing cases
- Modify: `tests/ui/agent-dock-keyboard.test.tsx` — update `DockHost` for new index space, add main-row cases + disabled-CommandInput test
- Modify: `tests/ui/agent-view-switching.test.ts` — add `getVisibleAgents` sort test
- Create: `tests/ui/agent-view-auto-return.test.tsx` — covers §7 auto-return

---

## Task 1: Sort visible agents by `startedAt` ascending

**Files:**
- Modify: `src/ui/components/AgentDock.tsx`
- Test: `tests/ui/agent-view-switching.test.ts`

- [ ] **Step 1: Append failing test**

Append to `tests/ui/agent-view-switching.test.ts`:

```ts
import { getVisibleAgents } from "../../src/ui/components/AgentDock.js";

test("getVisibleAgents returns rows sorted by startedAt ascending", () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "third",
    description: "third spawn",
    status: "running",
    startedAt: 30,
    abort: () => {},
  });
  asyncAgentRegistry.register({
    agentId: "first",
    description: "first spawn",
    status: "running",
    startedAt: 10,
    abort: () => {},
  });
  asyncAgentRegistry.register({
    agentId: "second",
    description: "second spawn",
    status: "running",
    startedAt: 20,
    abort: () => {},
  });
  const visible = getVisibleAgents(asyncAgentRegistry.getSnapshot(), 1_000_000);
  expect(visible.map((a) => a.agentId)).toEqual(["first", "second", "third"]);
});
```

NOTE: the existing `import { getVisibleAgents } from "../../src/ui/components/AgentDock.js";` may not be at the top of `tests/ui/agent-view-switching.test.ts`. If the file does not already import it, add it. The file currently only imports `asyncAgentRegistry`. Read the top of the file first.

- [ ] **Step 2: Run test, expect failure**

```
bun test tests/ui/agent-view-switching.test.ts
```
Expected: the new test fails — `getVisibleAgents` returns insertion order `["third", "first", "second"]`.

- [ ] **Step 3: Add the sort**

In `src/ui/components/AgentDock.tsx`, find the `getVisibleAgents` function (currently around line 119):

```ts
export function getVisibleAgents(
  all: AsyncAgentEntry[],
  now: number,
): AsyncAgentEntry[] {
  return all.filter(
    (a) =>
      a.status === "running" ||
      (a.finishedFadeAt !== undefined && now < a.finishedFadeAt),
  );
}
```

Replace with:

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

- [ ] **Step 4: Run test, expect pass**

```
bun test tests/ui/agent-view-switching.test.ts
```
Expected: all tests pass (was 8, now 9 with the new sort test).

- [ ] **Step 5: Run the wider UI suite to catch regressions**

```
bun test tests/ui/
```
Expected: all green. The `getVisibleAgents` filter unit test in `tests/ui/agent-dock.test.tsx` constructs an array where `["running", "linger", "gone"]` is also the `startedAt` order (`0, 0, 0` — they tie). Stable sort preserves that order, so the test still passes.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/AgentDock.tsx tests/ui/agent-view-switching.test.ts
git commit -m "fix(ui): sort dock agents by startedAt so concurrent spawns are stable"
```

---

## Task 2: Add `marginTop={1}` between agent rows

**Files:**
- Modify: `src/ui/components/AgentDock.tsx`
- Test: `tests/ui/agent-dock.test.tsx`

- [ ] **Step 1: Append failing test**

Append to `tests/ui/agent-dock.test.tsx`:

```tsx
test("agent rows have visual separation (blank line between them)", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "first agent",
    status: "running",
    startedAt: 10,
    abort: () => {},
  });
  asyncAgentRegistry.register({
    agentId: "a2",
    description: "second agent",
    status: "running",
    startedAt: 20,
    abort: () => {},
  });
  const h = mount(
    React.createElement(AgentDock, { viewMode: VIEW_MAIN, focusedIndex: null }),
    { columns: 80, rows: 30 },
  );
  await flush();
  // Use dumpFrames (raw output) + ANSI strip, then split into display lines.
  const raw = h.frames.join("");
  const stripped = raw
    .replace(/\x1b\[(\d+)C/g, (_m, n) => " ".repeat(Number(n)))
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b/g, "");
  const lines = stripped.split(/\r?\n/);
  const i1 = lines.findIndex((l) => l.includes("first agent"));
  const i2 = lines.findIndex((l) => l.includes("second agent"));
  expect(i1).toBeGreaterThanOrEqual(0);
  expect(i2).toBeGreaterThan(i1);
  // At least one blank-ish line between the two agent rows (marginTop=1).
  // "blank-ish" = no agent description text.
  let foundGap = false;
  for (let j = i1 + 1; j < i2; j++) {
    const trimmed = lines[j].trim();
    if (trimmed === "" || (!trimmed.includes("first agent") && !trimmed.includes("second agent") && !trimmed.includes("●"))) {
      foundGap = true;
      break;
    }
  }
  expect(foundGap).toBe(true);
  h.unmount();
});
```

- [ ] **Step 2: Run test, expect failure**

```
bun test tests/ui/agent-dock.test.tsx
```
Expected: the new test fails — without margin, the two agent descriptions are on consecutive lines.

- [ ] **Step 3: Add `marginTop={1}` to `AgentDockRow`**

In `src/ui/components/AgentDock.tsx`, find `AgentDockRow` (currently around line 71). Change its return statement from:

```tsx
return (
  <Box flexDirection="row">
    <Text color={focused ? "ansi:cyanBright" : undefined} bold={focused}>
      {cursor}
    </Text>
    ...
  </Box>
);
```

to:

```tsx
return (
  <Box flexDirection="row" marginTop={1}>
    <Text color={focused ? "ansi:cyanBright" : undefined} bold={focused}>
      {cursor}
    </Text>
    ...
  </Box>
);
```

This puts a blank line above EVERY agent row. The first row's blank line sits between `<Text dim>agents</Text>` and the row, which is fine. (When the `main` row lands in Task 3, that row sits between `agents` label and the first agent row — still acceptable.)

- [ ] **Step 4: Run test, expect pass**

```
bun test tests/ui/agent-dock.test.tsx
```
Expected: green.

- [ ] **Step 5: Wider UI suite**

```
bun test tests/ui/
```
Expected: green. The existing "one running agent" tests don't pin layout heights, only substring matches.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/AgentDock.tsx tests/ui/agent-dock.test.tsx
git commit -m "feat(ui): add marginTop=1 between dock agent rows"
```

---

## Task 3: Add `MainDockRow` and render it at the top of the dock

**Files:**
- Modify: `src/ui/components/AgentDock.tsx`
- Test: `tests/ui/agent-dock.test.tsx`

This task introduces the `main` row but does NOT yet change the focus index space — the keyboard branch in App.tsx still treats `focusedIndex` as 0-based over agents. We pass `focusedIndex` through unchanged for now; Task 5 rebases keyboard logic onto the new space. To prevent the dock from rendering the wrong row as `>` between Task 3 and Task 5, we keep the existing semantics: `focusedIndex === i` highlights agent row `i`. The new `main` row receives `focused=false` and `active = viewMode.kind === "main"` for the duration of this interim.

- [ ] **Step 1: Write failing tests**

Append to `tests/ui/agent-dock.test.tsx`:

```tsx
test("dock with running agent renders main row above agent row", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "review module",
    status: "running",
    startedAt: 10,
    abort: () => {},
  });
  const h = mount(
    React.createElement(AgentDock, { viewMode: VIEW_MAIN, focusedIndex: null }),
    { columns: 80 },
  );
  await flush();
  const out = plainText(h);
  expect(out).toContain("main");
  expect(out).toContain("◆");
  // main appears before the agent description in the rendered output.
  const mainIdx = out.indexOf("main");
  const agentIdx = out.indexOf("review module");
  expect(mainIdx).toBeGreaterThanOrEqual(0);
  expect(agentIdx).toBeGreaterThan(mainIdx);
  h.unmount();
});

test("dock with no agents renders nothing (no orphan main row)", async () => {
  reset();
  const h = mount(
    React.createElement(AgentDock, { viewMode: VIEW_MAIN, focusedIndex: null }),
  );
  await flush();
  const out = plainText(h);
  expect(out).not.toContain("main");
  expect(out).not.toContain("◆");
  h.unmount();
});
```

- [ ] **Step 2: Run, expect failure**

```
bun test tests/ui/agent-dock.test.tsx
```
Expected: the two new tests fail — no `main` row exists.

- [ ] **Step 3: Add the `MainDockRow` component**

In `src/ui/components/AgentDock.tsx`, add a new component definition AFTER the `AgentDockRow` function (the existing component you modified in Task 2). Add this code block:

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

This row has no `marginTop` (it sits directly under the `agents` label) and no elapsed time.

- [ ] **Step 4: Render `MainDockRow` inside `AgentDock`**

In the `AgentDock` component's return, find the existing structure:

```tsx
return (
  <Box flexDirection="column" paddingX={1}>
    <Text dim>agents</Text>
    {rows.map((a, i) => (
      <AgentDockRow ... />
    ))}
    {overflow > 0 && <Text dim>{`... +${overflow} more`}</Text>}
  </Box>
);
```

Insert `<MainDockRow>` between the `<Text dim>agents</Text>` label and the agent rows. Keep the agent-row mapping unchanged for now (the keyboard rebase happens in Task 5):

```tsx
return (
  <Box flexDirection="column" paddingX={1}>
    <Text dim>agents</Text>
    <MainDockRow
      focused={false}
      active={viewMode.kind === "main"}
    />
    {rows.map((a, i) => (
      <AgentDockRow
        key={a.agentId}
        entry={a}
        focused={focusedIndex === i}
        active={viewMode.kind === "agent" && viewMode.agentId === a.agentId}
        now={now}
      />
    ))}
    {overflow > 0 && <Text dim>{`... +${overflow} more`}</Text>}
  </Box>
);
```

`focused={false}` on the main row is the interim — Task 5 will plumb the real index.

- [ ] **Step 5: Run tests, expect pass**

```
bun test tests/ui/agent-dock.test.tsx
```
Expected: the two new tests pass. The "no agents → renders nothing" test still passes because the early `if (visible.length === 0) return null;` skips the whole render path.

Watch out: the existing `focused {idx} shows '>' cursor on first row` test from the prior PR asserts `>\s*●\s*first agent` when `focusedIndex=0` and renders TWO agents. After this task the dock structure is `[main row] [agent 0] [agent 1]`, and `focusedIndex=0` still highlights agent row 0 (still "first agent"), so that test continues to pass. The `main` row above is rendered with `focused=false` and won't carry a `>` cursor.

- [ ] **Step 6: Run wider UI suite**

```
bun test tests/ui/
```
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/ui/components/AgentDock.tsx tests/ui/agent-dock.test.tsx
git commit -m "feat(ui): add main row at top of AgentDock (◆ magenta)"
```

---

## Task 4: Add `disabled` prop to `CommandInput`

**Files:**
- Modify: `src/ui/components/CommandInput.tsx`
- Test: `tests/ui/agent-dock-keyboard.test.tsx`

- [ ] **Step 1: Add a failing test**

Append to `tests/ui/agent-dock-keyboard.test.tsx`:

```tsx
test("disabled CommandInput swallows all keys", async () => {
  let changed = 0;
  let submitted = 0;
  const h = mount(
    React.createElement(CommandInput, {
      value: "",
      onChange: () => {
        changed += 1;
      },
      onSubmit: () => {
        submitted += 1;
      },
      commands: [],
      disabled: true,
    }),
    { columns: 80 },
  );
  await flush();
  // Send a few keys: up arrow, down arrow, a letter, Enter.
  h.stdin.write(UP);
  await flush();
  h.stdin.write(DOWN);
  await flush();
  h.stdin.write("x");
  await flush();
  h.stdin.write(ENTER);
  await flush();
  expect(changed).toBe(0);
  expect(submitted).toBe(0);
  h.unmount();
});
```

NOTE: the test file already imports `mount`, `flush`, and the `DOWN/UP/ENTER` byte constants. It does NOT yet import `CommandInput`. Add this near the top of the file (alongside the existing imports):

```tsx
import { CommandInput } from "../../src/ui/components/CommandInput.js";
```

- [ ] **Step 2: Run, expect failure**

```
bun test tests/ui/agent-dock-keyboard.test.tsx
```
Expected: the new test fails because `disabled` is not a known prop and `↑/↓` still fire `historyRef` mutations and Enter still submits.

Actually `disabled` isn't on the props interface yet, so the failure will be a TypeScript error. Either silence it temporarily by casting to `any` in the test (`as any`) OR accept the TS error and let Step 3 land the prop — the runtime behaviour is what we test.

Recommend: cast to `any` so the test compiles and runs. Replace the `mount(React.createElement(CommandInput, {...}))` argument with `as any`:

```tsx
const h = mount(
  React.createElement(CommandInput, ({
    value: "",
    onChange: () => { changed += 1; },
    onSubmit: () => { submitted += 1; },
    commands: [],
    disabled: true,
  } as any)),
  { columns: 80 },
);
```

After Step 3 you can drop the cast.

- [ ] **Step 3: Add `disabled` prop and gate `useInput`**

Open `src/ui/components/CommandInput.tsx`. Extend the props interface (currently has `value`, `onChange`, `onSubmit`, `commands`, `placeholder`, `onArrowOut`):

```ts
interface CommandInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  commands: CommandDef[];
  placeholder?: string;
  /** Fired when ↓ is pressed and input is empty and history is exhausted.
   *  Used by App.tsx to move keyboard focus into the AgentDock.  */
  onArrowOut?: (direction: "down") => void;
  /** When true, skip ALL key handling. Used while another part of the UI
   *  (e.g. the AgentDock) owns the keyboard. The text input still renders;
   *  only the useInput body short-circuits. */
  disabled?: boolean;
}
```

Update the destructure:

```ts
export function CommandInput({
  value,
  onChange,
  onSubmit,
  commands,
  placeholder,
  onArrowOut,
  disabled,
}: CommandInputProps) {
```

Add a guard at the top of the `useInput` callback:

```ts
useInput((ch, key) => {
  if (disabled) return;
  // ...existing body unchanged...
});
```

The `<TextInput>` element underneath also fires `onChange` when characters arrive via the input pipeline. Check `src/ui/components/TextInput.tsx` to see how it processes input — it likely has its OWN `useInput` or wraps a primitive that handles keystrokes. If `TextInput` does have its own input handler, we need to pass `disabled` down to it too, or wrap it.

Read `src/ui/components/TextInput.tsx` first. If it accepts a `focus` or `disabled` prop, set that. Otherwise, the simplest fix is to skip rendering `<TextInput>`'s input pipe entirely by adding a conditional:

```tsx
{disabled ? (
  <Text>{value}</Text>
) : (
  <TextInput
    value={value}
    onChange={handleChange}
    onSubmit={handleSubmit}
    placeholder={placeholder ?? "Ask anything… (/ for commands, ↑ for history)"}
  />
)}
```

This swaps the live editor for a static text display when disabled. The value still renders so the user sees what they typed before the dock claimed focus.

If `TextInput` already supports `focus` / `disabled`, use that prop instead and don't swap components — it's nicer to keep the cursor visible. Prefer the prop-on-TextInput route if available; fall back to the swap above if not.

- [ ] **Step 4: Run test, expect pass**

```
bun test tests/ui/agent-dock-keyboard.test.tsx
```
Expected: the new test passes — `changed` and `submitted` both stay at 0.

- [ ] **Step 5: Type-check**

```
bun run typecheck
```
Expected: no new errors. The pre-existing `agent.ts(127,9) TS2783` remains.

- [ ] **Step 6: Run wider suite**

```
bun test tests/ui/
```
Expected: green (was 37 from the prior PR, now 38 with the new test).

- [ ] **Step 7: Commit**

```bash
git add src/ui/components/CommandInput.tsx tests/ui/agent-dock-keyboard.test.tsx
git commit -m "feat(ui): CommandInput.disabled prop swallows all keys

Used by App.tsx to stop ↑/↓ from leaking into input history while
the AgentDock owns focus."
```

---

## Task 5: Rebase dock keyboard onto `main`-row index space

**Files:**
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/components/AgentDock.tsx` (the `MainDockRow` `focused` prop wiring)
- Test: `tests/ui/agent-dock-keyboard.test.tsx`

This is the largest task. After this lands, `dockFocusIdx === 0` means the `main` row is focused, and `1..MAX_VISIBLE` means agent rows `0..MAX_VISIBLE-1`.

- [ ] **Step 1: Update the `DockHost` fixture to mirror the new branch**

Open `tests/ui/agent-dock-keyboard.test.tsx`. Locate the `DockHost` fixture's `useInput` body. It currently looks like (excerpt):

```ts
if (dockFocusIdx !== null) {
  const visible = getVisibleAgents(...);
  if (key.upArrow) {
    if (dockFocusIdx === 0) setDockFocusIdx(null);
    else setDockFocusIdx(dockFocusIdx - 1);
    return;
  }
  if (key.downArrow) {
    const maxIdx = Math.min(MAX_VISIBLE, visible.length) - 1;
    setDockFocusIdx(Math.min(maxIdx, dockFocusIdx + 1));
    return;
  }
  if (key.return) {
    const target = visible[dockFocusIdx];
    if (target) setViewMode({ kind: "agent", agentId: target.agentId });
    setDockFocusIdx(null);
    return;
  }
  if (key.escape) {
    setDockFocusIdx(null);
    return;
  }
}
```

Replace the body with the new index space:

```ts
if (dockFocusIdx !== null) {
  const visible = getVisibleAgents(asyncAgentRegistry.getSnapshot(), Date.now());
  // 0 = main row, 1..agentRows = agents.
  const agentRows = Math.min(MAX_VISIBLE, visible.length);
  const maxIdx = agentRows;

  if (key.upArrow) {
    if (dockFocusIdx === 0) setDockFocusIdx(null);
    else setDockFocusIdx(dockFocusIdx - 1);
    return;
  }
  if (key.downArrow) {
    setDockFocusIdx(Math.min(maxIdx, dockFocusIdx + 1));
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

ALSO update the existing tests in the file that assume `dockFocusIdx=0` means "first agent". After rebasing:
- `↓ on empty input with 2 agents → dockFocusIdx becomes 0` — still passes (0 is now main row).
- `dockFocusIdx 0 + ↑ → null` — still passes (main row to input).
- `dockFocusIdx 0 + ↓ → 1, clamped` — semantics shift: 0→1 now means "main → first agent", and `DOWN×3 with 2 agents` should land at 2 (= second agent), not 1. Update the test's expected value from `1` to `2`.
- `dockFocusIdx + Enter on first row` — was meant to assert agent activation. With new space, `dockFocusIdx=0 + Enter` activates `main`. Rewrite the test: navigate to `dockFocusIdx=1` via DOWN then ENTER, expect `viewMode=agent:the-target`.
- `dockFocusIdx + Esc on first row` — still releases focus, no cancel; still passes.
- `viewMode=agent + Esc → returns to main, no cancel` — unchanged.
- `viewMode=main + Esc with no dock focus → cancel branch fires` — unchanged.
- `focus does not advance past MAX_VISIBLE-1 when there are more agents` — with the new space, clamp is at `MAX_VISIBLE` (not `MAX_VISIBLE - 1`). 7 agents, 8 DOWN presses: 0,1,2,3,4,5 then clamped at 5. Update the assertion to `expect(...dockFocusIdx).toBe(5)`.

Apply all those test edits in the same file.

- [ ] **Step 2: Add three new tests for main-row behaviour**

Append to `tests/ui/agent-dock-keyboard.test.tsx`:

```tsx
test("↓ from input with 2 agents → dockFocusIdx 0 (main row)", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1", description: "first", status: "running",
    startedAt: 10, abort: () => {},
  });
  asyncAgentRegistry.register({
    agentId: "a2", description: "second", status: "running",
    startedAt: 20, abort: () => {},
  });
  const ref = React.createRef<DockHostHandle>();
  const h = mount(React.createElement(DockHost, { ref }), { columns: 80 });
  await flush();
  h.stdin.write(DOWN);
  await flush();
  expect(ref.current?.getState().dockFocusIdx).toBe(0);
  h.unmount();
});

test("dockFocusIdx 0 + Enter → setViewMode main, focus released", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1", description: "first", status: "running",
    startedAt: 10, abort: () => {},
  });
  const ref = React.createRef<DockHostHandle>();
  const h = mount(
    React.createElement(DockHost, {
      ref,
      initialViewMode: { kind: "agent", agentId: "a1" },
    }),
    { columns: 80 },
  );
  await flush();
  h.stdin.write(DOWN);    // null → 0 (main row)
  await flush();
  h.stdin.write(ENTER);
  await flush();
  expect(ref.current?.getState().dockFocusIdx).toBe(null);
  expect(ref.current?.getState().viewMode.kind).toBe("main");
  h.unmount();
});

test("dockFocusIdx N (last agent) + ↓ → still N", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1", description: "first", status: "running",
    startedAt: 10, abort: () => {},
  });
  asyncAgentRegistry.register({
    agentId: "a2", description: "second", status: "running",
    startedAt: 20, abort: () => {},
  });
  const ref = React.createRef<DockHostHandle>();
  const h = mount(React.createElement(DockHost, { ref }), { columns: 80 });
  await flush();
  // null → 0 (main) → 1 (a1) → 2 (a2) → 2 (clamped)
  for (let i = 0; i < 4; i++) {
    h.stdin.write(DOWN);
    await flush();
  }
  expect(ref.current?.getState().dockFocusIdx).toBe(2);
  h.unmount();
});
```

Use the existing `DockHostHandle` type if the fixture already exposes one via `useImperativeHandle`. If the fixture's handle shape is different (the previous PR's implementer may have named the getter differently), adapt the `ref.current?.getState()` access to match the existing pattern in the file. Read the fixture's `useImperativeHandle` call before editing.

- [ ] **Step 3: Run tests, expect failure on the new ones**

```
bun test tests/ui/agent-dock-keyboard.test.tsx
```
Expected: the new tests run against the updated `DockHost` fixture and pass. The pre-existing tests, after the edits in Step 1, also pass. **All ~12 tests green.**

(If they DO NOT pass at this point, the fixture's index-space rebase isn't right — fix the fixture before proceeding.)

- [ ] **Step 4: Apply the same rebase to `App.tsx`**

Open `src/ui/App.tsx`. Locate the dock-focus branch in `useInput` (around line 822-857). Replace with:

```ts
if (dockFocusIdx !== null) {
  const visible = getVisibleAgents(
    asyncAgentRegistry.getSnapshot(),
    Date.now(),
  );
  // 0 = main row; 1..agentRows = agents.
  const agentRows = Math.min(MAX_VISIBLE, visible.length);
  const maxIdx = agentRows;

  if (key.upArrow) {
    setDockFocusIdx((cur) => {
      if (cur === null) return cur;
      if (cur === 0) return null;
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

Also update the clamp effect (around line 184) — the max index is now `Math.min(MAX_VISIBLE, len)` (no longer `-1` because index 0 is the main row, not the first agent):

```ts
useEffect(() => {
  if (dockFocusIdx === null) return;
  const len = getVisibleAgents(agentsSnapshot, Date.now()).length;
  if (len === 0) {
    setDockFocusIdx(null);
    return;
  }
  const maxIdx = Math.min(MAX_VISIBLE, len);
  if (dockFocusIdx > maxIdx) setDockFocusIdx(maxIdx);
}, [agentsSnapshot, dockFocusIdx]);
```

(`maxIdx` is INCLUSIVE here — `0` is always valid as long as `len > 0` because the main row exists; the last agent index is `len` capped at `MAX_VISIBLE`.)

- [ ] **Step 5: Plumb the real `focused` prop to `MainDockRow`**

Back in `src/ui/components/AgentDock.tsx`, update the `AgentDock` component's return so `MainDockRow` and `AgentDockRow` get the correct `focused` value under the new index space:

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

`focusedIndex === i + 1` shifts each agent's check by one to account for `main` at index 0.

- [ ] **Step 6: Update the existing dock visual test for the new focus space**

In `tests/ui/agent-dock.test.tsx` find the test `focusedIndex 0 shows '>' cursor on first row`. Under the new space, `focusedIndex=0` is the main row. Update the test to assert the cursor is on the main row, not on an agent row. Replace it with:

```tsx
test("focusedIndex 0 shows '>' cursor on main row", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "first agent",
    status: "running",
    startedAt: 10,
    abort: () => {},
  });
  asyncAgentRegistry.register({
    agentId: "a2",
    description: "second agent",
    status: "running",
    startedAt: 20,
    abort: () => {},
  });
  const h = mount(
    React.createElement(AgentDock, { viewMode: VIEW_MAIN, focusedIndex: 0 }),
    { columns: 80 },
  );
  await flush();
  const out = plainText(h);
  expect(out).toMatch(/>\s*◆\s*main/);
  // No '>' cursor on either agent row.
  expect(out).not.toMatch(/>\s*●\s*first agent/);
  expect(out).not.toMatch(/>\s*●\s*second agent/);
  h.unmount();
});
```

Then add a new test below it that asserts the agent-row cursor under the new space:

```tsx
test("focusedIndex 1 shows '>' cursor on first agent row", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "first agent",
    status: "running",
    startedAt: 10,
    abort: () => {},
  });
  asyncAgentRegistry.register({
    agentId: "a2",
    description: "second agent",
    status: "running",
    startedAt: 20,
    abort: () => {},
  });
  const h = mount(
    React.createElement(AgentDock, { viewMode: VIEW_MAIN, focusedIndex: 1 }),
    { columns: 80 },
  );
  await flush();
  const out = plainText(h);
  expect(out).toMatch(/>\s*●\s*first agent/);
  expect(out).not.toMatch(/>\s*◆\s*main/);
  expect(out).not.toMatch(/>\s*●\s*second agent/);
  h.unmount();
});
```

- [ ] **Step 7: Run tests**

```
bun test tests/ui/
```
Expected: all green. App.tsx's branch and the test fixture mirror each other exactly.

- [ ] **Step 8: Type-check**

```
bun run typecheck
```
Expected: only the pre-existing unrelated `agent.ts(127,9) TS2783`.

- [ ] **Step 9: Commit**

```bash
git add src/ui/App.tsx src/ui/components/AgentDock.tsx tests/ui/agent-dock.test.tsx tests/ui/agent-dock-keyboard.test.tsx
git commit -m "feat(ui): rebase dock keyboard onto main-row index space

- focusedIndex 0 now means main row; 1..N means agent rows
- Enter on main → setViewMode({kind:'main'})
- clamp effect uses maxIdx = Math.min(MAX_VISIBLE, len) (inclusive)
- MainDockRow / AgentDockRow get correct focused prop wiring"
```

---

## Task 6: Wire `disabled` from App.tsx to CommandInput

**Files:**
- Modify: `src/ui/App.tsx`

- [ ] **Step 1: Set the prop**

Open `src/ui/App.tsx`. Find the `<CommandInput>` JSX (around line 1601 from the prior PR — it has `onArrowOut` wired). Add `disabled={dockFocusIdx !== null}`:

```tsx
<CommandInput
  value={input}
  onChange={setInput}
  onSubmit={handleSubmit}
  commands={commandDefs}
  placeholder={isRunning ? "Interrupt… (Ctrl+C to cancel)" : undefined}
  disabled={dockFocusIdx !== null}
  onArrowOut={(dir) => {
    if (dir !== "down") return;
    const visible = getVisibleAgents(
      asyncAgentRegistry.getSnapshot(),
      Date.now(),
    );
    if (visible.length > 0) setDockFocusIdx(0);
  }}
/>
```

- [ ] **Step 2: Type-check**

```
bun run typecheck
```
Expected: pre-existing error only.

- [ ] **Step 3: Run tests**

```
bun test tests/ui/
```
Expected: green. None of the unit tests directly exercise the App-level wiring; this is validated by the existing `CommandInput.disabled` test from Task 4 and by the manual smoke at the end of the plan.

- [ ] **Step 4: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat(ui): pass disabled={dockFocusIdx !== null} to CommandInput"
```

---

## Task 7: Auto-return to main on agent finish

**Files:**
- Modify: `src/ui/App.tsx`
- Create: `tests/ui/agent-view-auto-return.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/ui/agent-view-auto-return.test.tsx`:

```tsx
import { test, expect } from "bun:test";
import React, { useState, useEffect, useSyncExternalStore, useImperativeHandle, forwardRef } from "react";
import { Box } from "../../src/render/index.js";
import { mount, flush } from "../render-fixtures";
import { asyncAgentRegistry } from "../../src/tool-system/builtin/agent-registry.js";

type ViewMode = { kind: "main" } | { kind: "agent"; agentId: string };

interface HostHandle {
  viewMode: ViewMode;
}

/**
 * Minimal fixture re-implementing the auto-return effect from App.tsx.
 * Keeps the test free of the App's many unrelated dependencies.
 */
const Host = forwardRef<HostHandle, { initialViewMode: ViewMode }>(
  function Host({ initialViewMode }, ref) {
    const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);
    const agentsSnapshot = useSyncExternalStore(
      asyncAgentRegistry.subscribe,
      asyncAgentRegistry.getSnapshot,
    );
    useEffect(() => {
      if (viewMode.kind !== "agent") return;
      const entry = agentsSnapshot.find((a) => a.agentId === viewMode.agentId);
      if (!entry || entry.status !== "running") {
        setViewMode({ kind: "main" });
      }
    }, [agentsSnapshot, viewMode]);
    useImperativeHandle(ref, () => ({ viewMode }), [viewMode]);
    return <Box />;
  },
);

function reset() {
  asyncAgentRegistry.reset();
}

test("viewMode falls back to main when focused agent leaves running", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "watch-me",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const ref = React.createRef<HostHandle>();
  const h = mount(
    React.createElement(Host, {
      ref,
      initialViewMode: { kind: "agent", agentId: "watch-me" },
    }),
  );
  await flush();
  // Still running → still in agent view.
  expect(ref.current?.viewMode.kind).toBe("agent");

  asyncAgentRegistry.markCompleted("watch-me", "ok");
  await flush();

  // The dock row lingers 30s, but viewMode flips immediately.
  expect(ref.current?.viewMode.kind).toBe("main");
  // And the entry is STILL in the snapshot (fade window).
  const snap = asyncAgentRegistry.getSnapshot();
  expect(snap.find((a) => a.agentId === "watch-me")).toBeDefined();
  h.unmount();
});

test("viewMode falls back to main on markFailed", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "boom",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const ref = React.createRef<HostHandle>();
  const h = mount(
    React.createElement(Host, {
      ref,
      initialViewMode: { kind: "agent", agentId: "boom" },
    }),
  );
  await flush();
  asyncAgentRegistry.markFailed("boom", "nope");
  await flush();
  expect(ref.current?.viewMode.kind).toBe("main");
  h.unmount();
});

test("viewMode stays in agent while it is still running", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "alive",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const ref = React.createRef<HostHandle>();
  const h = mount(
    React.createElement(Host, {
      ref,
      initialViewMode: { kind: "agent", agentId: "alive" },
    }),
  );
  await flush();
  // Add a second agent, modify transcript — fade window unchanged.
  asyncAgentRegistry.appendToTranscript("alive", {
    id: "t1",
    type: "tool_call",
  } as any);
  await flush();
  expect(ref.current?.viewMode.kind).toBe("agent");
  if (ref.current?.viewMode.kind === "agent") {
    expect(ref.current.viewMode.agentId).toBe("alive");
  }
  h.unmount();
});
```

- [ ] **Step 2: Run, expect pass on cases 1 + 2 currently FAIL**

```
bun test tests/ui/agent-view-auto-return.test.tsx
```
Expected: cases 1 and 2 fail with `viewMode.kind` still `"agent"` after `markCompleted`/`markFailed` — because the current `App.tsx` predicate falls back only when the agent is not in the snapshot at all, but the fade-window keeps the entry there. Case 3 should pass.

Wait — actually, the Host fixture in this test already implements the NEW predicate (`status !== "running"`). So all three tests will pass immediately if the fixture is correct. That's by design: the fixture is the spec.

What the test really validates is "after we update App.tsx in Step 3, the effect matches THIS fixture." If the test passes on first run, that means the fixture matches what we want. Step 3 then changes App.tsx to the SAME shape.

If you prefer a TDD-feeling order: first write Step 3's App.tsx change, then run this test against the fixture (which already encodes the new behaviour). The test should pass; both fixture and App.tsx now agree.

Either order is fine. Recommend: implement Step 3 first to keep the "no failing tests" momentum, then verify with this test file.

- [ ] **Step 3: Update the auto-fallback effect in App.tsx**

Open `src/ui/App.tsx`. Find the effect at App.tsx:172-179 (from prior PR):

```ts
useEffect(() => {
  if (viewMode.kind === "agent") {
    const exists = agentsSnapshot.some(
      (a) => a.agentId === viewMode.agentId,
    );
    if (!exists) setViewMode({ kind: "main" });
  }
}, [agentsSnapshot, viewMode]);
```

Replace with:

```ts
useEffect(() => {
  if (viewMode.kind !== "agent") return;
  const entry = agentsSnapshot.find((a) => a.agentId === viewMode.agentId);
  if (!entry || entry.status !== "running") {
    setViewMode({ kind: "main" });
  }
}, [agentsSnapshot, viewMode]);
```

Predicate change: was "entry doesn't exist" → now "entry doesn't exist OR entry is not running". The dock row's 30 s linger still works because `getVisibleAgents` keeps it in the visible list regardless of whether the user is currently viewing it.

- [ ] **Step 4: Run the auto-return test**

```
bun test tests/ui/agent-view-auto-return.test.tsx
```
Expected: 3 pass.

- [ ] **Step 5: Run the wider suite**

```
bun test tests/ui/
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/ui/App.tsx tests/ui/agent-view-auto-return.test.tsx
git commit -m "feat(ui): auto-return to main view when agent leaves running

Dock row still lingers 30s for re-entry. Tests:
- markCompleted → viewMode flips to main, entry still in snapshot
- markFailed → same
- still-running agent → viewMode stays put"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full test suite**

```
bun test
```
Expected: all green (was 422 from the prior PR; now ~430+ with the new tests).

- [ ] **Step 2: Type-check**

```
bun run typecheck
```
Expected: only the pre-existing `agent.ts(127,9) TS2783`.

- [ ] **Step 3: Confirm commit list**

```
git log --oneline f7d7053..HEAD
```

Expected order:
1. `fix(ui): sort dock agents by startedAt so concurrent spawns are stable`
2. `feat(ui): add marginTop=1 between dock agent rows`
3. `feat(ui): add main row at top of AgentDock (◆ magenta)`
4. `feat(ui): CommandInput.disabled prop swallows all keys`
5. `feat(ui): rebase dock keyboard onto main-row index space`
6. `feat(ui): pass disabled={dockFocusIdx !== null} to CommandInput`
7. `feat(ui): auto-return to main view when agent leaves running`

Expected files touched (diff stat against `f7d7053`):
- `src/ui/App.tsx`
- `src/ui/components/AgentDock.tsx`
- `src/ui/components/CommandInput.tsx`
- `tests/ui/agent-dock.test.tsx`
- `tests/ui/agent-dock-keyboard.test.tsx`
- `tests/ui/agent-view-switching.test.ts`
- `tests/ui/agent-view-auto-return.test.tsx` (new)

- [ ] **Step 4: Done.** Manual smoke (deferred to user):

1. Start the app. Verify dock is `null` (no main row floating).
2. Run a `run_in_background=true` Agent. Dock appears with `◆ main` on top and one `●` row below it.
3. Press `↓` from input — focus lands on `◆ main`.
4. Press `↓` — focus moves to the first agent.
5. Spawn 3 more agents concurrently. Verify they appear in `startedAt` order in the dock.
6. Press Enter on `◆ main` — view returns to main; dock focus released.
7. Press `↓ ↓ Enter` to enter the first agent's transcript.
8. From inside that transcript, press `↑` — verify the input box does NOT auto-fill from history (the `disabled` gate worked).
9. Wait for that agent to finish — verify the view returns to main automatically, BUT the dock row stays (still green, lingering).
10. Within 30 s, `↓ ↓ Enter` again on that finished agent — verify you can re-enter its transcript.
11. After 30 s, verify the row disappears from the dock; if no agents remain, the dock disappears entirely.

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| §2.1 main row in dock when agents exist | Task 3 (render), Task 5 (focus wiring) |
| §2.2 ↑/↓ never bleeds to input history | Task 4 (`disabled` prop), Task 6 (wire it) |
| §2.3 agents sorted by `startedAt` asc | Task 1 |
| §2.4 marginTop=1 between agent rows | Task 2 |
| §2.5 auto-return on leave running | Task 7 |
| §4 focusedIndex 0=main, 1..N=agents | Task 5 |
| §5.1 `getVisibleAgents` sorts | Task 1 |
| §5.2 `AgentDock` renders MainDockRow | Task 3 |
| §5.3 `MainDockRow` component | Task 3 |
| §5.4 `AgentDockRow` marginTop | Task 2 |
| §6.1 App-level branch rebased | Task 5 |
| §6.2 `onArrowOut` still sets idx 0 (= main row) | implicit; no code change |
| §6.3 `CommandInput.disabled` gates useInput | Task 4 |
| §6.4 Ctrl+C unchanged | implicit; no code change |
| §7 auto-return effect | Task 7 |
| §9.1-§9.14 tests | scattered across Tasks 1-7 |
