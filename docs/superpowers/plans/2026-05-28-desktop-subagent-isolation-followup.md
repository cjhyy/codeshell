# Desktop Subagent Isolation Followup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the three residual issues found in manual verification of the first followup: TodoWrite flicker (subagent task_updates polluting the global panel), folded-card flicker (elapsed using Date.now() per render), and persistent lag (no ingress event batching).

**Architecture:** Three small orthogonal changes. (A) `task_update` gains `agentId` in core; renderer drops events that carry it. (B) `AgentMessageView` derives elapsed from interval-driven state instead of `Date.now()` on every render. (C) Extract a pure `createEventCoalescer` helper in the renderer that buffers `text_delta` / `tool_use_args_delta` for 50 ms, flushing immediately on tool/turn/agent boundaries.

**Tech Stack:** TypeScript, React 18, `bun:test`. Changes cross `packages/core` (one-line type extension + one-line emit change) and `packages/desktop/src/renderer/`.

**Spec:** `docs/superpowers/specs/2026-05-28-desktop-subagent-isolation-followup-design.md`

---

## File Structure

**Modify:**
- `packages/core/src/types.ts` — add `agentId?: string` to `task_update` StreamEvent variant.
- `packages/core/src/tool-system/builtin/task.ts` — populate `agentId` from `ctx`.
- `packages/desktop/src/renderer/types.ts` — `task_update` reducer case drops events with `agentId`.
- `packages/desktop/src/renderer/types.test.ts` — append 2 tests for `task_update` routing.
- `packages/desktop/src/renderer/messages/AgentMessageView.tsx` — `useElapsed` hook for interval-driven elapsed.
- `packages/desktop/src/renderer/App.tsx` — wire the coalescer between `onStreamEvent` and `dispatch`.

**Create:**
- `packages/desktop/src/renderer/streamCoalescer.ts` — pure helper with `createEventCoalescer`.
- `packages/desktop/src/renderer/streamCoalescer.test.ts` — 5 tests for the helper.

**No new components, no UI additions, no AgentMessage type changes.**

---

## Task 1: `task_update` carries agentId; renderer drops subagent updates

**Files:**
- Modify: `packages/core/src/types.ts` (the `task_update` line in the StreamEvent union)
- Modify: `packages/core/src/tool-system/builtin/task.ts` (`emitTaskUpdate` body)
- Modify: `packages/desktop/src/renderer/types.ts` (`task_update` reducer case)
- Modify: `packages/desktop/src/renderer/types.test.ts` (append 2 tests)

### Step 1: Read `emitTaskUpdate` to confirm `ctx.agentId` shape

Read `packages/core/src/tool-system/builtin/task.ts` and find the `emitTaskUpdate` function. Confirm what `ctx` is and how `agentId` is exposed (it should be a property on the context object passed to tool handlers). If `ctx?.agentId` is not the right accessor, adapt the implementation in Step 3 — but use the same accessor pattern as other emit sites in the same file (e.g., search for `agentId` in the file).

### Step 2: Extend the `task_update` StreamEvent type

In `packages/core/src/types.ts`, find the line:

```ts
  | { type: "task_update"; tasks: TaskInfo[] }
```

Replace with:

```ts
  | { type: "task_update"; tasks: TaskInfo[]; agentId?: string }
```

### Step 3: Populate `agentId` in `emitTaskUpdate`

In `packages/core/src/tool-system/builtin/task.ts`, find the call that emits the `task_update` event (around line 141):

```ts
cb?.({ type: "task_update", tasks });
```

Replace with (use the actual `ctx` accessor confirmed in Step 1; the example assumes `ctx?.agentId`):

```ts
cb?.({ type: "task_update", tasks, agentId: ctx?.agentId });
```

For main-agent calls `ctx?.agentId` is `undefined`, so the emitted event is wire-compatible with the old shape.

### Step 4: Build core so desktop sees the new type

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell/packages/core
bun run build
```

Expected: clean exit. If `tsc` errors on the changed file (rare for a one-field type extension), fix the error before proceeding.

### Step 5: Reducer drops subagent task_updates

In `packages/desktop/src/renderer/types.ts`, find the `task_update` reducer case (around line 308):

```ts
case "task_update": {
  // Find the most recent TaskListMessage and update in place; if
  // none exists yet, append a new one.
  const msgs = state.messages.slice();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.kind === "task_list") {
      msgs[i] = { ...m, tasks: event.tasks };
      return { ...state, messages: msgs };
    }
  }
  return {
    ...state,
    messages: [
      ...state.messages,
      { kind: "task_list", id: freshId("tasks"), tasks: event.tasks },
    ],
  };
}
```

Insert an early-return at the top of the case body:

```ts
case "task_update": {
  // Subagent task lists are intentionally not shown in the desktop UI.
  // Main agent's task panel stays uncluttered by subagent activity.
  if (event.agentId) return state;
  // Find the most recent TaskListMessage and update in place; if
  // none exists yet, append a new one.
  const msgs = state.messages.slice();
  // ...rest unchanged...
```

Leave the rest of the case body identical.

### Step 6: Add reducer tests

In `packages/desktop/src/renderer/types.test.ts`, append two new tests inside the existing `describe("applyStreamEvent — subagent isolation", () => { ... })` block, after test 10:

```ts
  test("11. task_update without agentId updates the global TaskListMessage", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      ev("task_update", { tasks: [{ id: "t1", title: "main todo", state: "pending" }] } as any),
    ]);
    const taskList = s.messages.find((m) => m.kind === "task_list");
    expect(taskList).toBeDefined();
    if (taskList && taskList.kind === "task_list") {
      expect(taskList.tasks.length).toBe(1);
      expect(taskList.tasks[0]!.title).toBe("main todo");
    }
  });

  test("12. task_update with agentId is dropped (state unchanged)", () => {
    const before = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
    ]);
    const after = applyStreamEvent(
      before,
      ev("task_update", {
        tasks: [{ id: "t1", title: "sub todo", state: "pending" }],
        agentId: "A",
      } as any),
    );
    expect(after).toBe(before); // strict reference equality
    expect(after.messages.filter((m) => m.kind === "task_list").length).toBe(0);
  });
```

If the `TaskInfo` type's required fields differ from `{ id, title, state }`, adjust the test factory accordingly. Read `packages/core/src/types.ts` `TaskInfo` definition if needed.

### Step 7: Run tests

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
bun test packages/desktop/src/renderer/types.test.ts
```

Expected: 12 pass, 0 fail.

### Step 8: Typecheck

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop && bun run typecheck
```

Expected: pass.

### Step 9: Commit

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/core/src/types.ts packages/core/src/tool-system/builtin/task.ts packages/core/dist packages/desktop/src/renderer/types.ts packages/desktop/src/renderer/types.test.ts
git commit -m "fix(desktop): drop subagent task_update from the global todo panel

Subagent TodoWrite calls were emitting task_update events with no
agentId, so the desktop reducer treated them as main-agent updates and
overwrote the pinned task panel. With multiple parallel subagents the
panel flickered between their snapshots.

Core: add agentId?: string to the task_update StreamEvent and
populate it from ctx.agentId in emitTaskUpdate. Backward-compatible:
main-agent emits remain agentId-less.

Renderer: task_update case returns state unchanged when agentId is
set. Subagent todos are intentionally not displayed (user requirement).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Only stage the listed files. If `packages/core/dist/index.d.ts` is gitignored in this repo, do not force-add it — leave it out of the commit; the consumer rebuild step in Task 1 Step 4 produces it locally.

To verify whether `dist` is gitignored, run before staging:

```bash
git check-ignore packages/core/dist/index.d.ts || echo "NOT ignored"
```

If the command outputs `NOT ignored`, include `packages/core/dist/index.d.ts` in the `git add`. Otherwise omit it.

---

## Task 2: `useElapsed` hook — folded-card no longer flickers

**Files:**
- Modify: `packages/desktop/src/renderer/messages/AgentMessageView.tsx`

### Step 1: Replace `formatElapsed` call with a hook-driven value

In `packages/desktop/src/renderer/messages/AgentMessageView.tsx`, find the existing helper at the top (around line 7-15):

```ts
function formatElapsed(startedAt: number, endedAt?: number): string {
  const ms = (endedAt ?? Date.now()) - startedAt;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${rem}s`;
}
```

Change it to take both timestamps explicitly (no internal `Date.now()`):

```ts
function formatElapsed(startedAt: number, now: number): string {
  const ms = now - startedAt;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${rem}s`;
}
```

Add a `useElapsed` hook right below the `formatElapsed` definition:

```ts
function useElapsed(startedAt: number, endedAt: number | undefined): string {
  // For a completed agent we anchor `now` to endedAt and never tick.
  // For a running agent we tick once per second so the elapsed text
  // updates at most 1×/s regardless of how many stream events arrive.
  const [now, setNow] = useState<number>(() => endedAt ?? Date.now());
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

Imports at the top of the file currently are:

```ts
import React, { useState, memo } from "react";
```

Add `useEffect`:

```ts
import React, { useState, useEffect, memo } from "react";
```

### Step 2: Use the hook in the component

In `AgentMessageViewImpl`, find:

```ts
  const elapsed = formatElapsed(message.startedAt, message.endedAt);
```

Replace with:

```ts
  const elapsed = useElapsed(message.startedAt, message.endedAt);
```

### Step 3: Run existing tests

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
bun test packages/desktop/src/renderer/messages/AgentMessageView.test.tsx
```

Expected: 3 pass. The existing tests use `renderToStaticMarkup`, which runs effects in the React 18 server renderer; the initial value is read from the `useState` lazy initializer (`endedAt ?? Date.now()`) so behavior matches the previous direct call for SSR.

### Step 4: Typecheck

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop && bun run typecheck
```

Expected: pass.

### Step 5: Commit

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/renderer/messages/AgentMessageView.tsx
git commit -m "fix(desktop): drive AgentMessageView elapsed via interval, not per-render Date.now()

The folded card was re-rendering on every subagent stream event
(React.memo's shallow comparison invalidated on every new AgentMessage
ref). Each re-render called formatElapsed(Date.now()), producing a
new text node and visible flicker.

useElapsed reads now from interval-driven state: anchored to endedAt
when the agent is done, ticking 1×/s while running. Elapsed text
changes at most once per second — DOM stays stable between ticks even
when the component re-renders.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Stream event coalescer (50 ms ingress batching)

**Files:**
- Create: `packages/desktop/src/renderer/streamCoalescer.ts`
- Create: `packages/desktop/src/renderer/streamCoalescer.test.ts`
- Modify: `packages/desktop/src/renderer/App.tsx`

### Step 1: Write the helper tests (red)

Create `packages/desktop/src/renderer/streamCoalescer.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import { createEventCoalescer } from "./streamCoalescer";
import type { StreamEvent } from "@cjhyy/code-shell-core";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("createEventCoalescer", () => {
  test("13. two text_delta for the same agent merge into one flushed event", async () => {
    const out: StreamEvent[] = [];
    const c = createEventCoalescer((e) => out.push(e), 30);
    c.push({ type: "text_delta", text: "hello ", agentId: "A" } as any);
    c.push({ type: "text_delta", text: "world", agentId: "A" } as any);
    await delay(50);
    expect(out).toEqual([
      { type: "text_delta", text: "hello world", agentId: "A" } as any,
    ]);
    c.dispose();
  });

  test("14. tool_use_args_delta merges by toolCallId via shallow-assign", async () => {
    const out: StreamEvent[] = [];
    const c = createEventCoalescer((e) => out.push(e), 30);
    c.push({
      type: "tool_use_args_delta",
      toolCallId: "t1",
      args: { a: 1 },
      agentId: "A",
    } as any);
    c.push({
      type: "tool_use_args_delta",
      toolCallId: "t1",
      args: { b: 2, a: 99 },
      agentId: "A",
    } as any);
    await delay(50);
    expect(out).toEqual([
      {
        type: "tool_use_args_delta",
        toolCallId: "t1",
        args: { a: 99, b: 2 },
        agentId: "A",
      } as any,
    ]);
    c.dispose();
  });

  test("15. tool_use_start flushes any pending text_delta first, in order", async () => {
    const out: StreamEvent[] = [];
    const c = createEventCoalescer((e) => out.push(e), 30);
    c.push({ type: "text_delta", text: "hi", agentId: "A" } as any);
    c.push({
      type: "tool_use_start",
      toolCall: { id: "t1", toolName: "Read", args: {} },
      agentId: "A",
    } as any);
    // Both should be drained synchronously by the tool_use_start flush.
    expect(out.length).toBe(2);
    expect(out[0]!.type).toBe("text_delta");
    expect((out[0] as any).text).toBe("hi");
    expect(out[1]!.type).toBe("tool_use_start");
    c.dispose();
  });

  test("16. text_delta for agent A vs agent B do not merge", async () => {
    const out: StreamEvent[] = [];
    const c = createEventCoalescer((e) => out.push(e), 30);
    c.push({ type: "text_delta", text: "a1", agentId: "A" } as any);
    c.push({ type: "text_delta", text: "b1", agentId: "B" } as any);
    c.push({ type: "text_delta", text: "a2", agentId: "A" } as any);
    await delay(50);
    // Two flushed events: A merged ("a1a2") and B alone ("b1").
    expect(out.length).toBe(2);
    const a = out.find((e) => (e as any).agentId === "A") as any;
    const b = out.find((e) => (e as any).agentId === "B") as any;
    expect(a.text).toBe("a1a2");
    expect(b.text).toBe("b1");
    c.dispose();
  });

  test("17. dispose() flushes any pending content synchronously", () => {
    const out: StreamEvent[] = [];
    const c = createEventCoalescer((e) => out.push(e), 30);
    c.push({ type: "text_delta", text: "pending", agentId: "A" } as any);
    c.dispose();
    expect(out.length).toBe(1);
    expect((out[0] as any).text).toBe("pending");
  });
});
```

### Step 2: Run to confirm red

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
bun test packages/desktop/src/renderer/streamCoalescer.test.ts
```

Expected: all 5 fail with "module not found".

### Step 3: Implement `streamCoalescer.ts`

Create `packages/desktop/src/renderer/streamCoalescer.ts`:

```ts
import type { StreamEvent } from "@cjhyy/code-shell-core";

type Flush = (event: StreamEvent) => void;

interface PendingText {
  agentId: string | undefined;
  text: string;
  tokens?: number;
}

interface PendingArgs {
  agentId: string | undefined;
  toolCallId: string;
  args: Record<string, unknown>;
}

/**
 * Coalesce rapid `text_delta` and `tool_use_args_delta` bursts before
 * they reach the reducer. Mirrors the TUI's 50 ms `flushTextBuffer`
 * pattern (`packages/tui/src/ui/App.tsx`) at the renderer ingress.
 *
 * Pass-through events (everything else) emit immediately. The pending
 * buffer is also drained immediately on `tool_use_start`, `tool_result`,
 * `turn_complete`, `agent_start`, `agent_end`, and `error` — boundaries
 * the user must see in real time.
 *
 * Pure logic, no React. Callers (App.tsx) wire `push` to the stream
 * source and provide an `onFlush` that dispatches into the reducer.
 */
export function createEventCoalescer(onFlush: Flush, intervalMs = 50) {
  // Key shape: `${eventType}|${agentId ?? ""}|${toolCallId ?? ""}`
  const textBuf = new Map<string, PendingText>();
  const argsBuf = new Map<string, PendingArgs>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    // Drain in insertion order: text first, then args. Both maps preserve
    // insertion order per spec; cross-type ordering is not preserved
    // (text_delta and tool_use_args_delta should never interleave for the
    // same tool since args precedes the tool's text output).
    for (const [, p] of textBuf) {
      const ev: StreamEvent = p.tokens !== undefined
        ? ({ type: "text_delta", text: p.text, tokens: p.tokens, agentId: p.agentId } as any)
        : ({ type: "text_delta", text: p.text, agentId: p.agentId } as any);
      onFlush(ev);
    }
    textBuf.clear();
    for (const [, p] of argsBuf) {
      onFlush({
        type: "tool_use_args_delta",
        toolCallId: p.toolCallId,
        args: p.args,
        agentId: p.agentId,
      } as any);
    }
    argsBuf.clear();
  }

  function scheduleFlush(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, intervalMs);
  }

  function push(event: StreamEvent): void {
    const t = event.type;
    if (t === "text_delta") {
      const agentId = (event as any).agentId as string | undefined;
      const key = `text|${agentId ?? ""}`;
      const prev = textBuf.get(key);
      if (prev) {
        prev.text += (event as any).text;
        if ((event as any).tokens !== undefined) {
          prev.tokens = (prev.tokens ?? 0) + ((event as any).tokens as number);
        }
      } else {
        textBuf.set(key, {
          agentId,
          text: (event as any).text,
          tokens: (event as any).tokens,
        });
      }
      scheduleFlush();
      return;
    }
    if (t === "tool_use_args_delta") {
      const agentId = (event as any).agentId as string | undefined;
      const toolCallId = (event as any).toolCallId as string;
      const key = `args|${agentId ?? ""}|${toolCallId}`;
      const prev = argsBuf.get(key);
      if (prev) {
        Object.assign(prev.args, (event as any).args);
      } else {
        argsBuf.set(key, {
          agentId,
          toolCallId,
          args: { ...((event as any).args as Record<string, unknown>) },
        });
      }
      scheduleFlush();
      return;
    }
    // Boundary events: flush first to preserve ordering, then pass through.
    if (
      t === "tool_use_start" ||
      t === "tool_result" ||
      t === "turn_complete" ||
      t === "agent_start" ||
      t === "agent_end" ||
      t === "error"
    ) {
      flush();
      onFlush(event);
      return;
    }
    // Everything else passes straight through.
    onFlush(event);
  }

  function dispose(): void {
    flush();
  }

  return { push, flush, dispose };
}
```

### Step 4: Run tests to confirm green

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
bun test packages/desktop/src/renderer/streamCoalescer.test.ts
```

Expected: 5 pass, 0 fail.

### Step 5: Wire the coalescer into `App.tsx`

Open `packages/desktop/src/renderer/App.tsx` and find the `onStreamEvent` callback that ends with `dispatch({ type: "stream", bucket: target, event })` (the spec referenced around line 479 of the file; locate by the literal text rather than line number).

The current shape is approximately:

```ts
const onStreamEvent = useCallback((envelope: StreamEventEnvelope) => {
  // ...routing logic to find target bucket...
  dispatch({ type: "stream", bucket: target, event: envelope.event });
}, [/* deps */]);
```

You will:
1. Create one coalescer per bucket via a `useRef<Map<string, ReturnType<typeof createEventCoalescer>>>(new Map())`.
2. Look up (or create) the bucket's coalescer.
3. Call `coalescer.push(envelope.event)` with a closure that dispatches the merged event to the bucket.
4. On component unmount, dispose every coalescer.

The wiring code (add inside `App` component body, alongside existing refs):

```ts
import { createEventCoalescer } from "./streamCoalescer";
// ...other imports...

const coalescersRef = useRef<Map<string, ReturnType<typeof createEventCoalescer>>>(
  new Map(),
);

useEffect(() => {
  const coalescers = coalescersRef.current;
  return () => {
    for (const c of coalescers.values()) c.dispose();
    coalescers.clear();
  };
}, []);

function getCoalescer(bucket: string) {
  let c = coalescersRef.current.get(bucket);
  if (!c) {
    c = createEventCoalescer((event) =>
      dispatch({ type: "stream", bucket, event }),
    );
    coalescersRef.current.set(bucket, c);
  }
  return c;
}
```

Then in the `onStreamEvent` callback, replace the direct `dispatch` call with:

```ts
getCoalescer(target).push(envelope.event);
```

Keep all other logic (logging, recording, etc.) on the original event — coalescing affects only what reaches the reducer.

Important: if `dispatch` is referenced inside `getCoalescer`'s closure, ensure the closure captures the same `dispatch` reference React provides (it's stable across renders for `useReducer`, so no `useCallback` wrapping is needed; verify by reading the existing `dispatch` declaration).

### Step 6: Typecheck

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop && bun run typecheck
```

Expected: pass.

### Step 7: Run all renderer tests

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
bun test packages/desktop/src/renderer/
```

Expected: all pass — 12 reducer tests + 3 AgentMessageView tests + 5 coalescer tests + pre-existing tests (attachments, lightbox).

### Step 8: Commit

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/renderer/streamCoalescer.ts packages/desktop/src/renderer/streamCoalescer.test.ts packages/desktop/src/renderer/App.tsx
git commit -m "perf(desktop): 50ms ingress batching for text_delta / tool_use_args_delta

Mirrors the TUI's flushTextBuffer pattern at the renderer ingress:
- text_delta and tool_use_args_delta accumulate in per-bucket buffers
- 50ms timer flushes pending events, dispatched as merged single events
- tool_use_start / tool_result / turn_complete / agent_start / agent_end
  / error flush immediately to preserve ordering

Under a 4-agent, ~100 evt/sec storm: reducer dispatch rate drops from
~400/sec to ~20/sec. buildStreamItems runs 20x fewer times.
AgentMessageView re-renders 5x fewer times per visible card.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Manual re-verification

Same workload as the previous Task 6 (4 parallel subagents reading + scoring files). Verify:

- Pinned task panel above composer **does not** flicker when subagents call TodoWrite. (It should only update when the main agent updates its own todos.)
- Folded agent cards **do not** visibly flicker. Elapsed text changes once per second at most.
- Scroll + composer typing stay responsive under load. DevTools Performance shows < 5 ms scripting frames per dispatch.
- Subagent text still routes into its AgentMessage card; expanding reveals the tool calls correctly.

If any of these regresses, file specifics; otherwise the feature is complete.

---

## Self-Review

**1. Spec coverage**

- Spec §A (task_update isolation) → Task 1 (core type + emit + reducer + 2 tests).
- Spec §B (elapsed via interval) → Task 2 (useElapsed hook + signature change on formatElapsed).
- Spec §C (50 ms ingress batching) → Task 3 (streamCoalescer.ts + 5 tests + App.tsx wiring).
- Spec §Testing: 11/12 (reducer), tests for elapsed (note: spec deferred to manual since SSR can't observe intervals — added as comment in plan), 13-17 (coalescer). All covered.
- Spec §Failure Modes:
  - "text_delta followed by tool_use_start within < 50ms" → covered by Task 3 test 15.
  - "two tool_use_args_delta with disjoint keys" → covered by test 14 (shallow merge unions them).
  - "agent_end while text_delta buffered" → covered by Task 3 push logic (agent_end is a flush trigger).
  - "Component unmount mid-batch" → covered by Task 3 Step 5 useEffect cleanup.
  - "task_update with agentId for hypothetical future display" → reducer drops it; spec says one branch swap to reintroduce. No test needed for hypothetical.
- Spec §Out of Scope: no tasks added for the items explicitly listed (no comparator, no thinking_delta coalescing, no subagent todo display). Correct.

No gaps.

**2. Placeholder scan**

No "TBD", "TODO", "implement later", or "similar to" patterns. Every step has the full code block. Step 1 of Task 1 says "if ctx?.agentId is not the right accessor, adapt" — this is a deliberate concession because I haven't read the file yet, but the step explicitly tells the implementer how to discover the right accessor (search the file for `agentId` in similar emit sites). Not a placeholder — it's a guarded instruction.

**3. Type consistency**

- `text_delta` shape across Task 3 helper, Task 1 reducer untouched in this plan, and the existing reducer logic: all read `event.text`, `event.agentId`, `event.tokens?`. Consistent.
- `tool_use_args_delta` shape: `event.toolCallId`, `event.args`, `event.agentId`. Consistent across the helper and reducer expectations.
- `createEventCoalescer(onFlush, intervalMs = 50)` signature used identically in test file Step 1 (`createEventCoalescer((e) => out.push(e), 30)`) and helper definition Step 3. Test uses 30 ms for faster test execution; the wiring in App.tsx uses the default 50 ms. Consistent.
- `useElapsed(startedAt, endedAt)` signature matches the call site replacement in Task 2 Step 2. `formatElapsed` signature changes from `(startedAt, endedAt?)` to `(startedAt, now)` — only one call site (inside useElapsed), updated correctly.
- `TaskInfo` shape in Task 1 Step 6 test uses `{ id, title, state }` — flagged as "adjust if the type's required fields differ"; the step itself tells the implementer to verify against `packages/core/src/types.ts`.

Consistency check passes.
