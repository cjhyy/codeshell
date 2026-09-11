import { describe, expect, test } from "bun:test";
import type { TaskInfo } from "../types.js";
import { todoWriteTool } from "./builtin/task.js";
import type { ToolContext } from "./context.js";
import { TaskGuard } from "./task-guard.js";

function inProgress(subject: string, id = "1"): TaskInfo {
  return { id, subject, activeForm: `${subject} in progress`, status: "in_progress" };
}

describe("TaskGuard TodoWrite snapshot freshness", () => {
  test("keeps the existing stale and repeated reminder intervals for an unchanged snapshot", () => {
    const tasks = [inProgress("Investigate the issue")];
    const guard = new TaskGuard(() => tasks);

    expect(guard.turnEnded(1)).toBeUndefined();
    expect(guard.turnEnded(2)).toBeUndefined();
    expect(guard.turnEnded(3)).toBeUndefined();
    expect(guard.turnEnded(4)).toContain("in_progress for 3 turns");
    expect(guard.turnEnded(5)).toBeUndefined();
    expect(guard.turnEnded(6)).toBeUndefined();
    expect(guard.turnEnded(7)).toContain("in_progress for 6 turns");
  });

  test("a new task at the same position does not inherit the previous task's stale age", () => {
    let tasks = [inProgress("Investigate the issue")];
    const guard = new TaskGuard(() => tasks);

    guard.turnEnded(1);
    expect(guard.turnEnded(4)).toContain("Investigate the issue");
    tasks = [inProgress("Verify the fix")];

    expect(guard.turnEnded(7)).toBeUndefined();
    expect(guard.turnEnded(8)).toBeUndefined();
    expect(guard.turnEnded(9)).toBeUndefined();
    const reminder = guard.turnEnded(10);
    expect(reminder).toContain('"Verify the fix" (in_progress for 3 turns)');
    expect(reminder).not.toContain("Investigate the issue");
  });

  test("a real TodoWrite refresh acknowledges the current plan even when its content is unchanged", async () => {
    let tasks: TaskInfo[] = [];
    const context = {
      streamCallback(event) {
        if (event.type === "task_update") tasks = event.tasks;
      },
    } as ToolContext;
    const guard = new TaskGuard(() => tasks);
    const args = {
      todos: [
        {
          content: "Wait for the build",
          activeForm: "Waiting for the build",
          status: "in_progress",
        },
      ],
    };

    await todoWriteTool(args, context);
    guard.turnEnded(1);
    expect(guard.turnEnded(4)).toContain("Wait for the build");

    await todoWriteTool(args, context);
    expect(guard.turnEnded(7)).toBeUndefined();
    expect(guard.turnEnded(9)).toBeUndefined();
    expect(guard.turnEnded(10)).toContain("in_progress for 3 turns");
  });

  test("pending and completed tasks never produce stale reminders", () => {
    const tasks: TaskInfo[] = [
      { ...inProgress("Not started"), status: "pending" },
      { ...inProgress("Already done", "2"), status: "completed" },
    ];
    const guard = new TaskGuard(() => tasks);

    expect(guard.turnEnded(1)).toBeUndefined();
    expect(guard.turnEnded(100)).toBeUndefined();
  });

  test("clearing a snapshot or resetting the guard discards old ages", () => {
    const original = [inProgress("Finish the task")];
    let tasks = original;
    const guard = new TaskGuard(() => tasks);
    guard.turnEnded(1);
    expect(guard.turnEnded(4)).toBeDefined();

    tasks = [];
    expect(guard.turnEnded(5)).toBeUndefined();
    tasks = original;
    expect(guard.turnEnded(7)).toBeUndefined();
    expect(guard.turnEnded(10)).toContain("in_progress for 3 turns");

    guard.reset();
    expect(guard.turnEnded(1)).toBeUndefined();
    expect(guard.turnEnded(4)).toContain("in_progress for 3 turns");
  });
});
