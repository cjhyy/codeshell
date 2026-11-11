import { describe, expect, test } from "bun:test";
import { createNoticeActionControls, lastUserMessageIn } from "./pet-notice-action-controls.js";

function controls(
  options: { sessions?: Array<{ agentSessionId: string; runState?: string }> } = {},
) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const external: Array<{ method: string; args: unknown[] }> = [];
  const made = createNoticeActionControls({
    worker: {
      subscribeOutbound: () => () => {},
      injectWorkerMessage: () => {},
      requestWorker: async (method, params) => {
        requests.push({ method, params });
        return { ok: true, result: { updated: true, deleted: true } };
      },
    },
    external: () => ({
      get: () => ({}),
      isSessionRunning: () => false,
      getGoal: () => ({ goal: "x", goalId: "g", revision: 2, paused: true }),
      updateGoal: async (...args: unknown[]) => {
        external.push({ method: "updateGoal", args });
        return { updated: true };
      },
      deleteGoal: (...args: unknown[]) => {
        external.push({ method: "deleteGoal", args });
        return { cleared: true };
      },
      send: async () => undefined,
    }),
    sessions: () => options.sessions ?? [],
    longTasks: { get: () => undefined, control: async () => ({ ok: true }) },
    readEvents: async () => [],
    workspace: async () => undefined,
    openPath: async () => "",
    revealPath: () => {},
    openExternal: async () => {},
    locateSession: () => {},
  });
  return { made, requests, external };
}

describe("notice item controls", () => {
  test("a native Session the catalog no longer lists is gone", () => {
    const { made } = controls({ sessions: [{ agentSessionId: "a", runState: "idle" }] });
    expect(made.sessionState("a", "native")).toBe("idle");
    expect(made.sessionState("deleted", "native")).toBe("missing");
  });

  test("a paused Goal resumes through its own control, fenced by id and revision", async () => {
    const { made, requests, external } = controls();
    expect(await made.resumeGoal("a", "native", { goalId: "g", revision: 2 })).toBe(true);
    expect(requests).toEqual([
      {
        method: "agent/goalUpdate",
        params: { sessionId: "a", paused: false, expectedGoalId: "g", expectedRevision: 2 },
      },
    ]);
    expect(await made.resumeGoal("x", "external", { goalId: "g", revision: 2 })).toBe(true);
    expect(external).toEqual([
      {
        method: "updateGoal",
        args: ["x", { paused: false, expectedGoalId: "g", expectedRevision: 2 }],
      },
    ]);
    expect(await made.goal("x", "external")).toEqual({ goalId: "g", revision: 2, paused: true });
  });

  test("the last user message skips injected and non-user messages", () => {
    const message = (data: Record<string, unknown>) => ({ type: "message", data });
    expect(
      lastUserMessageIn([
        message({ role: "user", content: "把登录页做完" }),
        message({ role: "assistant", content: "好" }),
        message({ role: "user", content: "继续", injected: true }),
        message({ role: "user", content: [{ type: "text", text: "policy" }], authority: "policy" }),
      ]),
    ).toBe("把登录页做完");
    expect(lastUserMessageIn([])).toBeUndefined();
  });
});
