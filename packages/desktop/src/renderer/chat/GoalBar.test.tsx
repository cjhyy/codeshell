import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatGoalElapsed, GoalBar } from "./GoalBar";
import type { ActiveGoal } from "../types";

const goal: ActiveGoal = {
  objective: "帮我看看设计工作台怎么优化能够对标 figma",
  goalId: "g1",
  revision: 2,
  round: 3,
  paused: false,
  setAtMs: 1_000_000,
};
const at = (ms: number) => () => ms;

describe("formatGoalElapsed", () => {
  test("shows the largest unit with zero-padded tails", () => {
    expect(formatGoalElapsed(45_000)).toBe("45s");
    expect(formatGoalElapsed(3 * 60_000 + 5_000)).toBe("3m 05s");
    expect(formatGoalElapsed((12 * 3600 + 57 * 60 + 34) * 1000)).toBe("12h 57m 34s");
    expect(formatGoalElapsed(-5)).toBe("0s");
  });
});

describe("GoalBar", () => {
  test("a driving Goal shows its target icon, objective and age", () => {
    const html = renderToStaticMarkup(
      <GoalBar goal={goal} busy now={at(1_000_000 + 65_000)} onPausedChange={() => {}} />,
    );
    expect(html).toContain('data-goal-state="running"');
    expect(html).toContain("lucide-target");
    expect(html).toContain(goal.objective);
    expect(html).toContain("1m 05s");
    expect(html).toContain("lucide-pause");
  });

  test("a paused Goal swaps to the pause badge and offers Resume", () => {
    const html = renderToStaticMarkup(
      <GoalBar
        goal={{ ...goal, paused: true }}
        busy={false}
        now={at(1_000_000)}
        onPausedChange={() => {}}
      />,
    );
    expect(html).toContain('data-goal-state="paused"');
    expect(html).toContain("lucide-circle-pause");
    expect(html).not.toContain("lucide-target");
    expect(html).toContain("lucide-play");
  });

  test("controls are disabled while a Goal control is in flight", () => {
    const html = renderToStaticMarkup(
      <GoalBar
        goal={goal}
        busy={false}
        pending
        now={at(0)}
        onPausedChange={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });

  test("an unknown set time hides the age instead of guessing", () => {
    const { setAtMs: _setAtMs, ...withoutTime } = goal;
    const html = renderToStaticMarkup(<GoalBar goal={withoutTime} busy={false} now={at(0)} />);
    expect(html).not.toMatch(/\d+s</);
  });

  test("a Goal waiting on the user shows the question state, unless it is paused", () => {
    const waiting = renderToStaticMarkup(
      <GoalBar goal={{ ...goal, waitingForUser: "允许新增权限吗？" }} busy={false} now={at(0)} />,
    );
    expect(waiting).toContain('data-goal-state="waiting"');
    expect(waiting).toContain("lucide-message-circle-question");
    expect(waiting).toContain("等待你的回复");
    const paused = renderToStaticMarkup(
      <GoalBar
        goal={{ ...goal, paused: true, waitingForUser: "允许新增权限吗？" }}
        busy={false}
        now={at(0)}
      />,
    );
    expect(paused).toContain('data-goal-state="paused"');
  });
});
