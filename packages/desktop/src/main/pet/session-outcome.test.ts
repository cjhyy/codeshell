import { describe, expect, test } from "bun:test";
import type { SessionRunTrigger, StreamEvent } from "@cjhyy/code-shell-core";
// The real core stamping, so the reported path is tested against what core emits.
import {
  createTurnOutcomeTracker,
  withOutcomeTrigger,
} from "../../../../core/src/engine/turn-outcome.js";
import {
  closingOutcome,
  createSessionOutcomeTap,
  forwardedReplyText,
  runningOutcome,
  SessionOutcomeDeriver,
  type SessionOutcome,
} from "./session-outcome.js";

const SID = "s-work";
const NOW = 1_700_000_000_000;
/** The tools core's registry declares as bookkeeping (core and pet tests pin the list). */
const BOOKKEEPING = new Set([
  "NotifyMe",
  "ReportToMimi",
  "RequestMimiDelivery",
  "AskUserQuestion",
  "AskUserQuestionAsync",
  "ToolSearch",
]);

type Event = Record<string, unknown>;

const started = (extra: Event = {}): Event => ({
  type: "session_started",
  sessionId: SID,
  runId: "run-1",
  clientMessageId: "cm-1",
  promptTokens: 0,
  ...extra,
});
const tool = (toolName: string, extra: Event = {}): Event => ({
  type: "tool_use_start",
  toolCall: { id: `t-${toolName}`, toolName, args: {} },
  ...extra,
});
const complete = (extra: Event = {}): Event => ({
  type: "turn_complete",
  reason: "completed",
  text: "  All tests pass now.  ",
  runId: "run-1",
  completedAt: NOW + 5,
  ...extra,
});
const goal = (status: string, extra: Event = {}): Event => ({
  type: "goal_progress",
  status,
  round: 1,
  goalId: "g-1",
  revision: 2,
  runId: "run-1",
  timestamp: NOW + 1,
  ...extra,
});

/**
 * The same run as a current core publishes it: each top-level
 * `turn_complete` carries the `outcome` core computed from that run.
 */
function asReportedByCore(events: Event[]): Event[] {
  let tracker = createTurnOutcomeTracker((name) => BOOKKEEPING.has(name));
  let trigger: SessionRunTrigger | undefined;
  return events.map((event) => {
    if (event.type === "session_started" && event.agentId === undefined) {
      tracker = createTurnOutcomeTracker((name) => BOOKKEEPING.has(name));
      trigger = event.trigger as SessionRunTrigger | undefined;
    }
    const prepared = tracker.prepareEvent(event as unknown as StreamEvent);
    return withOutcomeTrigger(prepared, trigger) as unknown as Event;
  });
}

function derive(events: Event[]): SessionOutcome[] {
  const deriver = new SessionOutcomeDeriver({ now: () => NOW });
  return events.flatMap((event) => deriver.derive(SID, event));
}

/** Fields every outcome of run-1 carries, by where it was raised. */
const running = { sessionId: SID, runId: "run-1", runKey: "run-1", at: NOW + 1, final: false };
const closing = {
  sessionId: SID,
  runId: "run-1",
  runKey: "run-1",
  at: NOW + 5,
  final: true,
  // complete() ends with text, which a bound conversation is sent.
  reply: true,
};
const summary = "All tests pass now.";

interface Scenario {
  name: string;
  events: Event[];
  /** Expected outcomes, without the `turn` counter. */
  outcomes: Array<Record<string, unknown>>;
}

const scenarios: Scenario[] = [
  {
    name: "a working turn is done",
    events: [started(), tool("Bash"), complete()],
    outcomes: [{ ...closing, kind: "done", scope: "turn", summary }],
  },
  {
    name: "an acknowledgement is idle",
    events: [started(), complete()],
    outcomes: [{ ...closing, kind: "idle", summary }],
  },
  {
    name: "a turn that only used bookkeeping tools is idle",
    events: [
      started(),
      tool("NotifyMe"),
      tool("ReportToMimi"),
      tool("RequestMimiDelivery"),
      tool("AskUserQuestion"),
      tool("AskUserQuestionAsync"),
      tool("ToolSearch"),
      complete(),
    ],
    outcomes: [{ ...closing, kind: "idle", summary }],
  },
  {
    name: "a sub-agent's tool call is not the Session's work",
    events: [started(), tool("Bash", { agentId: "child" }), complete()],
    outcomes: [{ ...closing, kind: "idle", summary }],
  },
  {
    name: "a background wake is work without a tool",
    events: [
      started({ clientMessageId: undefined, trigger: "background_wake" }),
      complete({ text: "" }),
    ],
    outcomes: [{ ...closing, reply: false, kind: "done", scope: "turn" }],
  },
  {
    name: "a host-queued message that only acknowledges is idle",
    events: [
      { type: "session_user_message", text: "hi" },
      started({ clientMessageId: undefined, trigger: "host_message" }),
      complete(),
    ],
    outcomes: [{ ...closing, kind: "idle", summary }],
  },
  {
    name: "the Goal is met by complete_goal",
    events: [
      started(),
      tool("Bash"),
      goal("met"),
      complete({ completionKind: "goal_control_stop" }),
    ],
    outcomes: [
      { ...running, kind: "done", scope: "goal", goalId: "g-1" },
      { ...closing, kind: "done", scope: "goal", goalId: "g-1", repeat: true },
    ],
  },
  {
    name: "the Goal is met by the judge and the turn ends normally",
    events: [started(), tool("Bash"), goal("met"), complete()],
    outcomes: [
      { ...running, kind: "done", scope: "goal", goalId: "g-1" },
      { ...closing, kind: "done", scope: "turn", summary },
    ],
  },
  {
    name: "the Goal waits for the user",
    events: [
      started(),
      tool("Bash"),
      goal("not_met", { waitingForUser: " Which branch? ", gaps: "branch unknown" }),
      complete(),
    ],
    outcomes: [
      {
        ...running,
        kind: "blocked",
        reason: "user",
        question: "Which branch?",
        summary: "branch unknown",
        goalId: "g-1",
        revision: 2,
      },
      { ...closing, kind: "blocked", reason: "user", repeat: true },
    ],
  },
  {
    name: "the Goal is exhausted and the run fails",
    events: [
      started(),
      tool("Bash"),
      goal("exhausted"),
      complete({ reason: "goal_budget_exhausted" }),
    ],
    outcomes: [
      { ...running, kind: "blocked", reason: "goal_exhausted", goalId: "g-1", revision: 2 },
      { ...closing, kind: "failed", error: "Work session ended: goal_budget_exhausted" },
    ],
  },
  {
    name: "an exhausted Goal on a completed turn stays blocked",
    events: [started(), tool("Bash"), goal("exhausted"), complete()],
    outcomes: [
      { ...running, kind: "blocked", reason: "goal_exhausted", goalId: "g-1", revision: 2 },
      { ...closing, kind: "blocked", reason: "goal_exhausted", repeat: true },
    ],
  },
  {
    name: "the run's token budget stops it",
    events: [started(), tool("Bash"), complete({ completionKind: "limit_stop" })],
    outcomes: [{ ...closing, kind: "blocked", reason: "limit", summary }],
  },
  {
    name: "a token budget stop after a Goal pause restates the block",
    events: [
      started(),
      goal("not_met", { waitingForUser: "Which branch?" }),
      complete({ completionKind: "limit_stop" }),
    ],
    outcomes: [
      {
        ...running,
        kind: "blocked",
        reason: "user",
        question: "Which branch?",
        goalId: "g-1",
        revision: 2,
      },
      { ...closing, kind: "blocked", reason: "limit", summary, repeat: true },
    ],
  },
  {
    name: "the Goal is cleared by cancel_goal",
    events: [
      started(),
      { type: "goal_cleared", goalId: "g-1", runId: "run-1", timestamp: NOW + 1 },
      complete({ completionKind: "goal_control_stop" }),
    ],
    outcomes: [
      { ...running, kind: "cancelled" },
      { ...closing, kind: "cancelled", repeat: true },
    ],
  },
  {
    name: "the owner pauses the Goal while it runs",
    events: [started(), tool("Bash"), complete({ completionKind: "goal_control_stop" })],
    outcomes: [{ ...closing, kind: "cancelled" }],
  },
  {
    name: "the run yields to background work",
    events: [started(), tool("Bash"), complete({ completionKind: "background_wait" })],
    outcomes: [{ ...closing, kind: "waiting-worker" }],
  },
  {
    name: "a completion kind from a newer core is unrecognized, not idle",
    events: [started(), tool("Bash"), complete({ completionKind: "handed_off" })],
    outcomes: [{ ...closing, kind: "unrecognized", completionKind: "handed_off" }],
  },
  {
    name: "the user stops the run",
    events: [started(), tool("Bash"), complete({ reason: "aborted_tools" })],
    outcomes: [{ ...closing, kind: "aborted" }],
  },
  {
    name: "the run fails after an error",
    events: [
      started(),
      { type: "error", error: "provider down", runId: "run-1", timestamp: NOW + 1 },
      complete({ reason: "model_error" }),
    ],
    outcomes: [
      { ...running, kind: "failed", error: "provider down" },
      { ...closing, kind: "failed", error: "Work session ended: model_error" },
    ],
  },
  {
    name: "the run ends on its turn budget",
    events: [started(), tool("Bash"), complete({ reason: "max_turns" })],
    outcomes: [
      {
        ...closing,
        kind: "failed",
        error: "Work session ended: max_turns",
        budgetExhausted: true,
      },
    ],
  },
  {
    name: "an unmet Goal round reports nothing",
    events: [started(), tool("Bash"), goal("not_met", { gaps: "tests fail" }), complete()],
    outcomes: [{ ...closing, kind: "done", scope: "turn", summary }],
  },
  {
    name: "a run core gave no id for is keyed by time",
    events: [
      { type: "tool_use_start", toolCall: { id: "t", toolName: "Bash", args: {} } },
      { type: "turn_complete", reason: "completed", completedAt: NOW + 5 },
    ],
    outcomes: [
      {
        sessionId: SID,
        runKey: String(NOW + 5),
        at: NOW + 5,
        final: true,
        reply: false,
        kind: "done",
        scope: "turn",
      },
    ],
  },
];

const withoutTurn = (outcomes: SessionOutcome[]) =>
  outcomes.map(({ turn: _turn, ...rest }) => rest as Record<string, unknown>);

describe("SessionOutcomeDeriver", () => {
  describe.each(scenarios)("$name", ({ events, outcomes }) => {
    test("inferred from an older core's stream", () => {
      expect(events.some((event) => "outcome" in event)).toBe(false);
      expect(withoutTurn(derive(events))).toEqual(outcomes);
    });

    test("read from turn_complete.outcome, with the same result", () => {
      const reported = asReportedByCore(events);
      const terminals = reported.filter((event) => event.type === "turn_complete");
      expect(terminals.every((event) => typeof event.outcome === "object")).toBe(true);
      expect(withoutTurn(derive(reported))).toEqual(outcomes);
    });
  });

  test("a host that attached mid-run reads the Goal pause from turn_complete.outcome", () => {
    // The goal_progress that raised the pause was published before this host
    // subscribed, so the closing outcome is the first (not a repeated) report.
    for (const blockedOn of ["user", "goal_exhausted"] as const) {
      const outcomes = derive([
        tool("Bash"),
        complete({
          outcome: { didWork: true, blockedOn, goal: "paused", backgroundPending: false },
        }),
      ]);
      expect(withoutTurn(outcomes)).toEqual([{ ...closing, kind: "blocked", reason: blockedOn }]);
      expect(outcomes[0]).not.toHaveProperty("repeat");
    }
    // The same run seen from its start restates the pause instead.
    expect(
      derive([
        started(),
        goal("not_met", { waitingForUser: "Which branch?" }),
        complete({
          outcome: { didWork: true, blockedOn: "user", goal: "paused", backgroundPending: false },
        }),
      ]).map((outcome) => [outcome.kind, outcome.final, "repeat" in outcome]),
    ).toEqual([
      ["blocked", false, false],
      ["blocked", true, true],
    ]);
  });

  test("closing outcomes say whether the run forwards a reply, by the bridge's own rule", () => {
    const reply = (...events: Event[]) => closingOutcome(derive([started(), ...events]))!.reply;
    const said = (content: unknown): Event => ({
      type: "assistant_message",
      message: { role: "assistant", content },
    });
    expect(reply(complete())).toBe(true);
    // An explicit empty answer forwards nothing, even after progress text.
    expect(reply(said("working on it"), complete({ text: "  " }))).toBe(false);
    // No final text at all: the last assistant text stands in for it.
    expect(reply(said([{ type: "text", text: "done" }]), complete({ text: undefined }))).toBe(true);
    expect(reply(said([{ type: "tool_use", id: "t" }]), complete({ text: undefined }))).toBe(false);
    expect(reply(complete({ text: undefined }))).toBe(false);
    // A model error and a stop have canned replies; other failures do not.
    expect(reply(complete({ reason: "model_error", text: undefined }))).toBe(true);
    expect(reply(complete({ reason: "aborted_tools", text: "" }))).toBe(true);
    expect(reply(complete({ reason: "max_turns", text: undefined }))).toBe(false);
    expect(reply(complete({ reason: "max_turns" }))).toBe(true);
    // A child agent's message is not the Session's reply.
    expect(reply({ ...said("child text"), agentId: "a-1" }, complete({ text: undefined }))).toBe(
      false,
    );
    // Outcomes raised while the run is going cannot know yet.
    expect(runningOutcome(derive([started(), goal("met")]))).not.toHaveProperty("reply");
    expect(forwardedReplyText({ reason: "completed", text: " 改好了 " }, "earlier")).toBe("改好了");
  });

  test("turn_complete.outcome wins over what the stream suggests", () => {
    // No tool was seen, but core says the run did work (and the reverse).
    expect(
      derive([started(), complete({ outcome: { didWork: true, backgroundPending: false } })]),
    ).toMatchObject([{ kind: "done", scope: "turn" }]);
    expect(
      derive([
        started(),
        tool("Bash"),
        complete({ outcome: { didWork: false, backgroundPending: false } }),
      ]),
    ).toMatchObject([{ kind: "idle" }]);
    // A block or a background wait that only the outcome reports.
    expect(
      derive([
        started(),
        complete({ outcome: { didWork: true, blockedOn: "user", backgroundPending: false } }),
      ]),
    ).toEqual([expect.objectContaining({ kind: "blocked", reason: "user", final: true })]);
    expect(
      derive([started(), complete({ outcome: { didWork: true, backgroundPending: true } })]),
    ).toMatchObject([{ kind: "waiting-worker" }]);
    expect(
      derive([
        started(),
        complete({ outcome: { didWork: true, blockedOn: "limit", backgroundPending: false } }),
      ]),
    ).toMatchObject([{ kind: "blocked", reason: "limit" }]);
  });

  test("a malformed outcome falls back to the stream", () => {
    for (const outcome of [null, "done", [], {}, { didWork: "yes", backgroundPending: false }]) {
      expect(derive([started(), tool("Bash"), complete({ outcome })])).toMatchObject([
        { kind: "done", scope: "turn" },
      ]);
    }
  });

  describe("background wake without a trigger (older core)", () => {
    const untriggered = (extra: Event = {}) => started({ clientMessageId: undefined, ...extra });

    test("a run with no client message and no announcement is a wake", () => {
      expect(derive([untriggered(), complete()])).toMatchObject([{ kind: "done", scope: "turn" }]);
    });

    test("a run announced by session_user_message is a host message", () => {
      expect(
        derive([{ type: "session_user_message", text: "hi" }, untriggered(), complete()]),
      ).toMatchObject([{ kind: "idle" }]);
    });

    test("each announcement covers one run", () => {
      const kinds = derive([
        { type: "session_user_message", text: "one" },
        { type: "session_user_message", text: "two" },
        untriggered({ runId: "run-1" }),
        complete(),
        untriggered({ runId: "run-2" }),
        complete({ runId: "run-2" }),
        untriggered({ runId: "run-3" }),
        complete({ runId: "run-3" }),
      ]).map((outcome) => outcome.kind);
      expect(kinds).toEqual(["idle", "idle", "done"]);
    });

    test("a marked wake does not consume a queued message's announcement", () => {
      const kinds = derive([
        { type: "session_user_message", text: "queued" },
        untriggered({ runId: "wake", trigger: "background_wake" }),
        complete({ runId: "wake" }),
        untriggered({ runId: "host", trigger: "host_message" }),
        complete({ runId: "host" }),
      ]).map((outcome) => outcome.kind);
      expect(kinds).toEqual(["done", "idle"]);
    });
  });

  test("outcomes of one turn share a turn number; the next turn gets another", () => {
    const outcomes = derive([
      started(),
      { type: "error", error: "boom" },
      complete({ reason: "model_error" }),
      started({ runId: "run-2" }),
      complete({ runId: "run-2" }),
    ]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["failed", "failed", "idle"]);
    expect(outcomes[0]!.turn).toBe(outcomes[1]!.turn);
    expect(outcomes[2]!.turn).not.toBe(outcomes[0]!.turn);
  });

  test("Sessions are tracked separately", () => {
    const deriver = new SessionOutcomeDeriver({ now: () => NOW });
    deriver.derive("a", started({ sessionId: "a" }));
    deriver.derive("b", started({ sessionId: "b" }));
    deriver.derive("a", tool("Bash"));
    expect(deriver.derive("b", complete())).toMatchObject([{ sessionId: "b", kind: "idle" }]);
    expect(deriver.derive("a", complete())).toMatchObject([{ sessionId: "a", kind: "done" }]);
  });

  test("child-agent and malformed events produce nothing", () => {
    const deriver = new SessionOutcomeDeriver({ now: () => NOW });
    for (const event of [null, 3, "x", [], {}, { type: 5 }, complete({ agentId: "child" })])
      expect(deriver.derive(SID, event)).toEqual([]);
  });

  test("the event's own time is used, else now", () => {
    expect(derive([started(), tool("Bash"), complete({ completedAt: undefined })])).toMatchObject([
      { at: NOW },
    ]);
    expect(derive([started(), goal("met", { timestamp: undefined })])).toMatchObject([{ at: NOW }]);
  });

  test("texts are bounded", () => {
    const long = "x".repeat(5_000);
    const [done] = derive([started(), tool("Bash"), complete({ text: long })]);
    expect(done).toMatchObject({ kind: "done" });
    expect((done as { summary: string }).summary).toHaveLength(2_000);
    const [blocked] = derive([started(), goal("not_met", { waitingForUser: long, gaps: long })]);
    expect((blocked as { question: string }).question).toHaveLength(500);
    expect((blocked as { summary: string }).summary).toHaveLength(2_000);
  });
});

describe("createSessionOutcomeTap", () => {
  test("both consumers get the same outcome object, coordinator first", () => {
    const seen: Array<{ who: string; outcomes: readonly SessionOutcome[]; event?: unknown }> = [];
    const tap = createSessionOutcomeTap(
      {
        coordinator: (_sessionId, event, outcomes) =>
          seen.push({ who: "coordinator", outcomes, event }),
        watcher: (_sessionId, outcomes) => seen.push({ who: "watcher", outcomes }),
      },
      new SessionOutcomeDeriver({ now: () => NOW }),
    );
    const terminal = complete();
    for (const event of [started(), tool("Bash"), terminal]) tap(SID, event);

    // Every event reaches both, in a fixed order, including those with no outcome.
    expect(seen.map((entry) => entry.who)).toEqual([
      "coordinator",
      "watcher",
      "coordinator",
      "watcher",
      "coordinator",
      "watcher",
    ]);
    const [coordinator, watcher] = seen.slice(-2);
    expect(coordinator!.event).toBe(terminal);
    expect(coordinator!.outcomes).toHaveLength(1);
    expect(watcher!.outcomes).toBe(coordinator!.outcomes);
    expect(watcher!.outcomes[0]).toBe(coordinator!.outcomes[0]);
    expect(closingOutcome(watcher!.outcomes)).toMatchObject({ kind: "done", scope: "turn" });
    expect(runningOutcome(watcher!.outcomes)).toBeUndefined();
  });

  test("each event is interpreted once", () => {
    const deriver = new SessionOutcomeDeriver({ now: () => NOW });
    let derived = 0;
    const derive = deriver.derive.bind(deriver);
    deriver.derive = (sessionId, event) => {
      derived += 1;
      return derive(sessionId, event);
    };
    const tap = createSessionOutcomeTap(
      { coordinator: () => undefined, watcher: () => undefined },
      deriver,
    );
    for (const event of [started(), tool("Bash"), complete()]) tap(SID, event);
    expect(derived).toBe(3);
  });

  test("a failing coordinator does not keep the outcome from the watcher", () => {
    const watched: SessionOutcome[] = [];
    const tap = createSessionOutcomeTap({
      coordinator: () => {
        throw new Error("store is closed");
      },
      watcher: (_sessionId, outcomes) => watched.push(...outcomes),
    });
    expect(() => tap(SID, complete({ reason: "model_error" }))).toThrow("store is closed");
    expect(watched).toMatchObject([{ kind: "failed" }]);
  });
});
