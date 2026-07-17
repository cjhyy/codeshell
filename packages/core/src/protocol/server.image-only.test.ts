import { describe, expect, test } from "bun:test";
import type { Engine, EngineResult } from "../engine/engine.js";
import type { EngineRunOptions } from "../engine/run-types.js";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { ErrorCodes, Methods, type InputAttachmentMeta } from "./types.js";

function makeTransport() {
  const sent: any[] = [];
  let onMessage: (message: unknown) => void = () => undefined;
  return {
    sent,
    deliver: (message: unknown) => onMessage(message),
    transport: {
      send: (message: unknown) => sent.push(message),
      onMessage: (handler: (message: unknown) => void) => {
        onMessage = handler;
      },
      close: () => undefined,
    } as any,
  };
}

const attachment: InputAttachmentMeta = {
  id: "attachment-1",
  sessionId: "session-1",
  kind: "image",
  origin: "mobile",
  path: ".code-shell/attachments/session-1/image.png",
  relPath: ".code-shell/attachments/session-1/image.png",
  absPath: "/repo/.code-shell/attachments/session-1/image.png",
  mime: "image/png",
  size: 68,
  sha256: "a".repeat(64),
  createdAt: 1,
};

function makeEngine() {
  const calls: Array<{ task: string; options?: EngineRunOptions }> = [];
  const engine = {
    isHeadless: () => false,
    setAskUser() {},
    setBrowserBridge() {},
    setInjectCredential() {},
    setPlanMode() {},
    async run(task: string, options?: EngineRunOptions): Promise<EngineResult> {
      calls.push({ task, options });
      return {
        text: "saw image",
        reason: "completed",
        sessionId: options?.sessionId ?? "session-1",
        turnCount: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        extensions: { testProfile: { structured: true } },
      };
    },
  } as unknown as Engine;
  return { engine, calls };
}

function accepted(sent: any[], requestId: number): any {
  return sent.find(
    (message) => message.method === Methods.RunAccepted && message.params?.requestId === requestId,
  );
}

describe("AgentServer image-only agent/run", () => {
  test("multi-session accepts an empty task when a valid attachment is present", async () => {
    const { engine, calls } = makeEngine();
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, chatManager });

    transport.deliver({
      jsonrpc: "2.0",
      id: 101,
      method: Methods.Run,
      params: { sessionId: "session-1", task: "", attachments: [attachment] },
    });
    await Bun.sleep(10);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      task: "",
      options: { sessionId: "session-1", attachments: [attachment] },
    });
    expect(accepted(transport.sent, 101)?.params?.sessionId).toBe("session-1");
    expect(transport.sent.find((message) => message.id === 101)?.result?.text).toBe("saw image");
    expect(transport.sent.find((message) => message.id === 101)?.result?.extensions).toEqual({
      testProfile: { structured: true },
    });
  });

  test("legacy accepts image-only and forwards attachments to Engine.run", async () => {
    const { engine, calls } = makeEngine();
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, engine });

    transport.deliver({
      jsonrpc: "2.0",
      id: 102,
      method: Methods.Run,
      params: { sessionId: "session-1", task: "   ", attachments: [attachment] },
    });
    await Bun.sleep(10);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      task: "   ",
      options: { sessionId: "session-1", attachments: [attachment] },
    });
    expect(accepted(transport.sent, 102)).toBeDefined();
    expect(transport.sent.find((message) => message.id === 102)?.result?.extensions).toEqual({
      testProfile: { structured: true },
    });
  });

  test("still rejects missing, non-string, or whitespace-only input without valid attachments", async () => {
    const { engine, calls } = makeEngine();
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, chatManager });

    for (const [id, params] of [
      [201, { sessionId: "session-1" }],
      [202, { sessionId: "session-1", task: 123, attachments: [attachment] }],
      [203, { sessionId: "session-1", task: "  ", attachments: [null] }],
    ] as const) {
      transport.deliver({ jsonrpc: "2.0", id, method: Methods.Run, params });
    }
    await Bun.sleep(10);

    expect(calls).toHaveLength(0);
    for (const id of [201, 202, 203]) {
      expect(transport.sent.find((message) => message.id === id)?.error?.code).toBe(
        ErrorCodes.InvalidParams,
      );
    }
  });
});
