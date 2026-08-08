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

describe("AgentServer archive_range query anchors passthrough", () => {
  it("forwards toClientMessageId/fromClientMessageId/segmentId as the third arg", async () => {
    const archiveCalls: Array<{ sessionId: string; range: unknown; anchors: unknown }> = [];
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          isHeadless: () => true,
          sessionExistsOnDisk: (sessionId: string) => sessionId === "s-archive",
          getSessionManager: () => ({ readSessionMainRoot: () => "/project/from/disk" }),
          archiveTurnRange: (sessionId: string, range: unknown, anchors: unknown) => {
            archiveCalls.push({ sessionId, range, anchors });
            return { before: 100, after: 10 };
          },
        }) as unknown as Engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/query",
      params: {
        type: "archive_range",
        sessionId: "s-archive",
        start: 2,
        end: 10,
        toClientMessageId: "m2",
        fromClientMessageId: "m1",
        segmentId: "seg-1",
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(archiveCalls).toEqual([
      {
        sessionId: "s-archive",
        range: { start: 2, end: 10 },
        anchors: { toClientMessageId: "m2", fromClientMessageId: "m1", segmentId: "seg-1" },
      },
    ]);
  });

  it("passes undefined anchors when the new params are absent (backward compat)", async () => {
    const archiveCalls: Array<{ sessionId: string; range: unknown; anchors: unknown }> = [];
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          isHeadless: () => true,
          sessionExistsOnDisk: (sessionId: string) => sessionId === "s-archive",
          getSessionManager: () => ({ readSessionMainRoot: () => "/project/from/disk" }),
          archiveTurnRange: (sessionId: string, range: unknown, anchors: unknown) => {
            archiveCalls.push({ sessionId, range, anchors });
            return { before: 100, after: 10 };
          },
        }) as unknown as Engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: "agent/query",
      params: { type: "archive_range", sessionId: "s-archive", start: 2, end: 10 },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(archiveCalls).toEqual([
      { sessionId: "s-archive", range: { start: 2, end: 10 }, anchors: undefined },
    ]);
  });

  it("drops a non-string fromClientMessageId while keeping the other string anchors", async () => {
    const archiveCalls: Array<{ sessionId: string; range: unknown; anchors: unknown }> = [];
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          isHeadless: () => true,
          sessionExistsOnDisk: (sessionId: string) => sessionId === "s-archive",
          getSessionManager: () => ({ readSessionMainRoot: () => "/project/from/disk" }),
          archiveTurnRange: (sessionId: string, range: unknown, anchors: unknown) => {
            archiveCalls.push({ sessionId, range, anchors });
            return { before: 100, after: 10 };
          },
        }) as unknown as Engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 3,
      method: "agent/query",
      params: {
        type: "archive_range",
        sessionId: "s-archive",
        start: 2,
        end: 10,
        toClientMessageId: "m2",
        fromClientMessageId: 123,
        segmentId: "seg-1",
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(archiveCalls).toEqual([
      {
        sessionId: "s-archive",
        range: { start: 2, end: 10 },
        anchors: { toClientMessageId: "m2", segmentId: "seg-1" },
      },
    ]);
    expect(
      Object.prototype.hasOwnProperty.call(
        (archiveCalls[0]!.anchors as object) ?? {},
        "fromClientMessageId",
      ),
    ).toBe(false);
  });
});

describe("AgentServer archive_marker query", () => {
  it("appends a marker and responds with {appended: true}, emitting no stream event", async () => {
    const markerCalls: Array<{ sessionId: string; marker: unknown }> = [];
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          isHeadless: () => true,
          sessionExistsOnDisk: (sessionId: string) => sessionId === "s-marker",
          getSessionManager: () => ({ readSessionMainRoot: () => "/project/from/disk" }),
          appendArchiveMarker: (sessionId: string, marker: unknown) => {
            markerCalls.push({ sessionId, marker });
            return true;
          },
        }) as unknown as Engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/query",
      params: {
        type: "archive_marker",
        sessionId: "s-marker",
        summary: "old turns summarized",
        toClientMessageId: "m9",
        fromClientMessageId: "m5",
        segmentId: "migration-v1",
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(markerCalls).toEqual([
      {
        sessionId: "s-marker",
        marker: {
          summary: "old turns summarized",
          toClientMessageId: "m9",
          fromClientMessageId: "m5",
          segmentId: "migration-v1",
        },
      },
    ]);
    expect(last(t.sent).result).toEqual({
      type: "archive_marker",
      data: { appended: true },
    });
    expect(streamEvents(t.sent)).toEqual([]);
  });

  it("rejects missing summary with InvalidParams and the exact message", async () => {
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          isHeadless: () => true,
          sessionExistsOnDisk: () => true,
          getSessionManager: () => ({ readSessionMainRoot: () => "/x" }),
          appendArchiveMarker: () => true,
        }) as unknown as Engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: "agent/query",
      params: {
        type: "archive_marker",
        sessionId: "s-x",
        toClientMessageId: "m1",
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(last(t.sent).error?.code).toBe(ErrorCodes.InvalidParams);
    expect(last(t.sent).error?.message).toBe(
      "archive_marker requires sessionId, summary and toClientMessageId",
    );
  });

  it("rejects missing sessionId with InvalidParams", async () => {
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          isHeadless: () => true,
          sessionExistsOnDisk: () => true,
          getSessionManager: () => ({ readSessionMainRoot: () => "/x" }),
          appendArchiveMarker: () => true,
        }) as unknown as Engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 3,
      method: "agent/query",
      params: {
        type: "archive_marker",
        summary: "s",
        toClientMessageId: "m1",
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(last(t.sent).error?.code).toBe(ErrorCodes.InvalidParams);
  });

  it("rejects missing toClientMessageId with InvalidParams", async () => {
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          isHeadless: () => true,
          sessionExistsOnDisk: () => true,
          getSessionManager: () => ({ readSessionMainRoot: () => "/x" }),
          appendArchiveMarker: () => true,
        }) as unknown as Engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 4,
      method: "agent/query",
      params: {
        type: "archive_marker",
        sessionId: "s-x",
        summary: "s",
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(last(t.sent).error?.code).toBe(ErrorCodes.InvalidParams);
  });

  it("responds with InternalError when the engine call throws", async () => {
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          isHeadless: () => true,
          sessionExistsOnDisk: (sessionId: string) => sessionId === "s-boom",
          getSessionManager: () => ({ readSessionMainRoot: () => "/project/from/disk" }),
          appendArchiveMarker: () => {
            throw new Error("boom");
          },
        }) as unknown as Engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 5,
      method: "agent/query",
      params: {
        type: "archive_marker",
        sessionId: "s-boom",
        summary: "s",
        toClientMessageId: "m1",
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(last(t.sent).error?.code).toBe(ErrorCodes.InternalError);
    expect(last(t.sent).error?.message).toBe("boom");
  });

  it("relays {appended: false} as a success response, not an error", async () => {
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          isHeadless: () => true,
          sessionExistsOnDisk: (sessionId: string) => sessionId === "s-marker",
          getSessionManager: () => ({ readSessionMainRoot: () => "/project/from/disk" }),
          appendArchiveMarker: () => false,
        }) as unknown as Engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });

    t.deliver({
      jsonrpc: "2.0",
      id: 7,
      method: "agent/query",
      params: {
        type: "archive_marker",
        sessionId: "s-marker",
        summary: "s",
        toClientMessageId: "m1",
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(last(t.sent).error).toBeUndefined();
    expect(last(t.sent).result).toEqual({
      type: "archive_marker",
      data: { appended: false },
    });
  });

  it("returns SessionNotFound for an unknown session id", async () => {
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
      id: 6,
      method: "agent/query",
      params: {
        type: "archive_marker",
        sessionId: "missing",
        summary: "s",
        toClientMessageId: "m1",
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(last(t.sent).error?.code).toBe(ErrorCodes.SessionNotFound);
  });
});
