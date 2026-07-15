import { describe, expect, test } from "bun:test";
import { initialChatState, reduceStream } from "../src/lib/streamReducer.js";
import { chatFromTranscript, sessionTitle } from "./chat.js";

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
    expect(state.items).toEqual([{ kind: "user", id: "h-1", text: "question" }]);
  });

  test("sessionTitle falls back to id prefix", () => {
    expect(sessionTitle(undefined, "abcdef123456")).toBe("abcdef12");
  });
});
