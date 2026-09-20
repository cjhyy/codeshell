import { describe, expect, test } from "bun:test";
import { createGoalLifecycle } from "../goal/lifecycle.js";
import type { SessionBundle } from "../session/session-manager.js";
import { resolveRunGoal } from "./run-goal.js";

describe("resolveRunGoal", () => {
  test.each(["active", "waiting"] as const)(
    "continuation inherits %s Goal identity and budgets",
    (phase) => {
      const goal = {
        objective: "finish",
        goalId: "original",
        revision: 4,
        tokenBudget: 5000,
        timeBudgetMs: 60000,
        maxTurns: 7,
        setAtMs: 100,
      };
      const lifecycle = createGoalLifecycle(goal);
      const session = {
        state: {
          goalLifecycle:
            phase === "waiting"
              ? { ...lifecycle, phase, waitingSinceMs: 200, waitingFor: "finite_background_work" }
              : lifecycle,
        },
      } as SessionBundle;
      const result = resolveRunGoal({
        options: { goalContinuation: { goalId: "original", revision: 4 } },
        session,
        sessionManager: {
          saveActiveGoal: (_state, value) => {
            expect(value).toEqual(goal);
            return true;
          },
        },
        configGoal: undefined,
        isSubAgent: false,
        sid: "s",
        onStream: undefined,
      });
      expect(result.normalizedGoal).toEqual(goal);
      expect(result.persistedRunGoal).toEqual(goal);
    },
  );

  test.each(["paused", "terminal", "changed", "missing", "override"])(
    "continuation refuses a %s Goal",
    (kind) => {
      const lifecycle = createGoalLifecycle({
        objective: "finish",
        goalId: "original",
        revision: kind === "changed" ? 5 : 4,
      });
      const session = {
        state: {
          goalLifecycle:
            kind === "missing"
              ? undefined
              : {
                  ...lifecycle,
                  ...(kind === "paused" || kind === "terminal" ? { phase: kind } : {}),
                },
        },
      } as SessionBundle;
      expect(() =>
        resolveRunGoal({
          options: {
            goalContinuation: { goalId: "original", revision: 4 },
            ...(kind === "override" ? { goal: "replace" } : {}),
          },
          session,
          sessionManager: {
            saveActiveGoal: () => {
              throw new Error("must not mutate Goal");
            },
          },
          configGoal: undefined,
          isSubAgent: false,
          sid: "s",
          onStream: undefined,
        }),
      ).toThrow("Goal continuation is no longer authorized");
    },
  );
  test("disableGoal bypasses explicit, persisted, and configured goals for one turn", () => {
    const session = {
      state: {
        goalLifecycle: createGoalLifecycle({
          objective: "persisted goal",
          goalId: "persisted-id",
          revision: 1,
        }),
      },
      transcript: {},
    } as unknown as SessionBundle;
    let saves = 0;

    const result = resolveRunGoal({
      options: { goal: "explicit goal", disableGoal: true },
      session,
      sessionManager: {
        saveActiveGoal: () => {
          saves += 1;
          return true;
        },
      },
      configGoal: "configured goal",
      isSubAgent: false,
      sid: "standalone-loop",
      onStream: undefined,
    });

    expect(result).toEqual({ normalizedGoal: undefined, persistedRunGoal: undefined });
    expect(saves).toBe(0);
  });
});
