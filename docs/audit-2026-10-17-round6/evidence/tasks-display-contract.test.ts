import { describe, expect, test } from "bun:test";
import { todoWriteTool } from "../../../packages/core/src/tool-system/builtin/task.js";
import type { StreamEvent } from "../../../packages/core/src/types.js";
import { transcriptToFoldItems } from "../../../packages/desktop/src/main/transcript-reader.js";
import { foldTranscript } from "../../../packages/desktop/src/renderer/automation/foldTranscript.js";
import { applyStreamEvent, INITIAL_STATE } from "../../../packages/desktop/src/renderer/types.js";
import { initialChatState, reduceStream } from "../../../packages/web/src/lib/streamReducer.js";

const todo = (content: string, status = "pending", activeForm = `${content} now`) => ({ content, status, activeForm });
const line = (todos: unknown, id: number) => JSON.stringify({
  id: `audit-tasks-${id}`, type: "tool_use", timestamp: id, turnNumber: id,
  data: { toolName: "TodoWrite", toolCallId: `audit-call-${id}`, args: { todos } },
});

describe("round6 Task/Todo display data consumers", () => {
  test("Desktop disk reconstruction and live emission agree for bounded supported snapshots", async () => {
    const statuses = ["pending", "in_progress", "completed"];
    let samples = 0;
    for (let length = 0; length <= 3; length++) {
      for (let value = 0; value < 3 ** length; value++) {
        const todos = Array.from({ length }, (_, index) =>
          todo(`step ${index + 1} λ`, statuses[Math.floor(value / 3 ** index) % 3]),
        );
        const live: StreamEvent[] = [];
        await todoWriteTool({ todos }, { streamCallback: (event: StreamEvent) => live.push(event) } as never);
        const disk = transcriptToFoldItems(line(todos, ++samples))
          .flatMap((item) => item.kind === "stream" && item.event.type === "task_update" ? [item.event] : []);
        expect(disk).toEqual(live);
        const state = foldTranscript(transcriptToFoldItems(line(todos, samples)));
        const panel = state.messages.find((message) => message.kind === "task_list");
        expect(panel?.kind === "task_list" ? panel.tasks : undefined).toEqual(
          live[0]?.type === "task_update" ? live[0].tasks : undefined,
        );
      }
    }
    expect(samples).toBe(40);
  });

  test("Desktop replay of multiple writes retains one latest panel and clears on completion", () => {
    const state = foldTranscript(transcriptToFoldItems([
      line([todo("old", "in_progress"), todo("second")], 1),
      line([todo("replacement", "in_progress")], 2),
      line([todo("replacement", "completed")], 3),
    ].join("\n")));
    const panels = state.messages.filter((message) => message.kind === "task_list");
    expect(panels).toHaveLength(1);
    expect(panels[0]?.kind === "task_list" ? panels[0].tasks : undefined).toEqual([]);
  });

  test("Desktop ignores child snapshots while accepting replacement and empty parent snapshots", () => {
    const parent = [{ id: "1", subject: "parent", activeForm: "working", status: "in_progress" as const }];
    let state = applyStreamEvent(INITIAL_STATE, { type: "task_update", tasks: parent }, () => 1);
    const beforeChild = state;
    state = applyStreamEvent(state, { type: "task_update", tasks: [], agentId: "child" }, () => 2);
    expect(state).toBe(beforeChild);
    const replacement = [{ id: "1", subject: "replaced", status: "pending" as const }];
    state = applyStreamEvent(state, { type: "task_update", tasks: replacement }, () => 3);
    expect(state.messages.filter((message) => message.kind === "task_list")).toHaveLength(1);
    expect(state.messages.find((message) => message.kind === "task_list")).toMatchObject({ tasks: replacement });
    state = applyStreamEvent(state, { type: "task_update", tasks: [] }, () => 4);
    expect(state.messages.find((message) => message.kind === "task_list")).toMatchObject({ tasks: [] });
  });

  test("Web intentionally omits the main list and replaces child progress by owner", () => {
    const initial = initialChatState();
    expect(reduceStream(initial, { type: "task_update", tasks: [{ status: "in_progress" }] })).toBe(initial);
    let state = reduceStream(initial, { type: "task_update", agentId: "a", tasks: [{ status: "completed" }, { status: "pending" }] });
    state = reduceStream(state, { type: "task_update", agentId: "b", tasks: [{ status: "in_progress" }] });
    state = reduceStream(state, { type: "task_update", agentId: "a", tasks: [{ status: "completed" }] });
    expect(state.items.filter((item) => item.kind === "subagent")).toHaveLength(2);
    expect(state.items.find((item) => item.kind === "subagent" && item.agentId === "a")).toMatchObject({ label: "任务 1/1", status: "completed" });
    expect(state.items.find((item) => item.kind === "subagent" && item.agentId === "b")).toMatchObject({ label: "任务 0/1", status: "running" });
  });
});
