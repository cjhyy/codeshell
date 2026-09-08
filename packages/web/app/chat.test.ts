import { describe, expect, test } from "bun:test";
import { initialChatState, reduceStream } from "../src/lib/streamReducer.js";
import { chatFromSnapshot, chatFromTranscript, isNewStreamEvent, sessionTitle } from "./chat.js";

describe("SPA chat state", () => {
  test("tool_use_start + tool_result renders a completed tool item", () => {
    let state = initialChatState();
    state = reduceStream(state, {
      type: "tool_use_start",
      toolCall: { id: "t1", toolName: "Bash" },
    });
    state = reduceStream(state, {
      type: "tool_result",
      result: { id: "t1", result: "ok" },
    });
    const tool = state.items.find((item) => item.kind === "tool");
    expect(tool && tool.kind === "tool" && tool.done).toBe(true);
    expect(tool && tool.kind === "tool" ? tool.result : undefined).toBe("ok");
  });

  test("transcript mapping keeps user/assistant text and seq continuity", () => {
    const state = chatFromTranscript([
      { message: { role: "user", content: "帮我修个 bug" } },
      { message: { role: "assistant", content: [{ type: "text", text: "好的" }] } },
    ]);
    expect(state.items).toHaveLength(2);
    expect(state.seq).toBe(2);
    expect(sessionTitle(state, "abcdef123456")).toBe("帮我修个 bug");
  });

  test("transcript mapping skips system reminders and unknown events", () => {
    const state = chatFromTranscript([
      { message: { role: "user", content: "question" } },
      { message: { role: "user", content: "<system-reminder>internal</system-reminder>" } },
      { type: "tool_result", result: {} },
    ]);
    expect(state.items).toEqual([{ kind: "user", id: "u-1", text: "question" }]);
  });

  test("sessionTitle falls back to id prefix", () => {
    expect(sessionTitle(undefined, "abcdef123456")).toBe("abcdef12");
  });
});

describe("Hub atomic history and live snapshots", () => {
  test("reconnect preserves an unfinished streamed prefix and ignores notifications already covered by the cursor", () => {
    const { chat, cursor } = chatFromSnapshot(
      {
        state: {},
        transcript: [
          { type: "message", data: { role: "user", content: "旧问题" } },
          { type: "message", data: { role: "assistant", content: "旧回复" } },
        ],
        running: true,
        streamCursor: { epoch: "boot-1", sequence: 8 },
        liveStream: {
          truncated: false,
          events: [
            {
              sequence: 4,
              event: { type: "session_user_message", text: "新问题", clientMessageId: "new-user" },
            },
            { sequence: 5, event: { type: "stream_request_start" } },
            { sequence: 6, event: { type: "thinking_delta", text: "检查中" } },
            { sequence: 8, event: { type: "text_delta", text: "已保留的前半段" } },
          ],
        },
      },
      [
        {
          sessionId: "s1",
          hubEpoch: "boot-1",
          hubSequence: 8,
          event: { type: "text_delta", text: "已保留的前半段" },
        },
        {
          sessionId: "s1",
          hubEpoch: "boot-1",
          hubSequence: 9,
          event: { type: "text_delta", text: "，继续输出" },
        },
      ],
    );
    expect(chat.items.filter((item) => item.kind === "user")).toHaveLength(2);
    expect(chat.items.at(-1)).toMatchObject({
      kind: "assistant",
      text: "已保留的前半段，继续输出",
      reasoning: "检查中",
      done: false,
    });
    expect(chat.run).toBe("running");
    expect(cursor).toEqual({ epoch: "boot-1", sequence: 9 });
  });

  test("old-process notifications cannot leak into a snapshot after a server restart", () => {
    const restored = chatFromSnapshot(
      {
        state: {},
        transcript: [],
        running: false,
        streamCursor: { epoch: "boot-new", sequence: 2 },
      },
      [
        {
          sessionId: "s1",
          hubEpoch: "boot-old",
          hubSequence: 100,
          event: { type: "text_delta", text: "stale" },
        },
        {
          sessionId: "s1",
          hubEpoch: "boot-new",
          hubSequence: 3,
          event: { type: "text_delta", text: "fresh" },
        },
      ],
    );
    expect(restored.chat.items).toHaveLength(1);
    expect(restored.chat.items[0]).toMatchObject({ text: "fresh" });
    expect(
      isNewStreamEvent(
        { sessionId: "s1", hubEpoch: "boot-new", hubSequence: 3, event: {} },
        restored.cursor,
      ),
    ).toBe(false);
  });

  test("buffer overflow is exposed and durable history remains readable", () => {
    const restored = chatFromSnapshot({
      state: {},
      transcript: [{ type: "message", data: { role: "assistant", content: "已保存回复" } }],
      running: true,
      liveStream: { events: [], truncated: true },
      streamCursor: { epoch: "boot", sequence: 99 },
    });
    expect(restored.truncated).toBe(true);
    expect(restored.chat.items[0]).toMatchObject({ text: "已保存回复", done: true });
  });

  test("attachment-only active overlay restores its user bubble and deduplicates Core echo", () => {
    const event = {
      type: "session_user_message",
      text: "",
      attachments: [{ name: "notes.txt", size: 12, mime: "text/plain" }],
      clientMessageId: "file-only",
    };
    const restored = chatFromSnapshot({
      state: {},
      transcript: [],
      running: true,
      streamCursor: { epoch: "boot", sequence: 2 },
      liveStream: {
        truncated: false,
        events: [
          { sequence: 1, event },
          { sequence: 2, event },
        ],
      },
    });
    expect(restored.chat.items).toHaveLength(1);
    expect(restored.chat.items[0]).toMatchObject({
      kind: "user",
      text: "",
      attachments: event.attachments,
    });
    expect(sessionTitle(restored.chat, "s1")).toBe("附件：notes.txt");
  });
});
