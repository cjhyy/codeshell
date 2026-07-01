import { describe, test, expect } from "bun:test";
import { cancelGoalTool, cancelGoalToolDef, CANCEL_GOAL_TOOL_NAME } from "./cancel-goal.js";

describe("cancel_goal tool", () => {
  test("name and required fields enforce the strong-intent guard", () => {
    expect(cancelGoalToolDef.name).toBe(CANCEL_GOAL_TOOL_NAME);
    expect(cancelGoalToolDef.inputSchema.required).toEqual(["confirm", "reason"]);
  });

  test("confirm:true + reason acknowledges cancellation with the reason", async () => {
    const out = await cancelGoalTool({ confirm: true, reason: "用户说不用做了先停" });
    expect(out).toContain("取消");
    expect(out).toContain("用户说不用做了先停");
  });

  test("confirm missing/false is refused (does not acknowledge cancellation)", async () => {
    const out = await cancelGoalTool({ reason: "x" });
    expect(out).toContain("未生效");
    const out2 = await cancelGoalTool({ confirm: false, reason: "x" });
    expect(out2).toContain("未生效");
  });
});
