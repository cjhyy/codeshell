import { describe, expect, it } from "bun:test";

import type { Engine, EngineResult } from "../engine/engine.js";
import type { PermissionMode } from "../types.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function result(task: string): EngineResult {
  return {
    text: task,
    reason: "completed",
    sessionId: "queued-permission",
    turnCount: 1,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

function makeTransport() {
  const sent: any[] = [];
  let onMessage: (message: unknown) => void = () => {};
  return {
    sent,
    deliver(message: unknown) {
      onMessage(message);
    },
    transport: {
      send(message: unknown) {
        sent.push(message);
      },
      onMessage(callback: (message: unknown) => void) {
        onMessage = callback;
      },
      close() {},
    } as any,
  };
}

describe("queued run permission context", () => {
  it("does not let a queued bypass turn change the active turn's tool approval", async () => {
    const firstToolReady = deferred();
    const releaseFirstTool = deferred();
    const observed: Array<{ task: string; mode: PermissionMode; asked: boolean }> = [];
    let mode: PermissionMode = "default";

    const engine = {
      isHeadless: () => true,
      getPermissionMode: () => mode,
      setPermissionMode(next: PermissionMode) {
        mode = next;
      },
      async run(task: string, opts: { permissionMode?: PermissionMode }): Promise<EngineResult> {
        if (task === "first") {
          firstToolReady.resolve();
          await releaseFirstTool.promise;
        }
        // A real ToolExecutor reads a run snapshot. Before the fix no queued
        // context exists, so this falls back to the Engine's live mode and
        // reproduces the classifier reconfiguration leak.
        const effectiveMode = opts.permissionMode ?? mode;
        observed.push({
          task,
          mode: effectiveMode,
          asked: effectiveMode !== "bypassPermissions",
        });
        return result(task);
      },
    } as unknown as Engine;

    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const transport = makeTransport();
    new AgentServer({ chatManager: manager, transport: transport.transport });

    transport.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/run",
      params: { sessionId: "queued-permission", task: "first" },
    });
    await firstToolReady.promise;

    transport.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: "agent/run",
      params: {
        sessionId: "queued-permission",
        task: "second",
        permissionMode: "bypassPermissions",
      },
    });
    await Promise.resolve();
    expect(observed).toEqual([]);

    releaseFirstTool.resolve();
    while (!transport.sent.some((message) => message.id === 2)) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(observed).toEqual([
      { task: "first", mode: "default", asked: true },
      { task: "second", mode: "bypassPermissions", asked: false },
    ]);
  });
});
