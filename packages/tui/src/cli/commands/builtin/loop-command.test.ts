import { describe, expect, test } from "bun:test";
import type { CommandContext } from "../registry.js";
import { buildLoopCommandPrompt, loopCommand } from "./loop-command.js";

describe("/loop command", () => {
  test("builds a skill-backed prompt that explicitly bypasses Goal", () => {
    const prompt = buildLoopCommandPrompt("night 修好测试");
    expect(prompt).toContain("loop-mode");
    expect(prompt).toContain("Original command: /loop night 修好测试");
    expect(prompt).toContain("not Goal mode");
  });

  test("submits the expanded prompt but displays the original command", async () => {
    const calls: unknown[][] = [];
    const ctx = {
      addStatus: () => undefined,
      submitPrompt: (...args: unknown[]) => {
        calls.push(args);
        return true;
      },
    } as unknown as CommandContext;
    await loopCommand.execute("修好所有失败测试", ctx);
    expect(calls[0]?.[1]).toBe("/loop 修好所有失败测试");
    expect(calls[0]?.[2]).toEqual({ disableGoal: true });
  });
});
