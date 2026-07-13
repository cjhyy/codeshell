import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Keep this focused render test isolated from App-level module mocks.
// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { StatusPopover } = await import("./StatusPopover.tsx?goal-controls-render-test");

describe("StatusPopover Goal controls", () => {
  test("renders edit, pause, and delete actions for a running goal", () => {
    const html = renderToStaticMarkup(
      <StatusPopover
        busy={true}
        tasks={null}
        activeGoal={{
          objective: "ship the fix",
          goalId: "goal-a",
          revision: 2,
          round: 3,
          paused: false,
        }}
        onUpdateGoal={() => undefined}
        onGoalPausedChange={() => undefined}
        onDeleteGoal={() => undefined}
      />,
    );

    expect(html).toContain("ship the fix");
    expect(html).toContain("第 3 轮");
    expect(html).toContain('title="编辑目标"');
    expect(html).toContain('title="暂停目标"');
    expect(html).toContain('title="删除目标"');
  });

  test("shows paused state and the resume action", () => {
    const html = renderToStaticMarkup(
      <StatusPopover
        busy={false}
        tasks={null}
        activeGoal={{
          objective: "paused goal",
          goalId: "goal-a",
          revision: 3,
          round: 1,
          paused: true,
        }}
        onGoalPausedChange={() => undefined}
        onClearGoal={() => undefined}
      />,
    );

    expect(html).toContain("已暂停");
    expect(html).toContain('title="恢复目标"');
    // Legacy onClearGoal callers still receive the new delete affordance.
    expect(html).toContain('title="删除目标"');
  });
});
