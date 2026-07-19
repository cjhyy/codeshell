import { describe, expect, test } from "bun:test";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { Methods } from "./types.js";
import type { Engine, EngineResult } from "../engine/engine.js";
import type { WorkspaceBridge } from "../tool-system/workspace-bridge.js";

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

async function waitFor<T>(read: () => T | undefined, message: string): Promise<T> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function makeWorkspaceBridgeEngine() {
  const state = {
    workspaceBridge: undefined as WorkspaceBridge | undefined,
    switchedRoot: "",
  };
  const engine = {
    setAskUser() {},
    setPlanMode() {},
    setBrowserBridge() {},
    setInjectCredential() {},
    setSessionMessageRouter() {},
    setWorkspaceBridge(bridge: WorkspaceBridge | undefined) {
      state.workspaceBridge = bridge;
    },
    isHeadless: () => false,
    async run(_task: string, opts: { sessionId: string }): Promise<EngineResult> {
      const workspace = await state.workspaceBridge!.switch("feature");
      state.switchedRoot = workspace.root;
      return {
        text: `switched:${workspace.root}`,
        reason: "completed",
        sessionId: opts.sessionId,
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
  return { engine, state };
}

describe("AgentServer workspace bridge", () => {
  test("emits __workspace_action__ and resolves the bridge from agent/approve", async () => {
    const { engine, state } = makeWorkspaceBridgeEngine();
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager, workspaceBridge: true });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: Methods.Run,
      params: { sessionId: "sess-workspace", task: "switch" },
    });

    const request = await waitFor(
      () =>
        t.sent.find(
          (m) =>
            m.method === Methods.ApprovalRequest &&
            m.params?.request?.toolName === "__workspace_action__",
        ),
      "workspace bridge request should be emitted",
    );
    expect(request.params.sessionId).toBe("sess-workspace");
    expect(request.params.request.args).toEqual({ action: "switch", target: "feature" });

    t.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: Methods.Approve,
      params: {
        sessionId: "sess-workspace",
        requestId: request.params.requestId,
        decision: {
          approved: true,
          answer: JSON.stringify({ root: "/repo/.worktrees/feature", kind: "worktree" }),
        },
      },
    });

    const response = await waitFor(
      () => t.sent.find((m) => m.id === 1 && m.result),
      "run response should resolve after workspace approval",
    );
    expect(state.switchedRoot).toBe("/repo/.worktrees/feature");
    expect(response.result.text).toBe("switched:/repo/.worktrees/feature");
  });

  test("agent/releaseWorkspace resets a live session engine", async () => {
    const released: string[] = [];
    const engine = {
      setAskUser() {},
      setPlanMode() {},
      setBrowserBridge() {},
      setInjectCredential() {},
      setSessionMessageRouter() {},
      isHeadless: () => false,
      releaseSessionWorkspace(sessionId: string) {
        released.push(sessionId);
        return { root: "/repo", kind: "main" };
      },
      async run(_task: string, opts: { sessionId: string }): Promise<EngineResult> {
        return {
          text: "ok",
          reason: "completed",
          sessionId: opts.sessionId,
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
      id: 1,
      method: Methods.Run,
      params: { sessionId: "sess-release", task: "start" },
    });
    await waitFor(() => t.sent.find((m) => m.id === 1 && m.result), "session should be live");

    t.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: Methods.ReleaseWorkspace,
      params: { sessionId: "sess-release" },
    });

    const response = await waitFor(
      () => t.sent.find((m) => m.id === 2 && m.result),
      "releaseWorkspace response should resolve",
    );
    expect(released).toEqual(["sess-release"]);
    expect(response.result).toEqual({ ok: true, workspace: { root: "/repo", kind: "main" } });
  });

  test("agent/setWorkspace rebases a live session engine", async () => {
    const updates: Array<{ sessionId: string; workspace: unknown }> = [];
    const engine = {
      setAskUser() {},
      setPlanMode() {},
      setBrowserBridge() {},
      setInjectCredential() {},
      setSessionMessageRouter() {},
      isHeadless: () => false,
      setSessionWorkspace(sessionId: string, workspace: unknown) {
        updates.push({ sessionId, workspace });
        return workspace;
      },
      async run(_task: string, opts: { sessionId: string }): Promise<EngineResult> {
        return {
          text: "ok",
          reason: "completed",
          sessionId: opts.sessionId,
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
      id: 1,
      method: Methods.Run,
      params: { sessionId: "sess-set-workspace", task: "start" },
    });
    await waitFor(() => t.sent.find((m) => m.id === 1 && m.result), "session should be live");

    const workspace = { root: "/repo/.worktrees/feature", kind: "worktree" };
    t.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: Methods.SetWorkspace,
      params: { sessionId: "sess-set-workspace", workspace },
    });

    const response = await waitFor(
      () => t.sent.find((m) => m.id === 2 && m.result),
      "setWorkspace response should resolve",
    );
    expect(updates).toEqual([{ sessionId: "sess-set-workspace", workspace }]);
    expect(response.result).toEqual({ ok: true, workspace });
  });
});
