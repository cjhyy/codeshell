import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import {
  INITIAL_STATE,
  applyStreamEvent,
  appendTurnEndMessage,
  appendUserMessage,
  isCurrentStreamRunEvent,
  type MessagesReducerState,
} from "./types";

const identity = (name: string) => ({ runId: `run-${name}`, clientMessageId: `input-${name}` });
function event(state: MessagesReducerState, name: string, payload: StreamEvent) {
  return applyStreamEvent(state, { ...payload, ...identity(name) }, () => 100);
}
function user(state: MessagesReducerState, name: string) {
  return appendUserMessage(state, name, 1, false, false, undefined, false, `input-${name}`);
}
function start(state: MessagesReducerState, name: string) {
  state = event(state, name, { type: "session_started", sessionId: "session", promptTokens: 0 });
  return event(state, name, {
    type: "stream_request_start",
    turnNumber: 1,
    messageId: `assistant-${name}`,
  });
}
function usage(state: MessagesReducerState, name: string, tokens: number, cached = 0) {
  return event(state, name, {
    type: "usage_update",
    promptTokens: tokens,
    singleTurnPromptTokens: tokens,
    singleTurnCacheReadTokens: cached,
  });
}
function usageBetweenUsers(state: MessagesReducerState, name: string) {
  const start = state.messages.findIndex(
    (message) => message.kind === "user" && message.text === name,
  );
  const next = state.messages.findIndex(
    (message, index) => index > start && message.kind === "user",
  );
  return state.messages
    .slice(start, next < 0 ? undefined : next)
    .filter((message) => message.kind === "turn_usage");
}

describe("stream run ownership", () => {
  test("Stop after injected guidance still updates the original run's usage", () => {
    let state = start(user(INITIAL_STATE, "a"), "a");
    state = usage(state, "a", 100);
    state = applyStreamEvent(state, { type: "steer_injected", id: "steer", text: "guidance" });
    state = appendTurnEndMessage(state, "stopped");
    state = usage(state, "a", 120);
    expect(state.messages.filter((message) => message.kind === "turn_usage")).toMatchObject([
      { promptTokens: 120 },
    ]);
  });
  test("stop then immediate resend keeps old usage before the new user, including late updates", () => {
    let state = start(user(INITIAL_STATE, "a"), "a");
    state = event(state, "a", { type: "text_delta", text: "old partial" });
    state = usage(state, "a", 108_800, 99_800);
    state = appendTurnEndMessage(state, "stopped", 33_000);
    expect(usageBetweenUsers(state, "a")).toMatchObject([
      { promptTokens: 108_800, cacheReadTokens: 99_800 },
    ]);
    state = user(state, "b");
    state = event(state, "a", { type: "text_delta", text: " tail" });
    state = event(state, "a", { type: "turn_complete", reason: "aborted_streaming" });
    expect(state.messages.find((message) => message.id === "assistant-a")).toMatchObject({
      text: "old partial tail",
      done: true,
    });
    expect(usageBetweenUsers(state, "b")).toEqual([]);
    expect(usageBetweenUsers(state, "a")).toMatchObject([{ promptTokens: 108_800 }]);
    expect(
      isCurrentStreamRunEvent(state, {
        type: "turn_complete",
        reason: "aborted_streaming",
        ...identity("a"),
      }),
    ).toBe(false);
    state = start(state, "b");
    state = usage(state, "b", 42, 10);
    expect(usageBetweenUsers(state, "b")).toEqual([]);
    state = usage(state, "a", 108_900, 99_900);
    expect(state.singleTurnPromptTokens).toBe(42);
    expect(state.streamingAssistantId).toBe("assistant-b");
    expect(usageBetweenUsers(state, "a")).toMatchObject([
      { promptTokens: 108_900, cacheReadTokens: 99_900 },
    ]);
    state = event(state, "b", { type: "turn_complete", reason: "completed" });
    expect(usageBetweenUsers(state, "b")).toMatchObject([
      { promptTokens: 42, cacheReadTokens: 10 },
    ]);
    expect(usageBetweenUsers(state, "a")).toHaveLength(1);
  });

  test("late old completion does not finalize the new assistant, tool, thinking or foreground agent", () => {
    let state = start(user(INITIAL_STATE, "a"), "a");
    state = usage(state, "a", 100);
    state = appendTurnEndMessage(state, "stopped");
    state = start(user(state, "b"), "b");
    state = event(state, "b", {
      type: "tool_use_start",
      toolCall: { id: "new-tool", toolName: "Read", args: {} },
    });
    state = event(state, "b", {
      type: "stream_request_start",
      turnNumber: 2,
      messageId: "new-assistant",
    });
    state = event(state, "b", { type: "thinking_delta", text: "new reasoning" });
    state = applyStreamEvent(
      state,
      { type: "agent_start", agentId: "new-agent", description: "new work" },
      () => 200,
    );
    const newThinking = state.streamingThinkingId;
    const newAgent = state.messages[state.agentMessageIndex["new-agent"]!];
    state = event(state, "a", { type: "turn_complete", reason: "completed" });
    expect(state.streamingAssistantId).toBe("new-assistant");
    expect(state.streamingThinkingId).toBe(newThinking);
    expect(state.turnEpoch).toBe(0);
    expect(state.messages.find((message) => message.id === "new-assistant")).toMatchObject({
      done: false,
    });
    expect(state.messages.find((message) => message.id === "new-tool")).toMatchObject({
      status: "running",
    });
    expect(state.messages.find((message) => message.id === newThinking)).toMatchObject({
      done: false,
    });
    expect(state.activeAgents["new-agent"]).toBeDefined();
    expect(state.messages[state.agentMessageIndex["new-agent"]!]).toBe(newAgent);
    state = event(state, "a", { type: "error", error: "late old failure" });
    expect(state.streamingAssistantId).toBe("new-assistant");
    expect(
      state.messages.findIndex(
        (message) => message.kind === "system" && message.text.includes("late old failure"),
      ),
    ).toBeLessThan(
      state.messages.findIndex((message) => message.kind === "user" && message.text === "b"),
    );
  });

  test("a new zero-usage run cannot inherit the previous run's spend", () => {
    let state = start(user(INITIAL_STATE, "a"), "a");
    state = usage(state, "a", 500);
    state = event(state, "a", { type: "turn_complete", reason: "completed" });
    state = start(user(state, "b"), "b");
    state = event(state, "b", { type: "turn_complete", reason: "aborted_streaming" });
    expect(usageBetweenUsers(state, "a")).toMatchObject([{ promptTokens: 500 }]);
    expect(usageBetweenUsers(state, "b")).toEqual([]);
    expect(state.singleTurnPromptTokens).toBe(0);
  });

  test("identity-free legacy terminal events stay with the run until its successor starts", () => {
    let state = appendUserMessage(INITIAL_STATE, "a");
    state = applyStreamEvent(state, {
      type: "session_started",
      sessionId: "session",
      promptTokens: 0,
    });
    state = applyStreamEvent(state, {
      type: "usage_update",
      promptTokens: 100,
      singleTurnPromptTokens: 100,
    });
    state = appendTurnEndMessage(state, "stopped");
    state = appendUserMessage(state, "b");
    state = applyStreamEvent(state, { type: "turn_complete", reason: "aborted_streaming" });
    expect(usageBetweenUsers(state, "a")).toMatchObject([{ promptTokens: 100 }]);
    expect(usageBetweenUsers(state, "b")).toEqual([]);
    state = applyStreamEvent(state, {
      type: "stream_request_start",
      turnNumber: 1,
      messageId: "legacy-new",
    });
    state = applyStreamEvent(state, { type: "text_delta", text: "new legacy reply" });
    expect(state.streamingAssistantId).toBe("legacy-new");
    expect(state.messages.at(-1)).toMatchObject({ kind: "assistant", text: "new legacy reply" });
  });

  test("matching client identity cannot make an older run finalize a newer run on the same user", () => {
    let state = start(user(INITIAL_STATE, "a"), "a");
    state = applyStreamEvent(state, {
      type: "session_started",
      sessionId: "session",
      promptTokens: 0,
      runId: "continuation",
      clientMessageId: "input-a",
    });
    expect(
      isCurrentStreamRunEvent(state, {
        type: "turn_complete",
        reason: "completed",
        ...identity("a"),
      }),
    ).toBe(false);
    expect(
      isCurrentStreamRunEvent(state, {
        type: "turn_complete",
        reason: "completed",
        runId: "continuation",
        clientMessageId: "input-a",
      }),
    ).toBe(true);
  });
});
