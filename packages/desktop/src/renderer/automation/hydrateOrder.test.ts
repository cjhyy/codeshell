import { describe, it, expect } from "bun:test";
import { chooseHydrateBase, mergeHistoryIntoLive } from "./hydrateOrder";
import { applyStreamEvent, INITIAL_STATE, type Message, type MessagesReducerState } from "../types";

const stateOf = (m: Message[]): MessagesReducerState => ({ ...INITIAL_STATE, messages: m });
const user = (id: string, text: string): Message => ({ kind: "user", id, text });
const tool = (id: string, n: string, a: string): Message => ({ kind: "tool", id, toolName: n, args: a, status: "ok", startedAt: 0 });

describe("chooseHydrateBase", () => {
  it("uses disk (merged) when disk has messages — local-only redundant tools don't tail", () => {
    const disk = stateOf([user("d1", "汇总"), tool("d2", "WebSearch", "{}")]);
    const local = stateOf([user("l1", "汇总"), tool("l2", "WebSearch", "{}")]); // same content
    const out = chooseHydrateBase(disk, local);
    expect(out.messages.filter((m) => m.kind === "tool")).toHaveLength(1);
    expect(out.messages.map((m) => m.kind)).toEqual(["user", "tool"]);
  });

  it("falls back to local when disk is empty", () => {
    const local = stateOf([user("l1", "hi")]);
    expect(chooseHydrateBase(INITIAL_STATE, local)).toBe(local);
  });
});

describe("mergeHistoryIntoLive", () => {
  const assistant = (id: string, text: string): Message => ({
    kind: "assistant", id, text, done: true,
  });

  it("keeps newer durable turns when the live bucket only contains an old cached turn", () => {
    const history = stateOf([
      user("old-user", "old question"),
      assistant("old-answer", "old answer"),
      user("cron-user", "scheduled question"),
      assistant("cron-answer", "scheduled answer"),
    ]);
    const live = stateOf([
      user("cached-user", "old question"),
      assistant("cached-answer", "old answer"),
    ]);

    expect(mergeHistoryIntoLive(history, live).messages).toEqual(history.messages);
  });

  it("never truncates unrelated history because a new assistant starts with the same text", () => {
    const history = stateOf([
      user("old-user", "old question"),
      assistant("old-answer", "好的，我已处理。"),
      user("later-user", "later question"),
      assistant("later-answer", "later answer"),
    ]);
    let live = applyStreamEvent(INITIAL_STATE, { type: "stream_request_start", turnNumber: 1 });
    live = applyStreamEvent(live, { type: "text_delta", text: "好的" });

    const merged = mergeHistoryIntoLive(history, live);
    expect(merged.messages.slice(0, history.messages.length)).toEqual(history.messages);
    expect(merged.messages.at(-1)).toMatchObject({ kind: "assistant", text: "好的" });
  });

  it("deduplicates stable tool ids when an unmatched live message precedes the overlap", () => {
    const history = stateOf([user("user", "question"), tool("call-1", "Read", '{"path":"a"}')]);
    const live = stateOf([
      { kind: "system", id: "live-notice", text: "live notice" },
      tool("call-1", "Read", "{}"),
    ]);

    const merged = mergeHistoryIntoLive(history, live);
    expect(merged.messages.filter((message) => message.id === "call-1")).toHaveLength(1);
    expect(merged.messages[0]).toEqual(history.messages[0]);
  });

  it("keeps a streaming message addressable when disk contains its text under a replay id", () => {
    let live = applyStreamEvent(INITIAL_STATE, { type: "stream_request_start", turnNumber: 1 });
    live = applyStreamEvent(live, { type: "text_delta", text: "hello" });
    const history = stateOf([user("user", "question"), assistant("replayed-answer", "hello")]);

    const merged = mergeHistoryIntoLive(history, live);
    const continued = applyStreamEvent(merged, { type: "text_delta", text: " world" });
    const replies = continued.messages.filter((message) => message.kind === "assistant");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: live.streamingAssistantId, text: "hello world" });
  });

  it("keeps historical usage when session_started has only seeded an empty live bucket", () => {
    const history: MessagesReducerState = {
      ...stateOf([user("user", "question")]),
      cumulativePromptTokens: 900,
      cumulativeCacheReadTokens: 400,
      cumulativeCacheCreationTokens: 100,
      sessionPromptTokens: 900,
      sessionCacheReadTokens: 400,
      sessionCacheCreationTokens: 100,
      turnEpoch: 3,
    };
    const live = applyStreamEvent(INITIAL_STATE, { type: "session_started", sessionId: "session" });

    expect(mergeHistoryIntoLive(history, live)).toMatchObject({
      messages: history.messages,
      sessionId: "session",
      cumulativePromptTokens: 900,
      cumulativeCacheReadTokens: 400,
      cumulativeCacheCreationTokens: 100,
      sessionPromptTokens: 900,
      sessionCacheReadTokens: 400,
      sessionCacheCreationTokens: 100,
      turnEpoch: 3,
    });
  });
});
