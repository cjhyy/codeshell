# Sub-Agent Dock Revisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the dock revisions from `docs/superpowers/specs/2026-05-18-subagent-dock-revisions-design.md` — vertical bottom-anchored dock with `↑/↓ + Enter` navigation, 30 s linger window, no tool name, working in both fullscreen and flow modes.

**Architecture:** Additive `finishedFadeAt` field on the registry; full rewrite of `AgentDock.tsx` into a column layout with internal `AgentDockRow` + exported `getVisibleAgents` helper; new `onArrowOut` prop on `CommandInput` to release `↓` when input is empty; new `dockFocusIdx` state on `App.tsx` with a keyboard branch that wins over the existing Esc/Ctrl-0..5 handlers.

**Tech Stack:** Bun + React + custom Ink-style renderer (`src/render/`). Tests use `bun:test` with the `mount`/`plainText`/`flush` harness in `tests/render-fixtures.ts`.

---

## File Map

- Create: `tests/ui/agent-dock-keyboard.test.tsx` — keyboard routing tests
- Modify: `src/tool-system/builtin/agent-registry.ts` — add `finishedFadeAt`
- Modify: `src/ui/components/AgentDock.tsx` — rewrite to vertical layout, export `getVisibleAgents`
- Modify: `src/ui/components/CommandInput.tsx` — add `onArrowOut` prop
- Modify: `src/ui/App.tsx` — relocate `<AgentDock>`, add `dockFocusIdx`, replace Ctrl-0..5 with `↑/↓+Enter+Esc` branch, relax viewMode exists predicate
- Modify: `tests/ui/agent-dock.test.tsx` — update existing tests to new dock shape

---

## Task 1: Add `finishedFadeAt` to registry

**Files:**
- Modify: `src/tool-system/builtin/agent-registry.ts`
- Test: `tests/ui/agent-view-switching.test.ts` (extend, not replace)

- [ ] **Step 1: Write failing test**

Append to `tests/ui/agent-view-switching.test.ts`:

```ts
test("markCompleted sets finishedFadeAt to finishedAt + 30000", () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "f1",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  asyncAgentRegistry.markCompleted("f1", "result");
  const a = asyncAgentRegistry.getSnapshot().find((x) => x.agentId === "f1");
  expect(a?.finishedAt).toBeDefined();
  expect(a?.finishedFadeAt).toBe((a?.finishedAt ?? 0) + 30_000);
});

test("markFailed sets finishedFadeAt", () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "f2",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  asyncAgentRegistry.markFailed("f2", "boom");
  const a = asyncAgentRegistry.getSnapshot().find((x) => x.agentId === "f2");
  expect(a?.finishedFadeAt).toBe((a?.finishedAt ?? 0) + 30_000);
});

test("cancel sets finishedFadeAt", () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "f3",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  asyncAgentRegistry.cancel("f3");
  const a = asyncAgentRegistry.getSnapshot().find((x) => x.agentId === "f3");
  expect(a?.finishedFadeAt).toBe((a?.finishedAt ?? 0) + 30_000);
});
```

- [ ] **Step 2: Run tests, expect failure**

```
bun test tests/ui/agent-view-switching.test.ts
```
Expected: 3 new tests fail because `finishedFadeAt` is `undefined`.

- [ ] **Step 3: Add the field and populate it**

In `src/tool-system/builtin/agent-registry.ts`, extend the interface:

```ts
export interface AsyncAgentEntry {
  agentId: string;
  description: string;
  status: AsyncAgentStatus;
  startedAt: number;
  finishedAt?: number;
  /** finishedAt + 30_000. Dock filters rows past this. */
  finishedFadeAt?: number;
  result?: string;
  error?: string;
  abort: () => void;
  transcript?: AgentTranscriptEntry[];
}
```

In `markCompleted`, set `finishedFadeAt` next to `finishedAt`:

```ts
markCompleted(agentId: string, result: string): void {
  const e = this.agents.get(agentId);
  if (!e) return;
  if (e.status !== "running") return;
  e.status = "completed";
  e.result = result;
  e.finishedAt = Date.now();
  e.finishedFadeAt = e.finishedAt + 30_000;
  this.notify();
}
```

Do the same in `markFailed`:

```ts
markFailed(agentId: string, error: string): void {
  const e = this.agents.get(agentId);
  if (!e) return;
  if (e.status !== "running") return;
  e.status = "failed";
  e.error = error;
  e.finishedAt = Date.now();
  e.finishedFadeAt = e.finishedAt + 30_000;
  this.notify();
}
```

And `cancel`:

```ts
cancel(agentId: string): boolean {
  const e = this.agents.get(agentId);
  if (!e) return false;
  if (e.status !== "running") return false;
  try {
    e.abort();
  } catch {
    // ignore abort errors — we still mark cancelled
  }
  e.status = "cancelled";
  e.finishedAt = Date.now();
  e.finishedFadeAt = e.finishedAt + 30_000;
  this.notify();
  return true;
}
```

- [ ] **Step 4: Run tests, expect pass**

```
bun test tests/ui/agent-view-switching.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tool-system/builtin/agent-registry.ts tests/ui/agent-view-switching.test.ts
git commit -m "feat(registry): add finishedFadeAt for 30s dock linger"
```

---

## Task 2: Rewrite `AgentDock.tsx` shape + helpers (no keyboard yet)

**Files:**
- Modify: `src/ui/components/AgentDock.tsx`
- Test: `tests/ui/agent-dock.test.tsx` (replace existing cases)

- [ ] **Step 1: Replace `tests/ui/agent-dock.test.tsx` with the new shape's tests**

Write the file (overwrites the current 75 lines):

```tsx
import { test, expect } from "bun:test";
import React from "react";
import { mount, plainText, flush } from "../render-fixtures";
import {
  AgentDock,
  formatElapsed,
  getVisibleAgents,
} from "../../src/ui/components/AgentDock.js";
import { asyncAgentRegistry } from "../../src/tool-system/builtin/agent-registry.js";

function reset() {
  asyncAgentRegistry.reset();
}

const VIEW_MAIN = { kind: "main" as const };

test("no agents → dock renders nothing", async () => {
  reset();
  const h = mount(
    React.createElement(AgentDock, { viewMode: VIEW_MAIN, focusedIndex: null }),
  );
  await flush();
  const out = plainText(h);
  expect(out).not.toContain("agents");
  h.unmount();
});

test("one running agent → row shows name and elapsed, no tool name", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "abc",
    description: "review module",
    status: "running",
    startedAt: Date.now() - 5_000,
    abort: () => {},
  });
  const h = mount(
    React.createElement(AgentDock, { viewMode: VIEW_MAIN, focusedIndex: null }),
    { columns: 80 },
  );
  await flush();
  const out = plainText(h);
  expect(out).toContain("review module");
  // Elapsed should render as "Ns" near 5s
  expect(out).toMatch(/[45]s/);
  // No latest-tool-name leakage
  expect(out).not.toContain("Bash");
  expect(out).not.toContain("Read");
  h.unmount();
});

test("focusedIndex 0 shows '>' cursor on first row", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "first agent",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  asyncAgentRegistry.register({
    agentId: "a2",
    description: "second agent",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const h = mount(
    React.createElement(AgentDock, { viewMode: VIEW_MAIN, focusedIndex: 0 }),
    { columns: 80 },
  );
  await flush();
  const out = plainText(h);
  // The '>' cursor appears immediately before the focused name.
  expect(out).toMatch(/>\s*●\s*first agent/);
  // Second row stays unfocused
  expect(out).not.toMatch(/>\s*●\s*second agent/);
  h.unmount();
});

test("completed agent within fade window → still visible", async () => {
  reset();
  const start = Date.now();
  asyncAgentRegistry.register({
    agentId: "lingers",
    description: "linger row",
    status: "running",
    startedAt: start,
    abort: () => {},
  });
  asyncAgentRegistry.markCompleted("lingers", "done");
  // Sanity: finishedFadeAt is in the future.
  const a = asyncAgentRegistry
    .getSnapshot()
    .find((x) => x.agentId === "lingers");
  expect(a?.finishedFadeAt).toBeGreaterThan(Date.now());

  const h = mount(
    React.createElement(AgentDock, { viewMode: VIEW_MAIN, focusedIndex: null }),
    { columns: 80 },
  );
  await flush();
  const out = plainText(h);
  expect(out).toContain("linger row");
  h.unmount();
});

test("getVisibleAgents filter excludes agents past finishedFadeAt", () => {
  const now = 1_000_000;
  const all = [
    {
      agentId: "running",
      description: "r",
      status: "running",
      startedAt: 0,
      abort: () => {},
    },
    {
      agentId: "linger",
      description: "l",
      status: "completed",
      startedAt: 0,
      finishedAt: now - 1_000,
      finishedFadeAt: now + 29_000,
      abort: () => {},
    },
    {
      agentId: "gone",
      description: "g",
      status: "completed",
      startedAt: 0,
      finishedAt: now - 31_000,
      finishedFadeAt: now - 1_000,
      abort: () => {},
    },
  ] as any[];
  const visible = getVisibleAgents(all, now);
  expect(visible.map((a) => a.agentId)).toEqual(["running", "linger"]);
});

test("more than 5 agents → '+N more' overflow indicator", async () => {
  reset();
  for (let i = 0; i < 7; i++) {
    asyncAgentRegistry.register({
      agentId: `o${i}`,
      description: `agent-${i}`,
      status: "running",
      startedAt: Date.now(),
      abort: () => {},
    });
  }
  const h = mount(
    React.createElement(AgentDock, { viewMode: VIEW_MAIN, focusedIndex: null }),
    { columns: 200 },
  );
  await flush();
  const out = plainText(h);
  expect(out).toContain("agent-4");
  expect(out).not.toContain("agent-5");
  expect(out).toContain("+2 more");
  h.unmount();
});

test("formatElapsed covers s, m s, h m s boundaries", () => {
  expect(formatElapsed(0)).toBe("0s");
  expect(formatElapsed(59_000)).toBe("59s");
  expect(formatElapsed(60_000)).toBe("1m 0s");
  expect(formatElapsed(4 * 60_000 + 23_000)).toBe("4m 23s");
  expect(formatElapsed(60 * 60_000)).toBe("1h 0m 0s");
  expect(formatElapsed(3_600_000 + 4 * 60_000 + 23_000)).toBe("1h 4m 23s");
});
```

- [ ] **Step 2: Run tests, expect failure**

```
bun test tests/ui/agent-dock.test.tsx
```
Expected: every test fails — either the named exports don't exist yet (`formatElapsed`, `getVisibleAgents`) or the prop signature is different.

- [ ] **Step 3: Rewrite `src/ui/components/AgentDock.tsx`**

Replace the entire file:

```tsx
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text } from "../../render/index.js";
import {
  asyncAgentRegistry,
  type AsyncAgentEntry,
} from "../../tool-system/builtin/agent-registry.js";

const MAX_VISIBLE = 5;
const NAME_MAX = 40;

export type DockViewMode =
  | { kind: "main" }
  | { kind: "agent"; agentId: string };

export interface AgentDockProps {
  viewMode: DockViewMode;
  /** null = dock is not the keyboard target; integer = focused row index. */
  focusedIndex: number | null;
}

/**
 * AgentDock — vertical list of running and recently-finished sub-agents,
 * pinned at the very bottom of the UI. Updates elapsed text once per
 * second; redraws are local to this subtree (no app-wide re-render).
 *
 * See docs/superpowers/specs/2026-05-18-subagent-dock-revisions-design.md.
 */
export function AgentDock({
  viewMode,
  focusedIndex,
}: AgentDockProps): React.ReactElement | null {
  const agents = useSyncExternalStore(
    asyncAgentRegistry.subscribe,
    asyncAgentRegistry.getSnapshot,
  );

  // 1 Hz tick — refreshes elapsed text and re-evaluates the fade window.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const visible = getVisibleAgents(agents, now);
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
      {overflow > 0 && <Text dim>{`... +${overflow} more`}</Text>}
    </Box>
  );
}

function AgentDockRow({
  entry,
  focused,
  active,
  now,
}: {
  entry: AsyncAgentEntry;
  focused: boolean;
  active: boolean;
  now: number;
}) {
  const cursor = focused ? ">" : " ";
  const dotColor =
    entry.status === "running"
      ? "ansi:cyan"
      : entry.status === "completed"
        ? "ansi:green"
        : entry.status === "cancelled"
          ? "ansi:yellow"
          : "ansi:red"; /* failed */
  const elapsed = formatElapsed(
    (entry.finishedAt ?? now) - entry.startedAt,
  );
  const name = truncate(entry.description, NAME_MAX);

  return (
    <Box flexDirection="row">
      <Text color={focused ? "ansi:cyanBright" : undefined} bold={focused}>
        {cursor}
      </Text>
      <Text color={dotColor}>{" ● "}</Text>
      <Text
        color={focused ? "ansi:cyanBright" : active ? "ansi:cyan" : undefined}
        bold={focused}
      >
        {name}
      </Text>
      <Box flexGrow={1} />
      <Text dim>{elapsed}</Text>
    </Box>
  );
}

/**
 * Filter the registry snapshot down to rows the dock should show:
 * running agents + recently-finished agents still inside the 30 s fade
 * window. Exported so App.tsx's keyboard handler shares the same predicate.
 */
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

/**
 * Format an elapsed-millisecond duration as "23s" / "4m 23s" / "1h 4m 23s".
 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s}s`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
```

- [ ] **Step 4: Run tests, expect pass**

```
bun test tests/ui/agent-dock.test.tsx
```
Expected: all 7 tests pass.

- [ ] **Step 5: Run the wider UI test suite to catch unintended breakage**

```
bun test tests/ui/
```
Expected: existing `agent-view-switching` and other UI tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/AgentDock.tsx tests/ui/agent-dock.test.tsx
git commit -m "feat(ui): rewrite AgentDock as vertical column with focus prop

- exports getVisibleAgents + formatElapsed helpers
- row format: cursor + colored dot + name + flexGrow spacer + elapsed
- no latestToolName; spec 2026-05-18-subagent-dock-revisions §6"
```

---

## Task 3: Add `onArrowOut` prop to `CommandInput`

**Files:**
- Modify: `src/ui/components/CommandInput.tsx`

- [ ] **Step 1: Add the prop to the interface**

Edit `src/ui/components/CommandInput.tsx`:

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
}: CommandInputProps) {
```

- [ ] **Step 2: Wire `↓` to escape on empty input**

Replace the existing `key.downArrow` branch in `useInput` (currently lines 94-100):

```ts
} else if (key.downArrow) {
  const next = historyRef.current.down();
  if (next !== null) {
    setFromHistory(true);
    onChange(next);
    return;
  }
  // History exhausted AND input is empty → let parent handle (dock focus).
  if (value.length === 0) {
    onArrowOut?.("down");
  }
}
```

The autocomplete-active branch above (lines 66-85) is unchanged — it returns early when the dropdown is open.

- [ ] **Step 3: Type-check the change**

```
bun run tsc -p tsconfig.json --noEmit
```
Expected: no new errors. (If the project doesn't have that script, run `bunx tsc --noEmit -p tsconfig.json` or the equivalent in `package.json`.)

- [ ] **Step 4: Run existing input-related tests**

```
bun test tests/ui/
```
Expected: still green — `onArrowOut` is optional and not exercised yet.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/CommandInput.tsx
git commit -m "feat(ui): CommandInput.onArrowOut releases ↓ on empty input"
```

---

## Task 4: Add `dockFocusIdx` state and keyboard branch to `App.tsx`

**Files:**
- Modify: `src/ui/App.tsx`
- Test: `tests/ui/agent-dock-keyboard.test.tsx` (new)

- [ ] **Step 1: Write the keyboard test file**

Create `tests/ui/agent-dock-keyboard.test.tsx`:

```tsx
import { test, expect } from "bun:test";
import React, { useState } from "react";
import { mount, flush } from "../render-fixtures";
import { Box, useInput } from "../../src/render/index.js";
import {
  AgentDock,
  getVisibleAgents,
  type DockViewMode,
} from "../../src/ui/components/AgentDock.js";
import { asyncAgentRegistry } from "../../src/tool-system/builtin/agent-registry.js";

/**
 * The keyboard branch lives inline in App.tsx, but the behaviour is small
 * enough to extract into a host fixture: we re-implement the exact branch
 * here and assert against it. This keeps the test from depending on the
 * full App.tsx surface (modals, queryGuard, etc.).
 *
 * If you change the branch in App.tsx, update this fixture in lockstep so
 * the test continues to guard the real shape.
 */
function DockHost({
  initialViewMode = { kind: "main" } as DockViewMode,
  onCancel,
}: {
  initialViewMode?: DockViewMode;
  onCancel?: () => void;
}) {
  const [viewMode, setViewMode] = useState<DockViewMode>(initialViewMode);
  const [dockFocusIdx, setDockFocusIdx] = useState<number | null>(null);
  const [inputValue, setInputValue] = useState("");

  // Expose probe state via the dataset of a hidden Box for test assertions.
  // We can't easily round-trip React state out of mount(), so we encode it
  // as text in a render-only line.
  const probe = `state=${dockFocusIdx ?? "null"}|view=${viewMode.kind}${
    viewMode.kind === "agent" ? ":" + viewMode.agentId : ""
  }`;

  useInput((_ch, key) => {
    if (dockFocusIdx !== null) {
      const visible = getVisibleAgents(
        asyncAgentRegistry.getSnapshot(),
        Date.now(),
      );
      if (key.upArrow) {
        if (dockFocusIdx === 0) setDockFocusIdx(null);
        else setDockFocusIdx(dockFocusIdx - 1);
        return;
      }
      if (key.downArrow) {
        setDockFocusIdx(Math.min(visible.length - 1, dockFocusIdx + 1));
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

    if (key.escape && viewMode.kind === "agent") {
      setViewMode({ kind: "main" });
      return;
    }

    // Simulated "Esc cancels request" branch — should NOT fire when the
    // dock owns focus (case 11) nor when transcript view owns Esc (case 12).
    if (key.escape) {
      onCancel?.();
    }

    // Simulated CommandInput.onArrowOut: ↓ on empty input → dock focus.
    if (key.downArrow && dockFocusIdx === null && inputValue === "") {
      const visible = getVisibleAgents(
        asyncAgentRegistry.getSnapshot(),
        Date.now(),
      );
      if (visible.length > 0) setDockFocusIdx(0);
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <span>{probe}</span>
      </Box>
      <AgentDock viewMode={viewMode} focusedIndex={dockFocusIdx} />
    </Box>
  );
}

function reset() {
  asyncAgentRegistry.reset();
}

function send(h: { stdin: NodeJS.WritableStream }, bytes: string) {
  h.stdin.write(bytes);
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";

async function readProbe(h: ReturnType<typeof mount>): Promise<string> {
  await flush();
  // Strip ANSI like plainText does, but only look for the probe= token.
  const raw = h.frames.join("");
  const clean = raw
    .replace(/\x1b\[(\d+)C/g, (_m, n) => " ".repeat(Number(n)))
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b/g, "");
  const m = clean.match(/state=[^|]+\|view=[^\s]+/g);
  return m ? m[m.length - 1] : "";
}

test("↓ on empty input with 2 agents → dockFocusIdx becomes 0", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "first",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  asyncAgentRegistry.register({
    agentId: "a2",
    description: "second",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const h = mount(React.createElement(DockHost), { columns: 80 });
  await flush();
  send(h, DOWN);
  const p = await readProbe(h);
  expect(p).toContain("state=0");
  h.unmount();
});

test("dockFocusIdx 0 + ↑ → returns to null", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "first",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const h = mount(React.createElement(DockHost), { columns: 80 });
  await flush();
  send(h, DOWN);
  await flush();
  send(h, UP);
  const p = await readProbe(h);
  expect(p).toContain("state=null");
  h.unmount();
});

test("dockFocusIdx 0 + ↓ → 1, clamped at len-1", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "first",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  asyncAgentRegistry.register({
    agentId: "a2",
    description: "second",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const h = mount(React.createElement(DockHost), { columns: 80 });
  await flush();
  send(h, DOWN);   // null → 0
  await flush();
  send(h, DOWN);   // 0 → 1
  await flush();
  send(h, DOWN);   // 1 → 1 (clamped)
  const p = await readProbe(h);
  expect(p).toContain("state=1");
  h.unmount();
});

test("dockFocusIdx + Enter → setViewMode agent, focus released", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "the-target",
    description: "first",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const h = mount(React.createElement(DockHost), { columns: 80 });
  await flush();
  send(h, DOWN);
  await flush();
  send(h, ENTER);
  const p = await readProbe(h);
  expect(p).toContain("state=null");
  expect(p).toContain("view=agent:the-target");
  h.unmount();
});

test("dockFocusIdx + Esc → focus released, no cancel call", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "first",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  let cancelled = false;
  const h = mount(
    React.createElement(DockHost, { onCancel: () => (cancelled = true) }),
    { columns: 80 },
  );
  await flush();
  send(h, DOWN);
  await flush();
  send(h, ESC);
  const p = await readProbe(h);
  expect(p).toContain("state=null");
  expect(cancelled).toBe(false);
  h.unmount();
});

test("viewMode=agent + Esc → returns to main, no cancel call", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "the-target",
    description: "first",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  let cancelled = false;
  const h = mount(
    React.createElement(DockHost, {
      initialViewMode: { kind: "agent", agentId: "the-target" },
      onCancel: () => (cancelled = true),
    }),
    { columns: 80 },
  );
  await flush();
  send(h, ESC);
  const p = await readProbe(h);
  expect(p).toContain("view=main");
  expect(cancelled).toBe(false);
  h.unmount();
});

test("viewMode=main + Esc with no dock focus → cancel branch fires", async () => {
  reset();
  let cancelled = false;
  const h = mount(
    React.createElement(DockHost, { onCancel: () => (cancelled = true) }),
    { columns: 80 },
  );
  await flush();
  send(h, ESC);
  await flush();
  expect(cancelled).toBe(true);
  h.unmount();
});
```

- [ ] **Step 2: Run the new tests**

```
bun test tests/ui/agent-dock-keyboard.test.tsx
```

These tests do **not** depend on App.tsx — they exercise the `DockHost` fixture inside the test file, which reimplements the keyboard branch we are about to add to App.tsx. The fixture imports `getVisibleAgents` and `AgentDock` (already shipped in Task 2), so the tests should pass at this point. **Expected: 7 pass.**

These tests are guards for the *shape* of the keyboard branch. If you later edit the branch in App.tsx, update the `DockHost` fixture in lockstep so the guard continues to match reality.

If a test fails here, the fixture itself is wrong — fix it before moving on. Do not skip ahead with red tests.

- [ ] **Step 3: Add `dockFocusIdx` state to `App.tsx`**

Open `src/ui/App.tsx`. The local `ViewMode` declaration is at `App.tsx:165-166`; it has the same shape as `DockViewMode` exported from `AgentDock.tsx`. Leave the local declaration alone (don't unify — the file already has many local types) and just add the new state:

```ts
type ViewMode = { kind: "main" } | { kind: "agent"; agentId: string };
const [viewMode, setViewMode] = useState<ViewMode>({ kind: "main" });
const [dockFocusIdx, setDockFocusIdx] = useState<number | null>(null);
```

When passing `viewMode` to `<AgentDock>` later (Task 5), TypeScript will accept it because the structural shape matches `DockViewMode`.

- [ ] **Step 4: Relax the `viewMode` exists predicate**

Replace the effect at `App.tsx:172-179`:

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

(Drop the `&& a.status === "running"` check — the registry now keeps the entry for the 30 s fade window after completion.)

- [ ] **Step 5: Add the dock-focus clamp effect**

Add right after the `viewMode` effect from Step 5:

```ts
// Clamp dockFocusIdx whenever the visible list shrinks. Runs after
// agent finishes + fade expires, or after the user releases focus via
// Enter/Esc. Imported lazily to avoid a circular import.
useEffect(() => {
  if (dockFocusIdx === null) return;
  // Inline the helper signature here to avoid a top-of-file import shuffle.
  // (getVisibleAgents is imported below alongside AgentDock.)
  const now = Date.now();
  const len = agentsSnapshot.filter(
    (a) =>
      a.status === "running" ||
      (a.finishedFadeAt !== undefined && now < a.finishedFadeAt),
  ).length;
  if (len === 0) setDockFocusIdx(null);
  else if (dockFocusIdx >= len) setDockFocusIdx(len - 1);
}, [agentsSnapshot, dockFocusIdx]);
```

- [ ] **Step 6: Update the `AgentDock` import**

Find the existing import at `App.tsx:51`:

```ts
import { AgentDock } from "./components/AgentDock.js";
```

Change to:

```ts
import { AgentDock, getVisibleAgents } from "./components/AgentDock.js";
```

Replace the inline filter in the clamp effect (Step 5) with `getVisibleAgents(agentsSnapshot, Date.now()).length` for DRY:

```ts
useEffect(() => {
  if (dockFocusIdx === null) return;
  const len = getVisibleAgents(agentsSnapshot, Date.now()).length;
  if (len === 0) setDockFocusIdx(null);
  else if (dockFocusIdx >= len) setDockFocusIdx(len - 1);
}, [agentsSnapshot, dockFocusIdx]);
```

- [ ] **Step 7: Replace the `Ctrl-0..5` block with the dock-focus branch**

In the `useInput` handler (`App.tsx:807-823`), delete the entire `Ctrl-0..5` block:

```ts
// DELETE THIS BLOCK:
if (key.ctrl && ch && ch >= "0" && ch <= "5") {
  const n = parseInt(ch, 10);
  if (n === 0) {
    setViewMode({ kind: "main" });
    return;
  }
  const running = asyncAgentRegistry
    .getSnapshot()
    .filter((a) => a.status === "running");
  const target = running[n - 1];
  if (target) {
    setViewMode({ kind: "agent", agentId: target.agentId });
  }
  return;
}
```

Replace with the dock-focus + agent-transcript-esc branches. Insert them at the top of the `useInput` body (before any other branch):

```ts
// Dock keyboard branch — highest priority among non-overlay keys.
if (dockFocusIdx !== null) {
  const running = getVisibleAgents(
    asyncAgentRegistry.getSnapshot(),
    Date.now(),
  );
  if (key.upArrow) {
    if (dockFocusIdx === 0) setDockFocusIdx(null);
    else setDockFocusIdx(dockFocusIdx - 1);
    return;
  }
  if (key.downArrow) {
    setDockFocusIdx(Math.min(running.length - 1, dockFocusIdx + 1));
    return;
  }
  if (key.return) {
    const target = running[dockFocusIdx];
    if (target) setViewMode({ kind: "agent", agentId: target.agentId });
    setDockFocusIdx(null);
    return;
  }
  if (key.escape) {
    setDockFocusIdx(null);
    return;
  }
}

// viewMode === 'agent' → Esc returns to main BEFORE the cancel branch.
if (
  key.escape &&
  viewMode.kind === "agent" &&
  !pendingQuestion &&
  !pendingApproval &&
  !showOnboarding &&
  !modelEntries &&
  !modelManager &&
  !sessionEntries
) {
  setViewMode({ kind: "main" });
  return;
}
```

- [ ] **Step 8: Wire `onArrowOut` from `CommandInput` to `dockFocusIdx`**

Find the `CommandInput` usage at `App.tsx:1558-1565`:

```tsx
<CommandInput
  value={input}
  onChange={setInput}
  onSubmit={handleSubmit}
  commands={commandDefs}
  placeholder={isRunning ? "Interrupt… (Ctrl+C to cancel)" : undefined}
/>
```

Add the `onArrowOut` prop:

```tsx
<CommandInput
  value={input}
  onChange={setInput}
  onSubmit={handleSubmit}
  commands={commandDefs}
  placeholder={isRunning ? "Interrupt… (Ctrl+C to cancel)" : undefined}
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

- [ ] **Step 9: Type-check the App.tsx changes**

```
bun run tsc -p tsconfig.json --noEmit
```
Expected: no new errors.

- [ ] **Step 10: Run the full UI test suite**

```
bun test tests/ui/
```
Expected: all green, including `agent-dock.test.tsx`, `agent-dock-keyboard.test.tsx`, and `agent-view-switching.test.ts`.

- [ ] **Step 11: Commit**

```bash
git add src/ui/App.tsx tests/ui/agent-dock-keyboard.test.tsx
git commit -m "feat(ui): wire ↑/↓+Enter dock navigation, drop Ctrl-0..5

- dockFocusIdx state on App.tsx with clamp effect
- dock-focus branch wins over Esc-cancel and transcript-Esc branches
- CommandInput.onArrowOut routes empty-input ↓ into dock"
```

---

## Task 5: Relocate `AgentDock` to the bottom of `bottomContent`

**Files:**
- Modify: `src/ui/App.tsx` (only the `bottomContent` JSX block)

- [ ] **Step 1: Read the current bottomContent**

Open `src/ui/App.tsx`. The block is at `App.tsx:1321-1324`:

```tsx
const bottomContent = (
  <Box flexDirection="column" marginTop={0}>
    <AgentDock viewMode={viewMode} />
    <Text dim>{separator}</Text>
    ...rest of bottom content...
  </Box>
);
```

- [ ] **Step 2: Move `<AgentDock>` to the end and pass `focusedIndex`**

Modify the JSX so the dock comes *last*, after the StatusLine `<Box>` (which is the current bottom of the stack — `App.tsx:1570-1586`):

```tsx
const bottomContent = (
  <Box flexDirection="column" marginTop={0}>
    <Text dim>{separator}</Text>

    {screen === "transcript" ? (
      // ...existing transcript-mode footer/onboarding/...
    ) : (
      // ...existing CommandInput etc...
    )}

    <Text dim>{separator}</Text>

    <Box wrap="truncate">
      <ModeIndicator mode={permMode} />
      {screen === "transcript" && <Text color="ansi:magenta">{" TRANSCRIPT "}</Text>}
      <Box flexGrow={1} />
      <StatusLine .../>
    </Box>

    {/* Dock at the very bottom — below StatusLine. Renders null when
        no running or recently-finished agents. */}
    <AgentDock viewMode={viewMode} focusedIndex={dockFocusIdx} />
  </Box>
);
```

Concretely the edit is two-part:

1. Delete the existing `<AgentDock viewMode={viewMode} />` near the top of `bottomContent` (it was the first child, before the separator).
2. Add `<AgentDock viewMode={viewMode} focusedIndex={dockFocusIdx} />` as the **last** child of the outer `<Box flexDirection="column">`.

- [ ] **Step 3: Type-check**

```
bun run tsc -p tsconfig.json --noEmit
```
Expected: no errors.

- [ ] **Step 4: Run full test suite**

```
bun test
```
Expected: green.

- [ ] **Step 5: Manual smoke (fullscreen mode)**

```
bun run dev
```

In the app, run any command that spawns a `run_in_background` Agent. Verify:
- Dock appears at the **bottom** of the terminal (below the status line).
- Each row reads `[ or >] ● <name>   …   <Ns>` with no tool name.
- Elapsed counts up every second.
- With an **empty** input box, pressing `↓` puts `>` on the first dock row.
- `↑/↓` cycle rows; `↑` on row 0 returns to input (no `>` on any row).
- `Enter` switches to that agent's transcript; `Esc` returns to main.
- Spawn 6+ agents — the dock caps at 5 rows + `... +N more`.
- Let one agent finish — its dot turns green, row stays for ~30 s, then disappears.

- [ ] **Step 6: Manual smoke (flow mode)**

Restart with `CODESHELL_FULLSCREEN=0 bun run dev`. Repeat the cases from Step 5.

Pay attention to **ghost rows**: when a dock row appears or disappears, the previous frame should not stay in scrollback above the new frame. If it does, file a follow-up; do not silently merge.

- [ ] **Step 7: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat(ui): move AgentDock to bottom of bottomContent (below StatusLine)"
```

---

## Task 6: Final verification

- [ ] **Step 1: Run the entire test suite**

```
bun test
```
Expected: all green.

- [ ] **Step 2: Lint / type-check**

```
bun run tsc -p tsconfig.json --noEmit
```
Expected: no errors.

- [ ] **Step 3: Review the diff**

```
git log --oneline main..HEAD
git diff main..HEAD --stat
```

Expected commits, in order:
1. `feat(registry): add finishedFadeAt for 30s dock linger`
2. `feat(ui): rewrite AgentDock as vertical column with focus prop`
3. `feat(ui): CommandInput.onArrowOut releases ↓ on empty input`
4. `feat(ui): wire ↑/↓+Enter dock navigation, drop Ctrl-0..5`
5. `feat(ui): move AgentDock to bottom of bottomContent (below StatusLine)`

Expected files in the diff:
- `src/tool-system/builtin/agent-registry.ts`
- `src/ui/components/AgentDock.tsx`
- `src/ui/components/CommandInput.tsx`
- `src/ui/App.tsx`
- `tests/ui/agent-dock.test.tsx`
- `tests/ui/agent-dock-keyboard.test.tsx` (new)
- `tests/ui/agent-view-switching.test.ts`

- [ ] **Step 4: Verify dropped behaviour**

```bash
grep -n "key.ctrl && ch && ch >= " src/ui/App.tsx
```

Expected: no match. The Ctrl-0..5 block is fully removed.

- [ ] **Step 5: Done.** All goals from `docs/superpowers/specs/2026-05-18-subagent-dock-revisions-design.md §2` are implemented.

---

## Spec coverage check

- §2.1 vertical list — Task 2 (AgentDock layout)
- §2.2 dock at bottom of UI — Task 5 (relocate in bottomContent)
- §2.3 row format `cursor ● name … elapsed` — Task 2 (`AgentDockRow`)
- §2.4 elapsed format — Task 2 (`formatElapsed`)
- §2.5 keyboard — Task 3 (`onArrowOut`) + Task 4 (dock-focus branch)
- §2.6 remove Ctrl-0..5 — Task 4 Step 8
- §2.7 30 s linger — Task 1 (`finishedFadeAt`) + Task 2 (`getVisibleAgents`)
- §2.8 fullscreen + flow — Task 5 Step 5/6 (manual smoke)
- §4.2 relax viewMode exists predicate — Task 4 Step 5
- §7.2 clamp effect — Task 4 Step 6/7
