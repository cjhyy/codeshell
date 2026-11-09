import { describe, expect, test } from "bun:test";
import { goalExtendOutcome, goalGetPayload, type GoalExtendTarget } from "./goal-rpc.js";
import { ErrorCodes } from "./types.js";

const limits = { maxTurns: 60, maxStopBlocks: 30 };
const target = (result: typeof limits | null): GoalExtendTarget & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    extendGoalRun: (ext) => {
      calls.push(ext);
      return result;
    },
  };
};

describe("goalExtendOutcome", () => {
  test("rejects malformed params before routing", () => {
    expect(goalExtendOutcome(null, () => undefined, target(limits))).toEqual({
      ok: false,
      code: ErrorCodes.InvalidParams,
      message: "goal extension params are required",
    });
    const invalid = goalExtendOutcome({ addTurns: -1 }, () => undefined, target(limits));
    expect(invalid).toMatchObject({ ok: false, code: ErrorCodes.InvalidParams });
  });

  test("routes to the named live session first, else the legacy engine", () => {
    const live = target(limits);
    const legacy = target(limits);
    expect(
      goalExtendOutcome(
        { sessionId: "s", addTurns: 5 },
        (id) => (id === "s" ? live : undefined),
        legacy,
      ),
    ).toEqual({ ok: true, limits });
    expect(live.calls).toEqual([
      {
        addTurns: 5,
        addTokenBudget: undefined,
        addTimeBudgetMs: undefined,
        addStopBlocks: undefined,
      },
    ]);
    expect(legacy.calls).toHaveLength(0);
    expect(goalExtendOutcome({ sessionId: "other", addTurns: 5 }, () => undefined, legacy)).toEqual(
      {
        ok: true,
        limits,
      },
    );
  });

  test("reports a missing target and a run that cannot be extended", () => {
    expect(goalExtendOutcome({ sessionId: "gone", addTurns: 1 }, () => undefined, null)).toEqual({
      ok: false,
      code: ErrorCodes.SessionClosed,
      message: "No such session: gone",
    });
    expect(goalExtendOutcome({ addTurns: 1 }, () => undefined, undefined)).toMatchObject({
      message: "sessionId is required",
    });
    expect(goalExtendOutcome({ sessionId: "s", addTurns: 1 }, () => target(null), null)).toEqual({
      ok: false,
      code: ErrorCodes.InvalidParams,
      message: "No active run to extend",
    });
  });
});

describe("goalGetPayload", () => {
  test("shapes identity, deadline anchor and same-goal progress", () => {
    const goal = { objective: "g", goalId: "g1", revision: 2, setAtMs: 7, paused: true };
    expect(goalGetPayload(goal, { goalId: "g1", rounds: 3, activeMs: 9 })).toEqual({
      ok: true,
      goal: "g",
      goalId: "g1",
      revision: 2,
      setAtMs: 7,
      paused: true,
      progress: { rounds: 3, activeMs: 9 },
    });
    expect(goalGetPayload(goal, { goalId: "other", rounds: 3, activeMs: 9 })).not.toHaveProperty(
      "progress",
    );
    expect(goalGetPayload(undefined, { goalId: "g1", rounds: 1, activeMs: 1 })).toEqual({
      ok: true,
      goal: null,
      paused: false,
    });
  });
});
