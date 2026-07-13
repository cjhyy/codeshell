import { describe, expect, test } from "bun:test";
import type { PetPendingDecision, PetSessionProjection } from "../../preload/types";
import { buildPetWorkMap } from "./petWorkMap";

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
  test("groups actionable, optimization and completed work while hiding ambiguous old sessions", () => {
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
        session("optimization", {
          title: "优化 session 加载性能",
          workspaceDisplayName: "desktop",
          lastActivityAt: 3_000,
        }),
        session("follow-up", {
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

    expect(map.counts).toEqual({ unfinished: 3, optimization: 1, completed: 2 });
    expect(map.dismissedCount).toBe(0);
    expect(map.unclassifiedCount).toBe(1);
    expect(map.groups.map((group) => group.workspace)).toEqual(["codeshell", "desktop"]);
    expect(map.groups[0]?.unfinished.map((item) => item.title)).toEqual([
      "修复 Pet 显示",
      "确认发布范围",
      "登录流程",
    ]);
    expect(map.groups[0]?.unfinished[2]?.state).toBe("follow-up");
    expect(map.groups[0]?.unfinished[1]?.navigation).toMatchObject({
      agentSessionId: "needs-user",
      requestId: "request-one",
      routeGeneration: 3,
    });
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

    expect(map.counts).toEqual({ unfinished: 1, optimization: 0, completed: 0 });
    expect(map.dismissedCount).toBe(1);
    expect(map.itemIds.completed).toEqual([]);
    expect(map.groups[0]?.completed).toEqual([]);
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

    expect(map.counts).toEqual({ unfinished: 1, optimization: 0, completed: 0 });
    expect(map.groups.flatMap((group) => group.completed)).toEqual([]);
    expect(map.unclassifiedCount).toBe(0);
  });
});
