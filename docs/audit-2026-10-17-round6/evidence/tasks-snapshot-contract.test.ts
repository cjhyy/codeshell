import { describe, expect, test } from "bun:test";
import type { StreamEvent, TaskInfo, TranscriptEvent } from "../../../packages/core/src/types.js";
import { todoWriteTool, readLastTodoSnapshot } from "../../../packages/core/src/tool-system/builtin/task.js";
import { TaskGuard } from "../../../packages/core/src/tool-system/task-guard.js";
import { buildWrappedOnStream } from "../../../packages/core/src/engine/run-stream.js";

// These imports reach only local source. No Engine, provider, transport, process,
// operator HOME, or persisted Session is created by this audit fixture.
const todo = (content: string, status = "pending", activeForm = `${content} now`) => ({
  content,
  status,
  activeForm,
});

function use(args: Record<string, unknown>, id: number, toolName = "TodoWrite"): TranscriptEvent {
  return {
    id: `audit-tasks-${id}`,
    type: "tool_use",
    timestamp: id,
    turnNumber: id,
    data: { toolName, toolCallId: `audit-call-${id}`, args },
  };
}

function taskEvents(events: StreamEvent[]) {
  return events.filter((event): event is Extract<StreamEvent, { type: "task_update" }> =>
    event.type === "task_update",
  );
}

describe("round6 Task/Todo ordinary snapshot contract", () => {
  test("create, update, reorder, delete and clear use replacement snapshots", async () => {
    const events: StreamEvent[] = [];
    const ctx = { streamCallback: (event: StreamEvent) => events.push(event) } as never;
    const history: TranscriptEvent[] = [];
    const snapshots = [
      [todo("plan", "in_progress"), todo("build"), todo("check")],
      [todo("check", "in_progress"), todo("plan", "completed")],
      [todo("check", "completed")],
      [],
    ];
    for (const [index, todos] of snapshots.entries()) {
      const args = { todos };
      await todoWriteTool(args, ctx);
      history.push(use(args, index + 1));
      expect(taskEvents(events).at(-1)?.tasks).toEqual(readLastTodoSnapshot(history));
    }
    expect(taskEvents(events).map((event) => event.tasks.map((task) => task.subject))).toEqual([
      ["plan", "build", "check"],
      ["check", "plan"],
      [],
      [],
    ]);
    expect(taskEvents(events)[1]?.tasks).toEqual([
      { id: "1", subject: "check", status: "in_progress", activeForm: "check now" },
      { id: "2", subject: "plan", status: "completed", activeForm: "plan now" },
    ]);
  });

  test("every bounded combination of supported statuses replays like the live snapshot", async () => {
    const statuses = ["pending", "in_progress", "completed"];
    let samples = 0;
    for (let length = 0; length <= 3; length++) {
      for (let value = 0; value < 3 ** length; value++) {
        const todos = Array.from({ length }, (_, index) =>
          todo(`step ${index + 1} λ`, statuses[Math.floor(value / 3 ** index) % 3]),
        );
        const args = { todos };
        const events: StreamEvent[] = [];
        await todoWriteTool(args, { streamCallback: (event: StreamEvent) => events.push(event) } as never);
        expect(taskEvents(events)).toHaveLength(1);
        expect(taskEvents(events)[0]?.tasks).toEqual(readLastTodoSnapshot([use(args, ++samples)]));
        expect(args.todos).toEqual(todos);
      }
    }
    expect(samples).toBe(40);
  });

  test("invalid outer input does not emit a replacement; documented item tolerance is stable", async () => {
    for (const todos of [null, undefined, {}, "bad"]) {
      const events: StreamEvent[] = [];
      expect(await todoWriteTool({ todos }, { streamCallback: (event: StreamEvent) => events.push(event) } as never))
        .toBe("Error: `todos` must be an array.");
      expect(events).toEqual([]);
    }
    const args = { todos: [null, 4, {}, { content: "bad", status: "blocked" }, { content: "fallback", status: "pending" }] };
    const events: StreamEvent[] = [];
    await todoWriteTool(args, { streamCallback: (event: StreamEvent) => events.push(event) } as never);
    expect(taskEvents(events)[0]?.tasks).toEqual([
      { id: "1", subject: "fallback", status: "pending", activeForm: "fallback" },
    ]);
    expect(readLastTodoSnapshot([use(args, 1)])).toEqual(taskEvents(events)[0]?.tasks);
  });

  test("replay uses latest valid outer shape and does not revive a legacy per-item API", () => {
    const old = use({ todos: [todo("old")] }, 1);
    const newer = use({ todos: [todo("new", "in_progress")] }, 2);
    expect(readLastTodoSnapshot([])).toBeNull();
    expect(readLastTodoSnapshot([old, newer, use({ todos: "bad" }, 3)])).toEqual([
      { id: "1", subject: "new", status: "in_progress", activeForm: "new now" },
    ]);
    expect(readLastTodoSnapshot([old, use({ todos: [] }, 3)])).toEqual([]);
    expect(readLastTodoSnapshot([use({ subject: "legacy", status: "pending" }, 1, "TaskCreate")])).toBeNull();
    expect(readLastTodoSnapshot([old, use({ todos: [todo("foreign")] }, 3, "OtherTool")]))
      .toEqual(readLastTodoSnapshot([old]));
  });

  test("independent callbacks retain isolated snapshots and cannot share a singleton", async () => {
    let first: TaskInfo[] = [];
    let second: TaskInfo[] = [];
    await todoWriteTool({ todos: [todo("first")] }, { streamCallback: (event: StreamEvent) => { if (event.type === "task_update") first = event.tasks; } } as never);
    await todoWriteTool({ todos: [todo("second")] }, { streamCallback: (event: StreamEvent) => { if (event.type === "task_update") second = event.tasks; } } as never);
    await todoWriteTool({ todos: [] }, { streamCallback: (event: StreamEvent) => { if (event.type === "task_update") second = event.tasks; } } as never);
    expect(first.map((task) => task.subject)).toEqual(["first"]);
    expect(second).toEqual([]);
  });

  test("real stream wrapper keeps child replacements out of parent guard metadata", () => {
    const parent: TaskInfo[] = [{ id: "1", subject: "parent", status: "in_progress" }];
    const child: TaskInfo[] = [{ id: "1", subject: "child", status: "in_progress" }];
    const events: StreamEvent[] = [];
    const replacements: TaskInfo[][] = [];
    let current: TaskInfo[] = [];
    const wrapped = buildWrappedOnStream({
      getSession: () => { throw new Error("pure fixture must not read a Session"); },
      setLatestTodos(tasks) { current = tasks; replacements.push(tasks); },
      userOnStream(event) { events.push(event); },
    });
    const guard = new TaskGuard(() => current);
    wrapped({ type: "task_update", tasks: parent, timestamp: 1 });
    expect(guard.turnEnded(1)).toBeUndefined();
    wrapped({ type: "task_update", tasks: child, agentId: "child", timestamp: 2 });
    wrapped({ type: "task_update", tasks: [], agentId: "child", timestamp: 3 });
    expect(current).toBe(parent);
    expect(replacements).toEqual([parent]);
    const reminder = guard.turnEnded(4);
    expect(reminder).toContain('"parent" (in_progress for 3 turns)');
    expect(reminder).not.toContain('"child"');
    expect(events).toHaveLength(3);
    wrapped.finish();
  });

  test("same-position replacement and clear reset guard age while unchanged snapshots re-nag", async () => {
    let current: TaskInfo[] = [];
    const ctx = { streamCallback: (event: StreamEvent) => { if (event.type === "task_update") current = event.tasks; } } as never;
    const guard = new TaskGuard(() => current);
    await todoWriteTool({ todos: [todo("old", "in_progress")] }, ctx);
    expect(guard.turnEnded(1)).toBeUndefined();
    expect(guard.turnEnded(3)).toBeUndefined();
    expect(guard.turnEnded(4)).toContain("3 turns");
    expect(guard.turnEnded(5)).toBeUndefined();
    expect(guard.turnEnded(7)).toContain("6 turns");
    await todoWriteTool({ todos: [todo("new", "in_progress")] }, ctx);
    expect(guard.turnEnded(8)).toBeUndefined();
    expect(guard.turnEnded(10)).toBeUndefined();
    expect(guard.turnEnded(11)).toContain('"new"');
    await todoWriteTool({ todos: [] }, ctx);
    expect(guard.turnEnded(100)).toBeUndefined();
    await todoWriteTool({ todos: [todo("new", "pending")] }, ctx);
    expect(guard.turnEnded(200)).toBeUndefined();
    expect(guard.turnEnded(300)).toBeUndefined();
  });
});
