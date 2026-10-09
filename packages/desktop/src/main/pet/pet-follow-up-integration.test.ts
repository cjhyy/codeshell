import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PetRegisteredFollowUp } from "@cjhyy/code-shell-pet";
import { sessionSelectorId } from "@cjhyy/code-shell-pet/disclosure";
import { PetDispatchService, type PetWorldContextInput } from "./pet-dispatch-service.js";
import { PetRegisteredFollowUpStore } from "./pet-registered-follow-up-store.js";
import { PetHostActionReceiptStore } from "./pet-host-action-receipts.js";
import { createPetFollowUpHost } from "./pet-follow-up-host.js";
import type { PetLongTaskStore } from "./pet-long-task-store.js";
import type { PetFollowUpService } from "./pet-follow-up-service.js";
import type { DesktopPetProjectionSnapshot } from "./pet-state-aggregator.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "mimi-followup-integration-"));
  roots.push(path);
  return path;
}

function followUp(): PetRegisteredFollowUp {
  return {
    id: `registered-followup-${"a".repeat(24)}`,
    operationKey: "op",
    registrationKey: "b".repeat(64),
    revision: 1,
    title: "核对导出",
    text: "继续核对导出的校验和",
    wakeAt: Date.now() - 1_000,
    catchUpUntil: Date.now() + 60_000,
    timezone: "Asia/Singapore",
    intent: "resume",
    missedPolicy: "fire-once",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    sourceSessionId: "original",
    taskId: "task-original",
    wake: { revision: 1, status: "claimed", claimedAt: 1 },
  };
}

function wakeService(
  options: {
    mode?: "same" | "new" | "duplicate";
    blockLaunch?: boolean;
    registerReminder?: boolean;
  } = {},
) {
  const snapshot: DesktopPetProjectionSnapshot = {
    version: 1,
    generation: 1,
    observedAt: Date.now(),
    workerState: "active",
    pending: [],
    sessions: ["original", "other"].map((id) => ({
      agentSessionId: id,
      title: id,
      runState: "dormant",
      queueDepth: 0,
      pendingDecisionCount: 0,
      lastActivityAt: 1,
      freshness: { source: "disk", observedAt: 1, workerState: "active" },
    })),
  };
  const requests: Record<string, unknown>[] = [];
  const launches: unknown[] = [];
  const recalls: PetWorldContextInput[] = [];
  let hostEffects = 0;
  const service = new PetDispatchService({
    metadata: { ensure: async () => ({ petSessionId: "mimi" }) },
    hostCwd: "/safe/mimi",
    aggregator: {
      getSnapshot: () => snapshot,
      resolveNavigation: async () => ({ status: "not-found" }),
    },
    listWorkspaces: async () => [{ path: "/safe/project", name: "Project" }],
    listReusableSessions: async () =>
      ["original", "other"].map((sessionId) => ({
        sessionId,
        title: sessionId,
        workspacePath: "/safe/project",
        updatedAt: 1,
      })),
    longTasks: {
      context: () => ({
        active: [{ taskId: "task-other", sessionId: "other", objective: "unrelated" }],
        recent: [
          {
            taskId: "task-original",
            sessionId: "original",
            objective: "Verify exports using original checksums",
          },
        ],
      }),
    },
    worldContext: (input) => {
      recalls.push(structuredClone(input));
      return {};
    },
    validateFollowUpContinuation: () => {
      if (options.blockLaunch) throw new Error("原任务已取消");
    },
    hostActions: {
      followUpMutation: async () => {
        hostEffects += 1;
        return {};
      },
    },
    worker: {
      requestWorker: async (_method, params) => {
        requests.push(params);
        if (String(params.clientMessageId).startsWith("pet-launch-receipt-"))
          return { ok: true, result: { text: "原任务已取消，未续办。", reason: "completed" } };
        const profile = params.profileParams as {
          workspaces: Array<{ id: string; name: string }>;
          reusableSessions: Array<{ id: string }>;
        };
        const delegation = {
          workspaceId: profile.workspaces.find((row) => row.name === "Project")!.id,
          objective: "继续核对导出校验和",
          ...(options.mode === "new"
            ? {}
            : {
                reusableSessionId: sessionSelectorId("original"),
                continuationEvidence: {
                  priorThread: "original",
                  reason: "继续核对该导出任务的剩余校验和",
                },
              }),
        };
        return {
          ok: true,
          result: {
            text: "已请求续办",
            reason: "completed",
            extensions: {
              pet: {
                ...(options.registerReminder
                  ? {
                      hostActions: [
                        {
                          kind: "followUpMutation",
                          payload: {
                            action: "register",
                            title: "复查",
                            text: "核对结果",
                            wakeAt: Date.now() + 60_000,
                            timezone: "Asia/Singapore",
                            intent: "remind",
                          },
                        },
                      ],
                    }
                  : {}),
                workDelegations:
                  options.mode === "duplicate" ? [delegation, delegation] : [delegation],
              },
            },
          },
        };
      },
    },
    startWorkSession: async (request) => {
      launches.push(request);
      return {
        sessionId: request.targetSessionId!,
        cwd: "/safe/project",
        taskId: "task-continued",
      };
    },
  });
  return { service, requests, launches, recalls, effects: () => hostEffects };
}

describe("Mimi registered follow-up host integration", () => {
  test("launching work can register a future reminder without prematurely handling the current work", async () => {
    const f = wakeService({ registerReminder: true });
    const result = await f.service.dispatch({
      type: "chat",
      message: "继续核对导出，明天提醒我复查",
    });
    expect(result).toMatchObject({
      ok: true,
      type: "chat",
      hostActions: [{ kind: "followUpMutation", ok: true }],
    });
    expect(f.launches).toHaveLength(1);
    expect(f.effects()).toBe(1);
  });
  test("wake rebuilds grounded context and launches only the original Session once", async () => {
    const f = wakeService();
    expect(await f.service.wakeFollowUp(followUp())).toMatchObject({
      launched: true,
      taskId: "task-continued",
    });
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0]).toMatchObject({ targetSessionId: "original" });
    expect(f.recalls[0]).toMatchObject({
      eventKind: "follow-up-wake",
      message: "继续核对导出的校验和",
      groundedTasks: [
        {
          taskId: "task-original",
          sessionId: "original",
          objective: "Verify exports using original checksums",
        },
      ],
    });
    expect(f.requests[0]).toMatchObject({ injected: true, disableGoal: true });
    expect(
      (
        f.requests[0]!.profileParams as { reusableSessions: Array<{ id: string }> }
      ).reusableSessions.map((row) => row.id),
    ).toEqual([sessionSelectorId("original")]);
    expect((f.requests[0]!.profileParams as { hostActions?: unknown }).hostActions).toBeUndefined();
    expect(f.effects()).toBe(0);
  });
  test.each(["new", "duplicate"] as const)(
    "rejects %s delegation before any launch",
    async (mode) => {
      const f = wakeService({ mode });
      await expect(f.service.wakeFollowUp(followUp())).rejects.toThrow("only its original Session");
      expect(f.launches).toHaveLength(0);
    },
  );
  test("revalidates cancellation after the model decides, before launching", async () => {
    const f = wakeService({ blockLaunch: true });
    const result = await f.service.wakeFollowUp(followUp());
    expect(result.launched).toBe(false);
    expect(result.text).toContain("已取消");
    expect(f.launches).toHaveLength(0);
  });
  test("host slot identity survives register replay after a later cancel", async () => {
    const path = await root();
    const store = new PetRegisteredFollowUpStore(join(path, "follow-ups.json"));
    const host = createPetFollowUpHost({
      store,
      service: {} as PetFollowUpService,
      tasks: { getSnapshot: () => ({ tasks: [] }) } as unknown as PetLongTaskStore,
      sessions: () => [],
    });
    const payload = {
      action: "register",
      title: "提醒",
      text: "提交材料",
      wakeAt: Date.now() + 60_000,
      timezone: "Asia/Singapore",
      intent: "remind",
    };
    const context = { originClientMessageId: "input-one", requestedAt: Date.now(), actionIndex: 0 };
    const first = await host(payload, context);
    const second = await host(payload, { ...context, actionIndex: 1 });
    expect(first.followUpId).not.toBe(second.followUpId);
    await store.cancel(String(first.followUpId), 1);
    expect(await host(payload, context)).toMatchObject({
      followUpId: first.followUpId,
      status: "cancelled",
      revision: 2,
    });
    expect(store.list()).toHaveLength(2);
  });
  test("an interrupted internal registration is reconciled, while external effects remain fenced", async () => {
    const path = await root();
    const receipts = new PetHostActionReceiptStore(join(path, "receipts.json"));
    await receipts.claim("mimi", "input-replay", 0, "followUpMutation");
    let executed = 0;
    let slot: number | undefined;
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "mimi" }) },
      hostCwd: path,
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
      hostActionReceipts: receipts,
      worker: {
        requestWorker: async () => ({
          ok: true,
          result: {
            text: "record",
            extensions: {
              pet: {
                hostActions: [
                  {
                    kind: "followUpMutation",
                    payload: {
                      action: "register",
                      title: "提醒",
                      text: "提交材料",
                      wakeAt: Date.now() + 60_000,
                      timezone: "Asia/Singapore",
                      intent: "remind",
                    },
                  },
                ],
              },
            },
          },
        }),
      },
      hostActions: {
        followUpMutation: async (_payload, context) => {
          executed += 1;
          slot = context?.actionIndex;
          return { action: "register", followUpId: "registered-id" };
        },
      },
    });
    await service.dispatch({
      type: "chat",
      message: "明天提醒我",
      clientMessageId: "input-replay",
    });
    await service.dispatch({
      type: "chat",
      message: "明天提醒我",
      clientMessageId: "input-replay",
    });
    expect(executed).toBe(1);
    expect(slot).toBe(0);
    expect(await receipts.find("mimi", "input-replay", 0)).toMatchObject({
      ok: true,
      phase: "completed",
    });
  });
});
