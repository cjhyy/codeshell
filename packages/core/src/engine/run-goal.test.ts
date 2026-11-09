import { describe, expect, test } from "bun:test";
import { createGoalLifecycle, waitGoalLifecycle, type GoalConfig } from "../goal/lifecycle.js";
import type { SessionBundle } from "../session/session-manager.js";
import { applyRunGoalUpdate, resolveRunGoal } from "./run-goal.js";

describe("applyRunGoalUpdate", () => {
  test("edits preserve borrowed object identities and remove the old pause flag", () => {
    const before = { objective: "old", goalId: "goal", revision: 1, paused: true };
    const runtime: GoalConfig = { ...before };
    const persisted: GoalConfig = { ...before };
    const next = { objective: "new", goalId: "goal", revision: 2, maxTurns: 9 };
    expect(applyRunGoalUpdate(before, next, runtime, persisted)).toBe("目标已编辑。新的目标：new");
    expect(runtime).toEqual(next);
    expect(persisted).toEqual(next);
    expect(before).toMatchObject({ objective: "old", paused: true, revision: 1 });
  });

  test("resume and budget-only controls keep their distinct prompt behavior", () => {
    const before: GoalConfig = { objective: "finish", paused: true };
    expect(applyRunGoalUpdate(before, { objective: "finish" }, before, null)).toBe(
      "目标已恢复：finish",
    );
    expect(before.paused).toBeUndefined();
    const paused = { objective: "finish", paused: true };
    expect(applyRunGoalUpdate(before, paused, before, null)).toBeUndefined();
    expect(before.paused).toBe(true);
    expect(
      applyRunGoalUpdate({ objective: "finish" }, { objective: "finish", maxTurns: 9 }, null, null),
    ).toBeUndefined();
  });
});

describe("resolveRunGoal", () => {
  test.each(["user", "background"] as const)(
    "only a real user reply re-arms a user wait; %s wait admission",
    (waitKind) => {
      const goal = { objective: "finish", goalId: "original", revision: 4 };
      const session = {
        state: { goalLifecycle: waitGoalLifecycle(createGoalLifecycle(goal), 1_000, waitKind) },
      } as SessionBundle;
      let saves = 0;
      const args = {
        session,
        sessionManager: {
          saveActiveGoal: () => {
            saves++;
            return true;
          },
        },
        configGoal: undefined,
        isSubAgent: false,
        sid: "s",
        onStream: undefined,
      };
      if (waitKind === "user") {
        expect(() => resolveRunGoal({ ...args, options: { injected: true } })).toThrow(
          "waiting for the user's reply",
        );
        expect(saves).toBe(0);
      } else {
        expect(resolveRunGoal({ ...args, options: { injected: true } }).normalizedGoal).toEqual(
          goal,
        );
        expect(saves).toBe(1);
      }
      expect(resolveRunGoal({ ...args, options: { injected: false } }).normalizedGoal).toEqual(
        goal,
      );
      expect(saves).toBe(waitKind === "user" ? 1 : 2);
    },
  );

  test("an automatic continuation cannot bypass a manual pause during setup", () => {
    const session = {
      state: { goalLifecycle: createGoalLifecycle({ objective: "finish" }, "paused") },
    } as SessionBundle;
    expect(() =>
      resolveRunGoal({
        options: { injected: true },
        session,
        sessionManager: {
          saveActiveGoal: () => {
            throw new Error("must not re-arm");
          },
        },
        configGoal: undefined,
        isSubAgent: false,
        sid: "s",
        onStream: undefined,
      }),
    ).toThrow("automatic continuation held");
  });

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
