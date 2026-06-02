import { describe, it, expect } from "bun:test";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import type { Engine, EngineResult } from "../engine/engine.js";

/**
 * Regression: the chatManager path (what desktop interactive chat uses) never
 * wired setAskUser on its per-session engines — only the legacyEngine path did.
 * So AskUserQuestion always hit its "not available in headless mode" branch in
 * interactive chat (and in a resumed automation session). After the fix, a Run
 * through the chatManager wires the session engine's askUser to the protocol.
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

/** Fake engine that records whether setAskUser was wired and runs trivially. */
function makeFakeEngine() {
  const state = { askUser: undefined as unknown };
  const engine = {
    setAskUser(fn: unknown) {
      state.askUser = fn;
    },
    setPlanMode() {},
    isHeadless: () => false,
    async run(): Promise<EngineResult> {
      return {
        text: "ok",
        reason: "completed",
        sessionId: "sess-1",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
  return { engine, state };
}

describe("AgentServer askUser wiring — chatManager path", () => {
  it("wires the session engine's askUser when a Run is dispatched", async () => {
    const { engine, state } = makeFakeEngine();
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    // Before any run, askUser is unwired.
    expect(state.askUser).toBeUndefined();

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/run",
      params: { sessionId: "sess-1", task: "hello" },
    });
    // let the async handler run
    await new Promise((r) => setTimeout(r, 10));

    // After the run is dispatched, the session engine has an askUser handler.
    expect(typeof state.askUser).toBe("function");
  });
});
