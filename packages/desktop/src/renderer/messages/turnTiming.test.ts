import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import {
  applyStreamEvent,
  appendTurnEndMessage,
  appendUserMessage,
  INITIAL_STATE,
  type Message,
  type ToolMessage,
  type UserMessage,
} from "../types";
import { foldTranscript } from "../automation/foldTranscript";
import {
  buildStreamItems,
  processGroupLabel,
  reconcileStreamItems,
  type TurnProcessGroup,
} from "./streamGroups";

function tool(overrides: Partial<ToolMessage> = {}): ToolMessage {
  return {
    kind: "tool",
    id: "read",
    toolName: "Read",
    args: "{}",
    status: "succeeded",
    startedAt: 105_000,
    endedAt: 105_000,
    ...overrides,
  };
}

function group(messages: Message[], live = false): TurnProcessGroup {
  return buildStreamItems(messages, { liveTurnActive: live }).find(
    (item): item is TurnProcessGroup => item.kind === "turn_process_group",
  )!;
}

describe("whole-turn timing", () => {
  test("formats elapsed seconds, minutes, hours and days without a synthetic 0s", () => {
    for (const duration of [undefined, NaN, Infinity, -1, 0, 999]) {
      expect(processGroupLabel(duration)).toBe("已处理");
    }
    for (const [duration, label] of [
      [1000, "已处理 1s"],
      [59_000, "已处理 59s"],
      [60_000, "已处理 1m"],
      [61_000, "已处理 1m 1s"],
      [3_600_000, "已处理 1h"],
      [90_061_000, "已处理 1d 1h 1m 1s"],
    ] as const)
      expect(processGroupLabel(duration)).toBe(label);
  });

  test("a result with a missing historical tool start does not invent decades of execution", () => {
    let state = applyStreamEvent(
      INITIAL_STATE,
      {
        type: "tool_use_start",
        toolCall: { id: "read", toolName: "Read", args: {} },
      },
      () => undefined,
    );
    state = applyStreamEvent(
      state,
      {
        type: "tool_result",
        result: { id: "read", toolName: "Read", result: "ok" },
      },
      () => 1_700_000_000_000,
    );
    expect(state.messages.find((item) => item.kind === "tool")).toMatchObject({
      status: "succeeded",
      durationMs: undefined,
    });
  });

  test("Stop seals unfinished content and freezes the run even before the worker acknowledges it", () => {
    let state = appendUserMessage(INITIAL_STATE, "inspect", 100_000);
    state = applyStreamEvent(state, { type: "stream_request_start", turnNumber: 1 }, () => 101_000);
    state = applyStreamEvent(state, { type: "text_delta", text: "Checking." }, () => 102_000);
    state = applyStreamEvent(
      state,
      {
        type: "tool_use_start",
        toolCall: { id: "read", toolName: "Read", args: {} },
      },
      () => 103_000,
    );
    const stopped = appendTurnEndMessage(state, "stopped", 5_000, undefined, () => 105_000);
    expect(stopped.messages.find((item) => item.kind === "tool")).toMatchObject({
      status: "cancelled",
      endedAt: 105_000,
    });
    expect(
      stopped.messages.filter((item) => item.kind === "assistant").every((item) => item.done),
    ).toBe(true);
    expect(group(stopped.messages, true)).toMatchObject({
      isLive: false,
      durationMs: 5_000,
      stopped: true,
    });
  });

  test("a local failure seals only its current turn and leaves background agents running", () => {
    const state = appendUserMessage(INITIAL_STATE, "inspect", 100_000);
    const background: Message = {
      kind: "agent",
      id: "background",
      description: "work",
      done: false,
      backgrounded: true,
      startedAt: 100_000,
      textBuffer: "",
      toolCount: 0,
      toolCalls: [],
    };
    const next = appendTurnEndMessage(
      {
        ...state,
        messages: [...state.messages, tool({ status: "running", endedAt: undefined }), background],
      },
      "error",
      8_000,
      "connection lost",
      () => 108_000,
    );
    expect(next.messages.find((item) => item.kind === "tool")).toMatchObject({ status: "failed" });
    expect(next.messages.find((item) => item.id === "background")).toBe(background);
    expect(group(next.messages, true).completedCleanly).toBe(false);
  });

  test("completed commentary does not finish a turn while its tool is running", () => {
    let state = appendUserMessage(INITIAL_STATE, "inspect", 100_000);
    for (const [timestamp, event] of [
      [101_000, { type: "stream_request_start", turnNumber: 1 }],
      [102_000, { type: "text_delta", text: "Checking the file." }],
      [103_000, { type: "tool_use_start", toolCall: { id: "read", toolName: "Read", args: {} } }],
    ] as const) {
      state = applyStreamEvent(state, event as StreamEvent, () => timestamp);
    }
    expect(group(state.messages, true).isLive).toBe(true);
    expect(group(state.messages, true).startedAt).toBe(100_000);
  });

  test("backend completion duration wins over message and tool spans", () => {
    let state = appendUserMessage(INITIAL_STATE, "inspect", 90_000);
    const events = [
      {
        type: "session_started",
        sessionId: "s",
        promptTokens: 0,
        startedAt: 100_000,
        timestamp: 101_000,
      },
      { type: "stream_request_start", turnNumber: 1, timestamp: 102_000 },
      {
        type: "tool_use_start",
        toolCall: { id: "read", toolName: "Read", args: {} },
        timestamp: 105_000,
      },
      {
        type: "tool_result",
        result: { id: "read", toolName: "Read", result: "ok" },
        timestamp: 105_000,
      },
      { type: "text_delta", text: "Done.", timestamp: 106_000 },
      {
        type: "assistant_message",
        message: { role: "assistant", content: "Done." },
        timestamp: 107_000,
      },
      {
        type: "turn_complete",
        reason: "completed",
        startedAt: 100_000,
        completedAt: 112_000,
        durationMs: 12_345,
        timestamp: 112_000,
      },
    ] as StreamEvent[];
    for (const event of events) state = applyStreamEvent(state, event, () => 9_000_000);
    expect(group(state.messages, true)).toMatchObject({
      isLive: false,
      startedAt: 100_000,
      durationMs: 12_345,
    });
    expect(state.messages.find((item) => item.kind === "tool")).toMatchObject({
      startedAt: 105_000,
      endedAt: 105_000,
    });
    expect(state.messages[0]).toMatchObject({
      turnTiming: { startedAt: 100_000, completedAt: 112_000, durationMs: 12_345 },
    });
  });

  test("journal replay uses source event times without a FoldItem clock", () => {
    const state = foldTranscript([
      {
        kind: "stream",
        event: { type: "session_user_message", text: "inspect", timestamp: 100_000 },
      },
      {
        kind: "stream",
        event: { type: "stream_request_start", turnNumber: 1, timestamp: 101_000 },
      },
      {
        kind: "stream",
        event: {
          type: "tool_use_start",
          toolCall: { id: "read", toolName: "Read", args: {} },
          timestamp: 105_000,
        },
      },
      {
        kind: "stream",
        event: {
          type: "tool_result",
          result: { id: "read", toolName: "Read", result: "ok" },
          timestamp: 108_000,
        },
      },
      { kind: "stream", event: { type: "turn_complete", reason: "completed", timestamp: 112_000 } },
    ]);
    expect(group(state.messages).durationMs).toBe(12_000);
    expect(state.messages[0]).toMatchObject({ createdAt: 100_000 });
  });

  test("legacy missing tool stamps do not turn into an epoch-sized duration", () => {
    const messages: Message[] = [
      { kind: "user", id: "user", text: "inspect", createdAt: 1_700_000_000_000 },
      tool({ startedAt: 0, endedAt: 0 }),
      { kind: "assistant", id: "answer", text: "done", done: true, doneAt: 1_700_000_008_000 },
    ];
    expect(group(messages).durationMs).toBe(8_000);
  });

  test("unknown historical duration does not claim 0 seconds", () => {
    const messages: Message[] = [
      { kind: "user", id: "user", text: "inspect" },
      tool({ startedAt: 0, endedAt: 0 }),
    ];
    expect(group(messages).durationMs).toBeUndefined();
    expect(processGroupLabel(group(messages).durationMs)).toBe("已处理");
  });

  test("legacy zero user and assistant stamps do not measure from 1970", () => {
    const messages: Message[] = [
      { kind: "user", id: "user", text: "inspect", createdAt: 0 },
      { kind: "assistant", id: "lead", text: "checking", done: true, createdAt: 0, doneAt: 0 },
      tool({ startedAt: 1_700_000_000_000, endedAt: 1_700_000_003_000 }),
    ];
    expect(group(messages).durationMs).toBe(3_000);
  });

  test("an injected wakeup cannot split an unfinished run after completed commentary", () => {
    const user: UserMessage = {
      kind: "user",
      id: "user",
      text: "inspect",
      createdAt: 100_000,
      turnTiming: { startedAt: 100_000 },
    };
    const messages: Message[] = [
      user,
      { kind: "assistant", id: "commentary", text: "checking", done: true, doneAt: 102_000 },
      tool({ status: "running", endedAt: undefined }),
      { kind: "user", id: "wakeup", text: "job update", injected: true },
    ];
    const groups = buildStreamItems(messages, { liveTurnActive: true }).filter(
      (item) => item.kind === "turn_process_group",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.isLive).toBe(true);
  });

  test("an id-less steer keeps authoritative completion on the original run anchor", () => {
    let state = appendUserMessage(INITIAL_STATE, "inspect", 100_000);
    for (const event of [
      {
        type: "session_started",
        sessionId: "s",
        promptTokens: 0,
        startedAt: 100_000,
        timestamp: 100_000,
      },
      { type: "stream_request_start", turnNumber: 1, timestamp: 101_000 },
      {
        type: "tool_use_start",
        toolCall: { id: "read", toolName: "Read", args: {} },
        timestamp: 102_000,
      },
      { type: "steer_injected", text: "keep going", timestamp: 103_000 },
      {
        type: "turn_complete",
        reason: "completed",
        durationMs: 8_123,
        completedAt: 108_000,
        timestamp: 108_000,
      },
    ] as StreamEvent[])
      state = applyStreamEvent(state, event);
    expect(group(state.messages, true)).toMatchObject({ isLive: false, durationMs: 8_123 });
    expect(state.messages[0]).toMatchObject({ turnTiming: { durationMs: 8_123, completed: true } });
  });
});

describe("process group reconciliation", () => {
  for (const replacement of [
    tool({ status: "running", endedAt: undefined, argsLive: { file_path: "/a" } }),
    tool({ status: "failed", error: "permission denied" }),
    tool({ result: "new result" }),
  ]) {
    test(`exposes immutable ${JSON.stringify(replacement)} updates with the same tool id`, () => {
      const user: Message = { kind: "user", id: "user", text: "inspect" };
      const before = tool({ status: "running", endedAt: undefined });
      const second = tool({
        id: "second",
        startedAt: 106_000,
        endedAt: undefined,
        status: "running",
      });
      const previous = buildStreamItems([user, before, second], { liveTurnActive: true });
      const next = buildStreamItems([user, replacement, second], { liveTurnActive: true });
      const reconciled = reconcileStreamItems(previous, next);
      expect(reconciled[1]).not.toBe(previous[1]);
      const process = reconciled[1] as TurnProcessGroup;
      const tools = process.items[0];
      expect(tools.kind).toBe("tool_group");
      if (tools.kind === "tool_group") expect(tools.items[0]).toBe(replacement);
    });
  }
});
