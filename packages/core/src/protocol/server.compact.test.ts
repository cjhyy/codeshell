import { describe, expect, it } from "bun:test";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";
import { ErrorCodes, Methods } from "./types.js";
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

function streamEvents(sent: any[]): any[] {
  return sent.filter((m) => m?.method === Methods.StreamEvent);
}

describe("AgentServer compact query", () => {
  it("materializes a persisted non-live chatManager session before compacting", async () => {
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

    // handleQuery awaits forceCompact (now async), so the response is sent on a
    // later microtask — flush before asserting.
    await new Promise((r) => setTimeout(r, 0));

    expect(last(t.sent).result).toEqual({
      type: "compact",
      data: { before: 100, after: 40, strategy: "compacted" },
    });
    expect(streamEvents(t.sent)).toEqual([
      {
        jsonrpc: "2.0",
        method: Methods.StreamEvent,
        params: {
          sessionId: "s-compact",
          event: {
            type: "context_compact",
            strategy: "compacted",
            before: 100,
            after: 40,
          },
        },
      },
    ]);
    expect(forceCompactCalls).toEqual(["s-compact"]);
    expect(slices.at(-1)?.cwd).toBe("/project/from/disk");
    expect(chatManager.get("s-compact")).toBeDefined();
  });

  it("does not emit a context boundary stream event when compact is a no-op", async () => {
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          isHeadless: () => true,
          sessionExistsOnDisk: (sessionId: string) => sessionId === "s-noop",
          getSessionManager: () => ({ readCwd: () => "/project/from/disk" }),
          forceCompact: () => ({ before: 40, after: 40, strategy: "no compaction needed" }),
        }) as unknown as Engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 3,
      method: "agent/query",
      params: { type: "compact", sessionId: "s-noop" },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(last(t.sent).result).toEqual({
      type: "compact",
      data: { before: 40, after: 40, strategy: "no compaction needed" },
    });
    expect(streamEvents(t.sent)).toEqual([]);
  });

  it("emits a context boundary stream event for concrete shrink strategies", async () => {
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          isHeadless: () => true,
          sessionExistsOnDisk: (sessionId: string) => sessionId === "s-summary",
          getSessionManager: () => ({ readCwd: () => "/project/from/disk" }),
          forceCompact: () => ({ before: 128_000, after: 46_000, strategy: "summary" }),
        }) as unknown as Engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 4,
      method: "agent/query",
      params: { type: "compact", sessionId: "s-summary" },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(last(t.sent).result).toEqual({
      type: "compact",
      data: { before: 128_000, after: 46_000, strategy: "summary" },
    });
    expect(streamEvents(t.sent)).toEqual([
      {
        jsonrpc: "2.0",
        method: Methods.StreamEvent,
        params: {
          sessionId: "s-summary",
          event: {
            type: "context_compact",
            strategy: "summary",
            before: 128_000,
            after: 46_000,
          },
        },
      },
    ]);
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
