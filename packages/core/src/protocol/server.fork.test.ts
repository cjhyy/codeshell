import { describe, expect, it } from "bun:test";
import type { Engine } from "../engine/engine.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";
import { ErrorCodes, Methods } from "./types.js";

function makeTransport() {
  const sent: any[] = [];
  let onMsg: (msg: unknown) => void = () => {};
  return {
    sent,
    deliver: (msg: unknown) => onMsg(msg),
    transport: {
      send: (message: unknown) => sent.push(message),
      onMessage: (callback: (msg: unknown) => void) => {
        onMsg = callback;
      },
      close: () => {},
    } as any,
  };
}

function fakeEngine() {
  const calls: unknown[] = [];
  const engine = {
    isHeadless: () => true,
    getConfig: () => ({ cwd: "/project/from-source-state" }),
    getSessionManager: () => ({
      readCwd: (id: string) => (id === "source" ? "/project/from-source-state" : undefined),
      registerSessionGeneration: () => 1,
      incrementSessionGeneration: () => 2,
    }),
    restoreSessionModel: (sourceSessionId: string) => {
      calls.push({ sourceSessionId, operation: "restore-model" });
    },
    sessionExistsOnDisk: (id: string) => id === "source" || id === "existing",
    forkSession: (sourceSessionId: string, options: unknown) => {
      calls.push({ sourceSessionId, options });
      return {
        bundle: {
          state: {
            sessionId: "target",
            cwd: "/project",
            workspace: { root: "/project/worktree", kind: "worktree" },
          },
        },
        lineage: {
          sessionId: "source",
          mode: "full",
          fromEventId: "a",
          throughEventId: "z",
          sourceEventCount: 4,
          createdAt: 1,
        },
        copiedEventCount: 4,
      };
    },
    selectContextPackage: (sourceSessionId: string, range: unknown) => {
      calls.push({ sourceSessionId, range, operation: "select" });
      return {
        messages: [{ role: "user", content: "selected" }],
        sourceEventCount: 2,
      };
    },
    summarizeContextPackage: async (messages: unknown) => {
      calls.push({ messages, operation: "summarize" });
      return { summary: "packaged summary", estimatedTokens: 42 };
    },
    createSummaryFork: (sourceSessionId: string, options: unknown) => {
      calls.push({ sourceSessionId, options, operation: "publish" });
      return {
        bundle: {
          state: {
            sessionId: "summary-target",
            cwd: "/project",
            workspace: { root: "/project/worktree", kind: "worktree" },
          },
        },
        lineage: {
          sessionId: "source",
          mode: "summary",
          fromEventId: "b",
          throughEventId: "c",
          sourceEventCount: 2,
          createdAt: 2,
        },
      };
    },
  } as unknown as Engine;
  return { engine, calls };
}

describe("AgentServer agent/forkSession", () => {
  it("forks a cold persisted source and returns lineage/workspace", async () => {
    const fake = fakeEngine();
    const slices: unknown[] = [];
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: (slice) => {
        slices.push(slice);
        return fake.engine;
      },
    });
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, chatManager: manager });

    transport.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: Methods.ForkSession,
      params: {
        sourceSessionId: "source",
        targetSessionId: "target",
        mode: "full",
        throughEventId: "z",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.sent.at(-1)?.result).toEqual({
      sessionId: "target",
      mode: "full",
      forkedFrom: {
        sessionId: "source",
        mode: "full",
        fromEventId: "a",
        throughEventId: "z",
        sourceEventCount: 4,
        createdAt: 1,
      },
      workspace: { root: "/project/worktree", kind: "worktree" },
      copiedEventCount: 4,
    });
    expect(fake.calls).toEqual([
      {
        sourceSessionId: "source",
        options: { targetSessionId: "target", throughEventId: "z" },
      },
    ]);
    expect(slices).toEqual([{}, { cwd: "/project/from-source-state", projectTrusted: false }]);
    expect(manager.get("source")?.engine).toBe(fake.engine);
    expect(transport.sent.some((message) => message.method === Methods.StreamEvent)).toBe(false);
  });

  it("rejects missing sources, target conflicts and unsupported modes", async () => {
    const fake = fakeEngine();
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => fake.engine,
    });
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, chatManager: manager });

    for (const [id, params] of [
      [1, { sourceSessionId: "missing", mode: "full" }],
      [2, { sourceSessionId: "source", targetSessionId: "existing", mode: "full" }],
      [3, { sourceSessionId: "source", mode: "summary" }],
      [4, { sourceSessionId: "source", mode: "full", forkKind: "other" }],
      [
        5,
        {
          sourceSessionId: "source",
          mode: "full",
          forkKind: "side",
          throughEventId: "z",
        },
      ],
    ] as const) {
      transport.deliver({ jsonrpc: "2.0", id, method: Methods.ForkSession, params });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(
      transport.sent.filter((message) => message.error).map((message) => message.error.code),
    ).toEqual([
      ErrorCodes.SessionNotFound,
      ErrorCodes.InvalidParams,
      ErrorCodes.InvalidParams,
      ErrorCodes.InvalidParams,
      ErrorCodes.InvalidParams,
    ]);
  });

  it("summarizes a validated event range before publishing the target", async () => {
    const fake = fakeEngine();
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => fake.engine,
    });
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, chatManager: manager });

    transport.deliver({
      jsonrpc: "2.0",
      id: 9,
      method: Methods.ForkSession,
      params: {
        sourceSessionId: "source",
        targetSessionId: "summary-target",
        mode: "summary",
        fromEventId: "b",
        toEventId: "c",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.sent.at(-1)?.result).toEqual({
      sessionId: "summary-target",
      mode: "summary",
      summary: "packaged summary",
      sourceRange: { fromEventId: "b", toEventId: "c" },
      estimatedTokens: 42,
      forkedFrom: expect.objectContaining({ mode: "summary" }),
      workspace: { root: "/project/worktree", kind: "worktree" },
    });
    expect(fake.calls.map((call: any) => call.operation).filter(Boolean)).toEqual([
      "restore-model",
      "select",
      "summarize",
      "publish",
    ]);
  });

  it("does not publish a target when context summarization fails", async () => {
    const fake = fakeEngine();
    (fake.engine as any).summarizeContextPackage = async () => {
      throw new Error("summary service unavailable");
    };
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => fake.engine,
    });
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, chatManager: manager });

    transport.deliver({
      jsonrpc: "2.0",
      id: 10,
      method: Methods.ForkSession,
      params: {
        sourceSessionId: "source",
        targetSessionId: "summary-target",
        mode: "summary",
        fromEventId: "b",
        toEventId: "c",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.sent.at(-1)?.error).toMatchObject({ code: ErrorCodes.InternalError });
    expect(fake.calls.some((call: any) => call.operation === "publish")).toBe(false);
  });

  it("rejects full-only quickChatClaimId on a summary fork", async () => {
    const fake = fakeEngine();
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => fake.engine,
    });
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, chatManager: manager });

    transport.deliver({
      jsonrpc: "2.0",
      id: 11,
      method: Methods.ForkSession,
      params: {
        sourceSessionId: "source",
        targetSessionId: "summary-target",
        mode: "summary",
        fromEventId: "b",
        toEventId: "c",
        quickChatClaimId: "qchat-generation",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.sent.at(-1)?.error).toMatchObject({ code: ErrorCodes.InvalidParams });
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects an empty targetSessionId before any Engine operation", async () => {
    const fake = fakeEngine();
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => fake.engine,
    });
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, chatManager: manager });

    transport.deliver({
      jsonrpc: "2.0",
      id: 12,
      method: Methods.ForkSession,
      params: {
        sourceSessionId: "source",
        targetSessionId: "",
        mode: "summary",
        fromEventId: "b",
        toEventId: "c",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.sent.at(-1)?.error).toMatchObject({ code: ErrorCodes.InvalidParams });
    expect(fake.calls).toHaveLength(0);
  });

  it("queues a run arriving during summary packaging until usage/publication finishes", async () => {
    const fake = fakeEngine();
    let releaseSummary!: () => void;
    let markSummaryStarted!: () => void;
    const summaryStarted = new Promise<void>((resolve) => {
      markSummaryStarted = resolve;
    });
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const order: string[] = [];
    (fake.engine as any).summarizeContextPackage = async () => {
      order.push("summary-start");
      markSummaryStarted();
      await summaryGate;
      order.push("summary-end");
      return { summary: "packaged summary", estimatedTokens: 42 };
    };
    (fake.engine as any).createSummaryFork = (...args: unknown[]) => {
      order.push("publish");
      return (fakeEngine().engine as any).createSummaryFork(...args);
    };
    (fake.engine as any).run = async () => {
      order.push("run");
      return {
        text: "ok",
        reason: "completed",
        sessionId: "source",
        turnCount: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    };
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => fake.engine,
    });
    await manager.getOrCreate("source", {} as never);
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, chatManager: manager });

    transport.deliver({
      jsonrpc: "2.0",
      id: 12,
      method: Methods.ForkSession,
      params: {
        sourceSessionId: "source",
        targetSessionId: "summary-target",
        mode: "summary",
        fromEventId: "b",
        toEventId: "c",
      },
    });
    await summaryStarted;
    transport.deliver({
      jsonrpc: "2.0",
      id: 13,
      method: Methods.Run,
      params: { sessionId: "source", task: "new work" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(order).toEqual(["summary-start"]);
    expect(manager.get("source")?.queueDepth()).toBe(1);

    releaseSummary();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["summary-start", "summary-end", "publish", "run"]);
  });

  for (const sourceState of ["busy", "queued"] as const) {
    it(`rejects a live ${sourceState} source without forking`, async () => {
      const fake = fakeEngine();
      const manager = new ChatSessionManager({
        runtime: {} as never,
        engineFactory: () => fake.engine,
      });
      const live = await manager.getOrCreate("source", {} as never);
      live.isBusy = () => sourceState === "busy";
      live.queueDepth = () => (sourceState === "queued" ? 1 : 0);
      const transport = makeTransport();
      new AgentServer({ transport: transport.transport, chatManager: manager });

      transport.deliver({
        jsonrpc: "2.0",
        id: 1,
        method: Methods.ForkSession,
        params: { sourceSessionId: "source", mode: "full" },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(transport.sent.at(-1)?.error).toEqual({
        code: ErrorCodes.Overloaded,
        message: "source session is still producing or has queued turns",
      });
      expect(fake.calls).toHaveLength(0);
    });
  }

  it("forks a busy source as a completed side snapshot without weakening normal fork guard", async () => {
    const fake = fakeEngine();
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => fake.engine,
    });
    const live = await manager.getOrCreate("source", {} as never);
    live.isBusy = () => true;
    live.queueDepth = () => 0;
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, chatManager: manager });

    transport.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: Methods.ForkSession,
      params: {
        sourceSessionId: "source",
        targetSessionId: "target",
        mode: "full",
        forkKind: "side",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.sent.at(-1)?.error).toBeUndefined();
    expect(fake.calls).toEqual([
      {
        sourceSessionId: "source",
        options: { targetSessionId: "target", snapshotMode: "completed" },
      },
    ]);
  });
});
