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

  test.each(["null", "42", "true", '"hello"', "[]"])(
    "rejects a non-object workspace payload (%s) instead of resolving it",
    async (answer) => {
      // A workspace is always an object. Resolving `null` / a number / a string
      // would hand a non-workspace to setSessionWorkspace as if the switch had
      // succeeded, rebasing the session onto garbage. (This used to be caught
      // only incidentally, by a TypeError from `"ok" in parsed`.)
      const state = {
        workspaceBridge: undefined as WorkspaceBridge | undefined,
        error: "",
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
          try {
            await state.workspaceBridge!.switch("feature");
            state.error = "RESOLVED_UNEXPECTEDLY";
          } catch (error) {
            state.error = error instanceof Error ? error.message : String(error);
          }
          return {
            text: "done",
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
      new AgentServer({ transport: t.transport, chatManager, workspaceBridge: true });
      t.deliver({
        jsonrpc: "2.0",
        id: 1,
        method: Methods.Run,
        params: { sessionId: "sess-malformed", task: "switch" },
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
      t.deliver({
        jsonrpc: "2.0",
        id: 2,
        method: Methods.Approve,
        params: {
          sessionId: "sess-malformed",
          requestId: request.params.requestId,
          decision: { approved: true, answer },
        },
      });

      await waitFor(() => (state.error === "" ? undefined : state.error), "switch should settle");
      expect(state.error).not.toBe("RESOLVED_UNEXPECTEDLY");
      expect(state.error).toContain("malformed");
    },
  );

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

  test("agent/migrateSessionMainRoot forwards one complete authoritative commit to the live engine", async () => {
    const updates: unknown[] = [];
    const engine = {
      setAskUser() {},
      setPlanMode() {},
      setBrowserBridge() {},
      setInjectCredential() {},
      setSessionMessageRouter() {},
      isHeadless: () => false,
      migrateSessionMainRoot(sessionId: string, project: unknown, mainRoot: string) {
        updates.push({ sessionId, project, mainRoot });
        return { root: mainRoot, kind: "main" };
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
      params: { sessionId: "sess-migrate-root", task: "start" },
    });
    await waitFor(() => t.sent.find((m) => m.id === 1 && m.result), "session should be live");

    t.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: Methods.MigrateSessionMainRoot,
      params: {
        sessionId: "sess-migrate-root",
        project: { projectId: "project-1", mainRootId: "root-new" },
        mainRoot: "/repo/new",
        ownershipToken: "live-owner-token",
      },
    });

    const response = await waitFor(
      () => t.sent.find((m) => m.id === 2 && m.result),
      "migrateSessionMainRoot response should resolve",
    );
    expect(updates).toEqual([
      {
        sessionId: "sess-migrate-root",
        project: { projectId: "project-1", mainRootId: "root-new" },
        mainRoot: "/repo/new",
      },
    ]);
    expect(response.result).toEqual({
      status: "migrated",
      workspace: { root: "/repo/new", kind: "main" },
    });
  });

  test("agent/migrateSessionMainRoot claims an idle-evicted Session until Main finishes its durable migration", async () => {
    let runs = 0;
    const engine = {
      setAskUser() {},
      setPlanMode() {},
      setBrowserBridge() {},
      setInjectCredential() {},
      setSessionMessageRouter() {},
      isHeadless: () => false,
      async run(_task: string, opts: { sessionId: string }): Promise<EngineResult> {
        runs += 1;
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
      idleTtlMs: 0,
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });
    const sessionId = "sess-idle-migrate-root";
    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: Methods.Run,
      params: { sessionId, task: "start" },
    });
    await waitFor(() => t.sent.find((m) => m.id === 1 && m.result), "session should finish");
    chatManager.get(sessionId)!.lastActivityAt = Date.now() - 1;
    chatManager.sweepIdle();
    expect(chatManager.get(sessionId)).toBeUndefined();

    t.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: Methods.MigrateSessionMainRoot,
      params: {
        sessionId,
        project: { projectId: "project-1", mainRootId: "root-new" },
        mainRoot: "/repo/new",
        ownershipToken: "idle-owner-token",
      },
    });
    const migration = await waitFor(
      () => t.sent.find((m) => m.id === 2 && m.result),
      "idle migration ownership should resolve",
    );
    const ownershipToken = migration.result.ownershipToken as string;
    expect(migration.result.status).toBe("not-resident");
    expect(ownershipToken).toBe("idle-owner-token");

    t.deliver({
      jsonrpc: "2.0",
      id: 3,
      method: Methods.Run,
      params: { sessionId, task: "resume while Main commits" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.sent.some((m) => m.id === 3)).toBe(false);
    expect(chatManager.get(sessionId)).toBeUndefined();

    t.deliver({
      jsonrpc: "2.0",
      id: 4,
      method: Methods.CompleteSessionMainRootMigration,
      params: { sessionId, ownershipToken: "wrong-owner-token" },
    });
    const rejectedCompletion = await waitFor(
      () => t.sent.find((m) => m.id === 4),
      "a mismatched claim completion should resolve",
    );
    expect(rejectedCompletion.error).toMatchObject({ code: -32602 });
    expect(chatManager.get(sessionId)).toBeUndefined();

    t.deliver({
      jsonrpc: "2.0",
      id: 5,
      method: Methods.CompleteSessionMainRootMigration,
      params: { sessionId, ownershipToken },
    });
    const completion = await waitFor(
      () => t.sent.find((m) => m.id === 5),
      "claim completion should resolve",
    );
    expect(completion).toEqual({ jsonrpc: "2.0", id: 5, result: { released: true } });
    await waitFor(() => t.sent.find((m) => m.id === 3 && m.result), "blocked run should resume");
    expect(runs).toBe(2);
    expect(chatManager.get(sessionId)).toBeDefined();
  });

  test("agent/migrateSessionMainRoot reports a resident owner error as failed", async () => {
    const engine = {
      setAskUser() {},
      setPlanMode() {},
      setBrowserBridge() {},
      setInjectCredential() {},
      setSessionMessageRouter() {},
      isHeadless: () => false,
      migrateSessionMainRoot() {
        throw new Error("state lock failed");
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
      params: { sessionId: "sess-failed-migrate-root", task: "start" },
    });
    await waitFor(() => t.sent.find((m) => m.id === 1 && m.result), "session should be live");

    t.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: Methods.MigrateSessionMainRoot,
      params: {
        sessionId: "sess-failed-migrate-root",
        project: { projectId: "project-1", mainRootId: "root-new" },
        mainRoot: "/repo/new",
        ownershipToken: "failed-owner-token",
      },
    });
    const response = await waitFor(
      () => t.sent.find((m) => m.id === 2 && m.result),
      "failed migration should resolve",
    );
    expect(response.result).toEqual({ status: "failed", error: "state lock failed" });
  });
});
