import { describe, it, expect } from "bun:test";
import { AgentServer } from "./server.js";
import { createFakeEngine } from "../testing/create-fake-engine.js";

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
  return createFakeEngine({
    // Preserve the optional-capability fallbacks exercised by this fixture.
    getComposition: undefined,
    getSessionManager: undefined,

    isHeadless: () => headless,
    setAskUserCalled: false,
    setAskUser: function (fn: unknown) {
      this.setAskUserCalled = true;
      this._askUser = fn;
    },
    _askUser: undefined as unknown,
  });
}

describe("AgentServer askUser wiring", () => {
  it("does NOT wire askUser when the engine is headless", () => {
    const engine = makeEngineStub(true);
    new AgentServer({ transport: makeTransport(), engine });
    expect(engine.setAskUserCalled).toBe(false);
    expect(engine._askUser).toBeUndefined();
  });

  it("wires askUser when the engine is interactive", () => {
    const engine = makeEngineStub(false);
    new AgentServer({ transport: makeTransport(), engine });
    expect(engine.setAskUserCalled).toBe(true);
    expect(typeof engine._askUser).toBe("function");
  });
});

describe("createFakeEngine defaults", () => {
  it("supports every host setter and rejects unconfigured capabilities by name", () => {
    const engine = createFakeEngine();
    expect(engine.isHeadless()).toBe(true);
    const setters = Object.entries(engine).filter(([name]) => name.startsWith("set"));
    expect(setters.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        "setAskUser",
        "setAskUserAsync",
        "setBrowserBridge",
        "setInjectCredential",
        "setChildHostBindings",
        "setSessionMessageRouter",
        "setWorkspaceBridge",
        "setPanelBridge",
      ]),
    );
    for (const [, setter] of setters) expect(() => setter(undefined)).not.toThrow();
    for (const method of [
      "getComposition",
      "getSessionManager",
      "getHookRegistry",
      "getPermissionMode",
      "restoreSessionModel",
      "prepareSessionCloseFinalization",
      "dispose",
    ])
      expect(() => Reflect.get(engine, method)()).toThrow(
        `Unexpected fake Engine.${method}() call`,
      );
    expect(Reflect.get(engine, "then")).toBeUndefined();
    expect(Reflect.get(engine, "unknownCapability")).toBeUndefined();
  });

  it("names unexpected method calls and keeps overrides isolated between fakes", () => {
    const absentCapabilities = {
      getComposition: undefined,
      getSessionManager: undefined,
      getHookRegistry: undefined,
      getPermissionMode: undefined,
      restoreSessionModel: undefined,
      prepareSessionCloseFinalization: undefined,
      dispose: undefined,
    };
    const absent = createFakeEngine(absentCapabilities);
    for (const method of Object.keys(absentCapabilities)) {
      expect(Reflect.get(absent, method)).toBeUndefined();
      expect(() => Reflect.get(createFakeEngine(), method)()).toThrow(
        `Unexpected fake Engine.${method}() call`,
      );
    }
    const calls: string[] = [];
    const engine = createFakeEngine({
      isHeadless: () => false,
      setPlanMode: (enabled: boolean) => calls.push(String(enabled)),
      getCurrentModel: () => "fixture-model",
    });
    expect(engine.isHeadless()).toBe(false);
    expect(engine.getCurrentModel()).toBe("fixture-model");
    engine.setPlanMode(true);
    expect(calls).toEqual(["true"]);
    expect(() => engine.run("unexpected")).toThrow("Unexpected fake Engine.run() call");
    expect(() => createFakeEngine().getCurrentModel()).toThrow("Engine.getCurrentModel()");
    createFakeEngine().setPlanMode(false);
    expect(calls).toEqual(["true"]);
  });
});
