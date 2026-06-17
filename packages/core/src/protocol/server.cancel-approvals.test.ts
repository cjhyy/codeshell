import { describe, it, expect } from "bun:test";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import type { Engine, EngineResult } from "../engine/engine.js";

/**
 * Regression (review-2026-06-17): handleCancel's chatManager branch only called
 * s.cancel() (abort + drain queue). It never resolved the session's
 * pendingApprovals nor cleared the server's approvalTimers — so a Stop while a
 * tool awaited approval left that tool hanging until APPROVAL_TIMEOUT_MS
 * (5 min) and leaked the timer. The legacy path always cleaned both up; the
 * multi-session path must too.
 */

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

/**
 * Fake engine whose run() invokes askUser (which never gets a client reply),
 * exposing the pending approval so the test can cancel mid-approval.
 */
function makeAskingEngine() {
  const state = { askUser: undefined as ((q: string) => Promise<string>) | undefined, answer: undefined as string | undefined };
  const engine = {
    setAskUser(fn: (q: string) => Promise<string>) {
      state.askUser = fn;
    },
    setPlanMode() {},
    setBrowserBridge() {},
    isHeadless: () => false,
    async run(): Promise<EngineResult> {
      // Ask the client something; the client never replies, so this hangs until
      // cancel resolves it (the bug: it would hang until the 5-min timeout).
      state.answer = await state.askUser!("are you sure?");
      return {
        text: state.answer,
        reason: "completed",
        sessionId: "sess-1",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
  return { engine, state };
}

describe("AgentServer cancel — clears session approvals", () => {
  it("resolves a pending askUser as cancelled and empties pendingApprovals on cancel", async () => {
    const { engine, state } = makeAskingEngine();
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/run",
      params: { sessionId: "sess-1", task: "hello" },
    });
    // Let run() reach the askUser await and register the pending approval.
    await new Promise((r) => setTimeout(r, 20));

    const session = chatManager.get("sess-1")!;
    expect(session).toBeDefined();
    expect(session.pendingApprovals.size).toBe(1); // the askUser is pending

    // Stop the session while the approval is pending.
    t.deliver({ jsonrpc: "2.0", id: 2, method: "agent/cancel", params: { sessionId: "sess-1" } });

    // The pending approval must be drained immediately (not after 5 min).
    await new Promise((r) => setTimeout(r, 20));
    expect(session.pendingApprovals.size).toBe(0);
    // The awaiting askUser resolved (engine.run's await unblocked) — a declined
    // approval surfaces as the decline reason rather than hanging.
    expect(state.answer).toBe("cancelled");
  });
});
