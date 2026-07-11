import { describe, it, expect } from "bun:test";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import type { Engine } from "../engine/engine.js";
import type { ValidatedSettings } from "../settings/schema.js";
import { getInteractiveApprovalBackend } from "../tool-system/permission.js";

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
  const reloadModelCalls: string[] = [];
  const engine = {
    id,
    setAskUser() {},
    setPlanMode() {},
    setPermissionMode() {},
    isHeadless: () => false,
    // The reload path folds per-session effective disabled lists into the
    // patch (能力总览 project on/off) — fake returns the empty baseline.
    getEffectiveDisabledLists: () => ({
      disabledSkills: [],
      disabledPlugins: [],
      disabledPluginHooks: [],
    }),
    refreshRuntimeConfig(patch: any, version: number) {
      calls.push({ patch, version });
    },
    reloadModelPool() {
      reloadModelCalls.push(id);
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
  return { engine, calls, reloadModelCalls };
}

function fakeSettings(appendSystemPrompt: string): ValidatedSettings {
  return {
    agent: { appendSystemPrompt },
    mcpServers: {},
    disabledPlugins: [],
  } as unknown as ValidatedSettings;
}

describe("AgentServer configure({ reloadSettings })", () => {
  it("wires interactive approval prompts for chatManager sessions", async () => {
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => makeFakeEngine("A").engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });
    await chatManager.getOrCreate("sess-1", {} as never);

    const approval = getInteractiveApprovalBackend().requestApproval({
      sessionId: "sess-1",
      toolName: "MemoryDelete",
      args: { scope: "user", name: "stale" },
      description: "Delete a user memory",
      riskLevel: "medium",
    });

    await new Promise((r) => setTimeout(r, 10));
    const notification = t.sent.find((m: any) => m.method === "agent/approvalRequest");
    expect(notification?.params?.sessionId).toBe("sess-1");
    expect(notification?.params?.request?.toolName).toBe("MemoryDelete");

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/approve",
      params: {
        sessionId: "sess-1",
        requestId: notification.params.requestId,
        decision: { approved: true },
      },
    });

    await expect(approval).resolves.toEqual({ approved: true });
  });

  it("answers global model/provider queries before the first chat session exists", async () => {
    let factoryCalls = 0;
    const engine = {
      getModelPool() {
        return {
          getActiveKey: () => "sonnet",
          list: () => [
            {
              key: "sonnet",
              label: "Sonnet",
              model: "claude-sonnet-4-5",
              provider: "anthropic",
              providerKey: "anthropic",
            },
          ],
        };
      },
      readSetting(key: string) {
        if (key === "providers") return [{ key: "anthropic", label: "Anthropic" }];
        if (key === "models") return [{ key: "sonnet", providerKey: "anthropic" }];
        return undefined;
      },
    } as unknown as Engine;

    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        factoryCalls++;
        return engine;
      },
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({ jsonrpc: "2.0", id: 1, method: "agent/query", params: { type: "models" } });
    t.deliver({ jsonrpc: "2.0", id: 2, method: "agent/query", params: { type: "providers" } });
    await new Promise((r) => setTimeout(r, 10));

    const models = t.sent.find((m: any) => m.id === 1)?.result;
    expect(models?.type).toBe("models");
    expect(models?.data?.[0]?.key).toBe("sonnet");

    const providers = t.sent.find((m: any) => m.id === 2)?.result;
    expect(providers?.type).toBe("providers");
    expect(providers?.data?.[0]?.key).toBe("anthropic");
    expect(providers?.data?.[0]?.modelCount).toBe(1);

    expect(factoryCalls).toBe(1);
    expect(chatManager.sessionCount()).toBe(0);
  });

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

  it("reloadModels refreshes the shared runtime model pool", () => {
    const a = makeFakeEngine("A");
    const b = makeFakeEngine("B");
    const runtimeReloads: string[] = [];
    const chatManager = new ChatSessionManager({
      runtime: { reloadModelsFromSettings: () => runtimeReloads.push("runtime") } as never,
      engineFactory: () => {
        throw new Error("factory should not be called");
      },
    });
    (chatManager as any).sessions.set("A", { id: "A", engine: a.engine });
    (chatManager as any).sessions.set("B", { id: "B", engine: b.engine });

    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager, settingsReader: () => fakeSettings("x") });

    t.deliver({ jsonrpc: "2.0", id: 1, method: "agent/configure", params: { reloadModels: true } });

    expect(runtimeReloads).toEqual(["runtime"]);
    expect(a.reloadModelCalls).toEqual([]);
    expect(b.reloadModelCalls).toEqual([]);
    expect(t.sent.some((m: any) => m.id === 1 && m.result?.ok === true)).toBe(true);
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

  it("rejects reloadSettings when no settingsReader is wired", () => {
    const a = makeFakeEngine("A");
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        throw new Error("factory should not be called");
      },
    });
    (chatManager as any).sessions.set("A", { id: "A", engine: a.engine });

    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({ jsonrpc: "2.0", id: 1, method: "agent/configure", params: { reloadSettings: true } });

    const response = t.sent.find((m: any) => m.id === 1);
    expect(response?.error?.message).toContain("reloadSettings is not supported");
    expect(t.sent.some((m: any) => m.id === 1 && m.result?.ok === true)).toBe(false);
    expect(a.calls.length).toBe(0);
  });

  it("reloads onto the single legacyEngine when there is no chatManager", () => {
    const a = makeFakeEngine("A");
    let readCount = 0;
    const settingsReader = () => {
      readCount++;
      return fakeSettings(`append-${readCount}`);
    };

    const t = makeTransport();
    new AgentServer({ transport: t.transport, engine: a.engine, settingsReader });

    t.deliver({ jsonrpc: "2.0", id: 1, method: "agent/configure", params: { reloadSettings: true } });

    // Without chatManager the reload must still land on the one engine, not be
    // silently dropped behind an ok:true.
    expect(readCount).toBe(1);
    expect(a.calls.length).toBe(1);
    expect(a.calls[0].patch.appendSystemPrompt).toBe("append-1");
    expect(t.sent.some((m: any) => m.id === 1 && m.result?.ok === true)).toBe(true);
  });

  it("rejects session-scoped reloadSettings when no settingsReader is wired", () => {
    const a = makeFakeEngine("A");
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        throw new Error("factory should not be called");
      },
    });
    (chatManager as any).sessions.set("A", { id: "A", engine: a.engine });

    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/configure",
      params: { sessionId: "A", reloadSettings: true },
    });

    const response = t.sent.find((m: any) => m.id === 1);
    expect(response?.error?.message).toContain("reloadSettings is not supported");
    expect(t.sent.some((m: any) => m.id === 1 && m.result?.ok === true)).toBe(false);
    expect(a.calls.length).toBe(0);
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
