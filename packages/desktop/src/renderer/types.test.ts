import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import {
  INITIAL_STATE,
  applyStreamEvent,
  type AgentMessage,
  type AssistantMessage,
  type MessagesReducerState,
} from "./types";

// ── helpers ─────────────────────────────────────────────────────────
function dispatch(
  state: MessagesReducerState,
  events: StreamEvent[],
): MessagesReducerState {
  return events.reduce((s, e) => applyStreamEvent(s, e), state);
}

function ev<T extends StreamEvent["type"]>(
  type: T,
  rest: Omit<Extract<StreamEvent, { type: T }>, "type">,
): StreamEvent {
  return { type, ...rest } as StreamEvent;
}

const mainTurn = (): StreamEvent[] => [
  ev("stream_request_start", { turnNumber: 1 } as any),
];

const startAgent = (
  agentId: string,
  name = "Sub",
  description = "doing work",
): StreamEvent =>
  ev("agent_start", { agentId, name, description } as any);

const findAgent = (state: MessagesReducerState, agentId: string): AgentMessage => {
  const m = state.messages.find((x) => x.kind === "agent" && x.id === agentId);
  if (!m || m.kind !== "agent") throw new Error(`no agent ${agentId}`);
  return m;
};

const findMainAssistant = (state: MessagesReducerState): AssistantMessage => {
  const m = state.messages.find(
    (x) => x.kind === "assistant" && x.id === state.streamingAssistantId,
  );
  if (!m || m.kind !== "assistant") throw new Error("no streaming assistant");
  return m;
};

// ── tests ───────────────────────────────────────────────────────────

describe("applyStreamEvent — subagent isolation", () => {
  test("1. text_delta with agentId does not touch main assistant", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      ev("text_delta", { text: "main says hi" } as any),
      startAgent("A"),
      ev("text_delta", { agentId: "A", text: "child noise" } as any),
    ]);
    expect(findMainAssistant(s).text).toBe("main says hi");
    expect(findAgent(s, "A").textBuffer).toBe("child noise");
  });

  test("2. tool_use_start/result with agentId routes to that agent's toolCalls", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      ev("tool_use_start", {
        agentId: "A",
        toolCall: { id: "t1", toolName: "Read", args: { file: "x" } },
      } as any),
      ev("tool_result", {
        agentId: "A",
        result: { id: "t1", toolName: "Read", result: "ok" },
      } as any),
    ]);
    const agent = findAgent(s, "A");
    expect(agent.toolCalls.length).toBe(1);
    expect(agent.toolCalls[0]!.toolName).toBe("Read");
    expect(agent.toolCalls[0]!.status).toBe("succeeded");
    expect(agent.toolCount).toBe(1);
    // And no top-level tool message:
    expect(s.messages.filter((m) => m.kind === "tool").length).toBe(0);
  });

  test("3. concurrent agents keep their textBuffers separate", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      startAgent("B"),
      ev("text_delta", { agentId: "A", text: "aaa" } as any),
      ev("text_delta", { agentId: "B", text: "bbb" } as any),
      ev("text_delta", { agentId: "A", text: "AAA" } as any),
    ]);
    expect(findAgent(s, "A").textBuffer).toBe("aaaAAA");
    expect(findAgent(s, "B").textBuffer).toBe("bbb");
  });

  test("4. turn_complete flushes textBuffer to text and clears buffer", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      ev("text_delta", { agentId: "A", text: "hello world" } as any),
      ev("turn_complete", {} as any),
    ]);
    const agent = findAgent(s, "A");
    expect(agent.text).toBe("hello world");
    expect(agent.textBuffer).toBe("");
  });

  test("5. text_delta for unknown agentId is dropped (state unchanged)", () => {
    const before = dispatch(INITIAL_STATE, [...mainTurn()]);
    const after = applyStreamEvent(
      before,
      ev("text_delta", { agentId: "ghost", text: "x" } as any),
    );
    expect(after).toBe(before); // strict reference equality
  });

  test("6. stream_request_start while an agent is active does not open a new main assistant", () => {
    const s = dispatch(INITIAL_STATE, [...mainTurn(), startAgent("A")]);
    const before = s;
    const after = applyStreamEvent(before, ev("stream_request_start", {} as any));
    expect(after.streamingAssistantId).toBe(before.streamingAssistantId);
    expect(after.messages.length).toBe(before.messages.length);
  });

  test("7. 10000 subagent deltas: main assistant reference is stable", () => {
    let s = dispatch(INITIAL_STATE, [...mainTurn(), startAgent("A")]);
    const mainAssistantBefore = findMainAssistant(s);
    for (let i = 0; i < 10000; i++) {
      s = applyStreamEvent(
        s,
        ev("text_delta", { agentId: "A", text: "x" } as any),
      );
    }
    const mainAssistantAfter = findMainAssistant(s);
    expect(mainAssistantAfter).toBe(mainAssistantBefore); // same ref
    expect(findAgent(s, "A").textBuffer.length).toBe(10000);
  });

  test("8. subagent thinking_delta is dropped (no thinking message appended)", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      ev("thinking_delta", { agentId: "A", text: "internal monologue" } as any),
    ]);
    expect(s.messages.filter((m) => m.kind === "thinking").length).toBe(0);
    expect(s.streamingThinkingId).toBeNull();
  });

  test("9. agent_end flushes residual textBuffer", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      ev("text_delta", { agentId: "A", text: "tail" } as any),
      ev("agent_end", { agentId: "A", text: undefined } as any),
    ]);
    const agent = findAgent(s, "A");
    expect(agent.text).toBe("tail");
    expect(agent.textBuffer).toBe("");
    expect(agent.done).toBe(true);
  });

  test("10. main-agent text_delta still appends to main assistant (regression)", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      ev("text_delta", { text: "abc" } as any),
      ev("text_delta", { text: "def" } as any),
    ]);
    expect(findMainAssistant(s).text).toBe("abcdef");
  });

  test("11. task_update without agentId updates the global TaskListMessage", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      ev("task_update", { tasks: [{ id: "t1", subject: "main todo", status: "pending" }] } as any),
    ]);
    const taskList = s.messages.find((m) => m.kind === "task_list");
    expect(taskList).toBeDefined();
    if (taskList && taskList.kind === "task_list") {
      expect(taskList.tasks.length).toBe(1);
      expect(taskList.tasks[0]!.subject).toBe("main todo");
    }
  });

  test("12. task_update with agentId is dropped (state unchanged)", () => {
    const before = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
    ]);
    const after = applyStreamEvent(
      before,
      ev("task_update", {
        tasks: [{ id: "t1", subject: "sub todo", status: "pending" }],
        agentId: "A",
      } as any),
    );
    expect(after).toBe(before); // strict reference equality
    expect(after.messages.filter((m) => m.kind === "task_list").length).toBe(0);
  });
});
