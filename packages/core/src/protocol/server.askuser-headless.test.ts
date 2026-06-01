import { describe, it, expect } from "bun:test";
import { AgentServer } from "./server.js";

// Minimal stub transport satisfying the Transport interface (send/onMessage/close).
function makeTransport() {
  return {
    send: (_msg: unknown) => {},
    onMessage: (_cb: (msg: unknown) => void) => {},
    close: () => {},
  } as any;
}

// Minimal Engine stub: only what the AgentServer ctor touches.
function makeEngineStub(headless: boolean) {
  return {
    isHeadless: () => headless,
    setAskUserCalled: false,
    setAskUser: function (fn: unknown) {
      (this as any).setAskUserCalled = true;
      (this as any)._askUser = fn;
    },
    _askUser: undefined as unknown,
  };
}

describe("AgentServer askUser wiring", () => {
  it("does NOT wire askUser when the engine is headless", () => {
    const engine = makeEngineStub(true);
    new AgentServer({ transport: makeTransport(), engine: engine as any });
    expect(engine.setAskUserCalled).toBe(false);
    expect(engine._askUser).toBeUndefined();
  });

  it("wires askUser when the engine is interactive", () => {
    const engine = makeEngineStub(false);
    new AgentServer({ transport: makeTransport(), engine: engine as any });
    expect(engine.setAskUserCalled).toBe(true);
    expect(typeof engine._askUser).toBe("function");
  });
});
