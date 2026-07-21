import { describe, expect, test } from "bun:test";
import type { DesktopPetProjectionSnapshot } from "./pet-state-aggregator";
import { PetDispatchService } from "./pet-dispatch-service";

const snapshot: DesktopPetProjectionSnapshot = {
  version: 4,
  generation: 2,
  workerState: "active",
  observedAt: 10,
  sessions: [
    {
      agentSessionId: "work-a",
      title: "Work A",
      workspaceDisplayName: "repo-a",
      runState: "running",
      summary: "模型处理中",
      queueDepth: 0,
      lastActivityAt: 9,
      pendingDecisionCount: 1,
      freshness: { source: "live-event", observedAt: 10, workerState: "active" },
    },
  ],
  pending: [
    {
      agentSessionId: "work-a",
      requestId: "req-a",
      workerGeneration: 2,
      kind: "ask_user",
      title: "Choose a plan",
      createdAt: 9,
      status: "pending",
    },
  ],
};

describe("PetDispatchService", () => {
  test("keeps deterministic commands off the model and reuses safe navigation", async () => {
    let workerCalls = 0;
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async () => {
          workerCalls += 1;
          return { ok: true, result: {} };
        },
      },
      hostCwd: "/safe/pet",
      listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
    });

    expect(await service.dispatch({ type: "get_global_status" })).toMatchObject({
      ok: true,
      type: "global_status",
      runningCount: 1,
      pendingCount: 1,
    });
    expect(await service.dispatch({ type: "list_pending" })).toMatchObject({
      ok: true,
      type: "pending_list",
      pending: [{ requestId: "req-a" }],
    });
    expect(
      await service.dispatch({
        type: "open_session",
        target: { agentSessionId: "work-a", snapshotVersion: 4, generation: 2 },
      }),
    ).toEqual({ ok: true, type: "open_session", result: { status: "not-found" } });
    expect(workerCalls).toBe(0);
  });

  test("runs every channel through the persisted Mimi manager model", async () => {
    let request: { method: string; params: Record<string, unknown> } | undefined;
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (method, params) => {
          request = { method, params };
          return { ok: true, result: { text: "1 running" } };
        },
      },
      hostCwd: "/safe/pet",
      managerModel: async () => "fast-model",
      longTasks: {
        context: () => ({
          version: 1,
          active: [
            {
              taskId: "pet-task-one",
              objective: "Ship the release",
              status: "running",
              sessionId: "work-a",
            },
          ],
          recent: [],
        }),
      },
      listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
    });

    expect(
      await service.dispatch({
        type: "chat",
        message: "What is running?",
        clientMessageId: "im:one",
        source: { kind: "im-gateway", channel: "telegram", target: "owner-chat" },
        attachments: [
          {
            id: "att-one",
            sessionId: "pet-one",
            kind: "file",
            origin: "im-gateway",
            path: ".code-shell/attachments/pet-one/a.txt",
            absPath: "/safe/pet/.code-shell/attachments/pet-one/a.txt",
            size: 1,
            sha256: "a".repeat(64),
            createdAt: 1,
          },
        ],
      }),
    ).toMatchObject({ ok: true, type: "chat", petSessionId: "pet-one" });
    expect(request).toMatchObject({
      method: "agent/run",
      params: {
        sessionId: "pet-one",
        cwd: "/safe/pet",
        behaviorMode: "pet",
        kind: "pet",
        permissionMode: "default",
        clientMessageId: "im:one",
        model: "fast-model",
        attachments: [{ id: "att-one", origin: "im-gateway" }],
      },
    });
    expect(String(request?.params.task)).toContain("What is running?");
    expect(String(request?.params.task)).not.toContain("<pet-world>");
    expect(String(request?.params.task)).not.toContain("requestId");
    expect(String(request?.params.petRuntimeContext)).toContain('"runState":"running"');
    expect(String(request?.params.petRuntimeContext)).toContain('"taskId":"pet-task-one"');
    expect(String(request?.params.petRuntimeContext)).toContain(
      '"currentMessageSource":{"kind":"im-gateway","channel":"telegram"}',
    );
    expect(request?.params.petWorkspaces).toEqual([
      expect.objectContaining({ id: "no-workspace", name: "No workspace" }),
      expect.objectContaining({ name: "CodeShell", description: "/work/codeshell" }),
    ]);
  });

  test("uses only the validated DelegateWork result for automatic delegation", async () => {
    const starts: unknown[] = [];
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (_method, params) => {
          const workspace = (params.petWorkspaces as Array<{ id: string; name: string }>).find(
            (candidate) => candidate.name === "CodeShell",
          )!;
          return {
            ok: true,
            result: {
              text: "已交给工作会话。",
              petWorkDelegation: {
                workspaceId: workspace.id,
                objective: "修复 CodeShell 登录问题",
              },
            },
          };
        },
      },
      hostCwd: "/safe/pet",
      listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
      startWorkSession: async (delegation) => {
        starts.push(delegation);
        return { sessionId: "pet-work-one", cwd: delegation.workspacePath! };
      },
    });

    expect(
      await service.dispatch({
        type: "chat",
        message: "修复登录问题",
        clientMessageId: "client-delegate",
        preferredProjectPath: "/work/codeshell",
        source: { kind: "im-gateway", channel: "wechat", target: "owner-conversation" },
      }),
    ).toMatchObject({
      ok: true,
      type: "chat",
      delegation: {
        clientMessageId: "client-delegate",
        task: "修复 CodeShell 登录问题",
        workspacePath: "/work/codeshell",
        sessionId: "pet-work-one",
      },
    });
    expect(starts).toEqual([
      {
        clientMessageId: "client-delegate",
        task: "修复 CodeShell 登录问题",
        workspacePath: "/work/codeshell",
        completionTarget: {
          kind: "im-gateway",
          channel: "wechat",
          target: "owner-conversation",
        },
      },
    ]);
  });

  test("injects a durable Mimi completion decision and returns its proactive reply", async () => {
    let request: { method: string; params: Record<string, unknown> } | undefined;
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (method, params) => {
          request = { method, params };
          return { ok: true, result: { text: "任务已完成，最终结果已经整理好了。" } };
        },
      },
      hostCwd: "/safe/pet",
      longTasks: { context: () => ({ version: 1, active: [], recent: [] }) },
    });

    const report = await service.reportLongTaskClosure({
      schemaVersion: 1,
      id: "pet-task-finished",
      originClientMessageId: "im:wechat:one",
      objective: "整理 CodeShell 待办事项",
      workspacePath: "/work/codeshell",
      sessionId: "pet-work-finished",
      status: "completed",
      phase: "finalizing",
      attempt: 1,
      revision: 3,
      createdAt: 100,
      updatedAt: 300,
      completedAt: 300,
      summary: "P0 是收口 Pet 外部 Session 接入。",
      artifacts: [],
      events: [],
    });

    expect(report).toEqual({
      text: "任务已完成，最终结果已经整理好了。",
      continued: false,
    });
    expect(request).toMatchObject({
      method: "agent/run",
      params: {
        sessionId: "pet-one",
        behaviorMode: "pet",
        kind: "pet",
        injected: true,
        requireExisting: true,
      },
    });
    expect(String(request?.params.clientMessageId)).toStartWith(
      "pet-closure:pet-task-finished:1:completed:",
    );
    expect(String(request?.params.task)).toContain("Decide the next manager action");
    expect(String(request?.params.petRuntimeContext)).toContain(
      '"summary":"P0 是收口 Pet 外部 Session 接入。"',
    );
  });

  test("lets Mimi continue completed work and carries the original notification route", async () => {
    const starts: unknown[] = [];
    const effects: string[] = [];
    let durableDecision: Record<string, unknown> | undefined;
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (_method, params) => {
          const workspace = (params.petWorkspaces as Array<{ id: string; name: string }>).find(
            (candidate) => candidate.name === "CodeShell",
          )!;
          return {
            ok: true,
            result: {
              text: "第一步完成，我继续验证发布流程。",
              extensions: {
                pet: {
                  workDelegation: {
                    workspaceId: workspace.id,
                    objective: "验证 CodeShell 发布流程并修复剩余问题",
                  },
                },
              },
            },
          };
        },
      },
      hostCwd: "/safe/pet",
      longTasks: {
        context: () => ({ version: 1, active: [], recent: [] }),
        recordClosureDecision: async (_taskId, decision) => {
          effects.push("decision-persisted");
          durableDecision = { ...decision, decidedAt: 301 };
          return { closureDecision: durableDecision } as never;
        },
        recordContinuationStarted: async (_taskId, _key, launch) => {
          effects.push("launch-persisted");
          durableDecision = { ...durableDecision, launch: { ...launch, at: 302 } };
          return { closureDecision: durableDecision } as never;
        },
      },
      listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
      startWorkSession: async (delegation) => {
        effects.push("session-started");
        starts.push(delegation);
        return { sessionId: "pet-work-next", cwd: delegation.workspacePath! };
      },
    });

    const report = await service.reportLongTaskClosure({
      schemaVersion: 1,
      id: "pet-task-step-one",
      originClientMessageId: "im:wechat:one",
      objective: "完成 CodeShell 发布准备",
      workspacePath: "/work/codeshell",
      sessionId: "pet-work-step-one",
      completionTarget: {
        kind: "im-gateway",
        channel: "wechat",
        target: "owner-conversation",
      },
      status: "completed",
      phase: "finalizing",
      attempt: 1,
      revision: 3,
      createdAt: 100,
      updatedAt: 300,
      completedAt: 300,
      summary: "构建已经通过，但发布流程尚未验证。",
      artifacts: [],
      events: [],
    });

    expect(report).toMatchObject({
      text: "第一步完成，我继续验证发布流程。",
      continued: true,
      delegation: { sessionId: "pet-work-next" },
    });
    expect(starts).toEqual([
      {
        clientMessageId: "pet-continuation:pet-task-step-one:1:completed",
        task: "验证 CodeShell 发布流程并修复剩余问题",
        workspacePath: "/work/codeshell",
        completionTarget: {
          kind: "im-gateway",
          channel: "wechat",
          target: "owner-conversation",
        },
        continuationDepth: 1,
      },
    ]);
    expect(effects).toEqual(["decision-persisted", "session-started", "launch-persisted"]);
  });

  test("replays a persisted continuation decision without rerunning Mimi", async () => {
    let workerCalls = 0;
    let startCalls = 0;
    let launchRecorded = false;
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async () => {
          workerCalls += 1;
          return { ok: true, result: {} };
        },
      },
      hostCwd: "/safe/pet",
      longTasks: {
        context: () => ({ version: 1, active: [], recent: [] }),
        recordContinuationStarted: async (_taskId, _key, launch) => {
          launchRecorded = true;
          return {
            closureDecision: {
              key: "pet-task-replay:1:completed",
              text: "继续验证发布流程。",
              decidedAt: 300,
              continuation: {
                clientMessageId: "pet-continuation:pet-task-replay:1:completed",
                objective: "验证发布流程",
                workspacePath: "/work/codeshell",
              },
              launch: { ...launch, at: 301 },
            },
          } as never;
        },
      },
      startWorkSession: async (delegation) => {
        startCalls += 1;
        expect(delegation.clientMessageId).toBe("pet-continuation:pet-task-replay:1:completed");
        return { sessionId: "pet-work-replayed", cwd: "/work/codeshell" };
      },
    });

    const report = await service.reportLongTaskClosure({
      schemaVersion: 1,
      id: "pet-task-replay",
      originClientMessageId: "im:wechat:replay",
      objective: "完成发布准备",
      workspacePath: "/work/codeshell",
      sessionId: "pet-work-original",
      status: "completed",
      phase: "finalizing",
      attempt: 1,
      revision: 4,
      createdAt: 100,
      updatedAt: 300,
      completedAt: 300,
      artifacts: [],
      events: [],
      closureDecision: {
        key: "pet-task-replay:1:completed",
        text: "继续验证发布流程。",
        decidedAt: 300,
        continuation: {
          clientMessageId: "pet-continuation:pet-task-replay:1:completed",
          objective: "验证发布流程",
          workspacePath: "/work/codeshell",
        },
      },
    });

    expect(report).toMatchObject({
      continued: true,
      delegation: { sessionId: "pet-work-replayed" },
    });
    expect(workerCalls).toBe(0);
    expect(startCalls).toBe(1);
    expect(launchRecorded).toBe(true);
  });

  test("stops autonomous continuation at the bounded depth", async () => {
    let started = false;
    let exposedWorkspaces: unknown;
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (_method, params) => {
          exposedWorkspaces = params.petWorkspaces;
          return { ok: true, result: { text: "自动续办已到上限，请你确认下一步。" } };
        },
      },
      hostCwd: "/safe/pet",
      listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
      startWorkSession: async () => {
        started = true;
        return { sessionId: "should-not-start", cwd: "/work/codeshell" };
      },
    });

    const report = await service.reportLongTaskClosure({
      schemaVersion: 1,
      id: "pet-task-depth-three",
      originClientMessageId: "pet-continuation:prior",
      objective: "完成发布",
      workspacePath: "/work/codeshell",
      sessionId: "pet-work-depth-three",
      continuationDepth: 3,
      status: "completed",
      phase: "finalizing",
      attempt: 1,
      revision: 3,
      createdAt: 100,
      updatedAt: 300,
      completedAt: 300,
      summary: "仍有一个可选优化。",
      artifacts: [],
      events: [],
    });

    expect(exposedWorkspaces).toEqual([]);
    expect(started).toBe(false);
    expect(report).toEqual({
      text: "自动续办已到上限，请你确认下一步。",
      continued: false,
    });
  });

  test("offers a bounded reusable Session set and resumes only the selected host entry", async () => {
    const starts: unknown[] = [];
    let exposedSessions: Array<{ id: string; workspaceId: string; name: string }> = [];
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (_method, params) => {
          const profileParams = params.profileParams as {
            workspaces: Array<{ id: string; name: string }>;
            reusableSessions: Array<{ id: string; workspaceId: string; name: string }>;
          };
          exposedSessions = profileParams.reusableSessions;
          const workspace = profileParams.workspaces.find(
            (candidate) => candidate.name === "CodeShell",
          )!;
          const reusable = exposedSessions.find((candidate) => candidate.name === "Login work")!;
          return {
            ok: true,
            result: {
              text: "继续原会话。",
              extensions: {
                pet: {
                  workDelegation: {
                    workspaceId: workspace.id,
                    objective: "继续修复登录问题",
                    reusableSessionId: reusable.id,
                  },
                },
              },
            },
          };
        },
      },
      hostCwd: "/safe/pet",
      listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
      listReusableSessions: async () => [
        {
          sessionId: "work-a",
          workspacePath: "/work/codeshell",
          title: "Busy work",
          updatedAt: 20,
          status: "active",
        },
        {
          sessionId: "work-login",
          workspacePath: "/work/codeshell",
          title: "Login work",
          updatedAt: 19,
          status: "completed",
        },
        {
          sessionId: "work-other",
          workspacePath: "/work/not-listed",
          title: "Other work",
          updatedAt: 18,
          status: "completed",
        },
      ],
      startWorkSession: async (delegation) => {
        starts.push(delegation);
        return { sessionId: delegation.targetSessionId!, cwd: delegation.workspacePath! };
      },
    });

    expect(
      await service.dispatch({
        type: "chat",
        message: "继续刚才的登录修复",
        clientMessageId: "client-reuse",
      }),
    ).toMatchObject({
      ok: true,
      type: "chat",
      delegation: {
        sessionId: "work-login",
        reusedSession: true,
      },
    });
    expect(exposedSessions).toEqual([expect.objectContaining({ name: "Login work" })]);
    expect(starts).toEqual([
      {
        clientMessageId: "client-reuse",
        task: "继续修复登录问题",
        workspacePath: "/work/codeshell",
        targetSessionId: "work-login",
      },
    ]);
  });

  test("binds a reusable Session whose cwd differs from its Workspace only by a trailing separator", async () => {
    let exposed: Array<{ id: string; workspaceId: string; name: string }> = [];
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (_method, params) => {
          exposed = (params.profileParams as { reusableSessions: typeof exposed }).reusableSessions;
          return { ok: true, result: { text: "noop" } };
        },
      },
      hostCwd: "/safe/pet",
      listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
      listReusableSessions: async () => [
        {
          sessionId: "work-login",
          workspacePath: "/work/codeshell/",
          title: "Login work",
          updatedAt: 19,
          status: "completed",
        },
      ],
    });

    await service.dispatch({ type: "chat", message: "继续", clientMessageId: "client-slash" });
    // Without trailing-separator normalization this Session would be dropped
    // because "/work/codeshell/" !== the Workspace's "/work/codeshell".
    expect(exposed).toEqual([expect.objectContaining({ name: "Login work" })]);
  });

  test("rejects a DelegateWork result outside the host-provided Workspace list", async () => {
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async () => ({
          ok: true,
          result: {
            text: "delegated",
            petWorkDelegation: {
              workspaceId: "workspace-invented",
              objective: "do not run this",
            },
          },
        }),
      },
      hostCwd: "/safe/pet",
      listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
    });

    expect(await service.dispatch({ type: "chat", message: "修复登录问题" })).toEqual({
      ok: false,
      code: "worker-error",
      message: "Mimi returned a Workspace outside the host-provided list",
    });
  });

  test("rejects a reusable Session selector outside the host-provided closed set", async () => {
    let started = false;
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (_method, params) => {
          const workspace = (params.petWorkspaces as Array<{ id: string; name: string }>).find(
            (candidate) => candidate.name === "CodeShell",
          )!;
          return {
            ok: true,
            result: {
              extensions: {
                pet: {
                  workDelegation: {
                    workspaceId: workspace.id,
                    objective: "do not run this",
                    reusableSessionId: "session-invented",
                  },
                },
              },
            },
          };
        },
      },
      hostCwd: "/safe/pet",
      listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
      listReusableSessions: async () => [
        {
          sessionId: "work-login",
          workspacePath: "/work/codeshell",
          title: "Login work",
          updatedAt: 1,
        },
      ],
      startWorkSession: async () => {
        started = true;
        return { sessionId: "bad", cwd: "/work/codeshell" };
      },
    });

    expect(await service.dispatch({ type: "chat", message: "继续登录修复" })).toEqual({
      ok: false,
      code: "worker-error",
      message: "Mimi returned a Session outside the host-provided reusable set",
    });
    expect(started).toBe(false);
  });

  test("keeps Mimi's chat reply but reports a delegationError when the Work Session cannot start", async () => {
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (_method, params) => {
          const workspace = (params.petWorkspaces as Array<{ id: string; name: string }>).find(
            (candidate) => candidate.name === "CodeShell",
          )!;
          return {
            ok: true,
            result: {
              text: "已交给工作会话。",
              petWorkDelegation: {
                workspaceId: workspace.id,
                objective: "修复 CodeShell 登录问题",
              },
            },
          };
        },
      },
      hostCwd: "/safe/pet",
      listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
      startWorkSession: async () => {
        throw new Error("queue rejected");
      },
    });

    const failedResult = await service.dispatch({
      type: "chat",
      message: "修复登录问题",
      clientMessageId: "client-delegate-failed",
    });
    expect(failedResult).toMatchObject({
      ok: true,
      type: "chat",
      petSessionId: "pet-one",
      result: { text: "已交给工作会话。" },
      delegationError: "Mimi failed to start the delegated Work Session: queue rejected",
    });
    expect(failedResult).not.toHaveProperty("delegation");
  });

  test("does not treat the legacy text marker as a delegation", async () => {
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async () => ({
          ok: true,
          result: { text: "我会自动派发。\n<!--PET:AUTO_DELEGATE-->" },
        }),
      },
      hostCwd: "/safe/pet",
      listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
    });

    expect(await service.dispatch({ type: "chat", message: "修复登录问题" })).not.toHaveProperty(
      "delegation",
    );
  });

  test("does not inject or persist any raw multiline AskUser title even if host input is malformed", async () => {
    let task = "";
    let runtimeContext = "";
    const unsafeSnapshot: DesktopPetProjectionSnapshot = {
      ...snapshot,
      pending: [
        {
          ...snapshot.pending[0]!,
          title: [
            "普通密码 hunter2",
            "middle token-middle-445566",
            "tail secret-tail-aabbcc778899",
          ].join("\n"),
        },
      ],
    };
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => unsafeSnapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (_method, params) => {
          task = String(params.task);
          runtimeContext = String(params.petRuntimeContext);
          return { ok: true, result: { text: "safe" } };
        },
      },
      hostCwd: "/safe/pet",
    });

    await service.dispatch({ type: "chat", message: "list pending" });
    expect(task).toBe("list pending");
    expect(task).not.toContain("<pet-world>");
    expect(runtimeContext).toContain("需要用户回答");
    expect(runtimeContext).not.toContain("hunter2");
    expect(task).not.toContain("token-middle-445566");
    expect(task).not.toContain("secret-tail-aabbcc778899");
  });

  test("injects the topic-segment carryover brief into the pet runtime context", async () => {
    let runtimeContext = "";
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (_method, params) => {
          runtimeContext = String(params.petRuntimeContext);
          return { ok: true, result: { text: "hi" } };
        },
      },
      hostCwd: "/safe/pet",
      segmentController: {
        beginTurn: async () => "未完成任务:\n- 重构 X",
        onDelegationClosed: async () => {},
      },
    });

    await service.dispatch({ type: "chat", message: "你好" });
    expect(runtimeContext).toContain('"carryoverBrief"');
    expect(runtimeContext).toContain("重构 X");
  });

  test("passes the turn's client message id to beginTurn so a boundary can key on it", async () => {
    const beginTurnArgs: (string | undefined)[] = [];
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: { requestWorker: async () => ({ ok: true, result: { text: "hi" } }) },
      hostCwd: "/safe/pet",
      segmentController: {
        beginTurn: async (clientMessageId) => {
          beginTurnArgs.push(clientMessageId);
          return undefined;
        },
        onDelegationClosed: async () => {},
      },
    });

    await service.dispatch({ type: "chat", message: "你好", clientMessageId: "client-turn-1" });
    expect(beginTurnArgs).toEqual(["client-turn-1"]);
  });

  test("does not record launch acceptance as a completed work-memory closure", async () => {
    const closures: Array<Record<string, unknown>> = [];
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (_method, params) => {
          const workspace = (params.petWorkspaces as Array<{ id: string; name: string }>).find(
            (candidate) => candidate.name === "CodeShell",
          )!;
          return {
            ok: true,
            result: {
              text: "已交给工作会话。",
              petWorkDelegation: {
                workspaceId: workspace.id,
                objective: "修复 CodeShell 登录问题",
              },
            },
          };
        },
      },
      hostCwd: "/safe/pet",
      listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
      startWorkSession: async (delegation) => ({
        sessionId: "pet-work-one",
        cwd: delegation.workspacePath!,
      }),
      segmentController: {
        beginTurn: async () => undefined,
        onDelegationClosed: async (closure) => {
          closures.push(closure as unknown as Record<string, unknown>);
        },
      },
    });

    await service.dispatch({
      type: "chat",
      message: "修复登录问题",
      clientMessageId: "client-delegate",
    });
    // PetLongTaskCoordinator records a closure only after the real worker
    // completion/failure/cancellation signal, never at launch acceptance.
    expect(closures).toEqual([]);
  });

  test("rejects direction, approval and arbitrary mutation commands", async () => {
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: { requestWorker: async () => ({ ok: true, result: {} }) },
      hostCwd: "/safe/pet",
    });

    expect(await service.dispatch({ type: "send_direction" } as never)).toEqual({
      ok: false,
      code: "unsupported-in-phase-1",
    });
  });
});
