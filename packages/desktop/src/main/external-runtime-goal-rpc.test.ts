import { describe, expect, test } from "bun:test";
import {
  createExternalGoalRpcHandler,
  parseExternalGoalInput,
} from "./external-runtime-goal-rpc.js";

function fixture() {
  const calls: string[] = [];
  let permitted = true;
  const handler = createExternalGoalRpcHandler({
    isExternalSession: (id) => id === "external-task",
    authorize: (_id, caller) => {
      calls.push(`authorize:${caller}`);
      if (!permitted) throw new Error("goal belongs to another window");
    },
    prepareResume: async () => {
      calls.push("external.ensure");
    },
    service: () => ({
      getGoal: () => {
        calls.push("external.get");
        return { ok: true, goal: "Finish the report", goalId: "goal-1", revision: 4, paused: true };
      },
      updateGoal: async (_id, patch) => {
        calls.push(`external.update:${patch.paused}`);
        return {
          ok: true,
          updated: true,
          goal: patch.objective ?? "Finish the report",
          goalId: "goal-1",
          revision: 5,
          paused: patch.paused === true,
        };
      },
      deleteGoal: () => {
        calls.push("external.delete");
        return { ok: true, cleared: true };
      },
      extendGoal: (_id, extension) => {
        calls.push(`external.extend:${extension.addTurns}`);
        return { ok: true, limits: { maxTurns: 15, maxStopBlocks: 3, timeBudgetMs: 1_800_000 } };
      },
    }),
  });
  return {
    calls,
    deny: () => {
      permitted = false;
    },
    request: (method: string, params: Record<string, unknown> = {}) =>
      handler(
        {
          id: "request-1",
          method,
          params: { sessionId: "external-task", ...params },
        },
        7,
      ),
  };
}

describe("external Goal RPC routing", () => {
  test("leaves native and unrelated methods on the existing worker path", () => {
    const f = fixture();
    expect(f.request("agent/goalGet", { sessionId: "native-task" })).toBeUndefined();
    expect(f.request("agent/run")).toBeUndefined();
    expect(f.calls).toEqual([]);
  });

  test("reads a cold external goal without starting either runtime", async () => {
    const f = fixture();
    expect(await f.request("agent/goalGet")).toMatchObject({
      id: "request-1",
      result: { goal: "Finish the report", goalId: "goal-1", revision: 4, paused: true },
    });
    expect(f.calls).toEqual(["authorize:7", "external.get"]);
  });

  test("resumes through external ensure before the versioned update", async () => {
    const f = fixture();
    expect(
      await f.request("agent/goalUpdate", {
        paused: false,
        expectedGoalId: "goal-1",
        expectedRevision: 4,
      }),
    ).toMatchObject({ result: { updated: true, revision: 5, paused: false } });
    expect(f.calls).toEqual([
      "authorize:7",
      "external.get",
      "external.ensure",
      "external.update:false",
    ]);
  });

  test("stale resume cannot start a runtime or mutate the replacement goal", async () => {
    const f = fixture();
    expect(
      await f.request("agent/goalUpdate", {
        paused: false,
        expectedGoalId: "old-goal",
        expectedRevision: 4,
      }),
    ).toMatchObject({ result: { updated: false } });
    expect(f.calls).toEqual(["authorize:7", "external.get"]);
  });

  test("pause and edit remain disk operations when the task is cold", async () => {
    const f = fixture();
    await f.request("agent/goalUpdate", {
      paused: true,
      objective: "Updated report",
      expectedGoalId: "goal-1",
      expectedRevision: 4,
    });
    expect(f.calls).toEqual(["authorize:7", "external.get", "external.update:true"]);
  });

  test("returns handled errors for unauthorized controls instead of falling through", async () => {
    const f = fixture();
    f.deny();
    expect(await f.request("agent/goalClear")).toMatchObject({
      id: "request-1",
      error: { message: "goal belongs to another window" },
    });
    expect(f.calls).toEqual(["authorize:7"]);
  });

  test("delete preserves the preload contract and clear stays a legacy alias", async () => {
    const f = fixture();
    expect(
      await f.request("agent/goalDelete", { expectedGoalId: "goal-1", expectedRevision: 4 }),
    ).toMatchObject({ result: { ok: true, deleted: true } });
    expect(await f.request("agent/goalClear")).toMatchObject({
      result: { ok: true, cleared: true },
    });
  });

  test("extends the external run and rejects invalid budgets or missing CAS", async () => {
    const f = fixture();
    expect(await f.request("agent/goalExtend", { addTurns: 3 })).toMatchObject({
      result: { ok: true, limits: { maxTurns: 15 } },
    });
    expect(await f.request("agent/goalExtend", { addTurns: -1 })).toHaveProperty("error");
    expect(await f.request("agent/goalUpdate", { paused: false })).toHaveProperty("error");
    expect(await f.request("agent/goalDelete")).toHaveProperty("error");
    expect(f.calls.filter((call) => call.startsWith("external."))).toEqual(["external.extend:3"]);
  });
});

describe("external Goal send input", () => {
  test("normalizes text and strips renderer-supplied lifecycle identity", () => {
    expect(parseExternalGoalInput(undefined)).toBeUndefined();
    expect(parseExternalGoalInput("  Finish the report  ")).toEqual({
      objective: "Finish the report",
    });
    expect(
      parseExternalGoalInput({
        objective: "Research",
        tokenBudget: 5000,
        maxTurns: 4,
        goalId: "forged",
        revision: 99,
        setAtMs: 1,
      }),
    ).toEqual({ objective: "Research", tokenBudget: 5000, maxTurns: 4 });
  });

  test("rejects blank, oversized and malformed objectives and invalid budgets", () => {
    for (const value of [
      null,
      [],
      true,
      "  ",
      "x".repeat(65_537),
      { objective: 9 },
      { objective: "Research", maxTurns: 0 },
      { objective: "Research", tokenBudget: Infinity },
    ]) {
      expect(() => parseExternalGoalInput(value)).toThrow();
    }
  });
});
