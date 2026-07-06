import { describe, expect, it } from "bun:test";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";
import { ErrorCodes } from "./types.js";
import type { Engine } from "../engine/engine.js";

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

function last(sent: any[]): any {
  return sent[sent.length - 1];
}

describe("AgentServer compact query", () => {
  it("materializes a persisted non-live chatManager session before compacting", () => {
    const slices: any[] = [];
    const forceCompactCalls: Array<string | undefined> = [];
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: (slice) => {
        slices.push(slice);
        return {
          isHeadless: () => true,
          sessionExistsOnDisk: (sessionId: string) => sessionId === "s-compact",
          getSessionManager: () => ({
            readCwd: (sessionId: string) =>
              sessionId === "s-compact" ? "/project/from/disk" : undefined,
          }),
          forceCompact: (sessionId?: string) => {
            forceCompactCalls.push(sessionId);
            return { before: 100, after: 40, strategy: "compacted" };
          },
        } as unknown as Engine;
      },
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/query",
      params: { type: "compact", sessionId: "s-compact" },
    });

    expect(last(t.sent).result).toEqual({
      type: "compact",
      data: { before: 100, after: 40, strategy: "compacted" },
    });
    expect(forceCompactCalls).toEqual(["s-compact"]);
    expect(slices.at(-1)?.cwd).toBe("/project/from/disk");
    expect(chatManager.get("s-compact")).toBeDefined();
  });

  it("returns SessionNotFound instead of creating a blank session for an unknown id", () => {
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          isHeadless: () => true,
          sessionExistsOnDisk: () => false,
          getSessionManager: () => ({ readCwd: () => undefined }),
        }) as unknown as Engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: "agent/query",
      params: { type: "compact", sessionId: "missing-session" },
    });

    expect(last(t.sent).error?.code).toBe(ErrorCodes.SessionNotFound);
    expect(chatManager.get("missing-session")).toBeUndefined();
  });
});
