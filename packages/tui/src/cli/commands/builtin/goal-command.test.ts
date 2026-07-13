import { describe, test, expect } from "bun:test";
import { goalCommand } from "./goal-command.js";
import type { CommandContext } from "../registry.js";

interface Recorded {
  statuses: string[];
  submitted: string[];
  cleared: number;
  deleted: number;
  updates: Array<{ objective?: string; paused?: boolean }>;
}

function makeCtx(over: Partial<CommandContext> = {}): { ctx: CommandContext; rec: Recorded } {
  const rec: Recorded = { statuses: [], submitted: [], cleared: 0, deleted: 0, updates: [] };
  const ctx = {
    addStatus: (m: string) => rec.statuses.push(m),
    submitGoal: (o: string) => rec.submitted.push(o),
    clearGoal: async () => {
      rec.cleared += 1;
      return true;
    },
    deleteGoal: async () => {
      rec.deleted += 1;
      return true;
    },
    updateGoal: async (patch: { objective?: string; paused?: boolean }) => {
      rec.updates.push(patch);
      return true;
    },
    activeGoal: null,
    ...over,
  } as unknown as CommandContext;
  return { ctx, rec };
}

describe("/goal command", () => {
  test("/goal <text> sets the goal and submits it", async () => {
    const { ctx, rec } = makeCtx();
    await goalCommand.execute("完成全部任务", ctx);
    expect(rec.submitted).toEqual(["完成全部任务"]);
    expect(rec.statuses.join("\n")).toContain("目标已设定");
  });

  test("bare /goal with an active goal shows it", async () => {
    const { ctx, rec } = makeCtx({ activeGoal: "做完 X" });
    await goalCommand.execute("", ctx);
    expect(rec.submitted).toHaveLength(0);
    expect(rec.statuses.join("\n")).toContain("做完 X");
    expect(rec.statuses.join("\n")).toContain("已激活");
  });

  test("bare /goal shows paused state", async () => {
    const { ctx, rec } = makeCtx({ activeGoal: "做完 X", activeGoalPaused: true });
    await goalCommand.execute("", ctx);
    expect(rec.statuses.join("\n")).toContain("已暂停");
    expect(rec.statuses.join("\n")).toContain("/goal resume");
  });

  test("bare /goal with no active goal hints how to set one", async () => {
    const { ctx, rec } = makeCtx({ activeGoal: null });
    await goalCommand.execute("", ctx);
    expect(rec.statuses.join("\n")).toContain("没有活跃目标");
  });

  test.each(["delete", "clear", "off", "stop", "none", "reset", "cancel", "CLEAR"])(
    "/goal %s clears the goal",
    async (alias) => {
      const { ctx, rec } = makeCtx();
      await goalCommand.execute(alias, ctx);
      expect(rec.deleted).toBe(1);
      expect(rec.cleared).toBe(0);
      expect(rec.submitted).toHaveLength(0);
    },
  );

  test("/goal clear when nothing active reports so", async () => {
    const { ctx, rec } = makeCtx({
      deleteGoal: async () => false,
    });
    await goalCommand.execute("clear", ctx);
    expect(rec.statuses.join("\n")).toContain("没有活跃目标");
  });

  test("/goal edit updates the same goal", async () => {
    const { ctx, rec } = makeCtx({ activeGoal: "旧目标" });
    await goalCommand.execute("edit 新目标", ctx);
    expect(rec.updates).toEqual([{ objective: "新目标" }]);
    expect(rec.submitted).toHaveLength(0);
    expect(rec.statuses.join("\n")).toContain("目标已编辑");
  });

  test("/goal edit requires objective text", async () => {
    const { ctx, rec } = makeCtx({ activeGoal: "旧目标" });
    await goalCommand.execute("edit", ctx);
    expect(rec.updates).toHaveLength(0);
    expect(rec.statuses.join("\n")).toContain("/goal edit <新目标>");
  });

  test("/goal pause and resume update paused state", async () => {
    const paused = makeCtx({ activeGoal: "目标" });
    await goalCommand.execute("pause", paused.ctx);
    expect(paused.rec.updates).toEqual([{ paused: true }]);

    const resumed = makeCtx({ activeGoal: "目标", activeGoalPaused: true });
    await goalCommand.execute("resume", resumed.ctx);
    expect(resumed.rec.updates).toEqual([{ paused: false }]);

    const kicked = makeCtx({ activeGoal: "目标", activeGoalPaused: false });
    await goalCommand.execute("resume", kicked.ctx);
    expect(kicked.rec.updates).toEqual([{ paused: false }]);
  });

  test.each([
    "pause extra",
    "resume extra",
    "delete extra",
    "clear extra",
    "off extra",
    "stop extra",
    "none extra",
    "reset extra",
    "cancel extra",
  ])("/goal %s only reports usage", async (arg) => {
    const { ctx, rec } = makeCtx({ activeGoal: "目标" });
    await goalCommand.execute(arg, ctx);

    expect(rec.statuses).toHaveLength(1);
    expect(rec.statuses[0]).toContain("用法：/goal");
    expect(rec.updates).toHaveLength(0);
    expect(rec.deleted).toBe(0);
    expect(rec.cleared).toBe(0);
    expect(rec.submitted).toHaveLength(0);
  });

  test("goal controls reject when no goal is active", async () => {
    const { ctx, rec } = makeCtx({ activeGoal: null });
    await goalCommand.execute("pause", ctx);
    await goalCommand.execute("resume", ctx);
    await goalCommand.execute("edit x", ctx);
    expect(rec.updates).toHaveLength(0);
    expect(rec.statuses.every((status) => status.includes("没有活跃目标"))).toBe(true);
  });
});
