# Desktop Subagent Content Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop subagent stream events from being folded into the main assistant message in the desktop renderer; route them O(1) into their owning `AgentMessage`, and only render them when the user expands that card.

**Architecture:** Extend `AgentMessage` with per-agent `toolCalls`, `textBuffer`, and `toolCount` fields. Add an `agentMessageIndex` to reducer state so events with an `agentId` patch the right card via O(1) index lookup instead of `state.messages.map()`. Buffer subagent `text_delta` and flush only at `turn_complete`/`agent_end`. Drop subagent `thinking_delta` and `stream_request_start`. `AgentMessageView` becomes collapsible (local `expanded` state, `React.memo` wrapped) and renders its tool calls by reusing the existing `ToolCard` dispatcher.

**Tech Stack:** React 18, TypeScript, `bun:test`. All changes in `packages/desktop/src/renderer/`. Tests follow the existing convention in `packages/desktop/src/renderer/chat/attachments.test.ts` (colocated `*.test.ts`/`*.test.tsx` files using `bun:test`).

**Spec:** `docs/superpowers/specs/2026-05-28-desktop-subagent-isolation-design.md`

---

## File Structure

**Modify:**
- `packages/desktop/src/renderer/types.ts` — extend `AgentMessage` interface, extend `MessagesReducerState` with `agentMessageIndex`, rewrite affected `applyStreamEvent` cases.
- `packages/desktop/src/renderer/messages/AgentMessageView.tsx` — add fold/expand state, render `toolCalls` via `ToolCard` when expanded, wrap in `React.memo`. Also render the final `text` through `Markdown` so subagent output renders like main-agent output.

**Create:**
- `packages/desktop/src/renderer/types.test.ts` — reducer behavior tests (7 cases per spec §Testing).
- `packages/desktop/src/renderer/messages/AgentMessageView.test.tsx` — fold/expand rendering test.

**Reuse (no edits required):**
- `packages/desktop/src/renderer/tool-cards/index.tsx` `ToolCard({ message })` — already accepts a `ToolMessage` and dispatches to the right card.
- `packages/desktop/src/renderer/Markdown.tsx` — for final subagent text.

---

## Task 1: Extend the data model

**Files:**
- Modify: `packages/desktop/src/renderer/types.ts:62-72` (AgentMessage), `:131-156` (state + initial state)

This task only changes type declarations and the initial state. No reducer logic moves yet; existing behavior stays intact.

- [ ] **Step 1: Add new fields to `AgentMessage`**

Replace the existing interface at `packages/desktop/src/renderer/types.ts:62-72`:

```ts
export interface AgentMessage {
  kind: "agent";
  id: string; // === agentId
  name?: string;
  description: string;
  done: boolean;
  text?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  /** Tool calls made by this subagent, in arrival order. */
  toolCalls: ToolMessage[];
  /** Accumulating text_delta payload; flushed to `text` on turn_complete / agent_end. */
  textBuffer: string;
  /** Cheap counter for the folded header. Equals toolCalls.length. */
  toolCount: number;
}
```

Note: `expanded` is intentionally NOT on this interface — it's local to `AgentMessageView`.

- [ ] **Step 2: Add `agentMessageIndex` to reducer state**

In `packages/desktop/src/renderer/types.ts`, modify the `MessagesReducerState` interface (around line 131) to add one field at the end:

```ts
export interface MessagesReducerState {
  messages: Message[];
  streamingAssistantId: string | null;
  streamingThinkingId: string | null;
  sessionId: string | null;
  promptTokens: number;
  activeAgents: Record<string, AgentRuntime>;
  /** agentId → index in `messages`. Set on agent_start; stable for the agent's lifetime
   * because AgentMessages are append-only and never removed mid-session. */
  agentMessageIndex: Record<string, number>;
}
```

And update `INITIAL_STATE` (around line 149) to include the new field:

```ts
export const INITIAL_STATE: MessagesReducerState = {
  messages: [],
  streamingAssistantId: null,
  streamingThinkingId: null,
  sessionId: null,
  promptTokens: 0,
  activeAgents: {},
  agentMessageIndex: {},
};
```

- [ ] **Step 3: Update `agent_start` to populate index and new fields**

In `packages/desktop/src/renderer/types.ts`, the existing `agent_start` case (around line 328) currently does:

```ts
case "agent_start": {
  const startedAt = Date.now();
  return {
    ...state,
    activeAgents: { ...state.activeAgents, [event.agentId]: { ... } },
    messages: [
      ...state.messages,
      { kind: "agent", id: event.agentId, name: event.name, description: event.description, done: false, startedAt },
    ],
  };
}
```

Replace it with:

```ts
case "agent_start": {
  const startedAt = Date.now();
  const newIndex = state.messages.length;
  return {
    ...state,
    activeAgents: {
      ...state.activeAgents,
      [event.agentId]: {
        agentId: event.agentId,
        name: event.name,
        description: event.description,
        startedAt,
      },
    },
    messages: [
      ...state.messages,
      {
        kind: "agent",
        id: event.agentId,
        name: event.name,
        description: event.description,
        done: false,
        startedAt,
        toolCalls: [],
        textBuffer: "",
        toolCount: 0,
      },
    ],
    agentMessageIndex: {
      ...state.agentMessageIndex,
      [event.agentId]: newIndex,
    },
  };
}
```

- [ ] **Step 4: Run typecheck**

Run from repo root:
```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop && bun run typecheck
```
Expected: pass. (If existing call sites construct `AgentMessage` literals elsewhere, the new required fields will surface as type errors here. Fix any such sites by adding `toolCalls: []`, `textBuffer: ""`, `toolCount: 0`.)

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/renderer/types.ts
git commit -m "feat(desktop): extend AgentMessage with toolCalls/textBuffer + agent index

Lays groundwork for routing subagent stream events O(1) into their
owning AgentMessage instead of folding them into the main assistant
message.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Write reducer tests (red)

**Files:**
- Create: `packages/desktop/src/renderer/types.test.ts`

We write all reducer tests first, then make them pass in Task 3. This validates the spec's seven test scenarios against `applyStreamEvent` in isolation.

- [ ] **Step 1: Create the test file**

Create `packages/desktop/src/renderer/types.test.ts` with this exact content:

```ts
import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import {
  INITIAL_STATE,
  applyStreamEvent,
  type AgentMessage,
  type AssistantMessage,
  type MessagesReducerState,
} from "./types";

// ── helpers ─────────────────────────────────────────────────────────
function dispatch(
  state: MessagesReducerState,
  events: StreamEvent[],
): MessagesReducerState {
  return events.reduce((s, e) => applyStreamEvent(s, e), state);
}

function ev<T extends StreamEvent["type"]>(
  type: T,
  rest: Omit<Extract<StreamEvent, { type: T }>, "type">,
): StreamEvent {
  return { type, ...rest } as StreamEvent;
}

const mainTurn = (): StreamEvent[] => [
  ev("stream_request_start", { turnNumber: 1 } as any),
];

const startAgent = (
  agentId: string,
  name = "Sub",
  description = "doing work",
): StreamEvent =>
  ev("agent_start", { agentId, name, description } as any);

const findAgent = (state: MessagesReducerState, agentId: string): AgentMessage => {
  const m = state.messages.find((x) => x.kind === "agent" && x.id === agentId);
  if (!m || m.kind !== "agent") throw new Error(`no agent ${agentId}`);
  return m;
};

const findMainAssistant = (state: MessagesReducerState): AssistantMessage => {
  const m = state.messages.find(
    (x) => x.kind === "assistant" && x.id === state.streamingAssistantId,
  );
  if (!m || m.kind !== "assistant") throw new Error("no streaming assistant");
  return m;
};

// ── tests ───────────────────────────────────────────────────────────

describe("applyStreamEvent — subagent isolation", () => {
  test("1. text_delta with agentId does not touch main assistant", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      ev("text_delta", { text: "main says hi" } as any),
      startAgent("A"),
      ev("text_delta", { agentId: "A", text: "child noise" } as any),
    ]);
    expect(findMainAssistant(s).text).toBe("main says hi");
    expect(findAgent(s, "A").textBuffer).toBe("child noise");
  });

  test("2. tool_use_start/result with agentId routes to that agent's toolCalls", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      ev("tool_use_start", {
        agentId: "A",
        toolCall: { id: "t1", toolName: "Read", args: { file: "x" } },
      } as any),
      ev("tool_result", {
        agentId: "A",
        result: { id: "t1", toolName: "Read", result: "ok" },
      } as any),
    ]);
    const agent = findAgent(s, "A");
    expect(agent.toolCalls.length).toBe(1);
    expect(agent.toolCalls[0]!.toolName).toBe("Read");
    expect(agent.toolCalls[0]!.status).toBe("succeeded");
    expect(agent.toolCount).toBe(1);
    // And no top-level tool message:
    expect(s.messages.filter((m) => m.kind === "tool").length).toBe(0);
  });

  test("3. concurrent agents keep their textBuffers separate", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      startAgent("B"),
      ev("text_delta", { agentId: "A", text: "aaa" } as any),
      ev("text_delta", { agentId: "B", text: "bbb" } as any),
      ev("text_delta", { agentId: "A", text: "AAA" } as any),
    ]);
    expect(findAgent(s, "A").textBuffer).toBe("aaaAAA");
    expect(findAgent(s, "B").textBuffer).toBe("bbb");
  });

  test("4. turn_complete flushes textBuffer to text and clears buffer", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      ev("text_delta", { agentId: "A", text: "hello world" } as any),
      ev("turn_complete", {} as any),
    ]);
    const agent = findAgent(s, "A");
    expect(agent.text).toBe("hello world");
    expect(agent.textBuffer).toBe("");
  });

  test("5. text_delta for unknown agentId is dropped (state unchanged)", () => {
    const before = dispatch(INITIAL_STATE, [...mainTurn()]);
    const after = applyStreamEvent(
      before,
      ev("text_delta", { agentId: "ghost", text: "x" } as any),
    );
    expect(after).toBe(before); // strict reference equality
  });

  test("6. stream_request_start while an agent is active does not open a new main assistant", () => {
    const s = dispatch(INITIAL_STATE, [...mainTurn(), startAgent("A")]);
    const before = s;
    const after = applyStreamEvent(before, ev("stream_request_start", {} as any));
    expect(after.streamingAssistantId).toBe(before.streamingAssistantId);
    expect(after.messages.length).toBe(before.messages.length);
  });

  test("7. 10000 subagent deltas: main assistant reference is stable", () => {
    let s = dispatch(INITIAL_STATE, [...mainTurn(), startAgent("A")]);
    const mainAssistantBefore = findMainAssistant(s);
    for (let i = 0; i < 10000; i++) {
      s = applyStreamEvent(
        s,
        ev("text_delta", { agentId: "A", text: "x" } as any),
      );
    }
    const mainAssistantAfter = findMainAssistant(s);
    expect(mainAssistantAfter).toBe(mainAssistantBefore); // same ref
    expect(findAgent(s, "A").textBuffer.length).toBe(10000);
  });

  test("8. subagent thinking_delta is dropped (no thinking message appended)", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      ev("thinking_delta", { agentId: "A", text: "internal monologue" } as any),
    ]);
    expect(s.messages.filter((m) => m.kind === "thinking").length).toBe(0);
    expect(s.streamingThinkingId).toBeNull();
  });

  test("9. agent_end flushes residual textBuffer", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      ev("text_delta", { agentId: "A", text: "tail" } as any),
      ev("agent_end", { agentId: "A", text: undefined } as any),
    ]);
    const agent = findAgent(s, "A");
    expect(agent.text).toBe("tail");
    expect(agent.textBuffer).toBe("");
    expect(agent.done).toBe(true);
  });

  test("10. main-agent text_delta still appends to main assistant (regression)", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      ev("text_delta", { text: "abc" } as any),
      ev("text_delta", { text: "def" } as any),
    ]);
    expect(findMainAssistant(s).text).toBe("abcdef");
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
bun test packages/desktop/src/renderer/types.test.ts
```

Expected: most tests fail. Specifically:
- Test 1 fails (subagent text leaks into main).
- Test 2 fails (no tool routing — top-level tool message exists).
- Test 3 fails (textBuffer not populated).
- Test 4 fails (text never gets flushed).
- Test 5 may pass by accident (state will likely be unchanged because no streaming assistant matches the unknown id — verify but don't rely on it).
- Test 6 fails (current reducer always pushes a new assistant).
- Test 7 fails (main assistant reference changes).
- Test 8 fails (thinking message gets created).
- Test 9 fails (no flush).
- Test 10 should pass already.

That's the red bar. Do not commit yet — we'll commit after the implementation passes them in Task 3.

---

## Task 3: Implement reducer changes (green)

**Files:**
- Modify: `packages/desktop/src/renderer/types.ts:197-207` (text_delta), `:209-230` (thinking_delta), `:232-248` (tool_use_start), `:250-259` (tool_use_args_delta), `:261-279` (tool_result), `:281-292` (tool_summary), `:186-195` (stream_request_start), `:355-367` (agent_end), `:396-411` (turn_complete)

We replace each affected case to honor `event.agentId`. After all replacements, the entire reducer test suite from Task 2 should pass.

- [ ] **Step 1: Replace the `text_delta` case**

In `packages/desktop/src/renderer/types.ts`, replace the existing case (around line 197):

```ts
case "text_delta": {
  // Subagent text never enters the main feed — it accumulates in the
  // owning AgentMessage's textBuffer and is flushed to `text` on
  // turn_complete / agent_end. This is the hot path that froze the
  // UI in session s-mpo7fju0-7d6942b7.
  if (event.agentId) {
    const idx = state.agentMessageIndex[event.agentId];
    if (idx === undefined) return state;
    const msgs = state.messages.slice();
    const m = msgs[idx];
    if (!m || m.kind !== "agent") return state;
    msgs[idx] = { ...m, textBuffer: m.textBuffer + event.text };
    return { ...state, messages: msgs };
  }
  if (!state.streamingAssistantId) return state;
  return {
    ...state,
    messages: state.messages.map((m) =>
      m.kind === "assistant" && m.id === state.streamingAssistantId
        ? { ...m, text: m.text + event.text }
        : m,
    ),
  };
}
```

- [ ] **Step 2: Replace the `thinking_delta` case**

Replace the existing case (around line 209):

```ts
case "thinking_delta": {
  // Subagent thinking is dropped — same as TUI. No user value in the
  // folded card, and rendering it would defeat the freeze fix.
  if (event.agentId) return state;
  if (!state.streamingThinkingId) {
    const id = freshId("thinking");
    return {
      ...state,
      streamingThinkingId: id,
      messages: [
        ...state.messages,
        { kind: "thinking", id, text: event.text, done: false, agentId: event.agentId },
      ],
    };
  }
  return {
    ...state,
    messages: state.messages.map((m) =>
      m.kind === "thinking" && m.id === state.streamingThinkingId
        ? { ...m, text: m.text + event.text }
        : m,
    ),
  };
}
```

- [ ] **Step 3: Replace the `tool_use_start` case**

Replace (around line 232):

```ts
case "tool_use_start": {
  const id = event.toolCall.id;
  const toolMsg: ToolMessage = {
    kind: "tool",
    id,
    toolName: event.toolCall.toolName,
    args: JSON.stringify(event.toolCall.args ?? {}),
    status: "running",
    startedAt: Date.now(),
  };
  if (event.agentId) {
    const idx = state.agentMessageIndex[event.agentId];
    if (idx === undefined) return state;
    const msgs = state.messages.slice();
    const m = msgs[idx];
    if (!m || m.kind !== "agent") return state;
    msgs[idx] = {
      ...m,
      toolCalls: [...m.toolCalls, toolMsg],
      toolCount: m.toolCount + 1,
    };
    return { ...state, messages: msgs };
  }
  return { ...state, messages: [...state.messages, toolMsg] };
}
```

- [ ] **Step 4: Replace the `tool_use_args_delta` case**

Replace (around line 250):

```ts
case "tool_use_args_delta": {
  if (event.agentId) {
    const idx = state.agentMessageIndex[event.agentId];
    if (idx === undefined) return state;
    const msgs = state.messages.slice();
    const m = msgs[idx];
    if (!m || m.kind !== "agent") return state;
    msgs[idx] = {
      ...m,
      toolCalls: m.toolCalls.map((t) =>
        t.id === event.toolCallId
          ? { ...t, argsLive: { ...(t.argsLive ?? {}), ...event.args } }
          : t,
      ),
    };
    return { ...state, messages: msgs };
  }
  return {
    ...state,
    messages: state.messages.map((m) =>
      m.kind === "tool" && m.id === event.toolCallId
        ? { ...m, argsLive: { ...(m.argsLive ?? {}), ...event.args } }
        : m,
    ),
  };
}
```

- [ ] **Step 5: Replace the `tool_result` case**

Replace (around line 261):

```ts
case "tool_result": {
  const endedAt = Date.now();
  const patch = (t: ToolMessage): ToolMessage => {
    const failed =
      event.result.error !== undefined || event.result.isError === true;
    return {
      ...t,
      result: event.result.result,
      error: event.result.error,
      status: failed ? "failed" : "succeeded",
      endedAt,
      durationMs: endedAt - t.startedAt,
    };
  };
  if (event.agentId) {
    const idx = state.agentMessageIndex[event.agentId];
    if (idx === undefined) return state;
    const msgs = state.messages.slice();
    const m = msgs[idx];
    if (!m || m.kind !== "agent") return state;
    msgs[idx] = {
      ...m,
      toolCalls: m.toolCalls.map((t) =>
        t.id === event.result.id ? patch(t) : t,
      ),
    };
    return { ...state, messages: msgs };
  }
  return {
    ...state,
    messages: state.messages.map((m) => {
      if (m.kind !== "tool" || m.id !== event.result.id) return m;
      return patch(m);
    }),
  };
}
```

- [ ] **Step 6: Replace the `tool_summary` case**

Replace (around line 281):

```ts
case "tool_summary": {
  if (event.agentId) {
    const idx = state.agentMessageIndex[event.agentId];
    if (idx === undefined) return state;
    const msgs = state.messages.slice();
    const m = msgs[idx];
    if (!m || m.kind !== "agent" || m.toolCalls.length === 0) return state;
    const newToolCalls = m.toolCalls.slice();
    const last = newToolCalls[newToolCalls.length - 1]!;
    newToolCalls[newToolCalls.length - 1] = { ...last, summary: event.summary };
    msgs[idx] = { ...m, toolCalls: newToolCalls };
    return { ...state, messages: msgs };
  }
  // Attach to most recent top-level tool message.
  const msgs = state.messages.slice();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.kind === "tool") {
      msgs[i] = { ...m, summary: event.summary };
      return { ...state, messages: msgs };
    }
  }
  return state;
}
```

- [ ] **Step 7: Replace the `stream_request_start` case**

Replace (around line 186):

```ts
case "stream_request_start": {
  // If a subagent is active, this request_start belongs to it (the
  // event itself doesn't carry agentId). Don't open a new main
  // assistant message — that would create a phantom card in the feed.
  if (Object.keys(state.activeAgents).length > 0) return state;
  const id = freshId("assistant");
  return {
    ...state,
    messages: [...state.messages, { kind: "assistant", id, text: "", done: false }],
    streamingAssistantId: id,
    streamingThinkingId: null,
  };
}
```

- [ ] **Step 8: Replace the `agent_end` case**

Replace (around line 355):

```ts
case "agent_end": {
  const endedAt = Date.now();
  const { [event.agentId]: _omit, ...rest } = state.activeAgents;
  const idx = state.agentMessageIndex[event.agentId];
  const msgs = state.messages.slice();
  if (idx !== undefined) {
    const m = msgs[idx];
    if (m && m.kind === "agent") {
      const flushed = m.textBuffer.length > 0
        ? (m.text ?? "") + m.textBuffer
        : m.text;
      msgs[idx] = {
        ...m,
        done: true,
        text: event.text ?? flushed,
        textBuffer: "",
        error: event.error,
        endedAt,
      };
    }
  }
  return { ...state, activeAgents: rest, messages: msgs };
}
```

- [ ] **Step 9: Replace the `turn_complete` case**

Replace (around line 396):

```ts
case "turn_complete": {
  // Flush every active agent's textBuffer to its `text` field.
  const msgs = state.messages.slice();
  for (const agentId of Object.keys(state.activeAgents)) {
    const idx = state.agentMessageIndex[agentId];
    if (idx === undefined) continue;
    const m = msgs[idx];
    if (!m || m.kind !== "agent" || m.textBuffer.length === 0) continue;
    msgs[idx] = {
      ...m,
      text: (m.text ?? "") + m.textBuffer,
      textBuffer: "",
    };
  }
  // Main-feed finalization (unchanged behavior for streaming pointers).
  const streamingAssistantId = state.streamingAssistantId;
  const streamingThinkingId = state.streamingThinkingId;
  return {
    ...state,
    streamingAssistantId: null,
    streamingThinkingId: null,
    messages: msgs.map((m) => {
      if (m.kind === "assistant" && m.id === streamingAssistantId) {
        return { ...m, done: true };
      }
      if (m.kind === "thinking" && m.id === streamingThinkingId) {
        return { ...m, done: true };
      }
      return m;
    }),
  };
}
```

- [ ] **Step 10: Run the reducer tests**

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
bun test packages/desktop/src/renderer/types.test.ts
```

Expected: all 10 tests pass. If any fail, fix the corresponding case before proceeding — do not move forward with red tests.

- [ ] **Step 11: Run typecheck**

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop && bun run typecheck
```

Expected: pass.

- [ ] **Step 12: Commit**

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/renderer/types.ts packages/desktop/src/renderer/types.test.ts
git commit -m "fix(desktop): route subagent stream events into AgentMessage, not main feed

Subagent text_delta no longer pollutes the streaming main assistant
message. Tool calls route to per-agent toolCalls arrays via O(1) index
lookup. Subagent thinking is dropped. stream_request_start during an
active subagent no longer opens a phantom main assistant. textBuffer
flushes on turn_complete and agent_end.

This is the freeze fix for session s-mpo7fju0-7d6942b7 where 10566
subagent deltas triggered O(messages × deltas) rebuilds.

Reducer is now fully unit-tested in types.test.ts (10 cases).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Foldable AgentMessageView with ToolCard reuse

**Files:**
- Modify: `packages/desktop/src/renderer/messages/AgentMessageView.tsx` (full rewrite)
- Create: `packages/desktop/src/renderer/messages/AgentMessageView.test.tsx`

- [ ] **Step 1: Write the rendering test**

Create `packages/desktop/src/renderer/messages/AgentMessageView.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMessageView } from "./AgentMessageView";
import type { AgentMessage, ToolMessage } from "../types";

function tool(id: string, name = "Read"): ToolMessage {
  return {
    kind: "tool",
    id,
    toolName: name,
    args: "{}",
    status: "succeeded",
    startedAt: 0,
    endedAt: 10,
    durationMs: 10,
    result: "ok",
  };
}

function agent(over: Partial<AgentMessage> = {}): AgentMessage {
  return {
    kind: "agent",
    id: "A",
    name: "Sub",
    description: "doing work",
    done: false,
    startedAt: 0,
    toolCalls: [],
    textBuffer: "",
    toolCount: 0,
    ...over,
  };
}

describe("AgentMessageView", () => {
  test("folded by default — does not render any tool cards", () => {
    const m = agent({ toolCalls: [tool("t1"), tool("t2")], toolCount: 2 });
    const html = renderToStaticMarkup(<AgentMessageView message={m} />);
    expect(html).toContain("Sub");
    expect(html).toContain("doing work");
    // ToolCard renders elements with className containing "tool-" — confirm
    // none are present while folded.
    expect(html).not.toMatch(/class="[^"]*tool-/);
  });

  test("folded header shows tool count when > 0", () => {
    const m = agent({ toolCount: 3 });
    const html = renderToStaticMarkup(<AgentMessageView message={m} />);
    expect(html).toContain("3");
  });

  test("done agent renders final text", () => {
    const m = agent({ done: true, text: "final answer" });
    const html = renderToStaticMarkup(<AgentMessageView message={m} />);
    expect(html).toContain("final answer");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (compilation error or assertion)**

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
bun test packages/desktop/src/renderer/messages/AgentMessageView.test.tsx
```

Expected: at minimum the "toolCount" test fails (current view doesn't render the count). Some tests may pass coincidentally since the current view also doesn't render toolCalls.

- [ ] **Step 3: Rewrite `AgentMessageView.tsx`**

Replace the entire file `packages/desktop/src/renderer/messages/AgentMessageView.tsx`:

```tsx
import React, { useState, memo } from "react";
import type { AgentMessage } from "../types";
import { StatusDot } from "../ui/StatusDot";
import { ToolCard } from "../tool-cards";
import { Markdown } from "../Markdown";

function formatElapsed(startedAt: number, endedAt?: number): string {
  const ms = (endedAt ?? Date.now()) - startedAt;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${rem}s`;
}

function AgentMessageViewImpl({ message }: { message: AgentMessage }) {
  const [expanded, setExpanded] = useState(false);
  const status = message.error ? "err" : message.done ? "ok" : "running";
  const elapsed = formatElapsed(message.startedAt, message.endedAt);
  const hasBody = message.toolCalls.length > 0 || !!message.text || !!message.error;

  return (
    <div className="msg-row msg-agent">
      <div className={`msg-agent-card ${expanded ? "expanded" : "folded"}`}>
        <button
          type="button"
          className="msg-agent-head"
          onClick={() => hasBody && setExpanded((v) => !v)}
          aria-expanded={expanded}
          disabled={!hasBody}
        >
          <StatusDot status={status} />
          <span className="msg-agent-name">{message.name ?? "agent"}</span>
          <span className="msg-agent-desc">{message.description}</span>
          <span className="msg-agent-meta">
            {elapsed}
            {message.toolCount > 0 && ` · ${message.toolCount} tools`}
          </span>
          {hasBody && (
            <span className="msg-agent-toggle">{expanded ? "▾" : "▸"}</span>
          )}
        </button>
        {expanded && (
          <div className="msg-agent-body">
            {message.toolCalls.map((t) => (
              <ToolCard key={t.id} message={t} />
            ))}
            {message.text && (
              <div className="msg-agent-text">
                <Markdown text={message.text} />
              </div>
            )}
            {message.error && <div className="msg-agent-err">{message.error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Memoized so subagent events that update one card don't re-render
 * sibling cards. Reducer produces a new AgentMessage object only when
 * that agent's own event arrives, so shallow comparison is correct.
 */
export const AgentMessageView = memo(AgentMessageViewImpl);
```

- [ ] **Step 4: Run the test again to verify it passes**

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
bun test packages/desktop/src/renderer/messages/AgentMessageView.test.tsx
```

Expected: all 3 tests pass.

- [ ] **Step 5: Run typecheck**

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop && bun run typecheck
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/renderer/messages/AgentMessageView.tsx packages/desktop/src/renderer/messages/AgentMessageView.test.tsx
git commit -m "feat(desktop): foldable AgentMessageView, renders subagent tool calls on expand

Folded by default shows status, name, description, elapsed, tool
count. Expanding reveals the per-agent tool calls (reusing the main
feed's ToolCard dispatcher) and final text (through Markdown).

Wrapped in React.memo so subagent event updates don't re-render
sibling cards — paired with the reducer's per-agent object-identity
guarantee from Task 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Minimal CSS for new header/body layout

**Files:**
- Modify: `packages/desktop/src/renderer/styles/` (find the file currently styling `.msg-agent-card`)

The new component uses a few new class names (`.expanded`, `.folded`, `.msg-agent-meta`, `.msg-agent-toggle`, `.msg-agent-body`). The existing `.msg-agent-card`, `.msg-agent-head`, `.msg-agent-name`, `.msg-agent-desc`, `.msg-agent-text`, `.msg-agent-err` classes stay used.

- [ ] **Step 1: Locate the existing AgentMessageView styles**

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
grep -rn "msg-agent-card\|msg-agent-head" packages/desktop/src/renderer/styles/ 2>/dev/null
```

Note the file path and line range of existing `.msg-agent-*` rules.

- [ ] **Step 2: Add minimal styles for the new classes**

Open the file found in Step 1. After the existing `.msg-agent-*` block, append:

```css
.msg-agent-head {
  /* If the existing rule already styles .msg-agent-head, MERGE these
     properties in rather than duplicating. cursor + width + reset
     button styles are the additions because the head is now a <button>. */
  cursor: pointer;
  width: 100%;
  background: none;
  border: 0;
  text-align: left;
  font: inherit;
  color: inherit;
  display: flex;
  align-items: center;
  gap: 8px;
}
.msg-agent-head:disabled {
  cursor: default;
}
.msg-agent-meta {
  margin-left: auto;
  opacity: 0.6;
  font-size: 0.85em;
}
.msg-agent-toggle {
  opacity: 0.6;
  font-size: 0.85em;
  width: 1em;
  text-align: center;
}
.msg-agent-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}
```

If the existing `.msg-agent-head` already has `display: flex; align-items: center; gap: …`, drop the duplicated properties from the new block and keep only `cursor`, `width`, `background`, `border`, `text-align`, `font`, `color`. The button reset is the only essential addition.

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/renderer/styles/
git commit -m "style(desktop): agent card header as button + expanded body layout

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: End-to-end manual verification

This task confirms the freeze is gone in the actual desktop app using the same kind of subagent-heavy workload that produced the original bug. No code changes.

**Files:** none.

- [ ] **Step 1: Build and start the desktop app**

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop && bun run dev
```

Wait for the Electron window to appear.

- [ ] **Step 2: Trigger a multi-subagent workload**

In the running app's chat, send a prompt that the agent will likely answer by dispatching parallel subagents. Example:

> "Read every file in packages/core/src/tool-system/ and have a subagent score each one for code quality. Run them in parallel."

This mirrors the workload that produced the original freeze.

- [ ] **Step 3: Observe behavior during streaming**

Verify by direct observation:
- Multiple AgentMessage cards appear in the main feed, one per subagent.
- Each card is folded by default and shows `name · description · elapsed · N tools`.
- The main feed stays responsive while subagents stream (scrolling, typing in the composer, etc.).
- No subagent text appears in the main streaming `AssistantMessage`.

- [ ] **Step 4: Expand a card and verify tool list**

Click an AgentMessage header. Confirm:
- It expands to reveal the tool calls.
- Tool cards render correctly (Bash/Read/etc. variants picked by ToolCard dispatcher).
- After the agent completes, the final text appears under the tool list, rendered as markdown.

- [ ] **Step 5: Capture the session log for the record**

The new session's jsonl will be at `~/.code-shell/logs/desktop/sessions/session-<sessionId>.jsonl`. Note the session ID and confirm the file exists. No need to commit it; just retain for future regression comparison.

- [ ] **Step 6: Stop the app**

`Ctrl+C` the `bun run dev` process.

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:

- Spec §Data Model → Task 1 (extend AgentMessage, add agentMessageIndex)
- Spec §Reducer Behavior, all event-type sub-sections → Task 3 (steps 1-9 cover text_delta, thinking_delta, tool_use_start, tool_use_args_delta, tool_result, tool_summary, stream_request_start, agent_end, turn_complete)
- Spec §Rendering → Task 4 (foldable view, React.memo, ToolCard reuse, Markdown for final text)
- Spec §Why This Resolves the Freeze (object identity guarantee + folded DOM cost) → Task 3 Step 10 test 7 (reference stability under 10k deltas) + Task 4 Step 1 test "folded by default — does not render any tool cards"
- Spec §Testing — all 7 numbered tests in the spec map to test cases in Task 2 (tests 1-7), with extras 8/9/10 for thinking-drop, agent_end flush, and main-agent regression
- Spec §Out of Scope items are not implemented (correct)

No gaps.

**2. Placeholder scan** — checked for TBD/TODO/"implement later"/"similar to"/handwave-only steps. None found. Every code-changing step has a complete code block. Every test step has the actual assertion code.

**3. Type consistency** —
- `AgentMessage.toolCalls: ToolMessage[]` declared in Task 1 Step 1, consumed in Task 3 (steps 3-6) and Task 4 (Step 3 rendering, Step 1 test factory).
- `agentMessageIndex` named consistently across Task 1 Step 2, Task 1 Step 3, Task 3 (all index-lookup steps), Task 3 Step 8 (agent_end), Task 3 Step 9 (turn_complete).
- `textBuffer` referenced identically across Task 1, Task 2 tests, Task 3 steps 1/8/9.
- `toolCount: number` declared in Task 1, set/incremented in Task 3 Step 3, displayed in Task 4 Step 3 (`message.toolCount > 0 && …`).
- `expanded` is local state — confirmed not added to interface (Task 1 Step 1 has the explicit note); used only in Task 4 Step 3 via `useState`.
- `StreamEvent` import path `@cjhyy/code-shell-core` matches `types.ts:8`.
- `bun:test` matches the existing `chat/attachments.test.ts` convention.
- `renderToStaticMarkup` from `react-dom/server` — react-dom is already a `dependencies` entry per the desktop `package.json` inspection.
- `ToolCard` from `../tool-cards` and `Markdown` from `../Markdown` — both confirmed against `MessageStream.tsx:3-4`.

Consistency check passes. No edits needed.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-28-desktop-subagent-isolation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best fit here: 6 focused tasks, each in a different file, clean review checkpoints.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

Which approach?
