import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine, EngineResult, EngineRunOptions } from "../engine/engine.js";
import { ChatSessionManager, type EngineConfigSlice } from "../protocol/chat-session-manager.js";
import { AgentServer } from "../protocol/server.js";
import { createInProcessTransport } from "../protocol/transport.js";
import { Methods } from "../protocol/types.js";
import { SessionManager } from "../session/session-manager.js";
import type { SessionMessageRouter } from "../session/session-message.js";
import { NotificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { sendMessageToSessionTool } from "../tool-system/builtin/send-message-to-session.js";
import type { ToolContext } from "../tool-system/context.js";
import { ApprovalRouter } from "../tool-system/permission.js";
import { hasWorkspaceHostBridge } from "./stdio-host-config.js";

async function waitFor<T>(read: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(description);
}

/** Real protocol routing and disk custody; only the paid model execution is replaced. */
function fixture(env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "stdio-workspace-fallback-"));
  const mainRoot = join(root, "main");
  const worktreeRoot = join(root, "worktree");
  mkdirSync(mainRoot);
  mkdirSync(worktreeRoot);
  const store = new SessionManager(join(root, "sessions"));
  for (const id of ["source", "target"]) store.create(mainRoot, "fixture", "fixture", id);
  const mailbox = new NotificationQueue();
  const runs: Array<{ task: string; options: EngineRunOptions; slice: EngineConfigSlice }> = [];
  const workspaceBridges: unknown[] = [];
  const completed = (sessionId: string, text: string): EngineResult => ({
    sessionId,
    text,
    reason: "completed",
    turnCount: 1,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
  const manager = new ChatSessionManager({
    runtime: {} as never,
    dataRoot: root,
    engineFactory(slice) {
      let routeMessage: SessionMessageRouter | undefined;
      let askUserAsync: ((question: string) => Promise<unknown>) | undefined;
      return {
        isHeadless: () => false,
        getGoal: () => undefined,
        enqueueSteer: (_id: string, _text: string, id: string) => ({ accepted: false, id }),
        sessionExistsOnDisk: (id: string) => store.exists(id),
        getSessionManager: () => store,
        resolveSessionRunWorkspace: (id: string) => ({
          cwd: store.getSessionWorkspace(id)?.root ?? store.readSessionMainRoot(id),
        }),
        setAskUser() {},
        setAskUserAsync(callback: typeof askUserAsync) {
          askUserAsync = callback;
        },
        setBrowserBridge() {},
        setInjectCredential() {},
        setWorkspaceBridge(bridge: unknown) {
          workspaceBridges.push(bridge);
        },
        setSessionMessageRouter(router: SessionMessageRouter) {
          routeMessage = router;
        },
        async run(task: string, options: EngineRunOptions) {
          runs.push({ task, options, slice });
          if (task === "send_message") {
            const target = { sessionId: "target", title: "Target", workspaceRoot: mainRoot };
            const text = await sendMessageToSessionTool(
              { target_session_id: "target", message: "Read existing facts." },
              {
                signal: options.signal,
                sessionMessages: {
                  targets: [target],
                  async send(input) {
                    const receipt = await routeMessage!({
                      sourceSessionId: "source",
                      target,
                      catalog: [target],
                      message: input.message,
                      signal: input.signal,
                    });
                    return { ...target, ...(receipt ? { receipt } : {}) };
                  },
                },
              } as ToolContext,
            );
            return completed(options.sessionId!, text);
          }
          if (task === "ask asynchronously") await askUserAsync!("Which existing facts?");
          return completed(options.sessionId!, "Existing facts read.");
        },
      } as unknown as Engine;
    },
  });
  // Keep cleanup scoped to this fixture's sessions and mailbox.
  manager.closeAllAsync = async () => {
    await Promise.all([manager.close("source"), manager.close("target")]);
  };
  const [serverTransport, clientTransport] = createInProcessTransport();
  const received: any[] = [];
  clientTransport.onMessage((message) => received.push(message));
  const server = new AgentServer({
    transport: serverTransport,
    chatManager: manager,
    workspaceBridge: hasWorkspaceHostBridge(env),
    sessionDiskRoot: join(root, "sessions"),
    notificationMailbox: mailbox,
    approvalRouter: new ApprovalRouter(),
  });
  let requestId = 0;
  const request = (method: string, params: Record<string, unknown>) => {
    const id = ++requestId;
    clientTransport.send({ jsonrpc: "2.0", id, method, params });
    return id;
  };
  const run = (task: string) =>
    request(Methods.Run, { sessionId: "source", task, cwd: mainRoot, projectTrusted: true });
  return {
    root,
    mainRoot,
    worktreeRoot,
    manager,
    mailbox,
    received,
    runs,
    workspaceBridges,
    run,
    request,
    moveToWorktree(id: string) {
      store.setSessionWorkspace(id, {
        root: worktreeRoot,
        kind: "worktree",
        worktree: {
          path: worktreeRoot,
          branch: "fixture-worktree",
          baseRef: "main",
          createdBy: "codeshell",
        },
      });
    },
    async response(id: number) {
      const response = await waitFor(
        () => received.find((message) => message.id === id),
        `RPC ${id} did not complete: ${JSON.stringify(received)}`,
      );
      expect(response.error).toBeUndefined();
      return response.result;
    },
    assertNoWorkspaceLoopback() {
      expect(
        received.filter(
          (message) =>
            message.method === Methods.ApprovalRequest &&
            message.params?.request?.toolName === "__workspace_action__",
        ),
      ).toEqual([]);
      expect(workspaceBridges).toEqual([]);
    },
    async close() {
      await server.close();
      clientTransport.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("stdio workspace Host declaration", () => {
  test("requires the Host's explicit declaration", () => {
    expect(hasWorkspaceHostBridge({})).toBe(false);
    expect(hasWorkspaceHostBridge({ CODE_SHELL_WORKSPACE_ACCESS: "true" })).toBe(false);
    expect(hasWorkspaceHostBridge({ CODE_SHELL_WORKSPACE_ACCESS: "local" })).toBe(false);
    expect(hasWorkspaceHostBridge({ CODE_SHELL_WORKSPACE_ACCESS: "host" })).toBe(true);
  });

  test("Desktop's declared bridge installs and requests Host authority", async () => {
    const f = fixture({ CODE_SHELL_WORKSPACE_ACCESS: "host" });
    try {
      const runId = f.run("send_message");
      const loopback = await waitFor(
        () =>
          f.received.find(
            (message) => message.params?.request?.toolName === "__workspace_action__",
          ),
        "Desktop must ask its installed bridge instead of the fallback",
      );
      expect(f.workspaceBridges).toHaveLength(1);
      expect(loopback.params.request.args).toEqual({
        action: "resolve_session_run",
        target: "target",
      });
      f.request(Methods.Cancel, { sessionId: "source" });
      await f.response(runId);
      expect(f.runs.some((run) => run.options.sessionId === "target")).toBe(false);
    } finally {
      await f.close();
    }
  });

  test("send_message uses the target's persisted workspace without a Host bridge", async () => {
    const f = fixture();
    try {
      f.moveToWorktree("target");
      const result = await f.response(f.run("send_message"));
      expect(result.text).toContain("Existing facts read.");
      const targetRun = f.runs.find((run) => run.options.sessionId === "target");
      expect(targetRun?.task).toBe("Read existing facts.");
      expect(targetRun?.slice).toMatchObject({ cwd: f.worktreeRoot, projectTrusted: true });
      expect(targetRun?.options.cwd).toBe(f.worktreeRoot);
      f.assertNoWorkspaceLoopback();
    } finally {
      await f.close();
    }
  });

  test("an asynchronous AskUser answer resumes from disk after the original turn ends", async () => {
    const f = fixture();
    try {
      await f.response(f.run("ask asynchronously"));
      const question = f.received.find(
        (message) => message.params?.request?.toolName === "__ask_user__",
      );
      expect(question.params.request.args.asynchronous).toBe(true);
      f.moveToWorktree("source");
      await f.response(
        f.request(Methods.Approve, {
          sessionId: "source",
          requestId: question.params.requestId,
          decision: { approved: true, answer: "Use the blue report." },
        }),
      );
      await waitFor(() => f.runs[1], "the answer should start a continuation");
      expect(f.runs[1]?.task).toContain("Use the blue report.");
      expect(f.runs[1]?.options.cwd).toBe(f.worktreeRoot);
      expect(f.manager.get("source")?.pendingApprovals.size).toBe(0);
      f.assertNoWorkspaceLoopback();
    } finally {
      await f.close();
    }
  });

  test("mailbox delivery wakes an idle session with its current persisted workspace", async () => {
    const f = fixture();
    try {
      await f.response(f.run("establish idle session"));
      f.moveToWorktree("source");
      f.mailbox.enqueue(
        {
          agentId: "fixture-background-work",
          name: "fixture result",
          description: "Existing facts are ready.",
          status: "completed",
          enqueuedAt: Date.now(),
        },
        "source",
      );
      await waitFor(() => f.runs[1], "mailbox completion should wake the idle session");
      await f.manager.get("source")?.settled;
      expect(f.runs).toHaveLength(2);
      expect(f.runs[1]?.task).toContain("Existing facts are ready.");
      expect(f.runs[1]?.options).toMatchObject({ cwd: f.worktreeRoot, injected: true });
      expect(f.mailbox.getSnapshot("source")).toEqual([]);
      f.assertNoWorkspaceLoopback();
    } finally {
      await f.close();
    }
  });
});
