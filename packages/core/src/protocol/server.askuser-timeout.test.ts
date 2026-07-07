import { describe, it, expect, spyOn } from "bun:test";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { Methods } from "./types.js";
import type { Engine, EngineResult } from "../engine/engine.js";
import type { ApprovalRequest, ApprovalResult } from "../types.js";

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const GOAL_ASKUSER_TIMEOUT_MS = 10 * 60 * 1000;

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

function result(text: string, sessionId: string): EngineResult {
  return {
    text,
    reason: "completed",
    sessionId,
    turnCount: 1,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeAskingEngine(sessionId: string, goal?: { objective: string }) {
  const state = {
    askUser: undefined as ((q: string) => Promise<string>) | undefined,
    answer: undefined as string | undefined,
  };
  const engine = {
    setAskUser(fn: (q: string) => Promise<string>) {
      state.askUser = fn;
    },
    setPlanMode() {},
    setBrowserBridge() {},
    setInjectCredential() {},
    isHeadless: () => false,
    getGoal: () => goal,
    async run(): Promise<EngineResult> {
      state.answer = await state.askUser!("continue?");
      return result(state.answer, sessionId);
    },
  } as unknown as Engine;
  return { engine, state };
}

describe("AgentServer AskUserQuestion timeout behavior", () => {
  it("does not arm the approval timeout for legacy interactive askUser", async () => {
    const { engine, state } = makeAskingEngine("legacy-sess");
    const t = makeTransport();
    const server = new AgentServer({ transport: t.transport, engine });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: Methods.Run,
      params: { sessionId: "legacy-sess", task: "ask" },
    });
    await tick();

    expect((server as any).pendingApprovals.size).toBe(1);
    expect((server as any).approvalTimers.size).toBe(0);
    expect(state.answer).toBeUndefined();
    expect(
      t.sent.some((m) => m.method === Methods.ApprovalRequest && m.params?.request?.toolName === "__ask_user__"),
    ).toBe(true);

    t.deliver({ jsonrpc: "2.0", id: 2, method: Methods.Cancel, params: { sessionId: "legacy-sess" } });
    await tick();

    expect((server as any).pendingApprovals.size).toBe(0);
    expect(state.answer).toBe("cancelled");
  });

  it("does not arm the approval timeout for chatManager interactive askUser", async () => {
    const { engine, state } = makeAskingEngine("sess-1");
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const t = makeTransport();
    const server = new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: Methods.Run,
      params: { sessionId: "sess-1", task: "ask" },
    });
    await tick();

    const session = chatManager.get("sess-1")!;
    expect(session.pendingApprovals.size).toBe(1);
    expect((server as any).approvalTimers.size).toBe(0);
    expect(state.answer).toBeUndefined();
    expect(
      t.sent.some(
        (m) =>
          m.method === Methods.ApprovalRequest &&
          m.params?.sessionId === "sess-1" &&
          m.params?.request?.toolName === "__ask_user__",
      ),
    ).toBe(true);

    t.deliver({ jsonrpc: "2.0", id: 2, method: Methods.Cancel, params: { sessionId: "sess-1" } });
    await tick();

    expect(session.pendingApprovals.size).toBe(0);
    expect(state.answer).toBe("cancelled");
  });

  it("arms the approval timeout for chatManager askUser when a goal is active, and resolves with a continue-nudge on expiry", async () => {
    const scheduled: Array<{ timeout: number | undefined; run: () => void }> = [];
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      ((handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => {
        scheduled.push({ timeout, run: () => handler(...args) });
        return 1 as any;
      }) as unknown as typeof setTimeout,
    );

    try {
      const { engine, state } = makeAskingEngine("goal-sess", { objective: "ship it" });
      const chatManager = new ChatSessionManager({
        runtime: {} as never,
        engineFactory: () => engine,
      });
      const t = makeTransport();
      const server = new AgentServer({ transport: t.transport, chatManager });

      t.deliver({
        jsonrpc: "2.0",
        id: 1,
        method: Methods.Run,
        params: { sessionId: "goal-sess", task: "ask" },
      });
      await tick();

      const session = chatManager.get("goal-sess")!;
      expect(session.pendingApprovals.size).toBe(1);
      // Goal-active ask arms a dedicated 10-minute timeout (longer than the
      // 5-minute tool-approval timeout — a present user deserves more time).
      const askTimer = scheduled.find((s) => s.timeout === GOAL_ASKUSER_TIMEOUT_MS);
      expect(askTimer).toBeDefined();
      expect((server as any).approvalTimers.size).toBe(1);
      expect(state.answer).toBeUndefined();

      // Fire the timeout → the pending ask drains and resolves with a nudge so
      // the goal loop keeps going instead of hanging forever.
      askTimer!.run();
      await tick();

      expect(session.pendingApprovals.size).toBe(0);
      expect((server as any).approvalTimers.size).toBe(0);
      expect(state.answer).toContain("自行做出合理假设并继续");
      // The server also notifies clients so the stale ask card is dismissed.
      expect(
        t.sent.some(
          (m) =>
            m.method === Methods.ApprovalResolved &&
            m.params?.sessionId === "goal-sess" &&
            typeof m.params?.requestId === "string",
        ),
      ).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("keeps the approval timeout for real tool approvals", async () => {
    const scheduled: Array<{ timeout: number | undefined; run: () => void }> = [];
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      ((handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => {
        scheduled.push({ timeout, run: () => handler(...args) });
        return 1 as any;
      }) as unknown as typeof setTimeout,
    );

    try {
      const t = makeTransport();
      const server = new AgentServer({
        transport: t.transport,
        engine: { isHeadless: () => true, setAskUser() {} } as unknown as Engine,
      });
      const request: ApprovalRequest = {
        toolName: "Bash",
        args: { command: "echo ok" },
        description: "echo ok",
        riskLevel: "medium",
      };

      const approval = (server as any).requestApprovalFromClient(request) as Promise<ApprovalResult>;

      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]!.timeout).toBe(APPROVAL_TIMEOUT_MS);
      expect((server as any).approvalTimers.size).toBe(1);

      scheduled[0]!.run();
      await expect(approval).resolves.toEqual({ approved: false, reason: "approval timed out" });
      expect((server as any).approvalTimers.size).toBe(0);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
