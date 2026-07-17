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

describe("AgentServer archive_range query", () => {
  it("archives a range and emits a context_compact boundary with strategy range", async () => {
    const archiveCalls: Array<{ sessionId: string; range: { start: number; end: number } }> = [];
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          isHeadless: () => true,
          sessionExistsOnDisk: (sessionId: string) => sessionId === "s-archive",
          getSessionManager: () => ({ readSessionMainRoot: () => "/project/from/disk" }),
          archiveTurnRange: (sessionId: string, range: { start: number; end: number }) => {
            archiveCalls.push({ sessionId, range });
            return { before: 128_000, after: 40_000 };
          },
        }) as unknown as Engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/query",
      params: { type: "archive_range", sessionId: "s-archive", start: 2, end: 10 },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(archiveCalls).toEqual([{ sessionId: "s-archive", range: { start: 2, end: 10 } }]);
    expect(last(t.sent).result).toEqual({
      type: "archive_range",
      data: { before: 128_000, after: 40_000 },
    });
    // The "range" strategy must survive to the wire, not degrade to "compacted".
    expect(streamEvents(t.sent)).toEqual([
      {
        jsonrpc: "2.0",
        method: Methods.StreamEvent,
        params: {
          sessionId: "s-archive",
          event: {
            type: "context_compact",
            strategy: "range",
            before: 128_000,
            after: 40_000,
          },
        },
      },
    ]);
  });

  it("does not emit a boundary when the archive is a no-op", async () => {
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          isHeadless: () => true,
          sessionExistsOnDisk: (sessionId: string) => sessionId === "s-noop",
          getSessionManager: () => ({ readSessionMainRoot: () => "/project/from/disk" }),
          archiveTurnRange: () => ({ before: 40, after: 40 }),
        }) as unknown as Engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: "agent/query",
      params: { type: "archive_range", sessionId: "s-noop", start: 0, end: 3 },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(last(t.sent).result).toEqual({
      type: "archive_range",
      data: { before: 40, after: 40 },
    });
    expect(streamEvents(t.sent)).toEqual([]);
  });

  it("rejects missing or non-numeric start/end", async () => {
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          isHeadless: () => true,
          sessionExistsOnDisk: () => true,
          getSessionManager: () => ({ readSessionMainRoot: () => "/x" }),
          archiveTurnRange: () => ({ before: 1, after: 1 }),
        }) as unknown as Engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 3,
      method: "agent/query",
      params: { type: "archive_range", sessionId: "s-x", start: "oops" },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(last(t.sent).error?.code).toBe(ErrorCodes.InvalidParams);
    expect(streamEvents(t.sent)).toEqual([]);
  });

  it("returns SessionNotFound for an unknown id", async () => {
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          isHeadless: () => true,
          sessionExistsOnDisk: () => false,
          getSessionManager: () => ({ readSessionMainRoot: () => undefined }),
        }) as unknown as Engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 4,
      method: "agent/query",
      params: { type: "archive_range", sessionId: "missing", start: 0, end: 2 },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(last(t.sent).error?.code).toBe(ErrorCodes.SessionNotFound);
  });
});
