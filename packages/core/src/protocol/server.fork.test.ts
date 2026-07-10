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
  } as unknown as Engine;
  return { engine, calls };
}

describe("AgentServer agent/forkSession", () => {
  it("forks a cold persisted source and returns lineage/workspace", async () => {
    const fake = fakeEngine();
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => fake.engine,
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
    ]);
  });

  it("rejects a live busy source without forking", async () => {
    const fake = fakeEngine();
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => fake.engine,
    });
    const live = manager.getOrCreate("source", {} as never);
    live.isBusy = () => true;
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, chatManager: manager });

    transport.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: Methods.ForkSession,
      params: { sourceSessionId: "source", mode: "full" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.sent.at(-1)?.error?.code).toBe(ErrorCodes.Overloaded);
    expect(fake.calls).toHaveLength(0);
  });
});
