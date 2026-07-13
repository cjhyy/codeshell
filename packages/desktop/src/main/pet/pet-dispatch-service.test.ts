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
    });

    expect(
      await service.dispatch({
        type: "chat",
        message: "What is running?",
        clientMessageId: "im:one",
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
