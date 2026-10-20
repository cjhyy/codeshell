import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Engine, EngineResult } from "../engine/engine.js";
import type { EngineRunOptions } from "../engine/run-types.js";
import type { GoalConfig } from "../goal/lifecycle.js";
import { NotificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { ApprovalRouter } from "../tool-system/permission.js";
import { createWorkspaceContext } from "../workspace/workspace-context.js";
import { ChatSessionManager } from "./chat-session-manager.js";
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

class IsolatedSessionManager extends ChatSessionManager {
  override closeAll(): void {
    this.forEachSession((session) => void this.close(session.id));
  }
}

// A paused Goal of a project-bound Session whose Engine is not resident (worker
// restart, idle eviction). Resume must rebuild the Session's Host authority.
function fixture(runResult: (sessionId: string) => EngineResult) {
  const dir = mkdtempSync(join(tmpdir(), "goal-cold-resume-"));
  const root = join(dir, "root");
  mkdirSync(root);
  const sessionId = `${basename(dir)}-bound`;
  const workspaceContext = createWorkspaceContext({
    projectId: "project",
    projectRevision: 3,
    sessionMainRootId: "root",
    roots: [{ id: "root", path: root, role: "primary" }],
  });
  let goal: GoalConfig = {
    objective: "finish the audit",
    goalId: "goal-1",
    revision: 1,
    paused: true,
  };
  const updateGoal = (patch: {
    paused?: boolean;
    expectedGoalId?: string;
    expectedRevision?: number;
  }): GoalConfig | undefined => {
    if (patch.expectedGoalId !== goal.goalId || patch.expectedRevision !== goal.revision)
      return undefined;
    goal = {
      ...goal,
      ...(patch.paused !== undefined ? { paused: patch.paused } : {}),
      revision: goal.revision! + 1,
    };
    return goal;
  };
  const runs: EngineRunOptions[] = [];
  const manager = new IsolatedSessionManager({
    runtime: {} as never,
    dataRoot: dir,
    engineFactory() {
      return {
        isHeadless: () => false,
        sessionExistsOnDisk: () => true,
        getSessionManager: () => ({ readSessionMainRoot: () => root }),
        restoreSessionModel() {},
        setAskUser() {},
        setBrowserBridge() {},
        setInjectCredential() {},
        setWorkspaceBridge() {},
        setSessionMessageRouter() {},
        getGoal: () => goal,
        updateGoal: (_id: string, patch: Parameters<typeof updateGoal>[0]) => updateGoal(patch),
        async run(_task: string, options: EngineRunOptions): Promise<EngineResult> {
          runs.push(options);
          return runResult(sessionId);
        },
      } as unknown as Engine;
    },
  });
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
    readActiveGoalFromDisk: () => goal,
    updateActiveGoalOnDisk: (_id, patch) => updateGoal(patch),
  });
  return {
    sessionId,
    root,
    workspaceContext,
    runs,
    received,
    goal: () => goal,
    resume() {
      clientTransport.send({
        jsonrpc: "2.0",
        id: "resume",
        method: Methods.GoalUpdate,
        params: { sessionId, paused: false, expectedGoalId: "goal-1", expectedRevision: 1 },
      });
    },
    async answerWorkspace() {
      const request = await waitFor(
        () =>
          received.find(
            (event) =>
              event.method === Methods.ApprovalRequest &&
              event.params?.request?.toolName === "__workspace_action__",
          ),
        "the cold resume should ask the Host for the Session's workspace",
      );
      expect(request.params.request.args).toEqual({
        action: "resolve_session_run",
        target: sessionId,
      });
      clientTransport.send({
        jsonrpc: "2.0",
        id: "workspace",
        method: Methods.Approve,
        params: {
          sessionId,
          requestId: request.params.requestId,
          decision: {
            approved: true,
            answer: JSON.stringify({ cwd: root, workspaceContext, projectTrusted: true }),
          },
        },
      });
    },
    async close() {
      server.close();
      await manager.close(sessionId);
      clientTransport.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("AgentServer cold Goal resume", () => {
  test("rebuilds the bound Session's Host workspace before the continuation turn", async () => {
    const f = fixture((sessionId) => ({
      sessionId,
      text: "done",
      reason: "completed",
      turnCount: 1,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    }));
    try {
      f.resume();
      await f.answerWorkspace();
      await waitFor(() => f.runs[0], "the continuation turn should run");
      expect(f.runs[0]).toMatchObject({ cwd: f.root, workspaceContext: f.workspaceContext });
      expect(f.goal().paused).toBe(false);
    } finally {
      await f.close();
    }
  });

  test("a continuation that fails before its first turn pauses the Goal again", async () => {
    const f = fixture((sessionId) => ({
      sessionId,
      text: "ERROR: bound Session requires an authoritative WorkspaceContext",
      reason: "model_error",
      turnCount: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    }));
    try {
      f.resume();
      await f.answerWorkspace();
      const error = await waitFor(
        () =>
          f.received.find(
            (event) =>
              event.method === Methods.StreamEvent && event.params?.event?.type === "error",
          ),
        "a failed resume should be reported",
      );
      expect(error.params.event.error).toContain("WorkspaceContext");
      expect(f.goal().paused).toBe(true);
    } finally {
      await f.close();
    }
  });
});
