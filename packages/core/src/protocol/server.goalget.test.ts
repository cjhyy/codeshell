import { describe, it, expect } from "bun:test";
import { AgentServer } from "./server.js";
import type { Engine } from "../engine/engine.js";
import type { GoalConfig } from "../engine/goal.js";

/**
 * agent/goalGet re-surfaces a session's persisted active goal on load. The goal
 * lives ONLY in state.activeGoal and is never replayed from the transcript, so
 * a reloaded / disk-rebuilt session can't otherwise learn it — the goal block +
 * Cancel button vanish even though the goal is still active ("goal 还在但页面
 * 不显示、取消不了"). The handler must read disk-only and work even when the
 * session is NOT live in chatManager (the bug case = an aborted/reloaded run).
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

/** Headless legacy engine whose getGoal reads from a fixed on-disk map. */
function makeEngine(goals: Record<string, GoalConfig | undefined>) {
  return {
    isHeadless: () => true,
    getGoal: (sessionId: string): GoalConfig | undefined => goals[sessionId],
  } as unknown as Engine;
}

function lastResult(sent: any[]): any {
  return sent[sent.length - 1]?.result;
}

describe("AgentServer agent/goalGet", () => {
  it("returns the persisted goal objective for a session that is NOT live (disk-only)", () => {
    const engine = makeEngine({ "s-1": { objective: "有授权 你直接帮我做完" } });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, engine });

    t.deliver({ jsonrpc: "2.0", id: 1, method: "agent/goalGet", params: { sessionId: "s-1" } });

    expect(lastResult(t.sent)).toEqual({ ok: true, goal: "有授权 你直接帮我做完" });
  });

  it("returns goal:null (not an error) for a session with no active goal", () => {
    const engine = makeEngine({ "s-2": undefined });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, engine });

    t.deliver({ jsonrpc: "2.0", id: 1, method: "agent/goalGet", params: { sessionId: "s-2" } });

    expect(lastResult(t.sent)).toEqual({ ok: true, goal: null });
  });

  it("chatManager mode: session NOT live falls through to the disk reader", () => {
    // Worker (chatManager) mode has no legacyEngine. Reopening a session after
    // restart doesn't create a live ChatSession (that only happens on a send),
    // so chatManager.get() misses. Without a disk fallback the handler returned
    // goal:null even though state.json still held the goal → UI showed nothing.
    const chatManager = { get: () => undefined } as any;
    const t = makeTransport();
    new AgentServer({
      transport: t.transport,
      chatManager,
      readActiveGoalFromDisk: (sid) =>
        sid === "s-3" ? { objective: "重启后仍在跑的目标" } : undefined,
    });

    t.deliver({ jsonrpc: "2.0", id: 1, method: "agent/goalGet", params: { sessionId: "s-3" } });

    expect(lastResult(t.sent)).toEqual({ ok: true, goal: "重启后仍在跑的目标" });
  });

  it("chatManager mode: a LIVE session's goal wins over the disk reader", () => {
    const chatManager = {
      get: (sid: string) =>
        sid === "s-4" ? { getGoal: () => ({ objective: "live goal" }) } : undefined,
    } as any;
    const t = makeTransport();
    new AgentServer({
      transport: t.transport,
      chatManager,
      readActiveGoalFromDisk: () => ({ objective: "stale disk goal" }),
    });

    t.deliver({ jsonrpc: "2.0", id: 1, method: "agent/goalGet", params: { sessionId: "s-4" } });

    expect(lastResult(t.sent)).toEqual({ ok: true, goal: "live goal" });
  });

  it("errors when sessionId is missing", () => {
    const engine = makeEngine({});
    const t = makeTransport();
    new AgentServer({ transport: t.transport, engine });

    t.deliver({ jsonrpc: "2.0", id: 1, method: "agent/goalGet", params: {} });

    expect(t.sent[t.sent.length - 1]?.error).toBeDefined();
    expect(lastResult(t.sent)).toBeUndefined();
  });
});
