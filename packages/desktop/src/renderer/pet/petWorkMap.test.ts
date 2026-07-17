import { describe, expect, test } from "bun:test";
import type { PetPendingDecision, PetSessionProjection } from "../../preload/types";
import { buildPetWorkMap } from "./petWorkMap";
import type { PetWorkGroup, PetWorkspaceWorkGroup } from "./petWorkMap";

function session(
  agentSessionId: string,
  overrides: Partial<PetSessionProjection> = {},
): PetSessionProjection {
  return {
    agentSessionId,
    title: agentSessionId,
    workspaceDisplayName: "codeshell",
    runState: "dormant",
    queueDepth: 0,
    lastActivityAt: 1_000,
    pendingDecisionCount: 0,
    freshness: { source: "disk", observedAt: 2_000, workerState: "reclaimed" },
    ...overrides,
  };
}

describe("buildPetWorkMap", () => {
  test("groups by structured state and keeps ambiguous sessions visible under Other", () => {
    const pending: PetPendingDecision = {
      agentSessionId: "needs-user",
      requestId: "request-one",
      routeGeneration: 3,
      workerGeneration: 2,
      kind: "ask_user",
      title: "需要用户回答",
      createdAt: 4_000,
      status: "pending",
    };
    const map = buildPetWorkMap(
      [
        session("needs-user", { title: "确认发布范围", pendingDecisionCount: 1 }),
        session("running", {
          title: "修复 Pet 显示",
          runState: "running",
          summary: "正在运行测试",
          lastActivityAt: 5_000,
        }),
        session("keyword-optimization", {
          title: "优化 session 加载性能",
          workspaceDisplayName: "desktop",
          lastActivityAt: 3_000,
        }),
        session("keyword-follow-up", {
          title: "登录流程",
          summary: "下一步需要确认异常场景",
          lastActivityAt: 2_800,
        }),
        session("completed", {
          title: "完成 Pet 拖动",
          runState: "terminal",
          terminal: { status: "completed", at: 2_500 },
          summary: "本轮已完成",
          lastActivityAt: 2_500,
        }),
        session("completed-optimization", {
          title: "优化 Pet 启动速度",
          runState: "terminal",
          terminal: { status: "completed", at: 2_400 },
          summary: "处理完成",
          lastActivityAt: 2_400,
        }),
        session("ambiguous-old", { title: "旧对话" }),
      ],
      [pending],
    );

    expect(map.counts).toEqual({
      running: 1,
      pending: 1,
      "follow-up": 0,
      completed: 2,
      other: 3,
    });
    expect(map.dismissedCount).toBe(0);
    expect(map.groups.map((group) => group.workspace)).toEqual(["codeshell", "desktop"]);
    const bucket = (group: PetWorkspaceWorkGroup | undefined, name: PetWorkGroup) =>
      group?.buckets.find((b) => b.group === name)?.items ?? [];
    expect(bucket(map.groups[0], "running").map((item) => item.title)).toEqual(["修复 Pet 显示"]);
    expect(bucket(map.groups[0], "pending").map((item) => item.title)).toEqual(["确认发布范围"]);
    expect(bucket(map.groups[0], "pending")[0]?.navigation).toMatchObject({
      agentSessionId: "needs-user",
      requestId: "request-one",
      routeGeneration: 3,
    });
    expect(bucket(map.groups[0], "other").map((item) => item.title)).toEqual([
      "登录流程",
      "旧对话",
    ]);
    expect(bucket(map.groups[1], "other").map((item) => item.title)).toEqual([
      "优化 session 加载性能",
    ]);
    expect(map.itemIds["follow-up"]).toEqual([]);
  });

  test("filters dismissed rows before counts and display limits are applied", () => {
    const map = buildPetWorkMap(
      [
        session("running", { runState: "running", lastActivityAt: 3_000 }),
        session("completed", {
          runState: "terminal",
          terminal: { status: "completed", at: 2_000 },
          lastActivityAt: 2_000,
        }),
      ],
      [],
      { dismissedIds: new Set(["completed:completed"]) },
    );

    expect(map.counts).toEqual({
      running: 1,
      pending: 0,
      "follow-up": 0,
      completed: 0,
      other: 0,
    });
    expect(map.dismissedCount).toBe(1);
    expect(map.itemIds.completed).toEqual([]);
    expect(map.groups[0]?.buckets.find((b) => b.group === "completed")?.items ?? []).toEqual([]);
  });

  test("does not bring renderer-archived sessions back from the disk projection", () => {
    const map = buildPetWorkMap(
      [
        session("archived-completed", {
          runState: "terminal",
          terminal: { status: "completed", at: 2_000 },
        }),
        session("visible-running", { runState: "running" }),
      ],
      [],
      { excludedSessionIds: new Set(["archived-completed"]) },
    );

    expect(map.counts).toEqual({
      running: 1,
      pending: 0,
      "follow-up": 0,
      completed: 0,
      other: 0,
    });
    expect(
      map.groups.flatMap(
        (group) => group.buckets.find((b) => b.group === "completed")?.items ?? [],
      ),
    ).toEqual([]);
  });
});

describe("buildPetWorkMap structured classification", () => {
  test("groups by structured state and never hides an unclassified session", () => {
    const map = buildPetWorkMap(
      [
        session("run", { runState: "running" }),
        session("queued", { runState: "queued" }),
        session("done", { terminal: { status: "completed", at: 5_000 }, runState: "terminal" }),
        session("followup", {
          runState: "idle",
          terminal: { status: "completed", at: 4_500 },
          summary: "本轮已完成:改好了三个文件",
        }),
        session("mystery", { runState: "idle", summary: undefined, title: "随便聊聊" }),
      ],
      [
        {
          agentSessionId: "decide",
          requestId: "r1",
          workerGeneration: 1,
          kind: "ask_user",
          title: "需要你确认",
          createdAt: 4_000,
          status: "pending",
        },
      ],
    );
    const byId = new Map(
      map.groups.flatMap((g) =>
        g.buckets.flatMap((b) => b.items.map((i) => [i.id, i.group] as const)),
      ),
    );
    expect(byId.get("running:run")).toBe("running");
    expect(byId.get("running:queued")).toBe("running");
    expect(byId.get("pending:decide:r1")).toBe("pending");
    expect(byId.get("follow-up:followup")).toBe("follow-up");
    expect(byId.get("completed:done")).toBe("completed");
    // The genuinely unclassifiable session lands in "other", not hidden.
    expect(byId.get("other:mystery")).toBe("other");
    expect(map.unclassifiedCount).toBe(0);
    expect(map.counts.other).toBe(1);
  });

  test("filters by workspace when workspaceFilter is provided", () => {
    const map = buildPetWorkMap(
      [
        session("a", { workspaceDisplayName: "alpha", runState: "running" }),
        session("b", { workspaceDisplayName: "beta", runState: "running" }),
      ],
      [],
      { workspaceFilter: "alpha" },
    );
    expect(map.groups.map((g) => g.workspace)).toEqual(["alpha"]);
  });

  test("does not classify by title/summary keywords anymore", () => {
    const map = buildPetWorkMap(
      [session("opt", { runState: "idle", summary: "需要重构性能优化" })],
      [],
    );
    // "优化/重构" no longer routes to a special bucket; idle w/o outcome → other.
    const groups = map.groups.flatMap((g) => g.buckets.map((b) => b.group));
    expect(groups).toContain("other");
    expect(groups).not.toContain("optimization");
  });
});
