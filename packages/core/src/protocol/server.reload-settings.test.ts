import { describe, it, expect } from "bun:test";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import type { Engine } from "../engine/engine.js";
import type { ValidatedSettings } from "../settings/schema.js";

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

/** Fake engine recording refreshRuntimeConfig calls (and the existing knobs). */
function makeFakeEngine(id: string) {
  const calls: Array<{ patch: any; version: number }> = [];
  const engine = {
    id,
    setAskUser() {},
    setPlanMode() {},
    setPermissionMode() {},
    isHeadless: () => false,
    refreshRuntimeConfig(patch: any, version: number) {
      calls.push({ patch, version });
    },
    async run() {
      return {
        text: "ok",
        reason: "completed" as const,
        sessionId: id,
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
  return { engine, calls };
}

function fakeSettings(appendSystemPrompt: string): ValidatedSettings {
  return {
    agent: { appendSystemPrompt },
    mcpServers: {},
    disabledPlugins: [],
  } as unknown as ValidatedSettings;
}

describe("AgentServer configure({ reloadSettings })", () => {
  it("pushes diskDefaultsFrom(settings) to ALL live sessions with a monotonic version", () => {
    const a = makeFakeEngine("A");
    const b = makeFakeEngine("B");
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        throw new Error("factory should not be called — sessions pre-seeded");
      },
    });
    // Seed two sessions directly via the private map (test-only).
    (chatManager as any).sessions.set("A", { id: "A", engine: a.engine });
    (chatManager as any).sessions.set("B", { id: "B", engine: b.engine });

    let readCount = 0;
    const settingsReader = () => {
      readCount++;
      return fakeSettings(`append-${readCount}`);
    };

    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager, settingsReader });

    t.deliver({ jsonrpc: "2.0", id: 1, method: "agent/configure", params: { reloadSettings: true } });

    expect(readCount).toBe(1);
    expect(a.calls.length).toBe(1);
    expect(b.calls.length).toBe(1);
    // Same freshly-read settings → same patch for both sessions.
    expect(a.calls[0].patch.appendSystemPrompt).toBe("append-1");
    expect(b.calls[0].patch.appendSystemPrompt).toBe("append-1");
    // Patch carries only disk-default fields.
    expect(a.calls[0].patch).toHaveProperty("preset");
    expect(a.calls[0].patch).not.toHaveProperty("permissionMode");
    // Monotonic version, equal across sessions in one reload.
    expect(a.calls[0].version).toBe(b.calls[0].version);
    const v1 = a.calls[0].version;

    // A second reload bumps the version.
    t.deliver({ jsonrpc: "2.0", id: 2, method: "agent/configure", params: { reloadSettings: true } });
    expect(a.calls.length).toBe(2);
    expect(a.calls[1].version).toBeGreaterThan(v1);

    // Both responses are ok.
    const oks = t.sent.filter((m: any) => m.result?.ok === true);
    expect(oks.length).toBeGreaterThanOrEqual(2);
  });

  it("#6: skips the broadcast when the disk patch is byte-identical to the last", () => {
    const a = makeFakeEngine("A");
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        throw new Error("factory should not be called");
      },
    });
    (chatManager as any).sessions.set("A", { id: "A", engine: a.engine });

    // Identical settings every read (simulates a no-op personalization re-save).
    let readCount = 0;
    const settingsReader = () => {
      readCount++;
      return fakeSettings("same");
    };

    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager, settingsReader });

    t.deliver({ jsonrpc: "2.0", id: 1, method: "agent/configure", params: { reloadSettings: true } });
    t.deliver({ jsonrpc: "2.0", id: 2, method: "agent/configure", params: { reloadSettings: true } });
    t.deliver({ jsonrpc: "2.0", id: 3, method: "agent/configure", params: { reloadSettings: true } });

    // Settings are re-read each time (cheap) but the broadcast — and the per-
    // session reloadHooks churn — fires only once because the patch is identical.
    expect(a.calls.length).toBe(1);
    // All three still get an ok response.
    const oks = t.sent.filter((m: any) => m.result?.ok === true);
    expect(oks.length).toBe(3);

    // A genuinely different patch propagates again.
    const a2 = makeFakeEngine("A2");
    const chatManager2 = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        throw new Error("factory should not be called");
      },
    });
    (chatManager2 as any).sessions.set("A2", { id: "A2", engine: a2.engine });
    let n = 0;
    const t2 = makeTransport();
    new AgentServer({
      transport: t2.transport,
      chatManager: chatManager2,
      settingsReader: () => fakeSettings(`v${++n}`),
    });
    t2.deliver({ jsonrpc: "2.0", id: 1, method: "agent/configure", params: { reloadSettings: true } });
    t2.deliver({ jsonrpc: "2.0", id: 2, method: "agent/configure", params: { reloadSettings: true } });
    expect(a2.calls.length).toBe(2);
  });

  it("sessionId-scoped reloadSettings applies to that one session only", () => {
    const a = makeFakeEngine("A");
    const b = makeFakeEngine("B");
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        throw new Error("factory should not be called");
      },
    });
    (chatManager as any).sessions.set("A", { id: "A", engine: a.engine });
    (chatManager as any).sessions.set("B", { id: "B", engine: b.engine });

    const settingsReader = () => fakeSettings("scoped");
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager, settingsReader });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/configure",
      params: { sessionId: "A", reloadSettings: true },
    });

    expect(a.calls.length).toBe(1);
    expect(a.calls[0].patch.appendSystemPrompt).toBe("scoped");
    expect(b.calls.length).toBe(0);
  });

  it("does not regress permissionMode / model configure paths", () => {
    let pmCalls = 0;
    const engine = {
      id: "A",
      setAskUser() {},
      setPlanMode() {},
      setPermissionMode() {
        pmCalls++;
      },
      isHeadless: () => false,
      refreshRuntimeConfig() {
        throw new Error("refreshRuntimeConfig must not fire for permissionMode configure");
      },
      async run() {
        return {
          text: "ok",
          reason: "completed" as const,
          sessionId: "A",
          turnCount: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
    } as unknown as Engine;
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        throw new Error("factory should not be called");
      },
    });
    (chatManager as any).sessions.set("A", {
      id: "A",
      engine,
      requestModelSwitch() {},
    });

    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager, settingsReader: () => fakeSettings("x") });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/configure",
      params: { sessionId: "A", permissionMode: "bypassPermissions" },
    });
    expect(pmCalls).toBe(1);
  });
});
