import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Engine, EngineResult } from "../engine/engine.js";
import type { EngineRunOptions } from "../engine/run-types.js";
import type { SessionMessageReceipt, SessionMessageRouter } from "../session/session-message.js";
import { NotificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { ApprovalRouter } from "../tool-system/permission.js";
import { createWorkspaceContext } from "../workspace/workspace-context.js";
import { ChatSessionManager, type EngineConfigSlice } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";
import { createInProcessTransport } from "./transport.js";
import { Methods } from "./types.js";

async function waitFor<T>(read: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(description);
}

// The fixture owns only its temporary Sessions, not process-wide background work.
class IsolatedSessionManager extends ChatSessionManager {
  override closeAll(): void {
    this.forEachSession((session) => void this.close(session.id));
  }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "session-message-host-"));
  const sourceRoot = join(dir, "source-root");
  const targetRoot = join(dir, "target-root");
  mkdirSync(sourceRoot);
  mkdirSync(targetRoot);
  const sourceId = `${basename(dir)}-source`;
  const targetId = `${basename(dir)}-target`;
  const sourceContext = createWorkspaceContext({
    projectId: "shared-project",
    projectRevision: 7,
    sessionMainRootId: "source-root",
    roots: [
      { id: "source-root", path: sourceRoot, role: "primary" },
      { id: "target-root", path: targetRoot, role: "secondary" },
    ],
  });
  const targetContext = createWorkspaceContext({
    projectId: sourceContext.projectId,
    projectRevision: sourceContext.projectRevision,
    sessionMainRootId: "target-root",
    roots: [
      { id: "source-root", path: sourceRoot, role: "secondary" },
      { id: "target-root", path: targetRoot, role: "primary" },
    ],
  });
  const catalog = [
    { sessionId: sourceId, title: "Source", workspaceRoot: sourceRoot },
    // The catalog reflects the source project, while Main resolves the target's
    // independently selected primary root when the dispatch actually runs.
    { sessionId: targetId, title: "Target", workspaceRoot: sourceRoot },
  ];
  const message = "Report the facts already read without making external changes.";
  const senderCancellation = new AbortController();
  const state = {
    receipt: undefined as SessionMessageReceipt | void,
    error: undefined as string | undefined,
    senderSignal: undefined as AbortSignal | undefined,
    targetRuns: [] as Array<{ task: string; options: EngineRunOptions; slice: EngineConfigSlice }>,
  };
  const completed = (sessionId: string, text: string): EngineResult => ({
    sessionId,
    text,
    reason: "completed",
    turnCount: 1,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
  const manager = new IsolatedSessionManager({
    runtime: {} as never,
    dataRoot: dir,
    engineFactory(slice) {
      let routeMessage: SessionMessageRouter | undefined;
      return {
        isHeadless: () => false,
        sessionExistsOnDisk: () => false,
        setAskUser() {},
        setBrowserBridge() {},
        setInjectCredential() {},
        setWorkspaceBridge() {},
        setSessionMessageRouter(router: SessionMessageRouter) {
          routeMessage = router;
        },
        async run(task: string, options: EngineRunOptions): Promise<EngineResult> {
          if (options.sessionId !== sourceId) {
            state.targetRuns.push({ task, options, slice });
            return completed(options.sessionId!, "The existing facts were read successfully.");
          }
          state.senderSignal = AbortSignal.any([options.signal!, senderCancellation.signal]);
          try {
            state.receipt = await routeMessage!({
              sourceSessionId: sourceId,
              target: catalog[1]!,
              message,
              catalog,
              signal: state.senderSignal,
            });
          } catch (error) {
            state.error = error instanceof Error ? error.message : String(error);
          }
          return completed(sourceId, state.error ?? "Dispatch completed.");
        },
      } as unknown as Engine;
    },
  });
  const getOrCreate = spyOn(manager, "getOrCreate");
  const [serverTransport, clientTransport] = createInProcessTransport();
  const received: any[] = [];
  clientTransport.onMessage((event) => received.push(event));
  const server = new AgentServer({
    transport: serverTransport,
    chatManager: manager,
    workspaceBridge: true,
    sessionDiskRoot: join(dir, "sessions"),
    notificationMailbox: new NotificationQueue(),
    approvalRouter: new ApprovalRouter(),
    ownsBackgroundWakeups: false,
  });
  const resolvedWorkspace = {
    cwd: targetRoot,
    workspaceContext: targetContext,
    projectTrusted: false,
  };

  return {
    sourceId,
    targetId,
    sourceRoot,
    sourceContext,
    targetRoot,
    targetContext,
    message,
    resolvedWorkspace,
    received,
    state,
    manager,
    getOrCreate,
    senderCancellation,
    async start() {
      clientTransport.send({
        jsonrpc: "2.0",
        id: 1,
        method: Methods.Run,
        params: {
          sessionId: sourceId,
          task: "Ask the target to report its existing facts.",
          cwd: sourceRoot,
          workspaceContext: sourceContext,
          projectTrusted: true,
        },
      });
      return waitFor(
        () =>
          received.find(
            (event) =>
              event.method === Methods.ApprovalRequest &&
              event.params?.request?.toolName === "__workspace_action__",
          ),
        "the source should request the target's authoritative workspace from Main",
      );
    },
    approve(request: any, answer: unknown = resolvedWorkspace) {
      clientTransport.send({
        jsonrpc: "2.0",
        id: 2,
        method: Methods.Approve,
        params: {
          sessionId: sourceId,
          requestId: request.params.requestId,
          decision: { approved: true, answer: JSON.stringify(answer) },
        },
      });
    },
    cancelSource() {
      clientTransport.send({
        jsonrpc: "2.0",
        id: 3,
        method: Methods.Cancel,
        params: { sessionId: sourceId },
      });
    },
    async settled() {
      await waitFor(
        () => received.find((event) => event.id === 1 && (event.result || event.error)),
        "the source run should settle after the workspace response",
      );
      await manager.get(sourceId)?.settled;
      await manager.get(targetId)?.settled;
    },
    async close() {
      server.close();
      await Promise.all([manager.close(sourceId), manager.close(targetId)]);
      getOrCreate.mockRestore();
      clientTransport.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("AgentServer cross-Session host workspace resolution", () => {
  test("uses the target's host-resolved primary root, full context, and trust through the approval transport", async () => {
    const f = fixture();
    try {
      const request = await f.start();
      expect(request.params.sessionId).toBe(f.sourceId);
      expect(request.params.request.args).toEqual({
        action: "resolve_session_run",
        target: f.targetId,
      });
      expect(f.state.targetRuns).toEqual([]);

      f.approve(request);
      await f.settled();

      expect(f.received.find((event) => event.id === 2)?.result).toEqual({ ok: true });
      expect(f.getOrCreate).toHaveBeenCalledWith(f.targetId, f.resolvedWorkspace, {
        allowReopen: false,
        signal: f.state.senderSignal,
      });
      expect(f.state.targetRuns).toHaveLength(1);
      expect(f.state.targetRuns[0]).toMatchObject({
        task: f.message,
        slice: f.resolvedWorkspace,
        options: {
          sessionId: f.targetId,
          cwd: f.targetRoot,
          workspaceContext: f.targetContext,
        },
      });
      expect(f.state.targetRuns[0]!.options.cwd).not.toBe(f.sourceRoot);
      expect(f.state.targetRuns[0]!.options.workspaceContext).not.toEqual(f.sourceContext);
      expect(f.state.error).toBeUndefined();
      expect(f.state.receipt).toMatchObject({
        status: "completed",
        result: { text: "The existing facts were read successfully.", reason: "completed" },
      });
    } finally {
      await f.close();
    }
  });

  test("rejects an explicit Main resolution failure before creating or enqueuing the target", async () => {
    const f = fixture();
    try {
      const request = await f.start();
      f.approve(request, {
        ok: false,
        error: "The target Session no longer belongs to this project.",
      });
      await f.settled();

      expect(f.state.error).toBe("The target Session no longer belongs to this project.");
      expect(f.state.receipt).toBeUndefined();
      expect(f.state.targetRuns).toEqual([]);
      expect(f.manager.get(f.targetId)).toBeUndefined();
      expect(f.getOrCreate.mock.calls.every(([sessionId]) => sessionId !== f.targetId)).toBe(true);
    } finally {
      await f.close();
    }
  });

  test.each(["missing trust", "mismatched primary root"] as const)(
    "rejects a host workspace with %s instead of running with incomplete authority",
    async (invalidCase) => {
      const f = fixture();
      try {
        const request = await f.start();
        const answer =
          invalidCase === "missing trust"
            ? { cwd: f.targetRoot, workspaceContext: f.targetContext }
            : { ...f.resolvedWorkspace, cwd: f.sourceRoot };
        f.approve(request, answer);
        await f.settled();

        expect(f.state.error).toContain(
          invalidCase === "missing trust" ? "invalid Session workspace" : "does not match",
        );
        expect(f.state.receipt).toBeUndefined();
        expect(f.state.targetRuns).toEqual([]);
        expect(f.manager.get(f.targetId)).toBeUndefined();
      } finally {
        await f.close();
      }
    },
  );

  test("does not reopen a target closed while Main is resolving its workspace", async () => {
    const f = fixture();
    try {
      const request = await f.start();
      await f.manager.close(f.targetId);
      f.approve(request);
      await f.settled();

      expect(f.state.error).toContain("closing or closed");
      expect(f.state.receipt).toBeUndefined();
      expect(f.state.targetRuns).toEqual([]);
      expect(f.manager.get(f.targetId)).toBeUndefined();
      expect(f.manager.isClosed(f.targetId)).toBe(true);
      expect(f.getOrCreate.mock.calls.every(([sessionId]) => sessionId !== f.targetId)).toBe(true);
    } finally {
      await f.close();
    }
  });

  test("cancels the pending host request on source Stop and ignores a late successful approval", async () => {
    const f = fixture();
    try {
      const request = await f.start();
      f.cancelSource();
      await f.settled();
      f.approve(request);

      expect(f.received.find((event) => event.id === 3)?.result).toEqual({ ok: true });
      expect(f.received.find((event) => event.id === 2)?.error).toBeDefined();
      expect(f.state.senderSignal?.aborted).toBe(true);
      expect(f.state.error).toContain("cancelled");
      expect(f.state.receipt).toBeUndefined();
      expect(f.state.targetRuns).toEqual([]);
      expect(f.manager.get(f.targetId)).toBeUndefined();
      expect(f.manager.get(f.sourceId)?.pendingApprovals.size).toBe(0);
    } finally {
      await f.close();
    }
  });

  test("checks the sender's AbortSignal again before enqueuing a late successful host resolution", async () => {
    const f = fixture();
    try {
      const request = await f.start();
      f.senderCancellation.abort(new Error("The source tool was cancelled."));
      f.approve(request);
      await f.settled();

      expect(f.state.error).toBe("The source tool was cancelled.");
      expect(f.state.receipt).toBeUndefined();
      expect(f.state.targetRuns).toEqual([]);
      expect(f.manager.get(f.targetId)).toBeUndefined();
      expect(f.getOrCreate.mock.calls.every(([sessionId]) => sessionId !== f.targetId)).toBe(true);
    } finally {
      await f.close();
    }
  });
});
