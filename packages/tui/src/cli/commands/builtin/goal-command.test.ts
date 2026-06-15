import { describe, test, expect } from "bun:test";
import { goalCommand } from "./goal-command.js";
import type { CommandContext } from "../registry.js";

interface Recorded {
  statuses: string[];
  submitted: string[];
  cleared: number;
}

function makeCtx(over: Partial<CommandContext> = {}): { ctx: CommandContext; rec: Recorded } {
  const rec: Recorded = { statuses: [], submitted: [], cleared: 0 };
  const ctx = {
    addStatus: (m: string) => rec.statuses.push(m),
    submitGoal: (o: string) => rec.submitted.push(o),
    clearGoal: async () => {
      rec.cleared += 1;
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
  });

  test("bare /goal with no active goal hints how to set one", async () => {
    const { ctx, rec } = makeCtx({ activeGoal: null });
    await goalCommand.execute("", ctx);
    expect(rec.statuses.join("\n")).toContain("没有活跃目标");
  });

  test.each(["clear", "off", "stop", "none", "reset", "cancel", "CLEAR"])(
    "/goal %s clears the goal",
    async (alias) => {
      const { ctx, rec } = makeCtx();
      await goalCommand.execute(alias, ctx);
      expect(rec.cleared).toBe(1);
      expect(rec.submitted).toHaveLength(0);
    },
  );

  test("/goal clear when nothing active reports so", async () => {
    const { ctx, rec } = makeCtx({
      clearGoal: async () => false,
    });
    await goalCommand.execute("clear", ctx);
    expect(rec.statuses.join("\n")).toContain("没有活跃目标");
  });
});
