import { describe, expect, test } from "bun:test";
import type { TranscriptEvent } from "../types.js";
import {
  MemoryClosureScheduler,
  closureGate,
  closureTranscript,
  planMemoryClosure,
  renderClosureContext,
  selectClosureWindow,
  type MemoryCursor,
} from "./memory-closure.js";

let sequence = 0;
function event(
  type: TranscriptEvent["type"],
  data: Record<string, unknown>,
  timestamp?: number,
): TranscriptEvent {
  sequence++;
  return { id: `e${sequence}`, type, timestamp: timestamp ?? sequence * 1000, turnNumber: 0, data };
}
const user = (content: string, extra: Record<string, unknown> = {}) =>
  event("message", { role: "user", content, ...extra });
const assistant = (content: unknown) => event("message", { role: "assistant", content });
const cursorAt = (target: TranscriptEvent): MemoryCursor => ({
  v: 1,
  eventId: target.id,
  at: target.timestamp,
  closedAt: target.timestamp + 1,
});
const texts = (messages: ReadonlyArray<{ content: unknown }>) =>
  messages.map((message) => message.content);

describe("selectClosureWindow", () => {
  test("without a cursor every conversation message is new", () => {
    const events = [user("first"), assistant("answer"), user("second")];
    const window = selectClosureWindow(events, undefined);
    expect(window.anchor).toBe("none");
    expect(texts(window.fresh)).toEqual(["first", "answer", "second"]);
    expect(window.context).toEqual([]);
    expect(window.humanCount).toBe(2);
    expect(window.through).toEqual({ eventId: events[2]!.id, at: events[2]!.timestamp });
  });

  test("an empty transcript has nothing to process and no cursor target", () => {
    expect(selectClosureWindow([], undefined)).toEqual({
      fresh: [],
      context: [],
      humanCount: 0,
      anchor: "none",
    });
  });

  test("a cursor found by event id splits covered messages from new ones", () => {
    const covered = [user("one"), assistant("two"), user("three"), assistant("four")];
    const boundary = assistant("five");
    const later = [user("six"), assistant("seven")];
    const window = selectClosureWindow([...covered, boundary, ...later], cursorAt(boundary));
    expect(window.anchor).toBe("event");
    expect(texts(window.fresh)).toEqual(["six", "seven"]);
    // The four messages just before the new ones, oldest first.
    expect(texts(window.context)).toEqual(["two", "three", "four", "five"]);
    expect(window.humanCount).toBe(1);
    expect(window.through!.eventId).toBe(later[1]!.id);
  });

  test("a cursor whose id is not in view falls back to its timestamp", () => {
    const old = [user("old question", {}), assistant("old answer")];
    const recent = [user("new question"), assistant("new answer")];
    const cursor: MemoryCursor = {
      v: 1,
      eventId: "id-from-before-the-fork",
      at: old[1]!.timestamp,
      closedAt: 0,
    };
    const window = selectClosureWindow([...old, ...recent], cursor);
    expect(window.anchor).toBe("timestamp");
    expect(texts(window.fresh)).toEqual(["new question", "new answer"]);
    expect(texts(window.context)).toEqual(["old question", "old answer"]);
  });

  test("a view that starts after the cursor is entirely new", () => {
    const tail = [user("late question"), assistant("late answer")];
    const cursor: MemoryCursor = { v: 1, eventId: "trimmed-away", at: 1, closedAt: 2 };
    const window = selectClosureWindow(tail, cursor);
    expect(window.anchor).toBe("timestamp");
    expect(texts(window.fresh)).toEqual(["late question", "late answer"]);
    expect(window.context).toEqual([]);
  });

  test("only messages a person typed count as human", () => {
    const events = [
      user("typed by a person"),
      user("steered mid-run", { steerId: "steer-1" }),
      user("background job finished", { injected: true }),
      user("host record", { displayOnly: true }),
      user("agent direction", { authority: "agent", source: "agent-direction" }),
      user("goal control", { source: "goal-control" }),
      user("policy notice", { authority: "policy" }),
      user("explicit user authority", { authority: "user" }),
      assistant("reply"),
    ];
    expect(selectClosureWindow(events, undefined).humanCount).toBe(3);
  });

  test("engine context and display-only records never enter the window", () => {
    const events = [
      user("ledger snapshot", {
        injected: true,
        contextLedger: { kind: "snapshot", state: "{}" },
      }),
      user("hook reminder", { injected: true, hookReminder: { promptSubmit: ["remember"] } }),
      user("shown in the UI only", { displayOnly: true }),
      user("the real question"),
    ];
    const window = selectClosureWindow(events, undefined);
    expect(texts(window.fresh)).toEqual(["the real question"]);
  });

  test("summaries, handoffs and range archives are not part of the conversation", () => {
    const events = [
      event("summary", { summary: "older turns, compacted" }),
      event("context_transfer", { summary: "handed over from another session" }),
      event("range_archive", { summary: "archived span", toClientMessageId: "c1" }),
      user("what was actually said"),
    ];
    const window = selectClosureWindow(events, undefined);
    expect(texts(window.fresh)).toEqual(["what was actually said"]);
  });

  test("tool results join the new messages but are not human input", () => {
    const events = [
      user("run the build"),
      assistant([
        { type: "text", text: "Running it." },
        { type: "tool_use", id: "call-1", name: "Bash", input: { command: "bun run build" } },
      ]),
      event("tool_use", { toolCallId: "call-1", toolName: "Bash" }),
      event("tool_result", { toolCallId: "call-1", result: "ok" }),
      assistant("Build passed."),
    ];
    const window = selectClosureWindow(events, undefined);
    expect(window.fresh.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(window.fresh[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "call-1", content: "ok" },
    ]);
    expect(window.humanCount).toBe(1);
  });

  test("context keeps messages with text and skips pure tool calls", () => {
    const covered = [
      user("question"),
      assistant([{ type: "tool_use", id: "call-9", name: "Read", input: {} }]),
      event("tool_result", { toolCallId: "call-9", result: "file body" }),
      assistant([{ type: "text", text: "It says hello." }]),
    ];
    const later = [user("thanks")];
    const window = selectClosureWindow([...covered, ...later], cursorAt(covered[3]!));
    expect(window.context.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});

describe("closureGate", () => {
  const cursor: MemoryCursor = { v: 1, eventId: "e", at: 1, closedAt: 2 };
  const window = (freshCount: number, humanCount: number) => ({
    fresh: Array.from({ length: freshCount }, () => ({ role: "user", content: "x" })),
    context: [],
    humanCount,
    anchor: "event" as const,
  });

  test("nothing new skips", () => {
    expect(closureGate(window(0, 0), cursor)).toEqual({ run: false, reason: "no-new-messages" });
  });

  test("a stretch nobody typed in skips", () => {
    expect(closureGate(window(12, 0), cursor)).toEqual({ run: false, reason: "no-human-message" });
  });

  test("a session's first closure waits for eight messages", () => {
    expect(closureGate(window(7, 3), undefined)).toEqual({ run: false, reason: "too-short" });
    expect(closureGate(window(8, 3), undefined)).toEqual({ run: true });
  });

  test("a later closure runs on any stretch a person typed in", () => {
    expect(closureGate(window(2, 1), cursor)).toEqual({ run: true });
  });
});

describe("renderClosureContext", () => {
  test("no context renders nothing", () => {
    expect(renderClosureContext([])).toBeUndefined();
  });

  test("covered messages are listed under a do-not-extract note and kept short", () => {
    const rendered = renderClosureContext([
      { role: "user", content: "short question" },
      { role: "assistant", content: [{ type: "text", text: "a".repeat(2000) }] },
    ])!;
    expect(rendered).toStartWith(
      "Earlier messages, already covered by a previous pass. They are shown only so the messages below make sense: do not extract memories from them.",
    );
    expect(rendered).toContain("\n- user: short question");
    expect(rendered).toContain(`\n- assistant: ${"a".repeat(600)}…`);
    expect(rendered).not.toContain("a".repeat(601));
  });
});

describe("planMemoryClosure", () => {
  test("a stretch worth reading comes with its transcript", () => {
    const events = Array.from({ length: 8 }, (_, index) =>
      index % 2 ? assistant(`answer ${index}`) : user(`question ${index}`),
    );
    const plan = planMemoryClosure(events, undefined);
    expect(plan.run).toBe(true);
    if (!plan.run) throw new Error("unreachable");
    expect(plan.transcript.map((entry) => entry.content)).toEqual(
      events.map((entry) => entry.data.content),
    );
    expect(plan.window.through!.eventId).toBe(events.at(-1)!.id);
  });

  test("a stretch nobody typed in comes with the reason and no transcript", () => {
    const events = Array.from({ length: 8 }, (_, index) =>
      index % 2 ? assistant("answer") : user("notice", { injected: true }),
    );
    expect(planMemoryClosure(events, undefined)).toMatchObject({
      run: false,
      reason: "no-human-message",
    });
  });
});

describe("closureTranscript", () => {
  test("new messages become flattened transcript entries", () => {
    expect(
      closureTranscript({
        context: [],
        fresh: [
          { role: "user", content: "run it" },
          { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Bash", input: {} }] },
          { role: "assistant", content: "done" },
        ],
      }),
    ).toEqual([
      { role: "user", content: "run it", endsTurn: false },
      {
        role: "assistant",
        content: JSON.stringify([{ type: "tool_use", id: "c1", name: "Bash", input: {} }]),
        endsTurn: false,
      },
      { role: "assistant", content: "done", endsTurn: true },
    ]);
  });

  test("covered messages lead as one entry that is neither a user nor an assistant turn", () => {
    const transcript = closureTranscript({
      context: [{ role: "user", content: "an old preference" }],
      fresh: [{ role: "user", content: "a new question" }],
    });
    expect(transcript.map((entry) => entry.role)).toEqual(["context", "user"]);
    expect(transcript[0]!.content).toContain("do not extract memories from them");
    expect(transcript[0]!.content).toContain("- user: an old preference");
  });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("MemoryClosureScheduler", () => {
  test("a closure runs once the session has been quiet", async () => {
    const scheduler = new MemoryClosureScheduler({ idleMs: 30 });
    const ran: string[] = [];
    scheduler.schedule("s1", async () => void ran.push("closure"));
    expect(scheduler.hasPending("s1")).toBe(true);
    await wait(10);
    expect(ran).toEqual([]);
    await wait(60);
    expect(ran).toEqual(["closure"]);
    expect(scheduler.hasPending("s1")).toBe(false);
    scheduler.dispose();
  });

  test("a newer run end restarts the wait and replaces the task", async () => {
    const scheduler = new MemoryClosureScheduler({ idleMs: 40 });
    const ran: string[] = [];
    scheduler.schedule("s1", async () => void ran.push("first"));
    await wait(20);
    scheduler.schedule("s1", async () => void ran.push("second"));
    await wait(30);
    expect(ran).toEqual([]);
    await wait(40);
    expect(ran).toEqual(["second"]);
    scheduler.dispose();
  });

  test("a new run cancels the waiting closure", async () => {
    const scheduler = new MemoryClosureScheduler({ idleMs: 20 });
    const ran: string[] = [];
    scheduler.schedule("s1", async () => void ran.push("closure"));
    scheduler.cancel("s1");
    expect(scheduler.hasPending("s1")).toBe(false);
    await wait(50);
    expect(ran).toEqual([]);
    scheduler.dispose();
  });

  test("sessions wait independently", async () => {
    const scheduler = new MemoryClosureScheduler({ idleMs: 20 });
    const ran: string[] = [];
    scheduler.schedule("s1", async () => void ran.push("s1"));
    scheduler.schedule("s2", async () => void ran.push("s2"));
    scheduler.cancel("s1");
    await wait(50);
    expect(ran).toEqual(["s2"]);
    scheduler.dispose();
  });

  test("runNow starts immediately unless the session already has one waiting or running", async () => {
    const scheduler = new MemoryClosureScheduler({ idleMs: 1000 });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const ran: string[] = [];
    expect(
      scheduler.runNow("s1", async () => {
        ran.push("started");
        await blocked;
      }),
    ).toBe(true);
    expect(scheduler.hasPending("s1")).toBe(true);
    expect(scheduler.runNow("s1", async () => void ran.push("duplicate"))).toBe(false);
    release();
    await scheduler.idle("s1");
    expect(ran).toEqual(["started"]);
    expect(scheduler.hasPending("s1")).toBe(false);

    scheduler.schedule("s1", async () => void ran.push("waiting"));
    expect(scheduler.runNow("s1", async () => void ran.push("duplicate"))).toBe(false);
    scheduler.dispose();
  });

  test("a closure that fires while another is running for the session waits its turn", async () => {
    const scheduler = new MemoryClosureScheduler({ idleMs: 10 });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    scheduler.runNow("s1", async () => {
      order.push("first:start");
      await blocked;
      order.push("first:end");
    });
    scheduler.schedule("s1", async () => void order.push("second"));
    await wait(40);
    expect(order).toEqual(["first:start"]);
    release();
    await wait(20);
    await scheduler.idle("s1");
    expect(order).toEqual(["first:start", "first:end", "second"]);
    scheduler.dispose();
  });

  test("a failing closure is reported and does not block the next one", async () => {
    const errors: Array<[string, unknown]> = [];
    const scheduler = new MemoryClosureScheduler({
      idleMs: 10,
      onError: (sessionId, error) => errors.push([sessionId, error]),
    });
    const ran: string[] = [];
    scheduler.schedule("s1", async () => {
      throw new Error("model unavailable");
    });
    await wait(40);
    expect(errors.map(([sessionId, error]) => [sessionId, String(error)])).toEqual([
      ["s1", "Error: model unavailable"],
    ]);
    scheduler.schedule("s1", async () => void ran.push("retry"));
    await wait(40);
    expect(ran).toEqual(["retry"]);
    scheduler.dispose();
  });

  test("dispose drops everything that is waiting and refuses new work", async () => {
    const scheduler = new MemoryClosureScheduler({ idleMs: 10 });
    const ran: string[] = [];
    scheduler.schedule("s1", async () => void ran.push("s1"));
    scheduler.dispose();
    scheduler.schedule("s2", async () => void ran.push("s2"));
    expect(scheduler.runNow("s3", async () => void ran.push("s3"))).toBe(false);
    await wait(40);
    expect(ran).toEqual([]);
    expect(scheduler.hasPending("s1")).toBe(false);
  });
});
