import { describe, it, expect } from "bun:test";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { ErrorCodes } from "./types.js";
import type { Engine, EngineResult } from "../engine/engine.js";

/**
 * `requireExisting`: agent/run must reject with SessionNotFound (and NOT run the
 * engine) when the target session isn't on disk. This is what lets a cron
 * "continue this conversation" job whose session was deleted fail loudly so the
 * scheduler can auto-disable it, instead of running the prompt against a fresh
 * blank session.
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

/** Fake engine with a controllable on-disk existence probe + run counter. */
function makeFakeEngine(existsOnDisk: boolean) {
  const state = { runs: 0 };
  const engine = {
    setAskUser() {},
    setBrowserBridge() {},
    setInjectCredential() {},
    setPlanMode() {},
    isHeadless: () => false,
    sessionExistsOnDisk: () => existsOnDisk,
    async run(): Promise<EngineResult> {
      state.runs++;
      return {
        text: "ok",
        reason: "completed",
        sessionId: "sess-x",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
  return { engine, state };
}

function lastError(sent: any[]): { code?: number; message?: string } | undefined {
  const errs = sent.filter((m) => m && m.error);
  return errs.length ? errs[errs.length - 1].error : undefined;
}

describe("agent/run requireExisting", () => {
  it("rejects with SessionNotFound and does NOT run when the session is absent", async () => {
    const { engine, state } = makeFakeEngine(false);
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
      params: { sessionId: "gone-sid", task: "continue", requireExisting: true },
    });
    await new Promise((r) => setTimeout(r, 10));

    const err = lastError(t.sent);
    expect(err?.code).toBe(ErrorCodes.SessionNotFound);
    expect(state.runs).toBe(0); // never ran against a blank session
    expect(chatManager.get("gone-sid")).toBeUndefined();
  });

  it("rejects absent requireExisting without consuming a maxSessions slot", async () => {
    const missing = makeFakeEngine(false);
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => missing.engine,
      maxSessions: 1,
    });
    await chatManager.getOrCreate("live-sid", {} as never);

    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: "agent/run",
      params: { sessionId: "gone-sid", task: "continue", requireExisting: true },
    });
    await new Promise((r) => setTimeout(r, 10));

    const err = lastError(t.sent);
    expect(err?.code).toBe(ErrorCodes.SessionNotFound);
    expect(chatManager.get("gone-sid")).toBeUndefined();
    expect(chatManager.sessionCount()).toBe(1);
    expect(missing.state.runs).toBe(0);
  });

  it("runs normally when the session exists on disk", async () => {
    const { engine, state } = makeFakeEngine(true);
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: "agent/run",
      params: { sessionId: "live-sid", task: "continue", requireExisting: true },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(lastError(t.sent)).toBeUndefined();
    expect(state.runs).toBe(1);
  });

  it("without requireExisting, an absent session still runs (create-fresh, unchanged)", async () => {
    const { engine, state } = makeFakeEngine(false);
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 3,
      method: "agent/run",
      params: { sessionId: "new-sid", task: "hello" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(lastError(t.sent)).toBeUndefined();
    expect(state.runs).toBe(1);
  });
});
