import { describe, expect, test } from "bun:test";
import { BUILTIN_CHANNEL_CAPABILITIES } from "@cjhyy/code-shell-chat";
import { validatePetRunParams } from "@cjhyy/code-shell-pet";
import { sessionSelectorId } from "@cjhyy/code-shell-pet/disclosure";
import type { DesktopPetProjectionSnapshot } from "./pet-state-aggregator";
import { boundedWorld, PetDispatchService } from "./pet-dispatch-service";

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

const textOnlyChannelCapabilities = {
  inbound: { text: true as const, attachments: [] },
  outbound: {
    text: true as const,
    maxTextLength: 8_000,
    button: "link" as const,
    attachments: [],
  },
};

const richChannelCapabilities = {
  inbound: {
    text: true as const,
    maxTextLength: 8_000,
    attachments: ["image", "file", "audio", "video"] as const,
  },
  outbound: {
    text: true as const,
    button: "native" as const,
    attachments: ["image", "file"] as const,
    maxAttachments: 4,
    maxAttachmentBytes: 10 * 1024 * 1024,
  },
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

  test("boundedWorld keeps the 25 most recently active sessions, newest first", () => {
    const manySessions = Array.from({ length: 30 }, (_, index) => ({
      agentSessionId: `a-${String(index).padStart(2, "0")}`,
      title: `Work ${index}`,
      workspaceDisplayName: "repo-a",
      runState: "idle" as const,
      summary: "空闲",
      queueDepth: 0,
      lastActivityAt: 1_000 + index,
      pendingDecisionCount: 0,
      freshness: { source: "live-event" as const, observedAt: 10, workerState: "active" as const },
    }));
    // The aggregator snapshot is ordered by agentSessionId, so a plain
    // slice(0, 25) would show Mimi an id-alphabetical subset instead of the
    // sessions the user actually touched most recently.
    const world = boundedWorld({ ...snapshot, sessions: manySessions });
    const ids = (world.sessions as Array<{ agentSessionId: string }>).map(
      (session) => session.agentSessionId,
    );
    expect(ids.length).toBe(25);
    expect(ids[0]).toBe("a-29");
    expect(ids).not.toContain("a-04");
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
      sessionsRootDir: "/tmp/x",
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
        source: {
          kind: "im-gateway",
          channel: "telegram",
          target: "owner-chat",
          capabilities: textOnlyChannelCapabilities,
        },
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
    // The host-injected sessions root reaches the worker turn so the Sessions
    // tool becomes visible and reads the right directory.
    expect(
      (request?.params.profileParams as Record<string, unknown> | undefined)?.sessionsRootDir,
    ).toBe("/tmp/x");
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
        source: {
          kind: "im-gateway",
          channel: "wechat",
          target: "owner-conversation",
          capabilities: textOnlyChannelCapabilities,
        },
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
          replyButton: "link",
        },
      },
    ]);
  });

  test("propagates Codex, defaults to CodeShell, and rejects an unknown worker backend", async () => {
    const starts: Array<Record<string, unknown>> = [];
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
          const task = String(params.task);
          return {
            ok: true,
            result: {
              text: "delegated",
              extensions: {
                pet: {
                  workDelegation: {
                    workspaceId: workspace.id,
                    objective: task,
                    ...(task === "use Codex"
                      ? { executionBackend: "codex" }
                      : task === "invalid backend"
                        ? { executionBackend: "claude" }
                        : {}),
                  },
                },
              },
            },
          };
        },
      },
      hostCwd: "/safe/pet",
      listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
      startWorkSession: async (delegation) => {
        starts.push(delegation as unknown as Record<string, unknown>);
        return {
          sessionId: `pet-work-${starts.length}`,
          cwd: delegation.workspacePath!,
        };
      },
    });

    const codex = await service.dispatch({
      type: "chat",
      message: "use Codex",
      clientMessageId: "client-codex",
    });
    expect(codex).toMatchObject({
      ok: true,
      type: "chat",
      delegation: { executionBackend: "codex", sessionId: "pet-work-1" },
    });
    expect(starts[0]).toMatchObject({
      task: "use Codex",
      executionBackend: "codex",
    });

    const codeShell = await service.dispatch({
      type: "chat",
      message: "normal work",
      clientMessageId: "client-codeshell",
    });
    expect(codeShell).toMatchObject({
      ok: true,
      type: "chat",
      delegation: { sessionId: "pet-work-2" },
    });
    expect(codeShell).not.toHaveProperty("delegation.executionBackend");
    expect(starts[1]).not.toHaveProperty("executionBackend");

    const invalid = await service.dispatch({
      type: "chat",
      message: "invalid backend",
      clientMessageId: "client-invalid",
    });
    expect(invalid).toMatchObject({ ok: true, type: "chat", result: { text: "delegated" } });
    expect(invalid).not.toHaveProperty("delegation");
    expect(starts).toHaveLength(2);
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
      summary: "模型处理中",
      resultSummary: "P0 是收口 Pet 外部 Session 接入。",
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
    expect(String(request?.params.petRuntimeContext)).not.toContain('"summary":"模型处理中"');
  });

  test("executes only Mimi's explicit closure attachment request and replays that intent", async () => {
    const imagePath = "/work/codeshell/generated/latest-comic.png";
    let workerCalls = 0;
    let request: { method: string; params: Record<string, unknown> } | undefined;
    let durableDecision:
      | {
          key: string;
          text: string;
          decidedAt: number;
          replyAttachmentPaths?: string[];
        }
      | undefined;
    const executed: Record<string, unknown>[] = [];
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (method, params) => {
          workerCalls += 1;
          request = { method, params };
          return {
            ok: true,
            result: {
              text: "找到了，我来附上图片。",
              extensions: {
                pet: {
                  hostActions: [
                    {
                      kind: "gatewayReply",
                      payload: { text: "找到了，我来附上图片。", attachmentPaths: [imagePath] },
                    },
                  ],
                },
              },
            },
          };
        },
      },
      hostCwd: "/safe/pet",
      replyAttachmentRoots: async () => ["/Users/admin/Downloads"],
      hostActions: {
        gatewayReply: async (payload) => {
          executed.push(payload);
          return {
            text: payload.text,
            attachments: [
              {
                kind: "image",
                name: "latest-comic.png",
                mimeType: "image/png",
                size: 123,
                path: imagePath,
              },
            ],
          };
        },
      },
      longTasks: {
        context: () => ({ version: 1, active: [], recent: [] }),
        recordClosureDecision: async (_taskId, decision) => {
          durableDecision = { ...decision, decidedAt: 301 };
          return { closureDecision: durableDecision } as never;
        },
      },
    });
    const task = {
      schemaVersion: 1 as const,
      id: "pet-task-found-image",
      originClientMessageId: "im:wechat:image",
      objective: "找到最近生成的小狗漫画并发给我",
      workspacePath: "/work/codeshell",
      sessionId: "pet-work-found-image",
      completionTarget: {
        kind: "im-gateway" as const,
        channel: "wechat",
        target: "owner-conversation",
        replyButton: "link" as const,
        replyAttachmentKinds: ["image", "file"] as const,
      },
      status: "completed" as const,
      phase: "finalizing" as const,
      attempt: 1,
      revision: 3,
      createdAt: 100,
      updatedAt: 300,
      completedAt: 300,
      resultSummary: `候选图片：${imagePath}`,
      artifacts: [],
      events: [],
    };

    const report = await service.reportLongTaskClosure(task);

    expect((request?.params.profileParams as Record<string, unknown>).hostActions).toEqual([
      "gatewayReply",
    ]);
    expect(String(request?.params.petRuntimeContext)).toContain(
      '"currentMessageSource":{"kind":"im-gateway","channel":"wechat"}',
    );
    expect(String(request?.params.petRuntimeContext)).toContain(
      '"currentMessageCapabilities":{"gatewayReply":{"tool":"GatewayReply","destination":"current originating IM conversation","allowedRoots":["/safe/pet","/Users/admin/Downloads"]}}',
    );
    expect((request?.params.profileParams as Record<string, unknown>).gateway).toBeUndefined();
    expect(String(request?.params.task)).toContain("MUST call GatewayReply exactly once");
    expect(String(request?.params.task)).toContain(
      "Never say you lack the declared Gateway capability",
    );
    expect(String(request?.params.task)).toContain("substitute a localhost link");
    expect(durableDecision?.replyAttachmentPaths).toEqual([imagePath]);
    expect(report).toMatchObject({
      text: "找到了，我来附上图片。",
      continued: false,
      hostActions: [
        {
          kind: "gatewayReply",
          payload: { text: "找到了，我来附上图片。", attachmentPaths: [imagePath] },
          ok: true,
          result: {
            text: "找到了，我来附上图片。",
            attachments: [{ kind: "image", path: imagePath }],
          },
        },
      ],
    });

    const replay = await service.reportLongTaskClosure({
      ...task,
      closureDecision: durableDecision as never,
    });
    expect(replay).toMatchObject({ continued: false, hostActions: [{ ok: true }] });
    expect(workerCalls).toBe(1);
    expect(executed).toEqual([
      { text: "找到了，我来附上图片。", attachmentPaths: [imagePath] },
      { text: "找到了，我来附上图片。", attachmentPaths: [imagePath] },
    ]);
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

  test("chat resolves an off-list reusable selector through the resolver and reuses it", async () => {
    const starts: unknown[] = [];
    const resolverCalls: string[] = [];
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
              text: "继续那个旧会话。",
              extensions: {
                pet: {
                  workDelegation: {
                    workspaceId: workspace.id,
                    // Mimi found this Session via the read-only Sessions tool;
                    // it is not in the turn's injected reusable set.
                    reusableSessionId: sessionSelectorId("old-session"),
                    objective: "继续旧会话的修复工作",
                  },
                },
              },
            },
          };
        },
      },
      hostCwd: "/safe/pet",
      listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
      resolveReusableSessionBySelector: async (selectorId) => {
        resolverCalls.push(selectorId);
        return {
          sessionId: "old-session",
          workspacePath: "/work/codeshell",
          title: "old",
          updatedAt: 1,
        };
      },
      startWorkSession: async (delegation) => {
        starts.push(delegation);
        return { sessionId: delegation.targetSessionId!, cwd: delegation.workspacePath! };
      },
    });

    expect(
      await service.dispatch({
        type: "chat",
        message: "继续那个旧会话",
        clientMessageId: "client-resolver",
      }),
    ).toMatchObject({
      ok: true,
      type: "chat",
      delegation: { sessionId: "old-session", reusedSession: true },
    });
    expect(resolverCalls).toEqual([sessionSelectorId("old-session")]);
    expect(starts).toEqual([
      expect.objectContaining({
        targetSessionId: "old-session",
        workspacePath: "/work/codeshell",
        task: "继续旧会话的修复工作",
      }),
    ]);
  });

  test("chat still rejects when the resolver misses, throws, or returns an ineligible session", async () => {
    let started = false;
    const makeService = (
      resolve: (selectorId: string) => Promise<{
        sessionId: string;
        workspacePath: string | null;
        title: string;
        updatedAt: number;
      } | null>,
    ) =>
      new PetDispatchService({
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
                      reusableSessionId: sessionSelectorId("old-session"),
                      objective: "do not run this",
                    },
                  },
                },
              },
            };
          },
        },
        hostCwd: "/safe/pet",
        listWorkspaces: async () => [{ path: "/work/codeshell", name: "CodeShell" }],
        resolveReusableSessionBySelector: resolve,
        startWorkSession: async () => {
          started = true;
          return { sessionId: "bad", cwd: "/work/codeshell" };
        },
      });

    // (a) The resolver finds nothing on disk: same fail-closed rejection.
    expect(
      await makeService(async () => null).dispatch({ type: "chat", message: "继续旧会话" }),
    ).toEqual({
      ok: false,
      code: "worker-error",
      message: "Mimi returned a Session outside the host-provided reusable set",
    });

    // (b) The resolved Session lives in a different workspace than the one
    // Mimi selected: the candidate must not silently switch workspaces.
    expect(
      await makeService(async () => ({
        sessionId: "old-session",
        workspacePath: "/repo/b",
        title: "old",
        updatedAt: 1,
      })).dispatch({ type: "chat", message: "继续旧会话" }),
    ).toEqual({
      ok: false,
      code: "worker-error",
      message: "Mimi returned a Session outside the host-provided reusable set",
    });

    // (c) A resolver crash is swallowed into the same fail-closed rejection.
    expect(
      await makeService(async () => {
        throw new Error("disk exploded");
      }).dispatch({ type: "chat", message: "继续旧会话" }),
    ).toEqual({
      ok: false,
      code: "worker-error",
      message: "Mimi returned a Session outside the host-provided reusable set",
    });

    // (d) The resolver must not hand Mimi her own manager session.
    expect(
      await makeService(async () => ({
        sessionId: "pet-one",
        workspacePath: "/work/codeshell",
        title: "mimi herself",
        updatedAt: 1,
      })).dispatch({ type: "chat", message: "继续旧会话" }),
    ).toEqual({
      ok: false,
      code: "worker-error",
      message: "Mimi returned a Session outside the host-provided reusable set",
    });

    // (e) A busy session (running/queued/pending decision — "work-a" is
    // running in the snapshot) stays unavailable even when resolved.
    expect(
      await makeService(async () => ({
        sessionId: "work-a",
        workspacePath: "/work/codeshell",
        title: "busy work",
        updatedAt: 1,
      })).dispatch({ type: "chat", message: "继续旧会话" }),
    ).toEqual({
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

  test("declares host-action kinds for IM and keeps world extras available", async () => {
    let params: Record<string, unknown> | undefined;
    const makeService = (withHostActions: boolean) =>
      new PetDispatchService({
        metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
        aggregator: {
          getSnapshot: () => snapshot,
          resolveNavigation: async () => ({ status: "not-found" }),
        },
        worker: {
          requestWorker: async (_method, requestParams) => {
            params = requestParams;
            return { ok: true, result: { text: "ok" } };
          },
        },
        hostCwd: "/safe/pet",
        ...(withHostActions
          ? {
              hostActions: {
                mobileRemote: async () => ({}),
                memory: async () => ({}),
              },
              worldContext: async () => ({
                memories: [{ id: "mem-1", text: "喜欢暗色主题" }],
                mobileRemote: { running: true },
              }),
            }
          : {}),
      });

    await makeService(true).dispatch({ type: "chat", message: "desktop" });
    expect((params?.profileParams as Record<string, unknown>).hostActions).toBeUndefined();

    await makeService(true).dispatch({
      type: "chat",
      message: "im",
      source: {
        kind: "im-gateway",
        channel: "telegram",
        target: "owner",
        capabilities: textOnlyChannelCapabilities,
      },
    });
    expect((params?.profileParams as Record<string, unknown>).hostActions).toEqual([
      "memory",
      "mobileRemote",
    ]);
    const world = JSON.parse(
      (params?.profileParams as Record<string, string>).runtimeContext,
    ) as Record<string, unknown>;
    expect(world.memories).toEqual([{ id: "mem-1", text: "喜欢暗色主题" }]);
    expect(world.mobileRemote).toEqual({ running: true });

    await makeService(false).dispatch({ type: "chat", message: "hi" });
    expect((params?.profileParams as Record<string, unknown>).hostActions).toBeUndefined();
  });

  test("bounds maximum Mimi memory state inside the final Pet protocol runtime JSON", async () => {
    let params: Record<string, unknown> | undefined;
    const memories = Array.from({ length: 24 }, (_, index) => ({
      id: `mem-${index}`,
      text: `${index}:`.padEnd(2_000, String(index % 10)),
      source: index % 2 === 0 ? "user" : "mimi",
      updatedAt: 10_000 - index,
    }));
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (_method, requestParams) => {
          params = requestParams;
          const validationError = validatePetRunParams(requestParams);
          return validationError
            ? { ok: false as const, message: validationError }
            : { ok: true as const, result: { text: "accepted" } };
        },
      },
      hostCwd: "/safe/pet",
      worldContext: async () => ({
        memories,
        mobileRemote: { running: true },
        oversizedExtra: "x".repeat(50_000),
      }),
    });

    expect(
      await service.dispatch({
        type: "chat",
        message: "remember what matters",
        source: {
          kind: "im-gateway",
          channel: "telegram",
          target: "owner",
          capabilities: textOnlyChannelCapabilities,
        },
      }),
    ).toMatchObject({ ok: true, type: "chat" });
    const runtimeContext = String(
      (params?.profileParams as Record<string, unknown>).runtimeContext,
    );
    expect(runtimeContext.length).toBeLessThanOrEqual(32_768);
    expect(params?.petRuntimeContext).toBe(runtimeContext);
    expect(validatePetRunParams(params ?? {})).toBeNull();
    const world = JSON.parse(runtimeContext) as { memories?: typeof memories };
    expect(world.memories?.[0]).toEqual(memories[0]);
    expect(world.memories?.length).toBeGreaterThan(1);
    expect(world.memories?.length).toBeLessThan(24);
  });

  test("exposes progressive Gateway discovery plus one exact current-route GatewayReply", async () => {
    const declared: unknown[] = [];
    const contexts: Array<Record<string, unknown>> = [];
    const profiles: Array<Record<string, unknown>> = [];
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (_method, requestParams) => {
          const profile = requestParams.profileParams as Record<string, unknown>;
          profiles.push(profile);
          declared.push(profile.hostActions);
          contexts.push(JSON.parse(String(profile.runtimeContext)) as Record<string, unknown>);
          return { ok: true, result: { text: "ok" } };
        },
      },
      hostCwd: "/safe/pet",
      replyAttachmentRoots: async () => ["/Users/admin/Downloads"],
      hostActions: {
        gatewayReply: async (payload) => ({ text: payload.text }),
      },
    });

    await service.dispatch({ type: "chat", message: "desktop" });
    const enabledChannels = Object.entries(BUILTIN_CHANNEL_CAPABILITIES).map(
      ([channel, capabilities]) => ({ channel, capabilities }),
    );
    for (const { channel, capabilities } of enabledChannels) {
      await service.dispatch({
        type: "chat",
        message: channel,
        source: {
          kind: "im-gateway",
          channel,
          target: "owner",
          capabilities,
          channels: enabledChannels,
        },
      });
    }

    expect(declared).toEqual([
      undefined,
      ...Object.keys(BUILTIN_CHANNEL_CAPABILITIES).map(() => ["gatewayReply"]),
    ]);
    expect(contexts[0]).not.toHaveProperty("currentMessageCapabilities");
    const channelEntries = Object.entries(BUILTIN_CHANNEL_CAPABILITIES);
    for (const [index, [channel, capabilities]] of channelEntries.entries()) {
      expect(contexts[index + 1]?.currentMessageCapabilities).toEqual({
        gateway: {
          tool: "Gateway",
          discovery: ["search", "describe"],
        },
        gatewayReply: {
          tool: "GatewayReply",
          destination: "current IM conversation",
          allowedRoots: ["/safe/pet", "/Users/admin/Downloads"],
        },
      });
      expect(profiles[index + 1]?.gatewayReply).toEqual({
        button: capabilities.outbound.button,
        attachments: capabilities.outbound.attachments,
        maxTextLength: capabilities.outbound.maxTextLength,
        maxAttachments: capabilities.outbound.maxAttachments ?? 4,
        maxAttachmentBytes: capabilities.outbound.maxAttachmentBytes ?? 10 * 1024 * 1024,
      });
      expect(profiles[index + 1]?.gateway).toMatchObject({
        currentChannel: channel,
        channels: enabledChannels,
      });
      const validationError = validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: profiles[index + 1],
      });
      if (validationError) {
        throw new Error(
          `${channel}: ${validationError}; ${JSON.stringify(profiles[index + 1]?.gatewayReply)}`,
        );
      }
    }
    const whatsappContext =
      contexts[channelEntries.findIndex(([channel]) => channel === "whatsapp") + 1];
    expect(whatsappContext?.currentMessageCapabilities).toEqual({
      gateway: {
        tool: "Gateway",
        discovery: ["search", "describe"],
      },
      gatewayReply: {
        tool: "GatewayReply",
        destination: "current IM conversation",
        allowedRoots: ["/safe/pet", "/Users/admin/Downloads"],
      },
    });
    const telegramContext =
      contexts[channelEntries.findIndex(([channel]) => channel === "telegram") + 1];
    expect(telegramContext?.currentMessageCapabilities).toEqual({
      gateway: {
        tool: "Gateway",
        discovery: ["search", "describe"],
      },
      gatewayReply: {
        tool: "GatewayReply",
        destination: "current IM conversation",
        allowedRoots: ["/safe/pet", "/Users/admin/Downloads"],
      },
    });
    const telegramProfile =
      profiles[channelEntries.findIndex(([channel]) => channel === "telegram") + 1];
    expect(telegramProfile?.gatewayReply).toMatchObject({
      button: "native",
      attachments: ["image", "file", "audio", "video"],
    });
  });

  test("executes GatewayReply as one capability-gated text, button, and attachment tool", async () => {
    const imagePath = "/safe/pet/result.png";
    const executed: Record<string, unknown>[] = [];
    let includeAttachment = true;
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
            text: "model compatibility fallback",
            extensions: {
              pet: {
                hostActions: [
                  {
                    kind: "gatewayReply",
                    payload: {
                      text: "完整回复",
                      button: { text: "打开", url: "https://example.test/result" },
                      ...(includeAttachment ? { attachmentPaths: [imagePath] } : {}),
                    },
                  },
                ],
              },
            },
          },
        }),
      },
      hostCwd: "/safe/pet",
      hostActions: {
        gatewayReply: async (payload) => {
          executed.push(payload);
          return {
            text: payload.text,
            button: payload.button,
            ...(Array.isArray(payload.attachmentPaths)
              ? {
                  attachments: [
                    {
                      kind: "image",
                      name: "result.png",
                      mimeType: "image/png",
                      size: 123,
                      path: imagePath,
                    },
                  ],
                }
              : {}),
          };
        },
      },
    });

    const rich = await service.dispatch({
      type: "chat",
      message: "给我结果",
      source: {
        kind: "im-gateway",
        channel: "telegram",
        target: "owner",
        capabilities: richChannelCapabilities,
      },
    });
    expect(rich).toMatchObject({
      ok: true,
      hostActions: [
        {
          kind: "gatewayReply",
          ok: true,
          result: {
            text: "完整回复",
            button: { text: "打开", url: "https://example.test/result" },
            attachments: [{ kind: "image", path: imagePath }],
          },
        },
      ],
    });

    const textOnly = await service.dispatch({
      type: "chat",
      message: "给我结果",
      source: {
        kind: "im-gateway",
        channel: "whatsapp",
        target: "owner",
        capabilities: textOnlyChannelCapabilities,
      },
    });
    expect(textOnly).toMatchObject({
      ok: true,
      hostActions: [{ kind: "gatewayReply", ok: false, error: "Gateway 渠道不支持所请求的附件" }],
    });
    expect(executed).toHaveLength(1);

    includeAttachment = false;
    const textAndButton = await service.dispatch({
      type: "chat",
      message: "只发链接",
      source: {
        kind: "im-gateway",
        channel: "whatsapp",
        target: "owner",
        capabilities: textOnlyChannelCapabilities,
      },
    });
    expect(textAndButton).toMatchObject({
      ok: true,
      hostActions: [{ kind: "gatewayReply", ok: true, result: { text: "完整回复" } }],
    });
    expect(executed).toHaveLength(2);
  });

  test("executes reported host actions after the turn and returns their outcomes", async () => {
    const executed: Array<{ kind: string; payload: Record<string, unknown> }> = [];
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
            text: "我去打开手机遥控并记住这一点。",
            extensions: {
              pet: {
                hostActions: [
                  { kind: "mobileRemote", payload: { action: "open" } },
                  { kind: "memory", payload: { action: "remember", text: "喜欢暗色" } },
                ],
              },
            },
          },
        }),
      },
      hostCwd: "/safe/pet",
      hostActions: {
        mobileRemote: async (payload) => {
          executed.push({ kind: "mobileRemote", payload });
          return {
            action: payload.action,
            url: "https://demo.trycloudflare.com",
            pairingUrl: "https://demo.trycloudflare.com/mobile?pairing=x",
            expiresAt: 99,
          };
        },
        memory: async (payload) => {
          executed.push({ kind: "memory", payload });
          return { action: payload.action, id: "mem-9" };
        },
      },
    });

    expect(
      await service.dispatch({
        type: "chat",
        message: "给我手机遥控",
        source: {
          kind: "im-gateway",
          channel: "telegram",
          target: "owner",
          capabilities: textOnlyChannelCapabilities,
        },
      }),
    ).toMatchObject({
      ok: true,
      type: "chat",
      hostActions: [
        {
          kind: "mobileRemote",
          ok: true,
          result: { action: "open", url: "https://demo.trycloudflare.com", expiresAt: 99 },
        },
        { kind: "memory", ok: true, result: { action: "remember", id: "mem-9" } },
      ],
    });
    expect(executed).toHaveLength(2);
  });

  test("drops the whole host-action envelope when any entry is malformed or duplicated", async () => {
    const envelopes: unknown[][] = [
      [{ kind: "mobileRemote", payload: { action: "destroy" } }],
      [{ kind: "memory", payload: { action: "forget", memoryId: "" } }],
      [{ kind: "unknown", payload: {} }],
      [
        { kind: "mobileRemote", payload: { action: "open" } },
        { kind: "mobileRemote", payload: { action: "close" } },
      ],
      [
        { kind: "mobileRemote", payload: { action: "open" } },
        { kind: "memory", payload: { action: "remember", text: "ok" }, extra: true },
      ],
    ];
    let envelopeIndex = 0;
    const executed: string[] = [];
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
            text: "ok",
            extensions: { pet: { hostActions: envelopes[envelopeIndex++] } },
          },
        }),
      },
      hostCwd: "/safe/pet",
      hostActions: {
        mobileRemote: async () => {
          executed.push("mobileRemote");
          return {};
        },
        memory: async () => {
          executed.push("memory");
          return {};
        },
      },
    });

    for (const _envelope of envelopes) {
      const result = await service.dispatch({
        type: "chat",
        message: "host action",
        source: {
          kind: "im-gateway",
          channel: "telegram",
          target: "owner",
          capabilities: textOnlyChannelCapabilities,
        },
      });
      expect(result).not.toHaveProperty("hostActions");
    }
    expect(executed).toEqual([]);
  });

  test("continues executing later host actions after one executor fails", async () => {
    const executed: string[] = [];
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
            text: "ok",
            extensions: {
              pet: {
                hostActions: [
                  { kind: "memory", payload: { action: "remember", text: "prefers dark" } },
                  {
                    kind: "longTaskControl",
                    payload: { taskId: "pet-task-1", action: "cancel" },
                  },
                ],
              },
            },
          },
        }),
      },
      hostCwd: "/safe/pet",
      hostActions: {
        memory: async () => {
          executed.push("memory");
          throw new Error("disk full");
        },
        longTaskControl: async () => {
          executed.push("longTaskControl");
          return { action: "cancel" };
        },
      },
    });

    expect(
      await service.dispatch({
        type: "chat",
        message: "remember and cancel",
        source: {
          kind: "im-gateway",
          channel: "telegram",
          target: "owner",
          capabilities: textOnlyChannelCapabilities,
        },
      }),
    ).toMatchObject({
      ok: true,
      type: "chat",
      hostActions: [
        { kind: "memory", ok: false, error: "disk full" },
        { kind: "longTaskControl", ok: true, result: { action: "cancel" } },
      ],
    });
    expect(executed).toEqual(["memory", "longTaskControl"]);
  });

  test("keeps the chat reply when a host action fails or its kind is not wired", async () => {
    const makeService = (withHostActions: boolean) =>
      new PetDispatchService({
        metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
        aggregator: {
          getSnapshot: () => snapshot,
          resolveNavigation: async () => ({ status: "not-found" }),
        },
        worker: {
          requestWorker: async () => ({
            ok: true,
            result: {
              text: "我去关闭隧道。",
              extensions: {
                pet: { hostActions: [{ kind: "mobileRemote", payload: { action: "close" } }] },
              },
            },
          }),
        },
        hostCwd: "/safe/pet",
        ...(withHostActions
          ? {
              hostActions: {
                mobileRemote: async () => {
                  throw new Error("cloudflared exited");
                },
              },
            }
          : {}),
      });

    expect(
      await makeService(true).dispatch({
        type: "chat",
        message: "关闭隧道",
        source: {
          kind: "im-gateway",
          channel: "telegram",
          target: "owner",
          capabilities: textOnlyChannelCapabilities,
        },
      }),
    ).toMatchObject({
      ok: true,
      type: "chat",
      hostActions: [{ kind: "mobileRemote", ok: false, error: "cloudflared exited" }],
    });
    const withoutRegistry = await makeService(false).dispatch({
      type: "chat",
      message: "关闭隧道",
    });
    expect(withoutRegistry).toMatchObject({ ok: true, type: "chat" });
    expect(withoutRegistry).not.toHaveProperty("hostActions");
  });

  test("routes an explicit Work Session report through one injected Mimi GatewayReply", async () => {
    const imagePath = "/Users/admin/Downloads/pet-comic-v2.png";
    let request: { method: string; params: Record<string, unknown> } | undefined;
    const executed: Record<string, unknown>[] = [];
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (method, params) => {
          request = { method, params };
          return {
            ok: true,
            result: {
              text: "internal acknowledgement",
              extensions: {
                pet: {
                  hostActions: [
                    {
                      kind: "gatewayReply",
                      payload: {
                        text: "漫画已经生成，我发给你了。",
                        attachmentPaths: [imagePath],
                      },
                    },
                  ],
                },
              },
            },
          };
        },
      },
      hostCwd: "/safe/pet",
      replyAttachmentRoots: async () => ["/Users/admin/Downloads"],
      hostActions: {
        gatewayReply: async (payload) => {
          executed.push(payload);
          return {
            text: payload.text,
            attachments: [
              {
                kind: "image",
                name: "pet-comic-v2.png",
                mimeType: "image/png",
                size: 123,
                path: imagePath,
              },
            ],
          };
        },
      },
    });
    const task = {
      id: "pet-task-report",
      objective: "生成漫画并通过微信发回",
      sessionId: "pet-work-806bb2404fc122889366de82",
      completionTarget: {
        kind: "im-gateway",
        channel: "wechat",
        target: "owner-conversation",
        replyButton: "link",
        replyAttachmentKinds: ["image"],
      },
    } as never;

    const result = await service.reportSessionMessage(
      {
        sourceSessionId: "pet-work-806bb2404fc122889366de82",
        reportId: "a".repeat(32),
        message: "图片已生成",
        attachmentPaths: [imagePath],
      },
      task,
    );

    expect(request?.method).toBe("agent/run");
    expect(request?.params).toMatchObject({
      sessionId: "pet-one",
      behaviorMode: "pet",
      kind: "pet",
      injected: true,
      requireExisting: true,
      clientMessageId: `pet-report:${"a".repeat(32)}`,
    });
    expect(String(request?.params.task)).toContain("call GatewayReply exactly once");
    expect(String(request?.params.task)).toContain("Do not search for a Mimi Session id");
    expect(String(request?.params.petRuntimeContext)).toContain(
      '"sessionReport":{"reportId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    );
    expect(String(request?.params.petRuntimeContext)).not.toContain("owner-conversation");
    expect(executed).toEqual([
      {
        text: "漫画已经生成，我发给你了。",
        attachmentPaths: [imagePath],
      },
    ]);
    expect(result).toMatchObject({
      text: "漫画已经生成，我发给你了。",
      routedToOrigin: true,
      hostActions: [
        {
          kind: "gatewayReply",
          ok: true,
          result: { attachments: [{ kind: "image", path: imagePath }] },
        },
      ],
    });
  });

  test("delivers a report from an ordinary Session to Mimi without inventing an IM route", async () => {
    let request: { method: string; params: Record<string, unknown> } | undefined;
    let executed = 0;
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (method, params) => {
          request = { method, params };
          return {
            ok: true,
            result: { text: "收到普通 Session 的报告，我会继续跟进。" },
          };
        },
      },
      hostCwd: "/safe/pet",
      hostActions: {
        gatewayReply: async () => {
          executed += 1;
          return { text: "must not run" };
        },
      },
    });

    const result = await service.reportSessionMessage({
      sourceSessionId: "ordinary-session",
      reportId: "b".repeat(32),
      message: "代码审查完成，没有阻塞项。",
    });

    expect(request?.method).toBe("agent/run");
    expect(String(request?.params.task)).toContain("No external reply route is attached");
    expect(String(request?.params.petRuntimeContext)).toContain(
      '"sessionReport":{"reportId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sourceSessionId":"ordinary-session"',
    );
    expect(String(request?.params.petRuntimeContext)).not.toContain("currentMessageSource");
    expect(request?.params.profileParams).not.toHaveProperty("hostActions");
    expect(executed).toBe(0);
    expect(result).toEqual({
      text: "收到普通 Session 的报告，我会继续跟进。",
      routedToOrigin: false,
    });
  });

  test("does not execute a reported host action for a desktop Pet turn", async () => {
    let executed = 0;
    let declared: unknown;
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
      aggregator: {
        getSnapshot: () => snapshot,
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      worker: {
        requestWorker: async (_method, requestParams) => {
          declared = (requestParams.profileParams as Record<string, unknown>).hostActions;
          return {
            ok: true,
            result: {
              text: "request accepted",
              extensions: {
                pet: { hostActions: [{ kind: "mobileRemote", payload: { action: "open" } }] },
              },
            },
          };
        },
      },
      hostCwd: "/safe/pet",
      hostActions: {
        mobileRemote: async () => {
          executed += 1;
          return { action: "open" };
        },
      },
    });

    const result = await service.dispatch({ type: "chat", message: "desktop request" });
    expect(declared).toBeUndefined();
    expect(executed).toBe(0);
    expect(result).not.toHaveProperty("hostActions");
  });
});
