import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import {
  INITIAL_STATE,
  applyStreamEvent,
  appendTurnEndMessage,
  type AgentMessage,
  type AssistantMessage,
  type Message,
  type MessagesReducerState,
  type TurnEndMessage,
} from "./types";

describe("appendTurnEndMessage (TODO 2.8)", () => {
  test("appends a turn_end marker with reason + elapsed", () => {
    const s = appendTurnEndMessage(INITIAL_STATE, "stopped", 18_000);
    const last = s.messages[s.messages.length - 1] as TurnEndMessage;
    expect(last.kind).toBe("turn_end");
    expect(last.reason).toBe("stopped");
    expect(last.elapsedMs).toBe(18_000);
  });

  test("replaces a trailing turn_end instead of stacking (double-stop)", () => {
    let s = appendTurnEndMessage(INITIAL_STATE, "stopped", 1000);
    s = appendTurnEndMessage(s, "stopped", 2000);
    const ends = s.messages.filter((m) => m.kind === "turn_end");
    expect(ends).toHaveLength(1);
    expect((ends[0] as TurnEndMessage).elapsedMs).toBe(2000);
  });
});

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

function withMessages(
  messages: Message[],
  over: Partial<MessagesReducerState> = {},
): MessagesReducerState {
  return { ...INITIAL_STATE, messages, ...over };
}

// A cleanly-completed turn — the only kind that bumps turnEpoch (and thus
// collapses tool cards). Abnormal ends carry a different reason and must not.
const turnComplete: StreamEvent = { type: "turn_complete", reason: "completed" } as StreamEvent;

// ── tests ───────────────────────────────────────────────────────────

describe("applyStreamEvent — tool_use_start idempotency", () => {
  // Regression: a duplicate tool_use_start for the same call id (provider
  // re-emit, stream replay/overlap) must not append a second tool message with
  // the same id — that caused duplicate React keys + a doubled card.
  test("duplicate main-feed tool_use_start does not append a second tool", () => {
    const dup = ev("tool_use_start", {
      toolCall: { id: "call_dup", toolName: "Skill", args: { skill: "x" } },
    } as any);
    const s = dispatch(INITIAL_STATE, [...mainTurn(), dup, dup]);
    const tools = s.messages.filter((m) => m.kind === "tool");
    expect(tools.length).toBe(1);
    expect(tools[0]!.id).toBe("call_dup");
  });

  test("duplicate agent tool_use_start does not append a second toolCall", () => {
    const dup = ev("tool_use_start", {
      agentId: "A",
      toolCall: { id: "call_dup", toolName: "Read", args: {} },
    } as any);
    const s = dispatch(INITIAL_STATE, [...mainTurn(), startAgent("A"), dup, dup]);
    const agent = findAgent(s, "A");
    expect(agent.toolCalls.length).toBe(1);
    expect(agent.toolCount).toBe(1);
  });
});

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

  test("9b. a second agent_end never overwrites the first terminal state", () => {
    // Defends against the old sub-agent-timeout race that emitted agent_end
    // twice (error then text). The first terminal result must win — a failed/
    // timed-out agent must not flip back to a successful "done" with text.
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      ev("agent_end", { agentId: "A", error: "Sub-agent timed out after 300000ms" } as any),
      ev("agent_end", { agentId: "A", text: "partial output" } as any),
    ]);
    const agent = findAgent(s, "A");
    expect(agent.done).toBe(true);
    expect(agent.error).toBe("Sub-agent timed out after 300000ms");
    expect(agent.text).toBeUndefined();
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

describe("applyStreamEvent — turn_complete files_changed + turnEpoch", () => {
  test("bumps turnEpoch from 0 to 1", () => {
    const next = applyStreamEvent(withMessages([]), turnComplete);
    expect(next.turnEpoch).toBe(1);
  });

  test("bumps turnEpoch on every call", () => {
    let s = withMessages([]);
    s = applyStreamEvent(s, turnComplete);
    s = applyStreamEvent(s, turnComplete);
    s = applyStreamEvent(s, turnComplete);
    expect(s.turnEpoch).toBe(3);
  });

  test("does NOT bump turnEpoch on an abnormal turn end (so tool cards stay open)", () => {
    // model_error / aborted_streaming etc. often fire mid-task on a transient
    // error; collapsing the cards the user is reading is the "莫名其妙折叠" bug.
    for (const reason of ["model_error", "aborted_streaming", "prompt_too_long"] as const) {
      const ev = { type: "turn_complete", reason } as StreamEvent;
      const next = applyStreamEvent(withMessages([], { turnEpoch: 5 }), ev);
      expect(next.turnEpoch).toBe(5);
    }
  });

  test("appends files_changed message when turn had successful Edits", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "edit a.ts" },
      {
        kind: "tool",
        id: "t1",
        toolName: "Edit",
        args: JSON.stringify({ file_path: "a.ts", old_string: "x", new_string: "y\nz" }),
        status: "succeeded",
        startedAt: 0,
      },
    ];
    const next = applyStreamEvent(withMessages(messages), turnComplete);
    const last = next.messages[next.messages.length - 1];
    expect(last.kind).toBe("files_changed");
    if (last.kind === "files_changed") {
      expect(last.files).toEqual([{ path: "a.ts", added: 2, removed: 1, count: 1 }]);
      expect(last.totalAdded).toBe(2);
      expect(last.totalRemoved).toBe(1);
    }
  });

  test("does not append files_changed when no edits happened", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "just read" },
      {
        kind: "tool",
        id: "t1",
        toolName: "Read",
        args: JSON.stringify({ file_path: "a.ts" }),
        status: "succeeded",
        startedAt: 0,
      },
    ];
    const next = applyStreamEvent(withMessages(messages), turnComplete);
    expect(next.messages.length).toBe(messages.length);
    expect(next.messages.find((m) => m.kind === "files_changed")).toBeUndefined();
  });

  test("replaces stale files_changed within same user-turn (multi turn_complete)", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "edit twice" },
      {
        kind: "tool",
        id: "t1",
        toolName: "Edit",
        args: JSON.stringify({ file_path: "a.ts", old_string: "x", new_string: "y" }),
        status: "succeeded",
        startedAt: 0,
      },
    ];
    let s = withMessages(messages);
    s = applyStreamEvent(s, turnComplete);
    const firstCardIdx = s.messages.findIndex((m) => m.kind === "files_changed");
    expect(firstCardIdx).toBeGreaterThan(-1);

    s = {
      ...s,
      messages: [
        ...s.messages,
        {
          kind: "tool",
          id: "t2",
          toolName: "Write",
          args: JSON.stringify({ file_path: "b.ts", content: "x\ny\nz" }),
          status: "succeeded",
          startedAt: 0,
        },
      ],
    };
    s = applyStreamEvent(s, turnComplete);

    const cards = s.messages.filter((m) => m.kind === "files_changed");
    expect(cards.length).toBe(1);
    if (cards[0].kind === "files_changed") {
      expect(cards[0].files.length).toBe(2);
    }
  });
});

describe("applyStreamEvent — message timestamps", () => {
  test("stream_request_start stamps assistant createdAt", () => {
    const before = Date.now();
    const s = applyStreamEvent(INITIAL_STATE, mainTurn()[0]);
    const a = findMainAssistant(s);
    expect(a.createdAt).toBeGreaterThanOrEqual(before);
    expect(a.doneAt).toBeUndefined();
  });

  test("turn_complete stamps assistant doneAt (so elapsed is computable)", () => {
    let s = applyStreamEvent(INITIAL_STATE, mainTurn()[0]);
    const created = findMainAssistant(s).createdAt!;
    s = applyStreamEvent(s, turnComplete);
    const a = s.messages.find((m) => m.kind === "assistant") as AssistantMessage;
    expect(a.done).toBe(true);
    expect(a.doneAt).toBeGreaterThanOrEqual(created);
  });

  test("assistant_message stamps doneAt and does not overwrite an existing one", () => {
    let s = applyStreamEvent(INITIAL_STATE, mainTurn()[0]);
    s = applyStreamEvent(s, { type: "assistant_message" } as StreamEvent);
    const first = (s.messages[0] as AssistantMessage).doneAt;
    expect(first).toBeGreaterThan(0);
    // A later turn_complete must not clobber the already-recorded doneAt.
    s = applyStreamEvent(s, turnComplete);
    expect((s.messages[0] as AssistantMessage).doneAt).toBe(first);
  });
});

describe("applyStreamEvent — empty error is dropped", () => {
  // An error event with no message would render as a bare "Error: " system
  // bubble (a blank-ish block). Drop it instead of materializing noise.
  test("empty error string produces no message", () => {
    const s = applyStreamEvent(INITIAL_STATE, { type: "error", error: "" } as StreamEvent);
    expect(s.messages.filter((m) => m.kind === "system")).toHaveLength(0);
  });

  test("non-empty error still produces a system message", () => {
    const s = applyStreamEvent(INITIAL_STATE, { type: "error", error: "boom" } as StreamEvent);
    const sys = s.messages.find((m) => m.kind === "system");
    expect(sys).toBeDefined();
    if (sys && sys.kind === "system") expect(sys.text).toContain("boom");
  });

  test("error always clears streaming ids (regression guard)", () => {
    let s = applyStreamEvent(INITIAL_STATE, mainTurn()[0]);
    expect(s.streamingAssistantId).not.toBeNull();
    s = applyStreamEvent(s, { type: "error", error: "" } as StreamEvent);
    expect(s.streamingAssistantId).toBeNull();
  });
});

describe("applyStreamEvent — goal_progress markers", () => {
  test("each goal_progress event appends one marker message (count = rounds)", () => {
    const s = dispatch(INITIAL_STATE, [
      ev("goal_progress", { status: "not_met", round: 1, gaps: "缺测试" } as any),
      ev("goal_progress", { status: "not_met", round: 2, gaps: "缺类型" } as any),
      ev("goal_progress", { status: "met", round: 3 } as any),
    ]);
    const markers = s.messages.filter((m) => m.kind === "goal_progress");
    expect(markers).toHaveLength(3);
    // not_met count tells the user how many re-prompt rounds happened.
    expect(markers.filter((m) => m.kind === "goal_progress" && m.status === "not_met")).toHaveLength(2);
    const met = markers.find((m) => m.kind === "goal_progress" && m.status === "met");
    expect(met).toMatchObject({ status: "met", round: 3 });
  });

  test("carries the judge gaps through unchanged", () => {
    const s = applyStreamEvent(
      INITIAL_STATE,
      ev("goal_progress", { status: "not_met", round: 1, gaps: "tests still failing" } as any),
    );
    const m = s.messages[0];
    expect(m.kind).toBe("goal_progress");
    if (m.kind === "goal_progress") expect(m.gaps).toBe("tests still failing");
  });
});
