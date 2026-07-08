import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import {
  INITIAL_STATE,
  applyStreamEvent,
  appendUserMessage,
  appendTurnEndMessage,
  bgCompletionText,
  removePendingSteerMessages,
  type AgentMessage,
  type AssistantMessage,
  type Message,
  type MessagesReducerState,
  type TurnEndMessage,
} from "./types";

describe("steer_injected → user bubble (引导不打断注入)", () => {
  test("appends the steered text as a user message in the feed", () => {
    const s = applyStreamEvent(INITIAL_STATE, {
      type: "steer_injected",
      text: "顺便也看看收藏页",
    } as StreamEvent);
    const last = s.messages[s.messages.length - 1];
    expect(last.kind).toBe("user");
    expect((last as { text: string }).text).toBe("顺便也看看收藏页");
    // It must NOT open/close an assistant streaming message — steering only
    // adds a user bubble; the running turn keeps its own assistant message.
    expect(s.streamingAssistantId).toBe(INITIAL_STATE.streamingAssistantId);
  });

  test("confirms an optimistic pending steer bubble instead of appending a duplicate", () => {
    const pending = appendUserMessage(
      INITIAL_STATE,
      "queued draft",
      100,
      false,
      true,
      "q-1",
      true,
    );
    const s = applyStreamEvent(pending, {
      type: "steer_injected",
      id: "q-1",
      text: "queued draft confirmed",
    } as StreamEvent);
    const users = s.messages.filter((m) => m.kind === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      kind: "user",
      text: "queued draft confirmed",
      injected: true,
      steerId: "q-1",
      pending: false,
    });
  });

  test("drops only matching pending steer bubbles when a queued steer is revoked", () => {
    let s = appendUserMessage(INITIAL_STATE, "keep", 1, false, true, "keep", true);
    s = appendUserMessage(s, "drop", 2, false, true, "drop", true);
    s = appendUserMessage(s, "real", 3);

    const next = removePendingSteerMessages(s, ["drop"]);

    expect(next.messages.map((m) => (m.kind === "user" ? m.text : ""))).toEqual(["keep", "real"]);
    expect(next.messages.some((m) => m.kind === "user" && m.steerId === "drop")).toBe(false);
  });
});

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

  // Interrupt-relay fix: stopping a turn must CLEAR the streaming pointers so
  // the killed turn can't leave a stale non-null streamingAssistantId behind —
  // otherwise the relayed (re-sent) turn never lights "正在思考…", and the
  // cancelled turn's late abort event races to clear it after the new turn
  // started. (missing thinking state on 打断接力)
  test("clears streamingAssistantId/streamingThinkingId so the next turn isn't poisoned", () => {
    const mid: MessagesReducerState = {
      ...INITIAL_STATE,
      streamingAssistantId: "assistant-stale",
      streamingThinkingId: "thinking-stale",
    };
    const s = appendTurnEndMessage(mid, "stopped", 1000);
    expect(s.streamingAssistantId).toBeNull();
    expect(s.streamingThinkingId).toBeNull();
  });

});

// ── helpers ─────────────────────────────────────────────────────────
function dispatch(
  state: MessagesReducerState,
  events: StreamEvent[],
): MessagesReducerState {
  return events.reduce((s, e) => applyStreamEvent(s, e), state);
}

describe("goal_progress approaching_limit (TODO 3.1)", () => {
  const goalCount = (s: MessagesReducerState, status: string) =>
    s.messages.filter((m) => m.kind === "goal_progress" && m.status === status).length;

  test("approaching_limit marker carries turnsRemaining", () => {
    const s = dispatch(INITIAL_STATE, [
      ev("goal_progress", { status: "approaching_limit", round: 0, turnsRemaining: 2 } as never),
    ]);
    const m = s.messages.find((x) => x.kind === "goal_progress");
    expect(m && m.kind === "goal_progress" && m.turnsRemaining).toBe(2);
  });

  test("a second approaching_limit replaces the first (no stacking)", () => {
    const s = dispatch(INITIAL_STATE, [
      ev("goal_progress", { status: "approaching_limit", round: 0, turnsRemaining: 2 } as never),
      ev("goal_progress", { status: "approaching_limit", round: 0, turnsRemaining: 2 } as never),
    ]);
    expect(goalCount(s, "approaching_limit")).toBe(1);
  });

  test("met/exhausted prune the approaching_limit marker (the moment passed)", () => {
    const sMet = dispatch(INITIAL_STATE, [
      ev("goal_progress", { status: "approaching_limit", round: 0, turnsRemaining: 2 } as never),
      ev("goal_progress", { status: "met", round: 3 } as never),
    ]);
    expect(goalCount(sMet, "approaching_limit")).toBe(0);
    expect(goalCount(sMet, "met")).toBe(1);

    const sExhausted = dispatch(INITIAL_STATE, [
      ev("goal_progress", { status: "approaching_limit", round: 0, turnsRemaining: 2 } as never),
      ev("goal_progress", { status: "exhausted", round: 5 } as never),
    ]);
    expect(goalCount(sExhausted, "approaching_limit")).toBe(0);
  });

  test("not_met does NOT prune the approaching_limit marker (still advancing — B2)", () => {
    // The goal is still working and may still be nearing the cap, so the "再续"
    // button must survive a not_met that lands in the same window.
    const s = dispatch(INITIAL_STATE, [
      ev("goal_progress", { status: "approaching_limit", round: 0, stopBlocksRemaining: 2, nearest: "stopBlocks" } as never),
      ev("goal_progress", { status: "not_met", round: 1, gaps: "still going" } as never),
    ]);
    expect(goalCount(s, "approaching_limit")).toBe(1);
    expect(goalCount(s, "not_met")).toBe(1);
  });
});

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

  // Screenshot echo: a tool_result carrying image contentBlocks (browser_observe
  // vision/image, view_image) must surface them on the ToolMessage so the card
  // can render thumbnails — they used to be dropped at this conversion step.
  test("tool_result image contentBlocks are surfaced on the ToolMessage", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      ev("tool_use_start", {
        toolCall: { id: "shot1", toolName: "browser_observe", args: { mode: "vision" } },
      } as any),
      ev("tool_result", {
        result: {
          id: "shot1",
          toolName: "browser_observe",
          result: "[screenshot loaded]",
          contentBlocks: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
          ],
        },
      } as any),
    ]);
    const tool = s.messages.find((m) => m.kind === "tool" && m.id === "shot1");
    if (!tool || tool.kind !== "tool") throw new Error("no tool msg");
    expect(tool.images).toEqual([{ mediaType: "image/jpeg", data: "QUJD" }]);
    expect(tool.status).toBe("succeeded");
  });

  test("tool_result without image blocks leaves images undefined", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      ev("tool_use_start", {
        toolCall: { id: "r1", toolName: "Read", args: { file: "x" } },
      } as any),
      ev("tool_result", { result: { id: "r1", toolName: "Read", result: "ok" } } as any),
    ]);
    const tool = s.messages.find((m) => m.kind === "tool" && m.id === "r1");
    if (!tool || tool.kind !== "tool") throw new Error("no tool msg");
    expect(tool.images).toBeUndefined();
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

  test("4b. clean turn_complete sweeps a still-running agent to done (#4 stuck count)", () => {
    // Orphan: agent_start but no agent_end (dropped/raced). A cleanly completed
    // main turn must not leave it done:false forever or the "后台 N 运行中" hint
    // sticks.
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      ev("text_delta", { agentId: "A", text: "partial" } as any),
      turnComplete, // reason: "completed"
    ]);
    const agent = findAgent(s, "A");
    expect(agent.done).toBe(true);
    expect(agent.text).toBe("partial");
    expect(agent.textBuffer).toBe("");
    expect(agent.endedAt).toBeDefined();
  });

  test("4c. ABNORMAL turn_complete does NOT sweep (only flushes) — turn may resume", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      ev("text_delta", { agentId: "A", text: "partial" } as any),
      ev("turn_complete", { reason: "model_error" } as any),
    ]);
    const agent = findAgent(s, "A");
    expect(agent.done).toBe(false); // not swept on a non-clean end
    expect(agent.text).toBe("partial"); // but textBuffer still flushed
    expect(agent.textBuffer).toBe("");
  });

  test("4d. agent_backgrounded marks the agent backgrounded (still running, not done)", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      ev("agent_backgrounded", { agentId: "A", name: "Sub", description: "doing work" } as any),
    ]);
    const agent = findAgent(s, "A");
    expect(agent.done).toBe(false);
    expect(agent.backgrounded).toBe(true);
  });

  test("4e. clean turn_complete does NOT sweep a BACKGROUNDED agent to done", () => {
    // The handoff→completion gap: a clean main turn_complete must leave a
    // backgrounded agent still running (it reports done later via agent_end /
    // background_agent_completed). Without this it collapses + shows no running.
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      ev("agent_backgrounded", { agentId: "A", name: "Sub", description: "doing work" } as any),
      turnComplete, // reason: "completed"
    ]);
    const agent = findAgent(s, "A");
    expect(agent.done).toBe(false); // backgrounded ≠ orphan; not swept
    expect(agent.backgrounded).toBe(true);
  });

  test("4f. agent_end on a backgrounded agent resolves it to done (clears backgrounded)", () => {
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      ev("agent_backgrounded", { agentId: "A", name: "Sub", description: "doing work" } as any),
      turnComplete,
      ev("agent_end", { agentId: "A", text: "final" } as any),
    ]);
    const agent = findAgent(s, "A");
    expect(agent.done).toBe(true);
    expect(agent.backgrounded).toBe(false);
    expect(agent.text).toBe("final");
  });

  test("4g. background_agent_completed resolves a backgrounded agent's card to done (not 可能失联)", () => {
    // Regression (s-mqqkkbpg): a backgrounded sub-agent that finishes via
    // background_agent_completed (the success handoff path) must close its card.
    // Before the fix that branch only added a system line, leaving the card
    // {backgrounded:true, done:false} → heartbeats stop → card shows "可能失联"
    // even though it completed.
    const s = dispatch(INITIAL_STATE, [
      ...mainTurn(),
      startAgent("A"),
      ev("agent_backgrounded", { agentId: "A", name: "Sub", description: "doing work" } as any),
      turnComplete,
      ev("background_agent_completed", {
        agentId: "A",
        name: "Sub",
        description: "doing work",
        status: "completed",
        finalText: "done result",
      } as any),
    ]);
    const agent = findAgent(s, "A");
    expect(agent.done).toBe(true);       // card closed
    expect(agent.backgrounded).toBe(false); // → isBackgrounded false → no "可能失联"
    expect(agent.text).toBe("done result");
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

  test("collapses across an injected user turn — one file, one card (not two)", () => {
    // A goal/steer task spans two engine.run boundaries: run 1 edits a.ts and a
    // clean turn_complete emits a files_changed card; then steer_injected inserts
    // an INJECTED user turn; run 2 edits a.ts again and turn_complete fires.
    // aggregateFileChangeSummary scopes from the last NON-injected user message,
    // so the second card correctly covers BOTH runs' edits — but the stale-card
    // sweep must use the SAME boundary, or run 1's card survives before the
    // injected user message and a.ts shows in two cards.
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "improve a.ts" },
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
    s = applyStreamEvent(s, turnComplete); // run 1 emits the first card

    s = applyStreamEvent(s, { type: "steer_injected", text: "keep going" } as StreamEvent);
    s = {
      ...s,
      messages: [
        ...s.messages,
        {
          kind: "tool",
          id: "t2",
          toolName: "Edit",
          args: JSON.stringify({ file_path: "a.ts", old_string: "y", new_string: "z" }),
          status: "succeeded",
          startedAt: 0,
        },
      ],
    };
    s = applyStreamEvent(s, turnComplete); // run 2

    const cards = s.messages.filter((m) => m.kind === "files_changed");
    expect(cards.length).toBe(1);
    if (cards[0].kind === "files_changed") {
      expect(cards[0].files).toEqual([{ path: "a.ts", added: 2, removed: 2, count: 2 }]);
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

  test("agent_start and agent_end use the replay clock", () => {
    let replayNow = 111;
    let s = applyStreamEvent(INITIAL_STATE, startAgent("A"), () => replayNow);
    let agent = findAgent(s, "A");
    expect(agent.startedAt).toBe(111);
    expect(s.activeAgents.A?.startedAt).toBe(111);

    replayNow = 222;
    s = applyStreamEvent(
      s,
      ev("agent_end", { agentId: "A", text: "done" } as any),
      () => replayNow,
    );
    agent = findAgent(s, "A");
    expect(agent.endedAt).toBe(222);
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

describe("applyStreamEvent — background_agent_completed", () => {
  test("completed → appends a system message with the saved path", () => {
    const ev = {
      type: "background_agent_completed",
      agentId: "video-1",
      name: "video generation",
      description: "Video generated: /p/.code-shell/generated_videos/1.mp4",
      status: "completed",
      finalText: "Video saved to /p/.code-shell/generated_videos/1.mp4",
      enqueuedAt: 1,
    } as unknown as StreamEvent;
    const s = applyStreamEvent(INITIAL_STATE, ev);
    const last = s.messages[s.messages.length - 1];
    expect(last.kind).toBe("system");
    expect((last as { text: string }).text).toContain("video generation");
    expect((last as { text: string }).text).toContain("Video saved to /p/.code-shell/generated_videos/1.mp4");
  });

  test("failed → appends a system message with the error", () => {
    const ev = {
      type: "background_agent_completed",
      agentId: "video-2",
      name: "video generation",
      description: "Video generation failed",
      status: "failed",
      error: "content policy",
      enqueuedAt: 1,
    } as unknown as StreamEvent;
    const s = applyStreamEvent(INITIAL_STATE, ev);
    const last = s.messages[s.messages.length - 1];
    expect(last.kind).toBe("system");
    expect((last as { text: string }).text).toContain("content policy");
  });

  test("long finalText is clipped to a one-line preview (#2 flood)", () => {
    // A subagent that returns a multi-paragraph report must not dump the whole
    // thing into the stream line — the full text lives in its own agent card.
    const longText = "段落一。".repeat(200) + "\n\n第二段也很长。" + "x".repeat(500);
    const line = bgCompletionText({
      name: "researcher",
      description: "deep dive",
      status: "completed",
      finalText: longText,
    });
    expect(line.length).toBeLessThan(200); // capped, not the full ~1000 chars
    expect(line).toContain("researcher完成");
    expect(line).toContain("…"); // ellipsis marks the clip
    expect(line).not.toContain("\n"); // newlines collapsed → single line
  });

  test("short finalText is shown in full (no needless ellipsis)", () => {
    const line = bgCompletionText({
      name: "researcher",
      description: "deep dive",
      status: "completed",
      finalText: "done, found 3 issues",
    });
    expect(line).toBe("✓ researcher完成:done, found 3 issues");
  });
});

describe("persistent goal lifecycle (reducer)", () => {
  test("goal_set establishes the active goal at round 0", () => {
    const s = dispatch(INITIAL_STATE, [
      ev("goal_set", { objective: "完成全部任务", replaced: false } as never),
    ]);
    expect(s.activeGoal).toEqual({ objective: "完成全部任务", round: 0 });
  });

  test("goal_set replaces an existing active goal", () => {
    const s = dispatch(INITIAL_STATE, [
      ev("goal_set", { objective: "目标一", replaced: false } as never),
      ev("goal_set", { objective: "目标二", replaced: true } as never),
    ]);
    expect(s.activeGoal?.objective).toBe("目标二");
  });

  test("goal_progress(not_met) bumps the round, keeps goal active", () => {
    const s = dispatch(INITIAL_STATE, [
      ev("goal_set", { objective: "g", replaced: false } as never),
      ev("goal_progress", { status: "not_met", round: 2, gaps: "还差" } as never),
    ]);
    expect(s.activeGoal).toEqual({ objective: "g", round: 2 });
  });

  test("goal_progress(met) clears the active goal", () => {
    const s = dispatch(INITIAL_STATE, [
      ev("goal_set", { objective: "g", replaced: false } as never),
      ev("goal_progress", { status: "met", round: 3 } as never),
    ]);
    expect(s.activeGoal).toBeNull();
  });

  test("goal_progress(exhausted) clears the active goal", () => {
    const s = dispatch(INITIAL_STATE, [
      ev("goal_set", { objective: "g", replaced: false } as never),
      ev("goal_progress", { status: "exhausted", round: 5 } as never),
    ]);
    expect(s.activeGoal).toBeNull();
  });

  test("goal_cleared wipes the active goal", () => {
    const s = dispatch(INITIAL_STATE, [
      ev("goal_set", { objective: "g", replaced: false } as never),
      ev("goal_cleared", {} as never),
    ]);
    expect(s.activeGoal).toBeNull();
  });
});
