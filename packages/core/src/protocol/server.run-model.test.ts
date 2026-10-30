import { describe, expect, it } from "bun:test";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import type { EngineConfigSlice } from "./chat-session-manager.js";
import { ErrorCodes } from "./types.js";
import type { Engine, EngineResult } from "../engine/engine.js";
import { Engine as ActualEngine } from "../engine/engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function makeEngine(opts: { failSwitch?: boolean } = {}) {
  const calls: string[] = [];
  const engine = {
    isHeadless: () => true,
    switchModel(key: string) {
      calls.push(`switch:${key}`);
      if (opts.failSwitch) throw new Error(`Model not found: ${key}`);
      return { key, model: key } as never;
    },
    resetSessionUsage(sessionId: string) {
      calls.push(`reset:${sessionId}`);
    },
    async run(): Promise<EngineResult> {
      calls.push("run");
      return {
        text: "ok",
        reason: "completed",
        sessionId: "sess-1",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
  return { engine, calls };
}

describe("agent/run model", () => {
  it("persists the actual per-run model on first use and after a later native switch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "native-model-metadata-"));
    const provider = "owned-native-model-metadata";
    const calls: string[] = [];
    class OwnedClient extends LLMClientBase {
      protected initClient() {}
      async createMessage(options: CreateMessageOptions) {
        if (options.requestVisible !== false) calls.push(this.model);
        const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
        this.recordUsage(usage, options);
        return { text: "owned response", toolCalls: [], stopReason: "stop" as const, usage };
      }
    }
    registerProvider(provider, OwnedClient);
    const engine = new ActualEngine({
      llm: { provider, model: "initial" },
      cwd: dir,
      sessionStorageDir: join(dir, "sessions"),
      settingsScope: "isolated",
      headless: true,
      enabledBuiltinTools: [],
      maxTurns: 2,
    });
    (engine as any).hooks.clear();
    for (const model of ["custom-alpha", "custom-beta"])
      engine.getModelPool().register({ key: model, provider, model });
    const manager = new ChatSessionManager({ runtime: {} as never, engineFactory: () => engine });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager: manager });
    try {
      for (const [index, model] of ["custom-alpha", "custom-beta"].entries()) {
        const id = 700 + index;
        t.deliver({
          jsonrpc: "2.0",
          id,
          method: "agent/run",
          params: {
            sessionId: "native-metadata",
            cwd: dir,
            task: "owned input",
            clientMessageId: `input-${index}`,
            model,
            permissionMode: "default",
          },
        });
        const deadline = Date.now() + 5000;
        while (!t.sent.some((item) => item.id === id) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(t.sent.find((item) => item.id === id)?.result?.reason).toBe("completed");
        expect(calls.at(-1)).toBe(model);
        const state = JSON.parse(
          readFileSync(join(dir, "sessions", "native-metadata", "state.json"), "utf8"),
        );
        expect(state).toMatchObject({ sessionId: "native-metadata", model, provider });
      }
      expect(calls).toEqual(["custom-alpha", "custom-beta"]);
      for (const [id, model, clientMessageId] of [
        [702, "missing", "rejected"],
        [703, "custom-alpha", "input-0"],
      ] as const) {
        t.deliver({
          jsonrpc: "2.0",
          id,
          method: "agent/run",
          params: {
            sessionId: "native-metadata",
            cwd: dir,
            task: "owned input",
            clientMessageId,
            model,
          },
        });
        const deadline = Date.now() + 5000;
        while (!t.sent.some((item) => item.id === id) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(t.sent.find((item) => item.id === id)).toBeDefined();
        if (model === "missing") expect(t.sent.find((item) => item.id === id)?.error).toBeDefined();
        else expect(t.sent.find((item) => item.id === id)?.result?.reason).toBe("completed");
        const state = JSON.parse(
          readFileSync(join(dir, "sessions", "native-metadata", "state.json"), "utf8"),
        );
        expect(state.model).toBe("custom-beta");
        expect(state.provider).toBe(provider);
        expect(calls).toEqual(["custom-alpha", "custom-beta"]);
      }
    } finally {
      await manager.closeAllAsync();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("uses the general preset for a fresh isolated Task instead of inheriting coding", async () => {
    const { engine } = makeEngine();
    let createdWith: EngineConfigSlice | undefined;
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: (slice) => {
        createdWith = slice;
        return engine;
      },
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 0,
      method: "agent/run",
      params: {
        sessionId: "panel-task-1",
        task: "initialize",
        behaviorMode: "isolatedTask",
        ephemeral: true,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(createdWith?.preset).toBe("general");
    expect(t.sent.find((message) => message.id === 0)?.result?.text).toBe("ok");
  });

  it("applies the requested model before the first turn starts", async () => {
    const { engine, calls } = makeEngine();
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
      params: { sessionId: "sess-1", task: "hello", model: "openrouter" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toEqual(["switch:openrouter", "reset:sess-1", "run"]);
    expect(t.sent.find((m) => m.id === 1)?.result?.text).toBe("ok");
  });

  it("rejects an unknown model without starting the turn", async () => {
    const { engine, calls } = makeEngine({ failSwitch: true });
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
      params: { sessionId: "sess-1", task: "hello", model: "missing" },
    });
    await new Promise((r) => setTimeout(r, 10));

    const err = t.sent.find((m) => m.id === 2)?.error;
    expect(err?.code).toBe(ErrorCodes.InvalidParams);
    expect(err?.message).toBe("Model not found: missing");
    expect(calls).toEqual(["switch:missing"]);
  });

  it("forwards host-injected completion turns without rendering a user bubble", async () => {
    let injected: boolean | undefined;
    const engine = {
      isHeadless: () => true,
      async run(_task: string, options: { injected?: boolean }): Promise<EngineResult> {
        injected = options.injected;
        return {
          text: "completion delivered",
          reason: "completed",
          sessionId: "pet-one",
          turnCount: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
    } as unknown as Engine;
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
      params: {
        sessionId: "pet-one",
        task: "<system-reminder>report completion</system-reminder>",
        injected: true,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(injected).toBe(true);
    expect(t.sent.find((message) => message.id === 3)?.result?.text).toBe("completion delivered");
  });

  it("shows displayText in the session while keeping the full task for the model", async () => {
    let receivedTask: string | undefined;
    let receivedDisplayText: string | undefined;
    const engine = {
      isHeadless: () => true,
      async run(task: string, options: { displayText?: string }): Promise<EngineResult> {
        receivedTask = task;
        receivedDisplayText = options.displayText;
        return {
          text: "design updated",
          reason: "completed",
          sessionId: "panel-session",
          turnCount: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
    } as unknown as Engine;
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 4,
      method: "agent/run",
      params: {
        sessionId: "panel-session",
        task: 'INTERNAL PANEL CONTEXT\n{"selection":["hero-title"]}',
        displayText: "【Design Studio】 把标题改得更醒目",
        clientMessageId: "panel:design-studio:1",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(receivedTask).toBe('INTERNAL PANEL CONTEXT\n{"selection":["hero-title"]}');
    expect(receivedDisplayText).toBe("【Design Studio】 把标题改得更醒目");
    expect(
      t.sent.find(
        (message) =>
          message.method === "agent/streamEvent" &&
          message.params?.event?.type === "session_user_message",
      )?.params,
    ).toEqual({
      sessionId: "panel-session",
      event: {
        type: "session_user_message",
        text: "【Design Studio】 把标题改得更醒目",
        clientMessageId: "panel:design-studio:1",
      },
    });
    expect(t.sent.find((message) => message.id === 4)?.result?.text).toBe("design updated");
  });

  it("rejects an empty displayText before starting a turn", async () => {
    const { engine, calls } = makeEngine();
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 5,
      method: "agent/run",
      params: {
        sessionId: "panel-session",
        task: "valid internal prompt",
        displayText: "   ",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(t.sent.find((message) => message.id === 5)?.error).toMatchObject({
      code: ErrorCodes.InvalidParams,
      message: "displayText must be a non-empty string up to 20000 characters",
    });
    expect(calls).toEqual([]);
  });
});
