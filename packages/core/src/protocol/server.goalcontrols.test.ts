import { describe, expect, it } from "bun:test";
import { ApprovalRouter } from "../tool-system/permission.js";
import { AgentServer } from "./server.js";
import { ErrorCodes, Methods } from "./types.js";

function makeTransport() {
  const sent: any[] = [];
  let onMsg: (msg: unknown) => void = () => {};
  return {
    sent,
    deliver: (msg: unknown) => onMsg(msg),
    transport: {
      send: (message: unknown) => sent.push(message),
      onMessage: (callback: (msg: unknown) => void) => {
        onMsg = callback;
      },
      close: () => {},
    } as any,
  };
}

describe("AgentServer goal controls", () => {
  it("treats resume on an unpaused idle Goal as an explicit drive request", async () => {
    const before = {
      objective: "idle objective",
      goalId: "goal-idle-kick",
      revision: 5,
    };
    const after = { ...before, revision: 6 };
    const queued: (typeof after)[] = [];
    const session = {
      engine: { isHeadless: () => false },
      getGoal: () => before,
      canResumeGoalInPlace: () => false,
      updateGoal: () => after,
      enqueueGoalResumeTurn: async (goal: typeof after) => {
        queued.push(goal);
        return true;
      },
    };
    const transport = makeTransport();
    const server = new AgentServer({
      transport: transport.transport,
      chatManager: { get: () => session } as any,
    });

    try {
      transport.deliver({
        jsonrpc: "2.0",
        id: "idle-kick",
        method: Methods.GoalUpdate,
        params: {
          sessionId: "s-idle-kick",
          paused: false,
          expectedGoalId: before.goalId,
          expectedRevision: before.revision,
        },
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(transport.sent.find((message) => message.id === "idle-kick")?.result).toMatchObject({
        ok: true,
        updated: true,
        revision: 6,
        paused: false,
      });
      expect(queued).toEqual([after]);
    } finally {
      server.disconnect();
    }
  });

  it("agent/goalUpdate forwards the expected version and publishes the updated version", () => {
    let receivedPatch: unknown;
    const chatManager = {
      get: (sessionId: string) =>
        sessionId === "s-1"
          ? {
              updateGoal: (patch: unknown) => {
                receivedPatch = patch;
                return {
                  objective: "edited objective",
                  goalId: "goal-1",
                  revision: 4,
                  paused: true,
                };
              },
            }
          : undefined,
    } as any;
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, chatManager });

    transport.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: Methods.GoalUpdate,
      params: {
        sessionId: "s-1",
        objective: "edited objective",
        paused: true,
        expectedGoalId: "goal-1",
        expectedRevision: 3,
      },
    });

    expect(receivedPatch).toEqual({
      objective: "edited objective",
      paused: true,
      expectedGoalId: "goal-1",
      expectedRevision: 3,
    });
    expect(transport.sent.find((message) => message.id === 1)?.result).toEqual({
      ok: true,
      updated: true,
      goal: "edited objective",
      goalId: "goal-1",
      revision: 4,
      paused: true,
    });
    expect(
      transport.sent.find(
        (message) =>
          message.method === Methods.StreamEvent && message.params?.event?.type === "goal_updated",
      )?.params,
    ).toEqual({
      sessionId: "s-1",
      event: {
        type: "goal_updated",
        goalId: "goal-1",
        revision: 4,
        objective: "edited objective",
        paused: true,
      },
    });
  });

  it("agent/goalUpdate rejects a stale expected version without publishing an event", () => {
    const chatManager = {
      get: () => ({ updateGoal: () => undefined }),
    } as any;
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, chatManager });

    transport.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: Methods.GoalUpdate,
      params: {
        sessionId: "s-1",
        paused: true,
        expectedGoalId: "goal-1",
        expectedRevision: 1,
      },
    });

    expect(transport.sent.find((message) => message.id === 2)?.result).toEqual({
      ok: true,
      updated: false,
    });
    expect(transport.sent.some((message) => message.method === Methods.StreamEvent)).toBe(false);
  });

  for (const [missingFence, params] of [
    [
      "expectedGoalId",
      {
        sessionId: "s-missing-fence",
        objective: "edited objective",
        expectedRevision: 2,
      },
    ],
    [
      "expectedRevision",
      {
        sessionId: "s-missing-fence",
        objective: "edited objective",
        expectedGoalId: "goal-missing-fence",
      },
    ],
  ] as const) {
    it(`agent/goalUpdate rejects missing ${missingFence}`, () => {
      let updateCalls = 0;
      const chatManager = {
        get: () => ({
          updateGoal: () => {
            updateCalls += 1;
            return undefined;
          },
        }),
      } as any;
      const transport = makeTransport();
      new AgentServer({ transport: transport.transport, chatManager });

      transport.deliver({
        jsonrpc: "2.0",
        id: "missing-fence",
        method: Methods.GoalUpdate,
        params,
      });

      expect(transport.sent.find((message) => message.id === "missing-fence")?.error?.code).toBe(
        ErrorCodes.InvalidParams,
      );
      expect(updateCalls).toBe(0);
      expect(transport.sent.some((message) => message.method === Methods.StreamEvent)).toBe(false);
    });
  }

  it("agent/goalDelete version-fences a cold persisted goal and publishes its cleared version", () => {
    let receivedExpected: unknown;
    const transport = makeTransport();
    new AgentServer({
      transport: transport.transport,
      chatManager: { get: () => undefined } as any,
      readActiveGoalFromDisk: () => ({
        objective: "persisted objective",
        goalId: "goal-2",
        revision: 9,
        paused: true,
      }),
      clearActiveGoalOnDisk: (_sessionId, expected) => {
        receivedExpected = expected;
        return expected?.goalId === "goal-2" && expected.revision === 9;
      },
    });

    transport.deliver({
      jsonrpc: "2.0",
      id: 3,
      method: Methods.GoalDelete,
      params: { sessionId: "s-2", expectedGoalId: "goal-2", expectedRevision: 9 },
    });

    expect(receivedExpected).toEqual({ goalId: "goal-2", revision: 9 });
    expect(transport.sent.find((message) => message.id === 3)?.result).toEqual({
      ok: true,
      deleted: true,
    });
    expect(
      transport.sent.find(
        (message) =>
          message.method === Methods.StreamEvent && message.params?.event?.type === "goal_cleared",
      )?.params,
    ).toEqual({
      sessionId: "s-2",
      event: { type: "goal_cleared", goalId: "goal-2", revision: 9 },
    });
  });

  it("agent/goalDelete returns deleted:false for a stale version and emits nothing", () => {
    const transport = makeTransport();
    new AgentServer({
      transport: transport.transport,
      chatManager: { get: () => undefined } as any,
      readActiveGoalFromDisk: () => ({
        objective: "newer objective",
        goalId: "goal-2",
        revision: 10,
      }),
      clearActiveGoalOnDisk: () => false,
    });

    transport.deliver({
      jsonrpc: "2.0",
      id: 4,
      method: Methods.GoalDelete,
      params: { sessionId: "s-2", expectedGoalId: "goal-2", expectedRevision: 9 },
    });

    expect(transport.sent.find((message) => message.id === 4)?.result).toEqual({
      ok: true,
      deleted: false,
    });
    expect(transport.sent.some((message) => message.method === Methods.StreamEvent)).toBe(false);
  });

  it("strict TCP ownership rejects another connection's update and delete", () => {
    const approvalRouter = new ApprovalRouter();
    const ownerTransport = makeTransport();
    const otherTransport = makeTransport();
    let updateCalls = 0;
    let deleteCalls = 0;
    const session = {
      pendingApprovals: new Map(),
      getGoal: () => ({
        objective: "owned goal",
        goalId: "goal-owned",
        revision: 3,
        paused: true,
      }),
      canResumeGoalInPlace: () => false,
      updateGoal: () => {
        updateCalls += 1;
        return undefined;
      },
      clearGoal: () => {
        deleteCalls += 1;
        return true;
      },
    };
    const chatManager = { get: () => session } as any;
    const owner = new AgentServer({
      transport: ownerTransport.transport,
      chatManager,
      approvalRouter,
      connectionId: "tcp-owner",
    });
    const other = new AgentServer({
      transport: otherTransport.transport,
      chatManager,
      approvalRouter,
      connectionId: "tcp-other",
    });

    try {
      expect(approvalRouter.register("s-owned", "tcp-owner").ok).toBe(true);

      otherTransport.deliver({
        jsonrpc: "2.0",
        id: "foreign-update",
        method: Methods.GoalUpdate,
        params: {
          sessionId: "s-owned",
          paused: false,
          expectedGoalId: "goal-owned",
          expectedRevision: 3,
        },
      });
      otherTransport.deliver({
        jsonrpc: "2.0",
        id: "foreign-delete",
        method: Methods.GoalDelete,
        params: {
          sessionId: "s-owned",
          expectedGoalId: "goal-owned",
          expectedRevision: 3,
        },
      });

      expect(
        otherTransport.sent.find((message) => message.id === "foreign-update")?.error?.code,
      ).toBe(ErrorCodes.Overloaded);
      expect(
        otherTransport.sent.find((message) => message.id === "foreign-delete")?.error?.code,
      ).toBe(ErrorCodes.Overloaded);
      expect(updateCalls).toBe(0);
      expect(deleteCalls).toBe(0);
      expect(approvalRouter.current("s-owned")?.connectionId).toBe("tcp-owner");
    } finally {
      owner.disconnect();
      other.disconnect();
    }
  });

  for (const kind of ["unknown", "stale"] as const) {
    it(`strict TCP ${kind} resume misses do not retain session ownership`, () => {
      const approvalRouter = new ApprovalRouter();
      const transport = makeTransport();
      const goal =
        kind === "stale"
          ? {
              objective: "paused goal",
              goalId: "goal-cas",
              revision: 7,
              paused: true,
            }
          : undefined;
      const server = new AgentServer({
        transport: transport.transport,
        chatManager: { get: () => undefined } as any,
        approvalRouter,
        connectionId: `tcp-${kind}`,
        readActiveGoalFromDisk: () => goal,
        updateActiveGoalOnDisk: () => undefined,
      });

      try {
        transport.deliver({
          jsonrpc: "2.0",
          id: `${kind}-resume`,
          method: Methods.GoalUpdate,
          params: {
            sessionId: `s-${kind}`,
            paused: false,
            expectedGoalId: kind === "stale" ? "goal-cas" : "goal-unknown",
            expectedRevision: kind === "stale" ? 6 : 1,
          },
        });

        expect(transport.sent.find((message) => message.id === `${kind}-resume`)?.result).toEqual({
          ok: true,
          updated: false,
        });
        expect(approvalRouter.current(`s-${kind}`)).toBeNull();
        expect(transport.sent.some((message) => message.method === Methods.StreamEvent)).toBe(
          false,
        );
      } finally {
        server.disconnect();
      }
    });
  }
});
