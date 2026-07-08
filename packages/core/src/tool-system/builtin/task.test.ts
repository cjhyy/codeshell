import { describe, expect, it } from "bun:test";

import type { StreamEvent, TranscriptEvent } from "../../types.js";
import { readLastTodoSnapshot, todoWriteTool } from "./task.js";

function toolUse(args: Record<string, unknown>, i = 1): TranscriptEvent {
  return {
    id: `e-${i}`,
    type: "tool_use",
    timestamp: i,
    turnNumber: i,
    data: { toolName: "TodoWrite", toolCallId: `t-${i}`, args },
  };
}

function message(i: number): TranscriptEvent {
  return {
    id: `m-${i}`,
    type: "message",
    timestamp: i,
    turnNumber: i,
    data: { role: "user", content: "ignore me" },
  };
}

describe("TodoWrite transcript replay", () => {
  it("restores the latest non-completed TodoWrite snapshot", () => {
    const snap = readLastTodoSnapshot([
      toolUse({ todos: [{ content: "old", status: "pending", activeForm: "olding" }] }, 1),
      toolUse(
        {
          todos: [
            { content: "implement", status: "in_progress", activeForm: "implementing" },
            { content: "test", status: "pending", activeForm: "testing" },
          ],
        },
        2,
      ),
    ]);

    expect(snap).toEqual([
      { id: "1", subject: "implement", activeForm: "implementing", status: "in_progress" },
      { id: "2", subject: "test", activeForm: "testing", status: "pending" },
    ]);
  });

  it("ignores non-TodoWrite events and invalid todo entries", () => {
    const snap = readLastTodoSnapshot([
      message(1),
      toolUse({ todos: [{ content: "wrong tool", status: "pending" }] }, 2),
      {
        ...toolUse({ todos: [{ content: "also ignored", status: "pending" }] }, 3),
        data: {
          toolName: "OtherTool",
          toolCallId: "other-1",
          args: { todos: [{ content: "also ignored", status: "pending" }] },
        },
      },
      toolUse(
        {
          todos: [
            { content: "valid", status: "pending" },
            { content: "bad-status", status: "blocked", activeForm: "blocking" },
            { status: "pending", activeForm: "missing content" },
          ],
        },
        4,
      ),
    ]);

    expect(snap).toEqual([
      { id: "1", subject: "valid", activeForm: "valid", status: "pending" },
    ]);
  });

  it("returns [] when the latest TodoWrite snapshot is all completed", () => {
    expect(
      readLastTodoSnapshot([
        toolUse({ todos: [{ content: "later", status: "completed", activeForm: "finishing" }] }),
      ]),
    ).toEqual([]);
  });

  it("live TodoWrite emits [] when the snapshot is all completed", async () => {
    const events: StreamEvent[] = [];
    await todoWriteTool(
      { todos: [{ content: "done", status: "completed", activeForm: "finishing" }] },
      { streamCallback: (event) => events.push(event) } as never,
    );

    expect(events).toEqual([{ type: "task_update", tasks: [] }]);
  });
});
