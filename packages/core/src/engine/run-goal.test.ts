import { describe, expect, test } from "bun:test";
import { createGoalLifecycle } from "../goal/lifecycle.js";
import type { SessionBundle } from "../session/session-manager.js";
import { resolveRunGoal } from "./run-goal.js";

describe("resolveRunGoal", () => {
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
