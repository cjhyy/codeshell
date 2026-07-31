import { describe, expect, it } from "bun:test";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { ErrorCodes } from "./types.js";
import type { Engine, EngineResult } from "../engine/engine.js";

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
