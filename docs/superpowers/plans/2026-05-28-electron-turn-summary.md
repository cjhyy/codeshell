# Electron Turn Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three renderer-only Codex-style improvements to the Electron chat stream: (1) hide empty streaming-assistant placeholder `…` rows, (2) append a folded "files changed" card at each `turn_complete`, (3) force-collapse all expanded tool cards on each turn boundary via a `turnEpoch` counter.

**Architecture:** Renderer-only changes. New pure aggregator `fileChangeAggregator.ts` scans messages from the last user message to the end (including subagent `toolCalls`) to build `FileEditEntry[]`. `applyStreamEvent`'s `turn_complete` branch appends a new `FilesChangedSummaryMessage` and increments `turnEpoch`. Existing `ToolCardShell` and `ToolGroupCard` accept a `turnEpoch` prop and reset their `open` state via `useEffect` when it changes. No engine/core/IPC touched.

**Tech Stack:** React 18 + TypeScript, `bun:test` for unit tests, `react-dom/server.renderToStaticMarkup` for renderer snapshot tests, esbuild + Vite for the desktop build, `lucide-react` icons (ChevronRight/Down already in use).

**Spec reference:** `docs/superpowers/specs/2026-05-28-electron-turn-summary-design.md`

**Working directory assumption:** All paths are relative to repo root `/Users/admin/Documents/个人学习/代码学习/codeshell`. Run all commands from there.

---

## Task 1: Empty-message guard in MessageStream

**Files:**
- Modify: `packages/desktop/src/renderer/MessageStream.tsx:92-106`
- Test: `packages/desktop/src/renderer/MessageStream.test.tsx` (new — does not exist yet; create it)

### Step 1.1 — Write failing test

- [ ] Create `packages/desktop/src/renderer/MessageStream.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageStream } from "./MessageStream";
import type { Message } from "./types";

describe("MessageStream — empty streaming assistant guard", () => {
  test("hides assistant with empty text while streaming", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "hi" },
      { kind: "assistant", id: "a1", text: "", done: false },
    ];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    // The empty streaming assistant must NOT render the … placeholder row.
    expect(html).not.toContain("…");
    // The user message still renders so we know we mounted correctly.
    expect(html).toContain("hi");
  });

  test("renders assistant with non-empty streaming text", () => {
    const messages: Message[] = [
      { kind: "assistant", id: "a1", text: "Hel", done: false },
    ];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    expect(html).toContain("Hel");
  });

  test("renders done assistant with empty text (defensive — never produced by reducer but should not crash)", () => {
    const messages: Message[] = [
      { kind: "assistant", id: "a1", text: "", done: true },
    ];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    // Done branch falls through to Markdown which renders empty content.
    // Just confirm no crash and no literal `…` placeholder.
    expect(html).not.toContain("…");
  });
});
```

### Step 1.2 — Run test, verify failure

- [ ] Run:

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
bun test packages/desktop/src/renderer/MessageStream.test.tsx
```

Expected: First test fails because current code renders `<pre>…</pre>` for empty streaming text.

### Step 1.3 — Apply minimal fix

- [ ] Edit `packages/desktop/src/renderer/MessageStream.tsx`, replace the `case "assistant":` block (lines 92-106):

```tsx
case "assistant":
  if (!m.done && m.text === "") return null;
  return (
    <div
      key={m.id}
      className={`msg-row msg-row-assistant ${m.done ? "done" : "streaming"}`}
    >
      {m.done ? (
        <Markdown text={m.text} />
      ) : (
        <div className="md-body md-streaming">
          <pre>{m.text}</pre>
        </div>
      )}
    </div>
  );
```

Note: removed the `|| "…"` fallback inside `<pre>`. The guard above ensures we never reach the `pre` with empty text during streaming.

### Step 1.4 — Run tests, verify pass

- [ ] Run:

```bash
bun test packages/desktop/src/renderer/MessageStream.test.tsx
```

Expected: All three tests pass.

### Step 1.5 — Typecheck

- [ ] Run:

```bash
cd packages/desktop && bun run typecheck
```

Expected: No errors.

### Step 1.6 — Commit

- [ ] Stage and commit:

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/renderer/MessageStream.tsx packages/desktop/src/renderer/MessageStream.test.tsx
git commit -m "fix(desktop): hide empty streaming assistant placeholder

Empty AssistantMessage created on stream_request_start was rendering as
<pre>…</pre> until first text_delta arrived, producing stray '…' rows
above tool bubbles. Skip rendering when (!done && text === '').

Spec: docs/superpowers/specs/2026-05-28-electron-turn-summary-design.md"
```

---

## Task 2: New types for files-changed summary and turnEpoch

**Files:**
- Modify: `packages/desktop/src/renderer/types.ts`

### Step 2.1 — Add FileEditEntry / FilesChangedSummaryMessage types

- [ ] Edit `packages/desktop/src/renderer/types.ts`. After the `AskUserMessage` interface (around line 117) and before the `Message` union (line 119), insert:

```ts
export interface FileEditEntry {
  path: string;
  added: number;
  removed: number;
  /** Number of tool calls that touched this path in this turn. */
  count: number;
}

/**
 * Codex-style "files changed this turn" summary card, appended on
 * turn_complete when at least one successful Edit/Write/NotebookEdit
 * fired since the last user message. Renderer-computed — no engine
 * event for this; see fileChangeAggregator.ts.
 */
export interface FilesChangedSummaryMessage {
  kind: "files_changed";
  id: string;
  files: FileEditEntry[];
  totalAdded: number;
  totalRemoved: number;
}
```

### Step 2.2 — Extend the Message union

- [ ] In the same file, replace the `Message` union (lines 119-128) with:

```ts
export type Message =
  | UserMessage
  | AssistantMessage
  | ThinkingMessage
  | ToolMessage
  | TaskListMessage
  | AgentMessage
  | ContextBoundaryMessage
  | SystemMessage
  | AskUserMessage
  | FilesChangedSummaryMessage;
```

### Step 2.3 — Add turnEpoch to MessagesReducerState

- [ ] In the same file, locate `MessagesReducerState` (around line 137) and add the field. Replace the interface:

```ts
export interface MessagesReducerState {
  messages: Message[];
  streamingAssistantId: string | null;
  streamingThinkingId: string | null;
  sessionId: string | null;
  promptTokens: number;
  activeAgents: Record<string, AgentRuntime>;
  agentMessageIndex: Record<string, number>;
  /**
   * Monotonic counter incremented on each turn_complete. ToolCard /
   * ToolGroupCard subscribe via prop and force their open state back
   * to false when this changes, so prior-turn details fold out of the
   * way when a new turn finishes.
   */
  turnEpoch: number;
}
```

Keep the JSDoc comments on the existing fields; the diff above is the literal new shape. Preserve the existing JSDoc verbatim for `streamingAssistantId` etc.

- [ ] Update `INITIAL_STATE` (around line 162) to include `turnEpoch: 0`:

```ts
export const INITIAL_STATE: MessagesReducerState = {
  messages: [],
  streamingAssistantId: null,
  streamingThinkingId: null,
  sessionId: null,
  promptTokens: 0,
  activeAgents: {},
  agentMessageIndex: {},
  turnEpoch: 0,
};
```

### Step 2.4 — Typecheck

- [ ] Run:

```bash
cd packages/desktop && bun run typecheck
```

Expected: No errors. (The new union member doesn't yet have switch-case coverage in MessageStream, but the `switch` on `m.kind` falls through without a default for unmatched kinds; TS won't error because the existing exhaustiveness is not enforced via `never`. Confirm by inspecting the output.)

### Step 2.5 — Commit

- [ ] Stage and commit:

```bash
git add packages/desktop/src/renderer/types.ts
git commit -m "feat(desktop/types): add FilesChangedSummaryMessage + turnEpoch

Renderer-only data model additions for the per-turn files-changed
summary card and force-collapse mechanism. No reducer wiring yet —
that lands in the turn_complete extension task.

Spec: docs/superpowers/specs/2026-05-28-electron-turn-summary-design.md"
```

---

## Task 3: File-change aggregator (pure function)

**Files:**
- Create: `packages/desktop/src/renderer/messages/fileChangeAggregator.ts`
- Test: `packages/desktop/src/renderer/messages/fileChangeAggregator.test.ts`

### Step 3.1 — Write failing test

- [ ] Create `packages/desktop/src/renderer/messages/fileChangeAggregator.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { aggregateFileChanges } from "./fileChangeAggregator";
import type { AgentMessage, Message, ToolMessage } from "../types";

function tool(
  toolName: string,
  args: Record<string, unknown>,
  status: ToolMessage["status"] = "succeeded",
  id = `t-${Math.random()}`,
): ToolMessage {
  return {
    kind: "tool",
    id,
    toolName,
    args: JSON.stringify(args),
    status,
    startedAt: 0,
  };
}

function user(text = "hi"): Message {
  return { kind: "user", id: `u-${Math.random()}`, text };
}

describe("aggregateFileChanges", () => {
  test("returns null when no qualifying tools after last user", () => {
    expect(aggregateFileChanges([user(), tool("Read", { file_path: "a.ts" })])).toBeNull();
  });

  test("returns null when message list is empty", () => {
    expect(aggregateFileChanges([])).toBeNull();
  });

  test("returns null when no user message present (defensive)", () => {
    // No user → scan from index 0
    expect(aggregateFileChanges([tool("Read", { file_path: "a.ts" })])).toBeNull();
  });

  test("counts Edit by line diff of old_string vs new_string", () => {
    const msgs: Message[] = [
      user(),
      tool("Edit", { file_path: "a.ts", old_string: "one\ntwo", new_string: "one\ntwo\nthree" }),
    ];
    const entries = aggregateFileChanges(msgs);
    expect(entries).toEqual([{ path: "a.ts", added: 3, removed: 2, count: 1 }]);
  });

  test("counts Write with no removed lines", () => {
    const msgs: Message[] = [
      user(),
      tool("Write", { file_path: "new.ts", content: "line1\nline2\nline3" }),
    ];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "new.ts", added: 3, removed: 0, count: 1 },
    ]);
  });

  test("counts NotebookEdit like Edit (new_source / old_source)", () => {
    const msgs: Message[] = [
      user(),
      tool("NotebookEdit", { file_path: "nb.ipynb", old_source: "x", new_source: "x\ny" }),
    ];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "nb.ipynb", added: 2, removed: 1, count: 1 },
    ]);
  });

  test("merges multiple edits to the same path", () => {
    const msgs: Message[] = [
      user(),
      tool("Edit", { file_path: "a.ts", old_string: "a", new_string: "a\nb" }),
      tool("Edit", { file_path: "a.ts", old_string: "c", new_string: "c\nd\ne" }),
    ];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "a.ts", added: 5, removed: 2, count: 2 },
    ]);
  });

  test("includes subagent toolCalls", () => {
    const agentMsg: AgentMessage = {
      kind: "agent",
      id: "A",
      description: "do stuff",
      done: true,
      startedAt: 0,
      toolCalls: [
        tool("Write", { file_path: "from-agent.ts", content: "hello" }),
      ],
      textBuffer: "",
      toolCount: 1,
    };
    const msgs: Message[] = [user(), agentMsg];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "from-agent.ts", added: 1, removed: 0, count: 1 },
    ]);
  });

  test("excludes failed and cancelled tool calls", () => {
    const msgs: Message[] = [
      user(),
      tool("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }, "failed"),
      tool("Write", { file_path: "b.ts", content: "z" }, "cancelled"),
    ];
    expect(aggregateFileChanges(msgs)).toBeNull();
  });

  test("excludes Read and Bash tools", () => {
    const msgs: Message[] = [
      user(),
      tool("Read", { file_path: "a.ts" }),
      tool("Bash", { command: "ls" }),
    ];
    expect(aggregateFileChanges(msgs)).toBeNull();
  });

  test("scans only after the last user message", () => {
    const msgs: Message[] = [
      user("first"),
      tool("Edit", { file_path: "old.ts", old_string: "a", new_string: "b" }),
      user("second"),
      tool("Edit", { file_path: "new.ts", old_string: "x", new_string: "y\nz" }),
    ];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "new.ts", added: 2, removed: 1, count: 1 },
    ]);
  });

  test("handles malformed args JSON without crashing", () => {
    const msgs: Message[] = [
      user(),
      { ...tool("Edit", {}), args: "not-json" },
      tool("Write", { file_path: "ok.ts", content: "x" }),
    ];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "ok.ts", added: 1, removed: 0, count: 1 },
    ]);
  });

  test("ignores tools missing file_path", () => {
    const msgs: Message[] = [
      user(),
      tool("Edit", { old_string: "a", new_string: "b" /* no file_path */ }),
      tool("Write", { file_path: "ok.ts", content: "x" }),
    ];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "ok.ts", added: 1, removed: 0, count: 1 },
    ]);
  });

  test("supports `path` as alias for file_path", () => {
    const msgs: Message[] = [
      user(),
      tool("Write", { path: "alias.ts", content: "x\ny" }),
    ];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "alias.ts", added: 2, removed: 0, count: 1 },
    ]);
  });
});
```

### Step 3.2 — Run test, verify failure

- [ ] Run:

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
bun test packages/desktop/src/renderer/messages/fileChangeAggregator.test.ts
```

Expected: All tests fail with "module not found" for `./fileChangeAggregator`.

### Step 3.3 — Implement aggregator

- [ ] Create `packages/desktop/src/renderer/messages/fileChangeAggregator.ts`:

```ts
import type { FileEditEntry, Message, ToolMessage } from "../types";

const EDIT_TOOLS = new Set([
  "edit",
  "multiedit",
  "applypatch",
  "apply_patch",
]);
const WRITE_TOOLS = new Set(["write", "filewrite"]);
const NOTEBOOK_TOOLS = new Set(["notebookedit", "notebook_edit"]);

function countLines(s: unknown): number {
  return typeof s === "string" && s.length > 0 ? s.split("\n").length : 0;
}

function parseArgs(t: ToolMessage): Record<string, unknown> {
  try {
    const parsed = JSON.parse(t.args);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function entryFor(t: ToolMessage): { path: string; added: number; removed: number } | null {
  if (t.status !== "succeeded") return null;
  const name = t.toolName.toLowerCase();
  const args = parseArgs(t);
  const path =
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.path === "string" && args.path) ||
    "";
  if (!path) return null;

  if (EDIT_TOOLS.has(name)) {
    return {
      path,
      added: countLines(args.new_string),
      removed: countLines(args.old_string),
    };
  }
  if (WRITE_TOOLS.has(name)) {
    return { path, added: countLines(args.content), removed: 0 };
  }
  if (NOTEBOOK_TOOLS.has(name)) {
    return {
      path,
      added: countLines(args.new_source),
      removed: countLines(args.old_source),
    };
  }
  return null;
}

/**
 * Walk messages from the last user message to the end, collect every
 * successful Edit/Write/NotebookEdit (including subagent toolCalls),
 * merge by path. Returns null when nothing to summarize so the caller
 * skips emitting an empty card.
 */
export function aggregateFileChanges(messages: Message[]): FileEditEntry[] | null {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === "user") {
      start = i;
      break;
    }
  }
  // No user yet → nothing to summarize (defensive; reducer only calls
  // this on turn_complete which implies a user message exists, but
  // bail explicitly so unit tests covering edge cases pass cleanly).
  if (start < 0) return null;

  const byPath = new Map<string, FileEditEntry>();
  const consume = (raw: { path: string; added: number; removed: number }): void => {
    const existing = byPath.get(raw.path);
    if (existing) {
      existing.added += raw.added;
      existing.removed += raw.removed;
      existing.count += 1;
    } else {
      byPath.set(raw.path, { path: raw.path, added: raw.added, removed: raw.removed, count: 1 });
    }
  };

  for (let i = start + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.kind === "tool") {
      const e = entryFor(m);
      if (e) consume(e);
    } else if (m.kind === "agent") {
      for (const t of m.toolCalls) {
        const e = entryFor(t);
        if (e) consume(e);
      }
    }
  }

  if (byPath.size === 0) return null;
  return Array.from(byPath.values());
}
```

### Step 3.4 — Run test, verify pass

- [ ] Run:

```bash
bun test packages/desktop/src/renderer/messages/fileChangeAggregator.test.ts
```

Expected: All tests pass.

### Step 3.5 — Typecheck

- [ ] Run:

```bash
cd packages/desktop && bun run typecheck
```

Expected: No errors.

### Step 3.6 — Commit

- [ ] Stage and commit:

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/renderer/messages/fileChangeAggregator.ts packages/desktop/src/renderer/messages/fileChangeAggregator.test.ts
git commit -m "feat(desktop): fileChangeAggregator pure function

Walks renderer messages from last user → end, collects successful
Edit/Write/NotebookEdit calls (including subagent toolCalls), merges
by path. Renderer-only — no engine event needed. Used next by the
turn_complete reducer extension to emit a Codex-style files-changed
summary card.

Spec: docs/superpowers/specs/2026-05-28-electron-turn-summary-design.md"
```

---

## Task 4: Wire turn_complete to emit files_changed + bump turnEpoch

**Files:**
- Modify: `packages/desktop/src/renderer/types.ts` — `turn_complete` case in `applyStreamEvent`
- Test: `packages/desktop/src/renderer/types.test.ts` (new — does not exist yet; create it)

### Step 4.1 — Write failing test

- [ ] Create `packages/desktop/src/renderer/types.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  applyStreamEvent,
  INITIAL_STATE,
  type MessagesReducerState,
  type Message,
} from "./types";

function withMessages(messages: Message[], over: Partial<MessagesReducerState> = {}): MessagesReducerState {
  return { ...INITIAL_STATE, messages, ...over };
}

describe("applyStreamEvent — turn_complete", () => {
  test("bumps turnEpoch from 0 to 1", () => {
    const next = applyStreamEvent(withMessages([]), { type: "turn_complete" } as never);
    expect(next.turnEpoch).toBe(1);
  });

  test("bumps turnEpoch on every call", () => {
    let s = withMessages([]);
    s = applyStreamEvent(s, { type: "turn_complete" } as never);
    s = applyStreamEvent(s, { type: "turn_complete" } as never);
    s = applyStreamEvent(s, { type: "turn_complete" } as never);
    expect(s.turnEpoch).toBe(3);
  });

  test("appends files_changed message when turn had successful Edits", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "edit a.ts" },
      {
        kind: "tool",
        id: "t1",
        toolName: "Edit",
        args: JSON.stringify({ file_path: "a.ts", old_string: "x", new_string: "y\nz" }),
        status: "succeeded",
        startedAt: 0,
      },
    ];
    const next = applyStreamEvent(withMessages(messages), { type: "turn_complete" } as never);
    const last = next.messages[next.messages.length - 1];
    expect(last.kind).toBe("files_changed");
    if (last.kind === "files_changed") {
      expect(last.files).toEqual([{ path: "a.ts", added: 2, removed: 1, count: 1 }]);
      expect(last.totalAdded).toBe(2);
      expect(last.totalRemoved).toBe(1);
    }
  });

  test("does not append files_changed when no edits happened", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "just read" },
      {
        kind: "tool",
        id: "t1",
        toolName: "Read",
        args: JSON.stringify({ file_path: "a.ts" }),
        status: "succeeded",
        startedAt: 0,
      },
    ];
    const next = applyStreamEvent(withMessages(messages), { type: "turn_complete" } as never);
    // length unchanged
    expect(next.messages.length).toBe(messages.length);
    expect(next.messages.find((m) => m.kind === "files_changed")).toBeUndefined();
  });

  test("replaces stale files_changed within same user-turn (multi turn_complete)", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "edit twice" },
      {
        kind: "tool",
        id: "t1",
        toolName: "Edit",
        args: JSON.stringify({ file_path: "a.ts", old_string: "x", new_string: "y" }),
        status: "succeeded",
        startedAt: 0,
      },
    ];
    let s = withMessages(messages);
    s = applyStreamEvent(s, { type: "turn_complete" } as never);
    const firstCardIdx = s.messages.findIndex((m) => m.kind === "files_changed");
    expect(firstCardIdx).toBeGreaterThan(-1);

    // engine reopens loop and runs another edit, then turn_complete again.
    s = {
      ...s,
      messages: [
        ...s.messages,
        {
          kind: "tool",
          id: "t2",
          toolName: "Write",
          args: JSON.stringify({ file_path: "b.ts", content: "x\ny\nz" }),
          status: "succeeded",
          startedAt: 0,
        },
      ],
    };
    s = applyStreamEvent(s, { type: "turn_complete" } as never);

    const cards = s.messages.filter((m) => m.kind === "files_changed");
    expect(cards.length).toBe(1);
    if (cards[0].kind === "files_changed") {
      // Combined totals from both edits.
      expect(cards[0].files.length).toBe(2);
    }
  });
});
```

### Step 4.2 — Run test, verify failures

- [ ] Run:

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
bun test packages/desktop/src/renderer/types.test.ts
```

Expected: tests for `turnEpoch` bump pass (Task 2 already added the field with init 0, but the `turn_complete` case currently doesn't increment it). Tests for files_changed insertion all fail.

If the `turnEpoch` test also fails, that means Task 2 wasn't completed — go back and verify the `turn_complete` case currently doesn't touch `turnEpoch`.

### Step 4.3 — Extend turn_complete case

- [ ] Edit `packages/desktop/src/renderer/types.ts`. Find the `case "turn_complete":` block (around line 497) and replace its body with:

```ts
    case "turn_complete": {
      // 1. Flush every active agent's textBuffer to its `text` field
      //    (existing behavior).
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

      // 2. Finalize streaming pointers (existing behavior).
      const streamingAssistantId = state.streamingAssistantId;
      const streamingThinkingId = state.streamingThinkingId;
      let finalized: Message[] = msgs.map((m) => {
        if (m.kind === "assistant" && m.id === streamingAssistantId) {
          return { ...m, done: true };
        }
        if (m.kind === "thinking" && m.id === streamingThinkingId) {
          return { ...m, done: true };
        }
        return m;
      });

      // 3. Compute the per-turn files-changed summary. Remove any prior
      //    files_changed from this user-turn first (handles engine
      //    reopening the loop and emitting turn_complete again).
      let lastUserIdx = -1;
      for (let i = finalized.length - 1; i >= 0; i--) {
        if (finalized[i].kind === "user") {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx >= 0) {
        finalized = finalized.filter(
          (m, i) => !(i > lastUserIdx && m.kind === "files_changed"),
        );
      }
      const entries = aggregateFileChanges(finalized);
      if (entries) {
        const totalAdded = entries.reduce((acc, e) => acc + e.added, 0);
        const totalRemoved = entries.reduce((acc, e) => acc + e.removed, 0);
        finalized = [
          ...finalized,
          {
            kind: "files_changed",
            id: freshId("files-changed"),
            files: entries,
            totalAdded,
            totalRemoved,
          },
        ];
      }

      return {
        ...state,
        streamingAssistantId: null,
        streamingThinkingId: null,
        messages: finalized,
        turnEpoch: state.turnEpoch + 1,
      };
    }
```

- [ ] Add the import at the top of `types.ts` (after the existing imports, around line 8):

```ts
import { aggregateFileChanges } from "./messages/fileChangeAggregator";
```

### Step 4.4 — Run test, verify pass

- [ ] Run:

```bash
bun test packages/desktop/src/renderer/types.test.ts
```

Expected: All 5 tests pass.

- [ ] Confirm Task 3 tests still pass:

```bash
bun test packages/desktop/src/renderer/messages/fileChangeAggregator.test.ts
```

### Step 4.5 — Typecheck

- [ ] Run:

```bash
cd packages/desktop && bun run typecheck
```

Expected: No errors.

### Step 4.6 — Commit

- [ ] Stage and commit:

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/renderer/types.ts packages/desktop/src/renderer/types.test.ts
git commit -m "feat(desktop): emit files_changed and bump turnEpoch on turn_complete

After flushing agent buffers and finalizing streaming pointers, the
turn_complete reducer now:
  - removes any prior files_changed from the current user-turn (idempotent
    across multiple turn_complete events in one user-turn),
  - appends a fresh FilesChangedSummaryMessage when aggregateFileChanges
    finds successful Edit/Write/NotebookEdit calls (including subagent),
  - increments turnEpoch so cards can force-collapse on each turn boundary.

Spec: docs/superpowers/specs/2026-05-28-electron-turn-summary-design.md"
```

---

## Task 5: FilesChangedCard component

**Files:**
- Create: `packages/desktop/src/renderer/messages/FilesChangedCard.tsx`
- Test: `packages/desktop/src/renderer/messages/FilesChangedCard.test.tsx`
- Modify: `packages/desktop/src/renderer/styles/` (add CSS — see Step 5.5)

### Step 5.1 — Write failing test

- [ ] Create `packages/desktop/src/renderer/messages/FilesChangedCard.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FilesChangedCard } from "./FilesChangedCard";
import type { FilesChangedSummaryMessage } from "../types";

function card(over: Partial<FilesChangedSummaryMessage> = {}): FilesChangedSummaryMessage {
  return {
    kind: "files_changed",
    id: "fc1",
    files: [{ path: "a.ts", added: 5, removed: 2, count: 1 }],
    totalAdded: 5,
    totalRemoved: 2,
    ...over,
  };
}

describe("FilesChangedCard", () => {
  test("renders folded summary header", () => {
    const html = renderToStaticMarkup(<FilesChangedCard message={card()} />);
    expect(html).toContain("已编辑 1 个文件");
    expect(html).toContain("+5");
    expect(html).toContain("-2");
    // Folded by default — no path row in DOM.
    expect(html).not.toContain("a.ts");
  });

  test("plural file count label", () => {
    const m = card({
      files: [
        { path: "a.ts", added: 1, removed: 0, count: 1 },
        { path: "b.ts", added: 2, removed: 1, count: 1 },
        { path: "c.ts", added: 3, removed: 2, count: 1 },
      ],
      totalAdded: 6,
      totalRemoved: 3,
    });
    const html = renderToStaticMarkup(<FilesChangedCard message={m} />);
    expect(html).toContain("已编辑 3 个文件");
    expect(html).toContain("+6");
    expect(html).toContain("-3");
  });
});
```

### Step 5.2 — Run test, verify failure

- [ ] Run:

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
bun test packages/desktop/src/renderer/messages/FilesChangedCard.test.tsx
```

Expected: failure with "module not found".

### Step 5.3 — Implement FilesChangedCard

- [ ] Create `packages/desktop/src/renderer/messages/FilesChangedCard.tsx`:

```tsx
import React, { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import type { FilesChangedSummaryMessage } from "../types";
import { truncate } from "../tool-cards/utils";

interface Props {
  message: FilesChangedSummaryMessage;
}

const INITIAL_VISIBLE = 3;

/**
 * Codex-style per-turn summary: "已编辑 N 个文件 +X -Y" folded by
 * default; expanding shows each file path with its +/- counts.
 * Created on turn_complete (see types.ts), so initial state is always
 * collapsed — no turnEpoch wiring needed.
 */
export function FilesChangedCard({ message }: Props) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const { files, totalAdded, totalRemoved } = message;
  const visible = showAll ? files : files.slice(0, INITIAL_VISIBLE);
  const remaining = files.length - visible.length;

  return (
    <div className={`files-changed-card${open ? " open" : ""}`}>
      <button
        type="button"
        className="files-changed-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="files-changed-label">已编辑 {files.length} 个文件</span>
        <span className="files-changed-totals">
          <span className="files-changed-added">+{totalAdded}</span>
          <span className="files-changed-removed">-{totalRemoved}</span>
        </span>
      </button>
      {open && (
        <div className="files-changed-body">
          {visible.map((f) => (
            <div key={f.path} className="files-changed-row">
              <span className="files-changed-path">{truncate(f.path, 70)}</span>
              <span className="files-changed-added">+{f.added}</span>
              <span className="files-changed-removed">-{f.removed}</span>
            </div>
          ))}
          {remaining > 0 && (
            <button
              type="button"
              className="files-changed-show-more"
              onClick={() => setShowAll(true)}
            >
              再显示 {remaining} 个文件 ▾
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

### Step 5.4 — Run test, verify pass

- [ ] Run:

```bash
bun test packages/desktop/src/renderer/messages/FilesChangedCard.test.tsx
```

Expected: Both tests pass.

### Step 5.5 — Add CSS

- [ ] Find the renderer's main stylesheet. Run:

```bash
ls packages/desktop/src/renderer/styles/
```

Identify the file that contains `.tool-group` styles (use grep):

```bash
grep -rln "\.tool-group" packages/desktop/src/renderer/styles/
```

- [ ] Append to that stylesheet (likely `packages/desktop/src/renderer/styles/chat.css` or similar — use whichever file holds `.tool-group`):

```css
/* ----- Files-changed summary card (per-turn Codex-style) ----- */

.files-changed-card {
  margin: 8px 0;
  border: 1px solid var(--border-subtle, #e5e7eb);
  border-radius: 8px;
  background: var(--surface-subtle, #fafafa);
  overflow: hidden;
}

.files-changed-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  border: none;
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
}

.files-changed-head:hover {
  background: var(--surface-hover, rgba(0, 0, 0, 0.03));
}

.files-changed-label {
  flex: 1;
  font-weight: 500;
}

.files-changed-totals {
  display: inline-flex;
  gap: 8px;
  font-variant-numeric: tabular-nums;
  font-size: 0.875em;
}

.files-changed-added {
  color: var(--diff-added, #16a34a);
}

.files-changed-removed {
  color: var(--diff-removed, #dc2626);
}

.files-changed-body {
  padding: 4px 12px 12px 28px;
  border-top: 1px solid var(--border-subtle, #e5e7eb);
}

.files-changed-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.875em;
}

.files-changed-path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.files-changed-show-more {
  margin-top: 6px;
  background: transparent;
  border: none;
  color: var(--text-muted, #6b7280);
  cursor: pointer;
  padding: 4px 0;
  font: inherit;
  font-size: 0.875em;
}

.files-changed-show-more:hover {
  color: var(--text-default, #111827);
}
```

Note: CSS variables like `--border-subtle`, `--diff-added` may not exist in this codebase. The fallback hex values keep it functional. If you find the codebase uses different variable names by greping existing CSS, substitute them.

### Step 5.6 — Wire into MessageStream

- [ ] Edit `packages/desktop/src/renderer/MessageStream.tsx`. Add import after existing message-view imports (around line 11):

```tsx
import { FilesChangedCard } from "./messages/FilesChangedCard";
```

- [ ] Add a switch case for `files_changed` inside the `switch (m.kind)` block (after `case "system":`, before the closing `}`):

```tsx
case "files_changed":
  return <FilesChangedCard key={m.id} message={m} />;
```

### Step 5.7 — Typecheck

- [ ] Run:

```bash
cd packages/desktop && bun run typecheck
```

Expected: No errors.

### Step 5.8 — Commit

- [ ] Stage and commit:

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/renderer/messages/FilesChangedCard.tsx \
        packages/desktop/src/renderer/messages/FilesChangedCard.test.tsx \
        packages/desktop/src/renderer/MessageStream.tsx \
        packages/desktop/src/renderer/styles/
git commit -m "feat(desktop): FilesChangedCard component + CSS

Codex-style folded summary card showing 'edited N files +X -Y' with
expandable per-file rows. Wired into MessageStream as a new case in
the message-kind switch. Initial state always collapsed.

Spec: docs/superpowers/specs/2026-05-28-electron-turn-summary-design.md"
```

---

## Task 6: turnEpoch prop — ToolCardShell

**Files:**
- Modify: `packages/desktop/src/renderer/tool-cards/ToolCardShell.tsx`

### Step 6.1 — Write failing test

- [ ] Create `packages/desktop/src/renderer/tool-cards/ToolCardShell.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import React from "react";
import { act, render } from "@testing-library/react";
import { ToolCardShell } from "./ToolCardShell";
import type { ToolMessage } from "../types";

function msg(): ToolMessage {
  return {
    kind: "tool",
    id: "t1",
    toolName: "Read",
    args: "{}",
    status: "succeeded",
    startedAt: 0,
  };
}

describe("ToolCardShell — turnEpoch force-collapse", () => {
  test("re-collapses when turnEpoch increases", () => {
    const { container, rerender } = render(
      <ToolCardShell message={msg()} summary="hello" details={<div>body</div>} turnEpoch={0} />,
    );
    // Open the card by clicking the head button.
    const button = container.querySelector(".tool-card-head") as HTMLButtonElement;
    act(() => {
      button.click();
    });
    expect(container.querySelector(".tool-card-body")).not.toBeNull();

    // Bump the epoch — effect should close the card.
    rerender(
      <ToolCardShell message={msg()} summary="hello" details={<div>body</div>} turnEpoch={1} />,
    );
    expect(container.querySelector(".tool-card-body")).toBeNull();
  });
});
```

Note: this test uses `@testing-library/react`. Check if it's already a dep:

```bash
cd packages/desktop && grep -E "@testing-library/react|react-dom/server" package.json
```

If `@testing-library/react` is **not** present, switch to a `renderToStaticMarkup`-based test instead — but staticMarkup can't simulate clicks, so just verify the prop change doesn't crash and that the rendered output for `turnEpoch=N` with no user interaction is identical to the baseline. Replace the test body with:

```tsx
test("accepts turnEpoch prop without errors", () => {
  // Compile-time prop check + does not crash at render.
  const html = renderToStaticMarkup(
    <ToolCardShell message={msg()} summary="hello" details={<div>body</div>} turnEpoch={5} />,
  );
  expect(html).toContain("Read");
});
```

(The actual force-collapse behavior would then be covered by manual UI verification in Task 9.)

### Step 6.2 — Run test, verify failure

- [ ] Run:

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
bun test packages/desktop/src/renderer/tool-cards/ToolCardShell.test.tsx
```

Expected: failure — `turnEpoch` prop not in Props interface yet.

### Step 6.3 — Add turnEpoch prop and effect

- [ ] Edit `packages/desktop/src/renderer/tool-cards/ToolCardShell.tsx`. Replace the entire file with:

```tsx
import React from "react";
import type { ToolMessage } from "../types";
import { ChevronRight, ChevronDown } from "../ui/icons";
import { StatusDot, type Status } from "../ui/StatusDot";
import { formatDuration } from "./utils";

interface Props {
  message: ToolMessage;
  /** One-line summary shown on the head row. */
  summary: React.ReactNode;
  /** Optional rich detail when the card is expanded inline. */
  details?: React.ReactNode;
  onSelect?: (m: ToolMessage) => void;
  selected?: boolean;
  /**
   * Monotonic per-turn counter. When this value changes the card
   * re-collapses, even if the user had opened it during streaming —
   * Codex-style "turn ends, details fold back out of the way."
   */
  turnEpoch?: number;
}

export function ToolCardShell({
  message,
  summary,
  details,
  onSelect,
  selected,
  turnEpoch,
}: Props) {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (turnEpoch !== undefined) setOpen(false);
  }, [turnEpoch]);
  const status: Status =
    message.status === "running"
      ? "running"
      : message.status === "failed" || message.status === "denied"
        ? "err"
        : message.status === "succeeded"
          ? "ok"
          : message.status === "cancelled"
            ? "warn"
            : "idle";
  const duration = formatDuration(message.durationMs);
  return (
    <div
      className={`tool-card status-${message.status}${selected ? " selected" : ""}`}
      onClick={() => onSelect?.(message)}
    >
      <button
        className="tool-card-head"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <StatusDot status={status} title={message.status} />
        <span className="tool-card-name">{message.toolName}</span>
        <span className="tool-card-summary">{summary}</span>
        {duration && <span className="tool-card-duration">{duration}</span>}
        {message.status === "failed" && (
          <span className="tool-card-err-badge">error</span>
        )}
      </button>
      {open && details && <div className="tool-card-body">{details}</div>}
      {message.summary && (
        <div className="tool-card-subtitle">{message.summary}</div>
      )}
    </div>
  );
}
```

### Step 6.4 — Run test, verify pass

- [ ] Run:

```bash
bun test packages/desktop/src/renderer/tool-cards/ToolCardShell.test.tsx
```

Expected: passes.

### Step 6.5 — Typecheck

- [ ] Run:

```bash
cd packages/desktop && bun run typecheck
```

Expected: pre-existing call sites (`FileToolCard`, `BashToolCard`, etc.) that don't pass `turnEpoch` should still compile — the prop is optional. Confirm zero errors.

### Step 6.6 — Commit

- [ ] Stage and commit:

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/renderer/tool-cards/ToolCardShell.tsx \
        packages/desktop/src/renderer/tool-cards/ToolCardShell.test.tsx
git commit -m "feat(desktop): ToolCardShell accepts turnEpoch to force-collapse

When the prop changes value, an effect resets open → false. Caller
opt-in: existing call sites that don't pass turnEpoch keep their
current behavior. Next task wires the prop through ToolCard and
MessageStream.

Spec: docs/superpowers/specs/2026-05-28-electron-turn-summary-design.md"
```

---

## Task 7: Plumb turnEpoch through ToolCard and ToolGroupCard

**Files:**
- Modify: `packages/desktop/src/renderer/tool-cards/index.tsx`
- Modify: `packages/desktop/src/renderer/tool-cards/BashToolCard.tsx`
- Modify: `packages/desktop/src/renderer/tool-cards/FileToolCard.tsx`
- Modify: `packages/desktop/src/renderer/tool-cards/SearchToolCard.tsx`
- Modify: `packages/desktop/src/renderer/tool-cards/WebToolCard.tsx`
- Modify: `packages/desktop/src/renderer/tool-cards/AgentToolCard.tsx`
- Modify: `packages/desktop/src/renderer/tool-cards/GenericToolCard.tsx`
- Modify: `packages/desktop/src/renderer/messages/ToolGroupCard.tsx`

### Step 7.1 — Update ToolCard props and pass-through

- [ ] Edit `packages/desktop/src/renderer/tool-cards/index.tsx`. Replace the file with:

```tsx
import React, { memo } from "react";
import type { ToolMessage } from "../types";
import { BashToolCard } from "./BashToolCard";
import { FileToolCard } from "./FileToolCard";
import { SearchToolCard } from "./SearchToolCard";
import { WebToolCard } from "./WebToolCard";
import { AgentToolCard } from "./AgentToolCard";
import { GenericToolCard } from "./GenericToolCard";

interface Props {
  message: ToolMessage;
  onSelect?: (m: ToolMessage) => void;
  selectedId?: string | null;
  turnEpoch?: number;
}

function ToolCardImpl({ message, onSelect, selectedId, turnEpoch }: Props) {
  const selected = selectedId === message.id;
  const name = message.toolName.toLowerCase();

  if (name === "bash" || name === "shell" || name === "run") {
    return <BashToolCard message={message} onSelect={onSelect} selected={selected} turnEpoch={turnEpoch} />;
  }
  if (name === "read" || name === "view" || name === "fileread") {
    return <FileToolCard message={message} variant="read" onSelect={onSelect} selected={selected} turnEpoch={turnEpoch} />;
  }
  if (name === "write" || name === "filewrite") {
    return <FileToolCard message={message} variant="write" onSelect={onSelect} selected={selected} turnEpoch={turnEpoch} />;
  }
  if (name === "edit" || name === "multiedit" || name === "applypatch" || name === "apply_patch") {
    return <FileToolCard message={message} variant="edit" onSelect={onSelect} selected={selected} turnEpoch={turnEpoch} />;
  }
  if (name === "grep" || name === "glob" || name === "search") {
    return <SearchToolCard message={message} onSelect={onSelect} selected={selected} turnEpoch={turnEpoch} />;
  }
  if (name === "webfetch" || name === "websearch" || name === "fetch") {
    return <WebToolCard message={message} onSelect={onSelect} selected={selected} turnEpoch={turnEpoch} />;
  }
  if (name === "agent" || name === "task" || name.startsWith("agent")) {
    return <AgentToolCard message={message} onSelect={onSelect} selected={selected} turnEpoch={turnEpoch} />;
  }
  return <GenericToolCard message={message} onSelect={onSelect} selected={selected} turnEpoch={turnEpoch} />;
}

export const ToolCard = memo(ToolCardImpl);
```

### Step 7.2 — Add turnEpoch to each leaf tool card

For each of the six leaf tool cards (`BashToolCard`, `FileToolCard`, `SearchToolCard`, `WebToolCard`, `AgentToolCard`, `GenericToolCard`):

- [ ] Open the file. Locate the `Props` interface (or `interface Props { ... }` definition).
- [ ] Add `turnEpoch?: number;` to Props.
- [ ] Locate where it instantiates `<ToolCardShell ... />`. Add `turnEpoch={turnEpoch}` to the prop list.
- [ ] Update the function signature to destructure `turnEpoch`.

Example for `FileToolCard.tsx` — replace the Props interface (lines 6-12) with:

```tsx
interface Props {
  message: ToolMessage;
  onSelect?: (m: ToolMessage) => void;
  selected?: boolean;
  /** "read" or "write" — affects the summary verbiage and detail layout. */
  variant: "read" | "write" | "edit";
  turnEpoch?: number;
}
```

Update the function signature and ToolCardShell call (line 14 and lines 86-94):

```tsx
export function FileToolCard({ message, onSelect, selected, variant, turnEpoch }: Props) {
  // ... existing logic unchanged ...
  return (
    <ToolCardShell
      message={message}
      summary={summary}
      details={details}
      onSelect={onSelect}
      selected={selected}
      turnEpoch={turnEpoch}
    />
  );
}
```

Apply the equivalent pattern to BashToolCard, SearchToolCard, WebToolCard, AgentToolCard, GenericToolCard.

### Step 7.3 — Update ToolGroupCard

- [ ] Edit `packages/desktop/src/renderer/messages/ToolGroupCard.tsx`. Replace the file:

```tsx
import React, { useState, useEffect } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { ToolCard } from "../tool-cards";
import { categoryLabel, type ToolGroup } from "./streamGroups";

interface Props {
  group: ToolGroup;
  turnEpoch?: number;
}

/**
 * Codex-style collapsed run of tool calls. Default state is collapsed
 * with a one-line summary like "已编辑 5 个文件 ▶". Clicking expands
 * the row to render every member ToolCard inline so the detail isn't
 * lost — it's just out of the way until you ask for it.
 *
 * On turnEpoch change, the group force-collapses back to summary.
 */
export function ToolGroupCard({ group, turnEpoch }: Props) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (turnEpoch !== undefined) setOpen(false);
  }, [turnEpoch]);
  const label = categoryLabel(group.category, group.tools.length);

  return (
    <div className={`tool-group${open ? " open" : ""}`}>
      <button
        type="button"
        className="tool-group-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="tool-group-label">{label}</span>
      </button>
      {open && (
        <div className="tool-group-body">
          {group.tools.map((t) => (
            <ToolCard key={t.id} message={t} turnEpoch={turnEpoch} />
          ))}
        </div>
      )}
    </div>
  );
}
```

### Step 7.4 — Typecheck

- [ ] Run:

```bash
cd packages/desktop && bun run typecheck
```

Expected: zero errors.

### Step 7.5 — Run all existing tests, verify nothing broke

- [ ] Run:

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
bun test packages/desktop/src/renderer/
```

Expected: All tests pass (Tasks 1-6's tests still green).

### Step 7.6 — Commit

- [ ] Stage and commit:

```bash
git add packages/desktop/src/renderer/tool-cards/ \
        packages/desktop/src/renderer/messages/ToolGroupCard.tsx
git commit -m "feat(desktop): plumb turnEpoch through ToolCard + ToolGroupCard

Each leaf tool card now forwards turnEpoch to ToolCardShell; ToolGroupCard
mirrors ToolCardShell's effect and also propagates to its inner ToolCards
when expanded.

Spec: docs/superpowers/specs/2026-05-28-electron-turn-summary-design.md"
```

---

## Task 8: MessageStream + ChatView + App wiring

**Files:**
- Modify: `packages/desktop/src/renderer/MessageStream.tsx` — accept `turnEpoch` prop, pass to ToolCard / ToolGroupCard
- Modify: `packages/desktop/src/renderer/ChatView.tsx` — accept `turnEpoch` prop, forward to MessageStream
- Modify: `packages/desktop/src/renderer/App.tsx` — pass `state.turnEpoch` to ChatView

### Step 8.1 — MessageStream

- [ ] Edit `packages/desktop/src/renderer/MessageStream.tsx`. Update the `Props` interface:

```tsx
interface Props {
  messages: Message[];
  onAskUserAnswer?: (requestId: string, answer: string) => void;
  trailing?: React.ReactNode;
  trailingKey?: string | null;
  /**
   * Monotonic counter incremented on each turn_complete. Forwarded to
   * tool cards so they force-collapse on each turn boundary.
   */
  turnEpoch?: number;
}
```

- [ ] Update the function signature:

```tsx
export function MessageStream({
  messages,
  onAskUserAnswer,
  trailing,
  trailingKey,
  turnEpoch,
}: Props) {
```

- [ ] Forward `turnEpoch` at the two render sites. Find the `tool_group` and `tool` cases:

```tsx
if (m.kind === "tool_group") {
  return <ToolGroupCard key={m.id} group={m} turnEpoch={turnEpoch} />;
}
switch (m.kind) {
  case "tool":
    return <ToolCard key={m.id} message={m} turnEpoch={turnEpoch} />;
  // ...
```

### Step 8.2 — ChatView

- [ ] Edit `packages/desktop/src/renderer/ChatView.tsx`. Find the `Props` interface (around line 26). Add `turnEpoch?: number`. Then in the body (around line 256), update the `<MessageStream ... />` call:

```tsx
<MessageStream
  messages={messages}
  onAskUserAnswer={onAskUserAnswer}
  trailing={inlineApproval}
  trailingKey={pendingApproval?.requestId ?? null}
  turnEpoch={turnEpoch}
/>
```

Also destructure `turnEpoch` from the props at the top of the component.

### Step 8.3 — App.tsx

- [ ] Edit `packages/desktop/src/renderer/App.tsx`. Find the `<ChatView ... />` block (around line 1046). Add `turnEpoch={state.turnEpoch}` to the prop list (after `messages={state.messages}`):

```tsx
<ChatView
  messages={state.messages}
  turnEpoch={state.turnEpoch}
  onSend={send}
  // ...rest unchanged
```

### Step 8.4 — Typecheck

- [ ] Run:

```bash
cd packages/desktop && bun run typecheck
```

Expected: zero errors.

### Step 8.5 — Run all tests

- [ ] Run:

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
bun test packages/desktop/src/renderer/
```

Expected: all pass.

### Step 8.6 — Commit

- [ ] Stage and commit:

```bash
git add packages/desktop/src/renderer/MessageStream.tsx \
        packages/desktop/src/renderer/ChatView.tsx \
        packages/desktop/src/renderer/App.tsx
git commit -m "feat(desktop): wire turnEpoch from reducer state into MessageStream

App → ChatView → MessageStream → ToolCard / ToolGroupCard. Closes
the loop on the force-collapse mechanism: turn_complete bumps the
counter, all tool cards in the stream re-collapse via their effect.

Spec: docs/superpowers/specs/2026-05-28-electron-turn-summary-design.md"
```

---

## Task 9: UI verification (manual via /verify)

**Files:** No code changes. Run the Electron app and observe.

### Step 9.1 — Build and launch

- [ ] Run:

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop
bun run dev
```

Wait for the Electron window to appear.

### Step 9.2 — Verify empty-message fix

- [ ] In the chat, ask the assistant a question whose answer begins with a tool call (e.g., "list files in this folder").
- [ ] Observe: no stray `…` row should appear between your message and the first tool bubble.
- [ ] Check the chat history for any other turn that previously had a `…` — should now be clean.

### Step 9.3 — Verify files-changed card

- [ ] Ask the assistant to edit a file (e.g., "add a comment to README.md").
- [ ] After the turn completes, scroll to the end of the turn. A folded card should appear:
  ```
  ▶ 已编辑 1 个文件  +N -M
  ```
- [ ] Click the chevron — the card should expand to show the path and the per-file `+N -M`.
- [ ] Ask the assistant to edit multiple files (e.g., "add a header comment to 3 files"). Verify:
  - Card shows `已编辑 3 个文件` with combined totals
  - Expanding shows all three paths
- [ ] Trigger a subagent (e.g., "use a Task agent to fix something") and verify the subagent's edits also appear in the parent turn's files-changed card.

### Step 9.4 — Verify force-collapse

- [ ] During a streaming response with several tool calls, manually click to expand 2-3 tool cards.
- [ ] After the turn completes, observe: all previously-expanded cards should collapse back.
- [ ] Send another message and repeat — collapse should fire on each turn boundary.

### Step 9.5 — Regression checks

- [ ] Stop and restart a generation (Esc / Stop button). Confirm:
  - No crashed renderer
  - No stuck `…` rows
- [ ] Run a long bash command. Confirm:
  - During streaming, the bash card can be expanded
  - After `turn_complete`, it collapses

### Step 9.6 — Final commit (if any UI polish needed)

If any visual issues were spotted (CSS misalignment, color mismatch), fix them now in `packages/desktop/src/renderer/styles/` and commit:

- [ ] Commit:

```bash
git add packages/desktop/src/renderer/styles/
git commit -m "style(desktop): polish files-changed card visuals after UI verify"
```

Otherwise skip this step.

---

## Self-review checklist (done before handing back)

- [x] **Spec coverage:**
  - Empty-message fix → Task 1
  - FileEditEntry / FilesChangedSummaryMessage types → Task 2
  - turnEpoch state field → Task 2
  - Aggregator pure function → Task 3
  - turn_complete reducer wiring → Task 4
  - FilesChangedCard component + CSS → Task 5
  - turnEpoch on ToolCardShell → Task 6
  - Plumbing through ToolCard + leaf cards + ToolGroupCard → Task 7
  - MessageStream / ChatView / App wiring → Task 8
  - Manual UI verification → Task 9
- [x] **Placeholder scan:** No "TBD" or "implement later". Every code block is complete.
- [x] **Type consistency:** `FileEditEntry`, `FilesChangedSummaryMessage`, `turnEpoch` names match across tasks.
- [x] **Files-touched parity with spec:** Matches the spec's "Files touched" list.
- [x] **`aggregateFileChanges` signature** consistent between definition (Task 3) and call site (Task 4).
- [x] **`turnEpoch` prop optional** in every component that takes it — no breakage for existing test fixtures.
