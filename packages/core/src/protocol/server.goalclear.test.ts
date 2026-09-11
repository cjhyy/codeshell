import { describe, it, expect } from "bun:test";
import { AgentServer } from "./server.js";
import { Methods } from "./types.js";

function makeTransport() {
  const sent: any[] = [];
  let onMsg: (msg: unknown) => void = () => {};
  return {
    sent,
    deliver: (msg: unknown) => onMsg(msg),
    transport: {
      send: (m: unknown) => sent.push(m),
      onMessage: (cb: (msg: unknown) => void) => {
        onMsg = cb;
      },
      close: () => {},
    } as any,
  };
}

describe("AgentServer agent/goalClear", () => {
  for (const mode of ["live", "legacy"] as const) {
    it(`stamps ${mode} Goal clear with the run identity captured before the control`, () => {
      let runId = "cleared-run";
      const engine = {
        isHeadless: () => true,
        getGoal: () => ({ objective: "ship", goalId: "goal-1", revision: 2 }),
        getSessionManager: () => ({
          readSessionState: () => ({ runId, clientMessageId: "cleared-client" }),
        }),
        clearGoal: () => {
          runId = "newer-run";
          return true;
        },
      } as any;
      const t = makeTransport();
      new AgentServer({
        transport: t.transport,
        ...(mode === "legacy"
          ? { engine }
          : {
              chatManager: {
                get: () => ({ engine, getGoal: engine.getGoal, clearGoal: engine.clearGoal }),
              } as any,
            }),
      });
      t.deliver({ jsonrpc: "2.0", id: 1, method: Methods.GoalClear, params: { sessionId: "s-1" } });
      expect(
        t.sent.find((message) => message.method === Methods.StreamEvent)?.params.event,
      ).toEqual({
        type: "goal_cleared",
        runId: "cleared-run",
        clientMessageId: "cleared-client",
        goalId: "goal-1",
        revision: 2,
      });
    });
  }

  it("notifies stream subscribers when a live session goal is cleared", () => {
    let clearCalls = 0;
    const chatManager = {
      get: (sessionId: string) =>
        sessionId === "s-1"
          ? {
              getGoal: () => ({ objective: "ship", goalId: "goal-1" }),
              clearGoal: () => {
                clearCalls += 1;
                return true;
              },
            }
          : undefined,
    } as any;
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: Methods.GoalClear,
      params: { sessionId: "s-1" },
    });

    expect(t.sent.find((msg) => msg.id === 1)?.result).toEqual({ ok: true, cleared: true });
    expect(clearCalls).toBe(1);
    const goalClearedNotifications = t.sent.filter(
      (msg) => msg.method === Methods.StreamEvent && msg.params?.event?.type === "goal_cleared",
    );
    expect(goalClearedNotifications).toHaveLength(1);
    expect(goalClearedNotifications[0]?.params).toEqual({
      sessionId: "s-1",
      event: { type: "goal_cleared", goalId: "goal-1" },
    });
  });

  it("does not notify when clear returns false", () => {
    const chatManager = {
      get: () => ({ clearGoal: () => false }),
    } as any;
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: Methods.GoalClear,
      params: { sessionId: "s-1" },
    });

    expect(t.sent.find((msg) => msg.id === 1)?.result).toEqual({ ok: true, cleared: false });
    expect(t.sent.some((msg) => msg.method === Methods.StreamEvent)).toBe(false);
  });
});
