# Background sub-agent completion notification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a background sub-agent finishes, deliver its final text to the main agent's `messages` as a new user turn (XML-wrapped), batching multiple completions and respecting idle/overlay state. Result text becomes single-source-of-truth in `messages`; `asyncAgentRegistry` keeps lifecycle metadata only.

**Architecture:** Mirror Claude Code's `commandQueue` + `useQueueProcessor` pattern. Tool-system side: a new `notificationQueue` module singleton parallel to `asyncAgentRegistry`. UI side: an inline `useEffect` in `App.tsx` that fires when the queue is non-empty AND the main agent is idle AND no overlays/input are pending — drains the queue, builds an XML message, submits via an extracted `submitToEngine` helper.

**Tech Stack:** TypeScript, Bun test runner, React (custom Ink fork), no new runtime deps.

**Spec:** `docs/superpowers/specs/2026-05-20-bg-agent-completion-notification-design.md`

---

## File Structure

**Created:**

- `src/tool-system/builtin/agent-notifications.ts` — `NotificationItem` type, `notificationQueue` singleton (subscribe/enqueue/drainAll/reset), `buildNotificationMessage` (LLM-facing XML), `buildNotificationSummary` (UI-facing string).
- `tests/agent-notifications.test.ts` — unit tests for the queue + formatters.

**Modified:**

- `src/tool-system/builtin/agent-registry.ts` — drop `result`/`error` fields from `AsyncAgentEntry`; narrow `markCompleted`/`markFailed` signatures; add `markCancelled`.
- `src/tool-system/builtin/agent.ts` — rewrite background-path `.then/.catch`: call `markCompleted/Failed/Cancelled` without text, and enqueue notification for completed/failed only.
- `src/ui/store.ts` — extend `SystemSubtype` union with `"bg_agent_notification"`.
- `src/ui/App.tsx` — extract `submitToEngine` helper from `handleSubmit`; add `useNotificationProcessor` effect; renderEntry branch for the new system subtype.

**Test files modified:** `tests/agent-notifications.test.ts` (new). No other existing tests need updates because nothing tests the `result`/`error` fields we are removing.

---

## Task 1: NotificationItem type + queue singleton (no formatters)

**Files:**
- Create: `src/tool-system/builtin/agent-notifications.ts`
- Test: `tests/agent-notifications.test.ts`

- [ ] **Step 1.1: Write the failing tests for the queue API**

Create `tests/agent-notifications.test.ts`:

```ts
import { describe, expect, test, beforeEach } from "bun:test";
import { notificationQueue, type NotificationItem } from "../src/tool-system/builtin/agent-notifications.js";

const fixture = (overrides: Partial<NotificationItem> = {}): NotificationItem => ({
  agentId: "abc12345",
  name: "Explore",
  description: "调研 AI 公司新闻",
  status: "completed",
  finalText: "Found 3 stories.",
  enqueuedAt: 1_700_000_000_000,
  ...overrides,
});

beforeEach(() => {
  notificationQueue.reset();
});

describe("notificationQueue", () => {
  test("starts empty", () => {
    expect(notificationQueue.getSnapshot()).toEqual([]);
  });

  test("enqueue appends to snapshot", () => {
    notificationQueue.enqueue(fixture());
    expect(notificationQueue.getSnapshot()).toHaveLength(1);
    expect(notificationQueue.getSnapshot()[0]!.agentId).toBe("abc12345");
  });

  test("multiple enqueues preserve order", () => {
    notificationQueue.enqueue(fixture({ agentId: "a" }));
    notificationQueue.enqueue(fixture({ agentId: "b" }));
    notificationQueue.enqueue(fixture({ agentId: "c" }));
    expect(notificationQueue.getSnapshot().map((i) => i.agentId)).toEqual(["a", "b", "c"]);
  });

  test("drainAll returns all items and clears queue", () => {
    notificationQueue.enqueue(fixture({ agentId: "a" }));
    notificationQueue.enqueue(fixture({ agentId: "b" }));
    const drained = notificationQueue.drainAll();
    expect(drained).toHaveLength(2);
    expect(notificationQueue.getSnapshot()).toEqual([]);
  });

  test("drainAll on empty queue returns empty array", () => {
    expect(notificationQueue.drainAll()).toEqual([]);
  });

  test("reset clears queue", () => {
    notificationQueue.enqueue(fixture());
    notificationQueue.reset();
    expect(notificationQueue.getSnapshot()).toEqual([]);
  });

  test("subscribe is notified on enqueue", () => {
    let calls = 0;
    const unsub = notificationQueue.subscribe(() => {
      calls += 1;
    });
    notificationQueue.enqueue(fixture());
    expect(calls).toBe(1);
    notificationQueue.enqueue(fixture());
    expect(calls).toBe(2);
    unsub();
  });

  test("subscribe is notified on drainAll", () => {
    let calls = 0;
    notificationQueue.subscribe(() => {
      calls += 1;
    });
    notificationQueue.enqueue(fixture());
    calls = 0; // reset count after enqueue
    notificationQueue.drainAll();
    expect(calls).toBe(1);
  });

  test("unsubscribe stops notifications", () => {
    let calls = 0;
    const unsub = notificationQueue.subscribe(() => {
      calls += 1;
    });
    unsub();
    notificationQueue.enqueue(fixture());
    expect(calls).toBe(0);
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `bun test tests/agent-notifications.test.ts`

Expected: All tests fail with `Cannot find module '../src/tool-system/builtin/agent-notifications.js'`.

- [ ] **Step 1.3: Implement the queue**

Create `src/tool-system/builtin/agent-notifications.ts`:

```ts
/**
 * Background-agent completion notification queue.
 *
 * Mirrors Claude Code's `commandQueue` with `mode: 'task-notification'`. A
 * background sub-agent that finishes (completed | failed) enqueues an item
 * here; the UI layer subscribes and, when the main agent is idle, drains
 * the queue and submits the formatted XML as a new user turn so the LLM
 * sees the result. Cancellation does NOT enqueue (user explicitly stopped
 * the agent; no follow-up needed).
 *
 * The result text lives only in this queue + the eventual user message —
 * not in `asyncAgentRegistry`. Registry stays metadata-only.
 *
 * Process-local singleton; same lifetime contract as `asyncAgentRegistry`.
 */

export type NotificationItem = {
  agentId: string;
  name?: string;
  description: string;
  status: "completed" | "failed";
  /** Final assistant text (completed only). */
  finalText?: string;
  /** Error message (failed only). */
  error?: string;
  enqueuedAt: number;
};

type Listener = () => void;

class NotificationQueue {
  private items: NotificationItem[] = [];
  private listeners = new Set<Listener>();

  enqueue(item: NotificationItem): void {
    this.items = [...this.items, item];
    this.notify();
  }

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): NotificationItem[] => this.items;

  /** Atomic: returns all items and clears in one shot. */
  drainAll(): NotificationItem[] {
    if (this.items.length === 0) return [];
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
      try {
        cb();
      } catch {
        // isolate per-listener errors
      }
    }
  }
}

export const notificationQueue = new NotificationQueue();
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `bun test tests/agent-notifications.test.ts`

Expected: All 8 tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add src/tool-system/builtin/agent-notifications.ts tests/agent-notifications.test.ts
git commit -m "$(cat <<'EOF'
feat(agent-notifications): introduce notification queue singleton

Mirrors Claude Code's commandQueue: a background sub-agent enqueues a
NotificationItem on completion/failure; the UI layer subscribes and
will drain it when the main agent is idle. Result text lives in the
queue (then in the eventual user message), keeping asyncAgentRegistry
metadata-only.

Spec: docs/superpowers/specs/2026-05-20-bg-agent-completion-notification-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: buildNotificationMessage (LLM-facing XML)

**Files:**
- Modify: `src/tool-system/builtin/agent-notifications.ts`
- Test: `tests/agent-notifications.test.ts`

- [ ] **Step 2.1: Write the failing tests**

Append to `tests/agent-notifications.test.ts`:

```ts
import { buildNotificationMessage } from "../src/tool-system/builtin/agent-notifications.js";

describe("buildNotificationMessage", () => {
  test("single completed item", () => {
    const msg = buildNotificationMessage([
      {
        agentId: "abc12345",
        name: "Explore",
        description: "调研 AI 公司新闻",
        status: "completed",
        finalText: "Found 3 stories.",
        enqueuedAt: 0,
      },
    ]);
    expect(msg).toContain("<background-agents-completed>");
    expect(msg).toContain(`<agent id="abc12345" name="Explore" status="completed">`);
    expect(msg).toContain("<description>调研 AI 公司新闻</description>");
    expect(msg).toContain("Found 3 stories.");
    expect(msg).toContain("</background-agents-completed>");
  });

  test("single failed item with error", () => {
    const msg = buildNotificationMessage([
      {
        agentId: "def67890",
        description: "Plan migration",
        status: "failed",
        error: "Engine timed out after 60s",
        enqueuedAt: 0,
      },
    ]);
    expect(msg).toContain(`<agent id="def67890" status="failed">`);
    expect(msg).toContain("<error>Engine timed out after 60s</error>");
    expect(msg).not.toContain("<result>");
  });

  test("agent without name omits name attribute", () => {
    const msg = buildNotificationMessage([
      {
        agentId: "x",
        description: "d",
        status: "completed",
        finalText: "ok",
        enqueuedAt: 0,
      },
    ]);
    expect(msg).toContain(`<agent id="x" status="completed">`);
    expect(msg).not.toContain(`name=`);
  });

  test("multiple items render as siblings", () => {
    const msg = buildNotificationMessage([
      { agentId: "a", description: "task A", status: "completed", finalText: "A done", enqueuedAt: 0 },
      { agentId: "b", description: "task B", status: "failed", error: "boom", enqueuedAt: 0 },
    ]);
    const agentCount = (msg.match(/<agent /g) ?? []).length;
    expect(agentCount).toBe(2);
    expect(msg).toContain("A done");
    expect(msg).toContain("boom");
  });

  test("trailing instructional sentence is present", () => {
    const msg = buildNotificationMessage([
      { agentId: "a", description: "d", status: "completed", finalText: "x", enqueuedAt: 0 },
    ]);
    expect(msg).toMatch(/Address them appropriately/);
  });

  test("escapes XML-special characters in user-provided fields", () => {
    const msg = buildNotificationMessage([
      {
        agentId: "x",
        name: "K&R",
        description: "find <foo> and replace with \"bar\"",
        status: "completed",
        finalText: "AT&T merged with X<Y>",
        enqueuedAt: 0,
      },
    ]);
    // Tag scaffolding intact
    expect(msg).toContain("<background-agents-completed>");
    expect(msg).toContain("</background-agents-completed>");
    // Ampersand escaped in attribute and body
    expect(msg).toContain("K&amp;R");
    expect(msg).toContain("AT&amp;T");
    // Angle brackets escaped in body
    expect(msg).toContain("find &lt;foo&gt;");
    expect(msg).toContain("X&lt;Y&gt;");
    // Quote escaped in attribute (name attribute is quoted with ")
    expect(msg).toMatch(/name="K&amp;R"/);
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `bun test tests/agent-notifications.test.ts`

Expected: New tests fail with `buildNotificationMessage is not a function` or similar.

- [ ] **Step 2.3: Implement buildNotificationMessage**

Append to `src/tool-system/builtin/agent-notifications.ts`:

```ts
/**
 * Escape XML-special characters. We only emit a fixed handful of tags, so
 * we can hand-roll this rather than pulling in a full encoder. Attribute
 * values get the quote escape too; element bodies don't need it.
 */
function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, "&quot;");
}

/**
 * Render a batch of completion notifications as the XML user-message
 * body that the main agent's LLM will see. Format is stable — main
 * agent prompts can rely on the `<background-agents-completed>` root
 * tag as a signal that this turn is a system-injected notification,
 * not a real user message.
 */
export function buildNotificationMessage(items: NotificationItem[]): string {
  const agents = items
    .map((item) => {
      const nameAttr = item.name ? ` name="${escapeXmlAttr(item.name)}"` : "";
      const opening = `  <agent id="${escapeXmlAttr(item.agentId)}"${nameAttr} status="${item.status}">`;
      const desc = `    <description>${escapeXmlText(item.description)}</description>`;
      const body =
        item.status === "completed"
          ? `    <result>\n${escapeXmlText(item.finalText ?? "")}\n    </result>`
          : `    <error>${escapeXmlText(item.error ?? "")}</error>`;
      return [opening, desc, body, "  </agent>"].join("\n");
    })
    .join("\n");

  return [
    "<background-agents-completed>",
    agents,
    "</background-agents-completed>",
    "",
    "Above are results from background agents that finished while you were idle. Address them appropriately — summarize for the user, continue work, or ignore if no longer relevant.",
  ].join("\n");
}
```

- [ ] **Step 2.4: Run tests to verify they pass**

Run: `bun test tests/agent-notifications.test.ts`

Expected: All 14 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add src/tool-system/builtin/agent-notifications.ts tests/agent-notifications.test.ts
git commit -m "$(cat <<'EOF'
feat(agent-notifications): buildNotificationMessage XML formatter

LLM-facing XML wrapper for one or more completed/failed background
agents. Stable root tag <background-agents-completed> lets the main
agent prompt distinguish injected notifications from real user input.
Hand-rolled XML escaping for the handful of user-provided fields.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: buildNotificationSummary (UI-facing string)

**Files:**
- Modify: `src/tool-system/builtin/agent-notifications.ts`
- Test: `tests/agent-notifications.test.ts`

- [ ] **Step 3.1: Write the failing tests**

Append to `tests/agent-notifications.test.ts`:

```ts
import { buildNotificationSummary } from "../src/tool-system/builtin/agent-notifications.js";

describe("buildNotificationSummary", () => {
  test("single completed", () => {
    const s = buildNotificationSummary([
      { agentId: "a", name: "Explore", description: "调研 AI", status: "completed", finalText: "x", enqueuedAt: 0 },
    ]);
    expect(s).toMatch(/background agents completed/i);
    expect(s).toContain("Explore");
    expect(s).toContain("调研 AI");
    expect(s).toContain("✓");
  });

  test("single failed includes error preview", () => {
    const s = buildNotificationSummary([
      { agentId: "a", description: "Plan migration", status: "failed", error: "Engine timed out", enqueuedAt: 0 },
    ]);
    expect(s).toContain("Plan migration");
    expect(s).toContain("✗");
    expect(s).toContain("failed");
    expect(s).toContain("Engine timed out");
  });

  test("multiple items render one line each", () => {
    const s = buildNotificationSummary([
      { agentId: "a", name: "Explore", description: "task A", status: "completed", finalText: "ok", enqueuedAt: 0 },
      { agentId: "b", name: "Plan", description: "task B", status: "failed", error: "boom", enqueuedAt: 0 },
    ]);
    const lines = s.split("\n");
    // Header + 2 body lines
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(s).toContain("task A");
    expect(s).toContain("task B");
  });

  test("agent without name renders without name segment", () => {
    const s = buildNotificationSummary([
      { agentId: "a", description: "did stuff", status: "completed", finalText: "x", enqueuedAt: 0 },
    ]);
    expect(s).toContain("did stuff");
    expect(s).not.toMatch(/^\s*·\s/m); // no leading orphan separator
  });
});
```

- [ ] **Step 3.2: Run tests to verify they fail**

Run: `bun test tests/agent-notifications.test.ts`

Expected: New `buildNotificationSummary` tests fail (function not defined).

- [ ] **Step 3.3: Implement buildNotificationSummary**

Append to `src/tool-system/builtin/agent-notifications.ts`:

```ts
/**
 * One-line-per-agent human summary for the chat feed. The full result
 * body goes to the LLM via buildNotificationMessage; the user sees only
 * this terse marker plus an optional inline error preview, and can
 * switch to the sub-agent's dock view if they want details.
 */
export function buildNotificationSummary(items: NotificationItem[]): string {
  const header = "📨 background agents completed";
  const rows = items.map((item) => {
    const badge = item.status === "completed" ? "✓" : "✗";
    const namePart = item.name ? `${item.name}  ·  ` : "";
    const statusPart = item.status === "failed" ? `  ·  failed: ${item.error ?? "unknown"}` : "";
    return `  └─ ${namePart}${item.description}  ·  ${badge}${statusPart}`;
  });
  return [header, ...rows].join("\n");
}
```

- [ ] **Step 3.4: Run tests to verify they pass**

Run: `bun test tests/agent-notifications.test.ts`

Expected: All 18 tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add src/tool-system/builtin/agent-notifications.ts tests/agent-notifications.test.ts
git commit -m "$(cat <<'EOF'
feat(agent-notifications): buildNotificationSummary for UI feed

One-line-per-agent terse marker shown to the user in the chat feed.
Full result text goes only to the LLM via the XML message; the user
gets a status badge and can switch to the dock view for details.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Narrow asyncAgentRegistry — drop result/error, add markCancelled

**Files:**
- Modify: `src/tool-system/builtin/agent-registry.ts`

- [ ] **Step 4.1: Read current state**

Open `src/tool-system/builtin/agent-registry.ts`. Confirm the current shape:
- `AsyncAgentEntry` has `result?: string` and `error?: string` fields.
- `markCompleted(agentId, result)` takes a string parameter.
- `markFailed(agentId, error)` takes a string parameter.
- `cancel(agentId)` exists and sets `status: "cancelled"`.

- [ ] **Step 4.2: Apply the changes**

Edit `src/tool-system/builtin/agent-registry.ts` (Edit tool):

Remove `result?: string` and `error?: string` from the `AsyncAgentEntry` interface (lines around 39–40).

Replace the `markCompleted` method body:

```ts
  markCompleted(agentId: string): void {
    const e = this.agents.get(agentId);
    if (!e) return;
    if (e.status !== "running") return;
    e.status = "completed";
    e.finishedAt = Date.now();
    e.finishedFadeAt = e.finishedAt + 30_000;
    this.notify();
  }
```

Replace the `markFailed` method body:

```ts
  markFailed(agentId: string): void {
    const e = this.agents.get(agentId);
    if (!e) return;
    if (e.status !== "running") return;
    e.status = "failed";
    e.finishedAt = Date.now();
    e.finishedFadeAt = e.finishedAt + 30_000;
    this.notify();
  }
```

Add a new `markCancelled` method (the existing `cancel(agentId)` calls `e.abort()` and is the user-facing API; `markCancelled` is the internal status-only setter used by `agent.ts` when the abort signal already fired):

```ts
  markCancelled(agentId: string): void {
    const e = this.agents.get(agentId);
    if (!e) return;
    if (e.status !== "running") return;
    e.status = "cancelled";
    e.finishedAt = Date.now();
    e.finishedFadeAt = e.finishedAt + 30_000;
    this.notify();
  }
```

Leave `cancel(agentId)` as-is — it's the public "stop this agent" API that triggers `abort()` and sets status. `markCancelled` is the bare status-setter for the post-abort `.catch` path in `agent.ts`.

- [ ] **Step 4.3: Typecheck**

Run: `bun run tsc --noEmit`

Expected: errors only in `src/tool-system/builtin/agent.ts` complaining about `markCompleted` / `markFailed` argument arity (will be fixed in Task 5). No other type errors anywhere.

If you see other errors (e.g. "Property 'result' does not exist"), some consumer was reading those dropped fields. Find and either remove that read (if it was about the result text, which is moving to messages) or report back — we may have missed a consumer.

- [ ] **Step 4.4: Run all unit tests**

Run: `bun test`

Expected: notification-queue tests still pass; engine/agent tests may fail on argument-arity mismatch — that's expected, fixed in Task 5.

- [ ] **Step 4.5: Commit**

```bash
git add src/tool-system/builtin/agent-registry.ts
git commit -m "$(cat <<'EOF'
refactor(agent-registry): drop result/error fields, add markCancelled

Result text moves to the notification queue (and then to the main
agent's messages); registry holds only lifecycle metadata. markCompleted
/markFailed/markCancelled now take only agentId — text goes via
notificationQueue.enqueue() in agent.ts.

Builds will fail in agent.ts until Task 5 lands.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire agent.ts background path — register markers + enqueue

**Files:**
- Modify: `src/tool-system/builtin/agent.ts`

- [ ] **Step 5.1: Open agent.ts and locate the background `.then/.catch`**

The current block lives around lines 191–198:

```ts
    void runSubAgent(
      spawner,
      { agentId, name, description, prompt, maxTurns, signal: controller.signal },
      parentStream,
      transcriptSink,
    )
      .then((text) => asyncAgentRegistry.markCompleted(agentId, text))
      .catch((err: Error) => {
        if (controller.signal.aborted) {
          // cancellation was already recorded by AgentCancel
          return;
        }
        asyncAgentRegistry.markFailed(agentId, err.message);
      });
```

- [ ] **Step 5.2: Add the import**

Near the existing imports at the top of `agent.ts`, add:

```ts
import { notificationQueue } from "./agent-notifications.js";
```

- [ ] **Step 5.3: Replace the .then/.catch block**

Edit the `.then((text) => ...).catch(...)` to:

```ts
      .then((text) => {
        asyncAgentRegistry.markCompleted(agentId);
        notificationQueue.enqueue({
          agentId,
          name,
          description,
          status: "completed",
          finalText: text,
          enqueuedAt: Date.now(),
        });
      })
      .catch((err: Error) => {
        if (controller.signal.aborted) {
          // User-initiated cancel: mark status but do NOT enqueue —
          // the main agent doesn't need a follow-up turn. Dock still
          // shows the "cancelled" badge for the fade window.
          asyncAgentRegistry.markCancelled(agentId);
          return;
        }
        asyncAgentRegistry.markFailed(agentId);
        notificationQueue.enqueue({
          agentId,
          name,
          description,
          status: "failed",
          error: err.message,
          enqueuedAt: Date.now(),
        });
      });
```

- [ ] **Step 5.4: Typecheck**

Run: `bun run tsc --noEmit`

Expected: clean. The agent.ts errors from Task 4 are resolved.

- [ ] **Step 5.5: Run all tests**

Run: `bun test`

Expected: all green.

- [ ] **Step 5.6: Commit**

```bash
git add src/tool-system/builtin/agent.ts
git commit -m "$(cat <<'EOF'
feat(agent): enqueue completion notification on background finish

Background path now (a) updates registry status via the narrowed
mark* signatures and (b) enqueues a NotificationItem with the final
text (or error) for the UI's notification processor to drain into a
new main-agent turn. Cancellation path marks status but skips the
enqueue — user-initiated stop, no follow-up needed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Extend SystemSubtype with bg_agent_notification

**Files:**
- Modify: `src/ui/store.ts`

- [ ] **Step 6.1: Add the subtype**

Edit `src/ui/store.ts` lines around 32–36. Change:

```ts
export type SystemSubtype =
  | "compact_boundary"
  | "memory_saved"
  | "turn_duration"
  | "info";
```

to:

```ts
export type SystemSubtype =
  | "compact_boundary"
  | "memory_saved"
  | "turn_duration"
  | "info"
  | "bg_agent_notification";
```

- [ ] **Step 6.2: Typecheck**

Run: `bun run tsc --noEmit`

Expected: clean.

- [ ] **Step 6.3: Commit**

```bash
git add src/ui/store.ts
git commit -m "$(cat <<'EOF'
feat(ui/store): add bg_agent_notification system subtype

New system-message subtype for the terse "📨 background agents
completed" row that App.tsx will append when delivering a batch of
sub-agent completion notifications.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Extract submitToEngine helper from handleSubmit

This task does a pure refactor — no behavior change. `handleSubmit` continues to call into the same logic, just via the new helper. Task 8 will then call the helper from the notification processor.

**Files:**
- Modify: `src/ui/App.tsx`

- [ ] **Step 7.1: Read the current handleSubmit body**

Open `src/ui/App.tsx`, locate the `handleSubmit` `useCallback` (around line 1074). The portion from `chatStore.update((prev) => [...prev, entry({ type: "user", text: trimmed })]);` (line ~1103) down to the closing `}` of the `useCallback` body (line ~1213) is the engine-submission state machine. Everything above that — slash-command branch, history bookkeeping, input clearing — is input-source-specific.

- [ ] **Step 7.2: Define the submitToEngine helper inside the App component**

Add this `useCallback` immediately above `handleSubmit` (above `const handleSubmit = useCallback(...)`):

```ts
  // Submits a message to the engine and runs the post-turn state-machine
  // (streaming flush, finalize entries, post duration/cost system row,
  // post status row, error capture, query-guard cleanup).
  //
  // Two input sources call this:
  //   - handleSubmit: real user input. asInjection=false, the user's text
  //     is appended as a "user" entry to chatStore.
  //   - useNotificationProcessor: background-agent completion injection.
  //     asInjection=true, a "system" entry with subtype
  //     "bg_agent_notification" is appended showing the terse summary;
  //     the full XML payload still goes to the engine so the LLM sees it.
  const submitToEngine = useCallback(
    async (
      message: string,
      opts: { asInjection: boolean; chatSummary?: string },
    ): Promise<void> => {
      if (opts.asInjection) {
        chatStore.update((prev) => [
          ...prev,
          entry({
            type: "system",
            subtype: "bg_agent_notification",
            text: opts.chatSummary ?? "",
          }),
        ]);
      } else {
        chatStore.update((prev) => [...prev, entry({ type: "user", text: message })]);
      }

      if (!queryGuard.reserve()) return;
      streamingTokensRef.current = 0;
      cancelledRef.current = false;
      taskManager.reset();

      const abortController = new AbortController();
      if (!queryGuard.tryStart(abortController)) {
        queryGuard.cancelReservation();
        return;
      }

      try {
        // For real user input: prepend pending /arena-style context if any.
        // Injections do not honor pendingContext (it belongs to the user
        // turn that staged it).
        let engineMessage = message;
        if (!opts.asInjection && pendingContextRef.current) {
          engineMessage = `<context>\n${pendingContextRef.current}\n</context>\n\n${message}`;
          pendingContextRef.current = null;
        }

        const result = await client.run(engineMessage, sessionId);

        if (cancelledRef.current) {
          return;
        }

        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        flushTextBuffer();

        chatStore.update((prev) =>
          prev
            .filter((e) => e.type !== "thinking" && e.type !== "tool_running")
            .map((e) =>
              e.type === "assistant_text" && e.streaming ? { ...e, streaming: false } : e,
            ),
        );

        setSessionId(result.sessionId);
        setTotalTokens(costTracker.getTotalTokens().total);
        setTotalCost(costTracker.getEstimatedCost());

        const elapsed = Date.now() - runStartRef.current;
        const turnCost = result.usage
          ? costTracker.estimateForTokens(
              model,
              result.usage.promptTokens,
              result.usage.completionTokens,
            )
          : 0;
        const parts: string[] = [formatDuration(elapsed)];
        if (result.usage && result.usage.totalTokens > 0) {
          parts.push(`${formatTokens(result.usage.totalTokens)} tokens`);
          if (result.usage.cacheReadTokens) {
            parts.push(`${formatTokens(result.usage.cacheReadTokens)} cached`);
          }
        }
        if (turnCost > 0) parts.push(`$${turnCost.toFixed(4)}`);
        chatStore.update((prev) => [
          ...prev,
          entry({ type: "system", subtype: "turn_duration", text: parts.join(" · ") }),
        ]);

        if (result.reason !== "completed") {
          chatStore.update((prev) => [
            ...prev,
            entry({ type: "status", reason: friendlyReason(result.reason) }),
          ]);
        }
      } catch (err) {
        if (!cancelledRef.current) {
          chatStore.update((prev) => [
            ...prev,
            entry({ type: "error", error: friendlyError((err as Error).message) }),
          ]);
        }
      } finally {
        queryGuard.end();
      }

      if (!cancelledRef.current) {
        setStreamMode("thinking");
        setThinkingContent(null);
        clearThinkingBuffer();
      }
    },
    [client, sessionId, model, flushTextBuffer],
  );
```

- [ ] **Step 7.3: Replace the inner body of handleSubmit with a delegating call**

Replace the existing `handleSubmit` `useCallback` body (lines ~1074–1215) so it ends up shaped like this — keeping its existing read-only-slash-command checks, input clearing, history/banner logic, and slash-command branch, but delegating engine submission to `submitToEngine`:

```ts
  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      const head = trimmed.split(/\s+/)[0]?.toLowerCase();
      const READ_ONLY_WHILE_RUNNING = new Set(["/sid", "/help"]);
      if (isQueryActive && !READ_ONLY_WHILE_RUNNING.has(head ?? "")) return;
      if (!isQueryActive) {
        setInput("");
        setShowBanner(false);
        onScrollToBottom();
      } else {
        setInput("");
      }

      if (trimmed.startsWith("/")) {
        handleSlashCommand(trimmed);
        return;
      }

      await submitToEngine(trimmed, { asInjection: false });
    },
    [isQueryActive, submitToEngine, handleSlashCommand, onScrollToBottom],
  );
```

The `handleSlashCommand` callback and `submitToEngine` callback are both defined in the same component scope; `handleSubmit` simply orchestrates input-source-specific work and delegates.

- [ ] **Step 7.4: Typecheck**

Run: `bun run tsc --noEmit`

Expected: clean.

- [ ] **Step 7.5: Smoke-test the refactor manually**

This is a pure refactor; we want to make sure ordinary user input still works.

Run the dev TUI: `bun run dev` (in a separate terminal).

Verify:
- A normal text submission ("hello") streams back a response.
- A slash command (`/sid`) still works while idle.
- ESC cancels mid-turn cleanly.

If any of these break, the refactor introduced a regression — revert and re-diff carefully.

- [ ] **Step 7.6: Commit**

```bash
git add src/ui/App.tsx
git commit -m "$(cat <<'EOF'
refactor(ui/App): extract submitToEngine from handleSubmit

Pure refactor in prep for background-agent notification injection. The
engine-submission state machine (chat append → queryGuard reserve →
client.run → post-turn cleanup) moves into a reusable
submitToEngine(message, { asInjection }) callback. handleSubmit keeps
its input-source-specific work (input clearing, slash branch,
history bookkeeping) and delegates the engine call.

asInjection=true variant appends a "system"/"bg_agent_notification"
entry instead of a "user" entry, but otherwise runs the same flow.
Not yet called by anyone; Task 8 wires the notification processor.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire useNotificationProcessor effect

**Files:**
- Modify: `src/ui/App.tsx`

- [ ] **Step 8.1: Add imports**

At the top of `App.tsx`, alongside the existing imports:

```ts
import {
  notificationQueue,
  buildNotificationMessage,
  buildNotificationSummary,
} from "../tool-system/builtin/agent-notifications.js";
```

- [ ] **Step 8.2: Add subscription + effect**

Locate the existing `useNotificationProcessor`-shaped slot — after the `viewKey` clearing effect (around line 195 — the `useEffect(() => { forceRedraw(); }, [viewKey]);` block) is a fine home.

Add:

```ts
  // Background sub-agent completion → main-agent turn injection.
  //
  // notificationQueue is filled by agent.ts when a background sub-agent
  // finishes (completed or failed; cancelled never enqueues). This effect
  // drains the queue and submits the contents as a new main-agent turn,
  // but ONLY when nothing else is competing for the conversation slot:
  //
  //   * main agent must be idle (no in-flight LLM call)
  //   * user must not be typing (input box empty)
  //   * no modal / overlay must be open (the user is already busy)
  //
  // Any of those changing re-runs the effect and re-evaluates the guards,
  // so notifications get delivered at the first idle moment naturally.
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
    if (modelManager) return;
    if (modelEntries) return;
    if (sessionEntries) return;
    if (showOnboarding) return;

    const items = notificationQueue.drainAll();
    if (items.length === 0) return;
    const xml = buildNotificationMessage(items);
    const summary = buildNotificationSummary(items);
    void submitToEngine(xml, { asInjection: true, chatSummary: summary });
  }, [
    notificationSnapshot,
    isQueryActive,
    input,
    pendingApproval,
    pendingQuestion,
    modelManager,
    modelEntries,
    sessionEntries,
    showOnboarding,
    submitToEngine,
  ]);
```

If any of `pendingApproval`, `pendingQuestion`, `modelManager`, `modelEntries`, `sessionEntries`, `showOnboarding` are named differently in your local copy of App.tsx, use the real names (they exist as state in the same component — find them by `grep -n "useState" src/ui/App.tsx | head -40`).

- [ ] **Step 8.3: Typecheck**

Run: `bun run tsc --noEmit`

Expected: clean.

- [ ] **Step 8.4: Commit**

```bash
git add src/ui/App.tsx
git commit -m "$(cat <<'EOF'
feat(ui): useNotificationProcessor — inject bg-agent results on idle

Subscribes to notificationQueue and drains it into a new main-agent
turn (via submitToEngine) when the main agent is idle, the input box
is empty, and no overlays/modals are open. Any of those changing re-
runs the effect, so notifications land at the first idle moment.

The injected user message is the full XML payload (LLM sees details);
the chatStore gets only the terse buildNotificationSummary line so
the user feed doesn't drown in result text. Full per-agent transcript
remains available via the dock detail view.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Render bg_agent_notification entries in the chat feed

**Files:**
- Modify: `src/ui/App.tsx`

- [ ] **Step 9.1: Locate the renderEntry "system" branch**

In `src/ui/App.tsx` around line 1822, the existing `case "system":` reads:

```tsx
    case "system": {
      const sysEntry = entry as ChatEntry & { type: "system" };
      if (sysEntry.subtype === "compact_boundary") {
        return (
          <Box key={key} marginLeft={1} marginTop={1}>
            <Text dim>{sysEntry.text ?? "── context compacted ──"}</Text>
          </Box>
        );
      }
      if (sysEntry.subtype === "memory_saved") {
        return (
          <Box key={key} marginLeft={1} marginTop={1}>
            <Text color="ansi:magenta">{"✦ "}</Text>
            <Text dim>{sysEntry.text ?? "Memory saved"}</Text>
          </Box>
        );
      }
      if (sysEntry.subtype === "turn_duration") {
        return (
          <Box key={key} marginLeft={1} marginTop={1}>
            <Text dim>{sysEntry.text}</Text>
          </Box>
        );
      }
      return (
        ...
```

- [ ] **Step 9.2: Add a branch for bg_agent_notification**

Insert before the final fallback `return (...)`:

```tsx
      if (sysEntry.subtype === "bg_agent_notification") {
        // Pre-formatted by buildNotificationSummary — already a multi-line
        // string. Render each line with dim styling so it reads as a
        // system marker, not as user content.
        const lines = (sysEntry.text ?? "").split("\n");
        return (
          <Box key={key} flexDirection="column" marginLeft={1} marginTop={1}>
            {lines.map((line, i) => (
              <Text key={i} dim>{line}</Text>
            ))}
          </Box>
        );
      }
```

- [ ] **Step 9.3: Typecheck**

Run: `bun run tsc --noEmit`

Expected: clean.

- [ ] **Step 9.4: Commit**

```bash
git add src/ui/App.tsx
git commit -m "$(cat <<'EOF'
feat(ui): render bg_agent_notification entries in the chat feed

Terse multi-line marker shown when a batch of background sub-agent
completions are delivered. Per-agent line includes name, description,
and a ✓/✗ badge (plus inline error preview on failure). Full result
text is in the LLM-visible XML user message only; the user can switch
to a sub-agent's dock view for the complete transcript.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Manual smoke + final verification

**Files:** (no edits; verification only)

- [ ] **Step 10.1: Run full test suite**

Run: `bun test`

Expected: all tests pass. Pay particular attention to `chat-store.test.ts` and `agent-notifications.test.ts`.

- [ ] **Step 10.2: Typecheck the whole project**

Run: `bun run tsc --noEmit`

Expected: clean.

- [ ] **Step 10.3: Manual smoke — single background agent**

Start the dev TUI: `bun run dev`

Send a prompt that gets the main agent to spawn one background sub-agent. For example:

> "Use Agent(run_in_background:true, name='Test', description='count to 3', prompt='Sleep 5 seconds then reply with a single word: done') to spawn a quick test agent. Then tell me you launched it and end your response."

Expected behavior:
1. Main agent calls Agent with `run_in_background:true`.
2. Tool returns the "Async agent launched..." text.
3. Main agent responds briefly and ends its turn.
4. Within ~6 seconds, a new entry appears in the chat feed: `📨 background agents completed` with a `✓ Test · count to 3` line.
5. Immediately after that, the main agent starts a new turn responding to the result.

If step 4 doesn't appear, debug:
- Open `~/.code-shell/logs/ui-ink-<today>.log` and grep for `agent-notification` events (none today; this is the first time we've added them) or anomalies.
- Add a temporary `console.error("[notif]", notificationSnapshot.length, isQueryActive)` inside the effect, save, re-run.

- [ ] **Step 10.4: Manual smoke — multi-agent batching**

Send a prompt asking the main agent to spawn 2–3 short-running background agents in parallel (single tool round). Wait for them to all finish.

Expected: ONE notification batch line listing all of them, not multiple separate batches.

- [ ] **Step 10.5: Manual smoke — failure path**

Spawn a background agent with a prompt that will fail (e.g. point at a non-existent model in the args, or write a sub-agent task that throws). Verify:
1. Dock shows the agent turning red (`failed` status).
2. Within a few seconds, a `📨 background agents completed` line appears with `✗ <task>  ·  failed: <error message>`.
3. Main agent gets a new turn and responds to the failure.

- [ ] **Step 10.6: Manual smoke — cancellation path**

Spawn a long-running background agent, then call `AgentCancel(agent_id="...")` from the main agent. Verify:
1. Dock shows the agent turning yellow (`cancelled` status).
2. No `📨 background agents completed` line appears.
3. Main agent does NOT start a new turn from the cancellation.

- [ ] **Step 10.7: If all smokes pass, push**

```bash
git push origin main
```
