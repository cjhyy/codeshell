import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatWaitDuration, GoalProgressView } from "./GoalProgressView";
import type { GoalProgressMessage } from "../types";

const base: GoalProgressMessage = {
  kind: "goal_progress",
  id: "goal-1",
  goalId: "g1",
  status: "not_met",
  round: 14,
};

describe("GoalProgressView", () => {
  test("formats waits at minute precision", () => {
    expect(formatWaitDuration(45_000)).toBe("45s");
    expect(formatWaitDuration(20 * 60_000 + 59_000)).toBe("20m");
    expect(formatWaitDuration(125 * 60_000)).toBe("2h 05m");
  });

  test("a background wait is not shown as an unmet verdict", () => {
    const ended = renderToStaticMarkup(
      <GoalProgressView
        message={{
          ...base,
          waiting: {
            sinceMs: 0,
            tasks: [{ kind: "job", label: "DriveAgent(codex): 修样式" }],
          },
          waitEndedAtMs: 20 * 60_000,
        }}
      />,
    );
    expect(ended).toContain('data-goal-wait="ended"');
    expect(ended).toContain("等了后台任务 20m · 第 14 轮");
    expect(ended).toContain("DriveAgent(codex): 修样式");
    expect(ended).not.toContain("目标未达成");

    const open = renderToStaticMarkup(
      <GoalProgressView
        message={{
          ...base,
          waiting: {
            sinceMs: Date.now() - 3 * 60_000,
            tasks: [
              { kind: "job", label: "a" },
              { kind: "job", label: "b" },
            ],
          },
        }}
      />,
    );
    expect(open).toContain('data-goal-wait="open"');
    expect(open).toContain("等待后台任务 · 第 14 轮 · 已等 3m");
    expect(open).toContain("2 个后台任务");
  });

  test("a question keeps one short record: no text while open, one line once closed", () => {
    const question = "发 rc 还是正式版？" + "详细背景。".repeat(40);
    const open = renderToStaticMarkup(
      <GoalProgressView
        message={{ ...base, gaps: `等待你的回复：${question}`, waitingForUser: question }}
      />,
    );
    expect(open).toContain('data-goal-question="open"');
    expect(open).toContain("等待你的回复 · 第 14 轮");
    // The question is on screen once, above the composer; not again here.
    expect(open).not.toContain("发 rc");
    expect(open).not.toContain("目标未达成");

    const closed = renderToStaticMarkup(
      <GoalProgressView message={{ ...base, waitingForUser: question, questionClosed: true }} />,
    );
    expect(closed).toContain('data-goal-question="closed"');
    expect(closed).toContain("已提问 · 第 14 轮");
    expect(closed).toContain("truncate");
    expect(closed).toContain(`title="${question}"`);
  });

  test("an unmet verdict keeps its goal-level round", () => {
    const html = renderToStaticMarkup(<GoalProgressView message={{ ...base, gaps: "还差验收" }} />);
    expect(html).toContain("目标未达成 · 第 14 轮");
    expect(html).not.toContain("data-goal-wait");
  });
});
