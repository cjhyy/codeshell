import { describe, expect, test } from "bun:test";
import type { StreamEvent, TurnOutcome } from "../types.js";
import { createTurnOutcomeTracker, withOutcomeTrigger } from "./turn-outcome.js";

const BOOKKEEPING = new Set(["AskUserQuestionAsync", "ToolSearch", "NotifyMe"]);

const tool = (toolName: string, agentId?: string): StreamEvent =>
  ({
    type: "tool_use_start",
    toolCall: { id: `call-${toolName}`, toolName, args: {} },
    ...(agentId ? { agentId } : {}),
  }) as StreamEvent;

const goal = (
  fields: Partial<Extract<StreamEvent, { type: "goal_progress" }>>,
  agentId?: string,
): StreamEvent =>
  ({
    type: "goal_progress",
    goalId: "g1",
    status: "not_met",
    round: 1,
    ...fields,
    ...(agentId ? { agentId } : {}),
  }) as StreamEvent;

const complete = (fields: Partial<Extract<StreamEvent, { type: "turn_complete" }>> = {}) =>
  ({ type: "turn_complete", reason: "completed", ...fields }) as StreamEvent;

/** The outcome a run reports after publishing `events` and then `terminal`. */
function outcomeOf(events: StreamEvent[], terminal: StreamEvent = complete()): TurnOutcome {
  const tracker = createTurnOutcomeTracker((name) => BOOKKEEPING.has(name));
  for (const event of events) expect(tracker.prepareEvent(event)).toBe(event);
  const prepared = tracker.prepareEvent(terminal);
  if (prepared.type !== "turn_complete" || !prepared.outcome) throw new Error("no outcome");
  return prepared.outcome;
}

describe("turn_complete.outcome", () => {
  const cases: Array<[string, StreamEvent[], StreamEvent | undefined, TurnOutcome]> = [
    ["an acknowledgement did no work", [], undefined, { didWork: false, backgroundPending: false }],
    [
      "only bookkeeping tools is still no work",
      [tool("NotifyMe"), tool("ToolSearch"), tool("AskUserQuestionAsync")],
      undefined,
      { didWork: false, backgroundPending: false },
    ],
    [
      "one real tool is work",
      [tool("NotifyMe"), tool("Bash")],
      undefined,
      { didWork: true, backgroundPending: false },
    ],
    [
      "an unregistered tool is work",
      [tool("mcp__server__anything")],
      undefined,
      { didWork: true, backgroundPending: false },
    ],
    [
      "a sub-agent's own tool calls are not the parent's",
      [tool("Bash", "child")],
      undefined,
      { didWork: false, backgroundPending: false },
    ],
    [
      "the Goal waits for the user",
      [tool("Bash"), goal({ waitingForUser: "Which branch?" })],
      undefined,
      { didWork: true, blockedOn: "user", goal: "paused", backgroundPending: false },
    ],
    [
      "the Goal is exhausted",
      [goal({ status: "exhausted" })],
      complete({ reason: "goal_budget_exhausted" }),
      { didWork: false, blockedOn: "goal_exhausted", backgroundPending: false },
    ],
    [
      "the run hit its token budget",
      [tool("Bash")],
      complete({ completionKind: "limit_stop" }),
      { didWork: true, blockedOn: "limit", backgroundPending: false },
    ],
    [
      "a Goal pause outranks the token budget stop",
      [goal({ waitingForUser: "Which branch?" })],
      complete({ completionKind: "limit_stop" }),
      { didWork: false, blockedOn: "user", goal: "paused", backgroundPending: false },
    ],
    [
      "the Goal was met",
      [tool("Bash"), goal({ status: "met" })],
      undefined,
      { didWork: true, goal: "met", backgroundPending: false },
    ],
    [
      "the Goal was cleared",
      [{ type: "goal_cleared", goalId: "g1" }],
      complete({ completionKind: "goal_control_stop" }),
      { didWork: false, goal: "cleared", backgroundPending: false },
    ],
    [
      "the run yields to background work",
      [tool("Bash")],
      complete({ completionKind: "background_wait" }),
      { didWork: true, backgroundPending: true },
    ],
    [
      "the Goal parks on background work",
      [goal({ waiting: { kind: "background_work", sinceMs: 1 } })],
      undefined,
      { didWork: false, goal: "paused", backgroundPending: false },
    ],
    [
      "an unmet round is neither a pause nor a block",
      [goal({ gaps: "tests fail" }), goal({ status: "approaching_limit" })],
      undefined,
      { didWork: false, backgroundPending: false },
    ],
    [
      "a child's Goal events are ignored",
      [goal({ status: "met" }, "child"), goal({ waitingForUser: "?" }, "child")],
      undefined,
      { didWork: false, backgroundPending: false },
    ],
    [
      "a failed run still reports what it did",
      [tool("Bash")],
      complete({ reason: "model_error" }),
      { didWork: true, backgroundPending: false },
    ],
  ];
  test.each(cases)("%s", (_name, events, terminal, expected) => {
    expect(outcomeOf(events, terminal)).toEqual(expected);
  });

  test("a child's turn_complete gets no outcome", () => {
    const tracker = createTurnOutcomeTracker(() => false);
    const child = { ...complete(), agentId: "child" } as StreamEvent;
    expect(tracker.prepareEvent(child)).toBe(child);
  });

  test("the terminal keeps its own fields", () => {
    const tracker = createTurnOutcomeTracker(() => false);
    expect(
      tracker.prepareEvent(complete({ text: "done", completionKind: "background_wait" })),
    ).toEqual({
      type: "turn_complete",
      reason: "completed",
      text: "done",
      completionKind: "background_wait",
      outcome: { didWork: false, backgroundPending: true },
    });
  });
});

describe("withOutcomeTrigger", () => {
  const withOutcome = (didWork: boolean): StreamEvent =>
    complete({ outcome: { didWork, backgroundPending: false } });

  test("a background wake counts as work", () => {
    expect(withOutcomeTrigger(withOutcome(false), "background_wake")).toMatchObject({
      outcome: { didWork: true, backgroundPending: false, trigger: "background_wake" },
    });
  });

  test.each(["user", "host_message"] as const)("%s only records the trigger", (trigger) => {
    expect(withOutcomeTrigger(withOutcome(false), trigger)).toMatchObject({
      outcome: { didWork: false, trigger },
    });
    expect(withOutcomeTrigger(withOutcome(true), trigger)).toMatchObject({
      outcome: { didWork: true, trigger },
    });
  });

  test("events without an outcome, without a trigger, or from a child pass through", () => {
    const bare = complete();
    expect(withOutcomeTrigger(bare, "background_wake")).toBe(bare);
    const untriggered = withOutcome(false);
    expect(withOutcomeTrigger(untriggered, undefined)).toBe(untriggered);
    const child = { ...withOutcome(false), agentId: "child" } as StreamEvent;
    expect(withOutcomeTrigger(child, "background_wake")).toBe(child);
    const other: StreamEvent = { type: "goal_cleared" };
    expect(withOutcomeTrigger(other, "user")).toBe(other);
  });
});
