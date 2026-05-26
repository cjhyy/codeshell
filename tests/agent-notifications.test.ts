import { describe, expect, test, beforeEach } from "bun:test";
import { notificationQueue, buildNotificationMessage, buildNotificationSummary, type NotificationItem } from "../packages/core/src/tool-system/builtin/agent-notifications.js";

const fixture = (overrides: Partial<NotificationItem> = {}): NotificationItem => ({
  agentId: "abc12345",
  name: "Explore",
  description: "调研 AI 公司新闻",
  status: "completed",
  finalText: "Found 3 stories.",
  enqueuedAt: 1_700_000_000_000,
  ...overrides,
});

const SID = "sess-test";

beforeEach(() => {
  notificationQueue.reset();
});

describe("notificationQueue", () => {
  test("starts empty", () => {
    expect(notificationQueue.getSnapshot("nonexistent")).toEqual([]);
  });

  test("enqueue appends to snapshot", () => {
    notificationQueue.enqueue(fixture(), SID);
    expect(notificationQueue.getSnapshot(SID)).toHaveLength(1);
    expect(notificationQueue.getSnapshot(SID)[0]!.agentId).toBe("abc12345");
  });

  test("multiple enqueues preserve order", () => {
    notificationQueue.enqueue(fixture({ agentId: "a" }), SID);
    notificationQueue.enqueue(fixture({ agentId: "b" }), SID);
    notificationQueue.enqueue(fixture({ agentId: "c" }), SID);
    expect(notificationQueue.getSnapshot(SID).map((i) => i.agentId)).toEqual(["a", "b", "c"]);
  });

  test("drainAll returns all items and clears queue", () => {
    notificationQueue.enqueue(fixture({ agentId: "a" }), SID);
    notificationQueue.enqueue(fixture({ agentId: "b" }), SID);
    const drained = notificationQueue.drainAll(SID);
    expect(drained).toHaveLength(2);
    expect(notificationQueue.getSnapshot(SID)).toEqual([]);
  });

  test("drainAll on empty queue returns empty array", () => {
    expect(notificationQueue.drainAll(SID)).toEqual([]);
  });

  test("reset clears queue", () => {
    notificationQueue.enqueue(fixture(), SID);
    notificationQueue.reset();
    expect(notificationQueue.getSnapshot(SID)).toEqual([]);
  });

  test("subscribe is notified on enqueue", () => {
    let calls = 0;
    const unsub = notificationQueue.subscribe(() => {
      calls += 1;
    });
    notificationQueue.enqueue(fixture(), SID);
    expect(calls).toBe(1);
    notificationQueue.enqueue(fixture(), SID);
    expect(calls).toBe(2);
    unsub();
  });

  test("subscribe is notified on drainAll", () => {
    let calls = 0;
    notificationQueue.subscribe(() => {
      calls += 1;
    });
    notificationQueue.enqueue(fixture(), SID);
    calls = 0; // reset count after enqueue
    notificationQueue.drainAll(SID);
    expect(calls).toBe(1);
  });

  test("unsubscribe stops notifications", () => {
    let calls = 0;
    const unsub = notificationQueue.subscribe(() => {
      calls += 1;
    });
    unsub();
    notificationQueue.enqueue(fixture(), SID);
    expect(calls).toBe(0);
  });
});

describe("notificationQueue session scoping (B2)", () => {
  test("enqueue with sessionId is isolated per session", () => {
    notificationQueue.enqueue(fixture({ agentId: "a" }), "sess-1");
    notificationQueue.enqueue(fixture({ agentId: "b" }), "sess-2");
    expect(notificationQueue.getSnapshot("sess-1").map((i) => i.agentId)).toEqual(["a"]);
    expect(notificationQueue.getSnapshot("sess-2").map((i) => i.agentId)).toEqual(["b"]);
    // An unknown session has no bucket of its own.
    expect(notificationQueue.getSnapshot("sess-unknown")).toEqual([]);
  });

  test("drainAll(sid) only drains that session's bucket", () => {
    notificationQueue.enqueue(fixture({ agentId: "a" }), "sess-1");
    notificationQueue.enqueue(fixture({ agentId: "b" }), "sess-2");
    const drained = notificationQueue.drainAll("sess-1");
    expect(drained.map((i) => i.agentId)).toEqual(["a"]);
    expect(notificationQueue.getSnapshot("sess-1")).toEqual([]);
    expect(notificationQueue.getSnapshot("sess-2").map((i) => i.agentId)).toEqual(["b"]);
  });

  test("drainAll(sid) on unknown session returns empty without disturbing others", () => {
    notificationQueue.enqueue(fixture({ agentId: "a" }), "sess-1");
    expect(notificationQueue.drainAll("never-existed")).toEqual([]);
    expect(notificationQueue.getSnapshot("sess-1").map((i) => i.agentId)).toEqual(["a"]);
  });

  test("subscribe fires for any bucket change", () => {
    let calls = 0;
    notificationQueue.subscribe(() => {
      calls += 1;
    });
    notificationQueue.enqueue(fixture(), "sess-1");
    expect(calls).toBe(1);
    notificationQueue.enqueue(fixture(), "sess-2");
    expect(calls).toBe(2);
    notificationQueue.drainAll("sess-1");
    expect(calls).toBe(3);
  });

  test("getSnapshot(sid) returns stable empty reference between calls", () => {
    const a = notificationQueue.getSnapshot("nope");
    const b = notificationQueue.getSnapshot("nope");
    // useSyncExternalStore compares by identity — must be the same array.
    expect(a).toBe(b);
  });

  test("reset(sid) clears only that bucket", () => {
    notificationQueue.enqueue(fixture(), "sess-1");
    notificationQueue.enqueue(fixture(), "sess-2");
    notificationQueue.reset("sess-1");
    expect(notificationQueue.getSnapshot("sess-1")).toEqual([]);
    expect(notificationQueue.getSnapshot("sess-2")).toHaveLength(1);
  });

  test("reset() with no arg clears every bucket", () => {
    notificationQueue.enqueue(fixture(), "sess-1");
    notificationQueue.enqueue(fixture(), "sess-2");
    notificationQueue.reset();
    expect(notificationQueue.getSnapshot("sess-1")).toEqual([]);
    expect(notificationQueue.getSnapshot("sess-2")).toEqual([]);
  });

  test("invalid sessionId (empty / undefined-via-any) is dropped at runtime", () => {
    let calls = 0;
    notificationQueue.subscribe(() => {
      calls += 1;
    });

    // Empty string — refused.
    notificationQueue.enqueue(fixture({ agentId: "empty" }), "");
    expect(calls).toBe(0);
    expect(notificationQueue.getSnapshot("")).toEqual([]);

    // Undefined via `as any` — refused.
    notificationQueue.enqueue(fixture({ agentId: "undef" }), undefined as unknown as string);
    expect(calls).toBe(0);

    // A real session still works after the bad calls.
    notificationQueue.enqueue(fixture({ agentId: "good" }), "sess-1");
    expect(calls).toBe(1);
    expect(notificationQueue.getSnapshot("sess-1").map((i) => i.agentId)).toEqual(["good"]);
  });
});

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
