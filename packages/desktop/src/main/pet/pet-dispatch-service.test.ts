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

  test("runs chat once through the global worker with the durable pet profile", async () => {
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
      listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
    });

    expect(
      await service.dispatch({
        type: "chat",
        message: "What is running?",
        clientMessageId: "im:one",
        source: { kind: "im-gateway", channel: "telegram" },
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
        attachments: [{ id: "att-one", origin: "im-gateway" }],
      },
    });
    expect(String(request?.params.task)).toContain("What is running?");
    expect(String(request?.params.task)).not.toContain("<pet-world>");
    expect(String(request?.params.task)).not.toContain("requestId");
    expect(String(request?.params.petRuntimeContext)).toContain('"runState":"running"');
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
      },
    ]);
  });

  test("launches a selected digital-human team as parallel profile-bound Sessions", async () => {
    const starts: Array<Record<string, unknown>> = [];
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
            digitalHumans: Array<{ id: string; name: string }>;
          };
          const workspace = profileParams.workspaces.find(
            (candidate) => candidate.name === "CodeShell",
          )!;
          return {
            ok: true,
            result: {
              text: "团队已并行派出。",
              extensions: {
                pet: {
                  workDelegations: profileParams.digitalHumans.map((human) => ({
                    workspaceId: workspace.id,
                    digitalHumanId: human.id,
                    objective: human.id === "researcher" ? "研究现有实现" : "独立准备实现方案",
                  })),
                },
              },
            },
          };
        },
      },
      hostCwd: "/safe/pet",
      listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
      listDigitalHumans: async () => [
        { name: "researcher", label: "研究员", description: "研究问题" },
        { name: "developer", label: "开发者", description: "实现功能" },
      ],
      listDigitalHumanTeams: async () => [
        {
          id: "build-team",
          name: "构建小队",
          members: ["researcher", "developer"],
          mode: "divide",
        },
      ],
      startWorkSession: async (delegation) => {
        starts.push(delegation as unknown as Record<string, unknown>);
        return {
          sessionId: `work-${String(delegation.digitalHumanId)}`,
          cwd: delegation.workspacePath!,
        };
      },
    });

    const result = await service.dispatch({
      type: "chat",
      message: "分析并实现这个功能",
      clientMessageId: "client-team",
      preferredProjectPath: "/work/codeshell",
      digitalHumanTeamId: "build-team",
    });

    expect(result).toMatchObject({
      ok: true,
      type: "chat",
      delegations: [
        { digitalHumanId: "researcher", sessionId: "work-researcher" },
        { digitalHumanId: "developer", sessionId: "work-developer" },
      ],
    });
    expect(starts).toEqual([
      expect.objectContaining({
        digitalHumanId: "researcher",
        task: "研究现有实现",
        workspacePath: "/work/codeshell",
      }),
      expect.objectContaining({
        digitalHumanId: "developer",
        task: "独立准备实现方案",
        workspacePath: "/work/codeshell",
      }),
    ]);
    expect(starts[0]?.clientMessageId).not.toBe(starts[1]?.clientMessageId);
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

  test("records a work-memory closure for each launched delegation", async () => {
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
    // One closure recorded, no turnRange (range archival stays dormant).
    expect(closures).toEqual([
      {
        objective: "修复 CodeShell 登录问题",
        outcome: "completed",
        workspace: "/work/codeshell",
        sessionRef: "pet-work-one",
      },
    ]);
    expect(closures[0]).not.toHaveProperty("turnRange");
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
