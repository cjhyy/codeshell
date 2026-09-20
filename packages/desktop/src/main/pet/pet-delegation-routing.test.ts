import { describe, expect, test } from "bun:test";
import { sessionSelectorId } from "@cjhyy/code-shell-pet/disclosure";
import { PetDispatchService, type PetAutoDelegation } from "./pet-dispatch-service";

const priorThread = "梳理当前项目目录结构";
const objective = "新开 Session 核查飞书文档，不要复用旧 Session";

function harness(
  options: {
    evidence?: unknown;
    reason?: string;
    legacy?: boolean;
    failLaunch?: boolean;
    newWork?: boolean;
  } = {},
) {
  const launches: PetAutoDelegation[] = [];
  const service = new PetDispatchService({
    metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
    aggregator: {
      getSnapshot: () => ({
        version: 1,
        generation: 1,
        observedAt: 1,
        workerState: "active",
        sessions: [],
        pending: [],
      }),
      resolveNavigation: async () => ({ status: "not-found" }),
    },
    hostCwd: "/safe/pet",
    listWorkspaces: async () => [{ path: "/work/project", name: "Project" }],
    listReusableSessions: async () => [
      {
        sessionId: "unrelated-old-session",
        workspacePath: "/work/project",
        title: priorThread,
        updatedAt: Date.now(),
        status: "completed",
      },
    ],
    worker: {
      requestWorker: async (_method, params) => {
        const { workspaces } = params.profileParams as {
          workspaces: Array<{ id: string; name: string }>;
        };
        const delegation = {
          workspaceId: workspaces.find((workspace) => workspace.name === "Project")!.id,
          objective,
          ...(options.newWork
            ? {}
            : { reusableSessionId: sessionSelectorId("unrelated-old-session") }),
          ...(options.evidence === undefined ? {} : { continuationEvidence: options.evidence }),
        };
        return {
          ok: true,
          result: {
            text: "我会单独核查这份飞书文档。",
            reason: options.reason ?? "completed",
            ...(options.legacy
              ? { petWorkDelegation: delegation }
              : { extensions: { pet: { workDelegation: delegation } } }),
          },
        };
      },
    },
    startWorkSession: async (request) => {
      launches.push(request);
      if (options.failLaunch) throw new Error("queue rejected");
      return { sessionId: request.targetSessionId ?? "new-work-session", cwd: "/work/project" };
    },
  });
  return {
    launches,
    dispatch: () =>
      service.dispatch({ type: "chat", message: objective, clientMessageId: "routing-regression" }),
  };
}

describe("Mimi continuation admission and reply preservation", () => {
  test.each([false, true])(
    "a selected old Session without evidence is rejected without substitution (legacy=%s)",
    async (legacy) => {
      const h = harness({ legacy });
      expect(await h.dispatch()).toMatchObject({
        ok: false,
        code: "worker-error",
        message: expect.stringContaining("no replacement Session was created"),
      });
      expect(h.launches).toEqual([]);
    },
  );

  test.each([
    null,
    { priorThread, reason: "" },
    { priorThread: "核查飞书文档", reason: "继续该文档核查" },
  ])(
    "ungrounded continuity evidence cannot resume the unrelated old Session: %j",
    async (evidence) => {
      const h = harness({ evidence });
      await h.dispatch();
      expect(h.launches).toEqual([]);
    },
  );

  test.each(["max_turns", "model_error"])(
    "only incomplete %s replies use a factual launch fallback",
    async (reason) => {
      const h = harness({ reason, newWork: true });
      expect(await h.dispatch()).toMatchObject({
        authoritativeReply: "任务已启动，正在处理。",
        result: { text: "任务已启动，正在处理。", reason },
        delegation: { reusedSession: false },
      });
    },
  );

  test("an incomplete reply with a failed launch does not claim success", async () => {
    const h = harness({ reason: "max_turns", failLaunch: true, newWork: true });
    expect(await h.dispatch()).toMatchObject({
      authoritativeReply: "任务未能启动，请稍后重试。",
      delegationError: "Mimi failed to start the delegated Work Session: queue rejected",
    });
  });
});
