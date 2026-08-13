/**
 * Fixtures are the SHAPES MEASURED from real `claude 2.1.220`
 * (`--output-format stream-json --include-partial-messages`), not invented ones.
 * A fixture that does not match the wire is how a translator test passes while
 * the translator is wrong.
 */
import { describe, expect, test } from "bun:test";
import { ClaudeEventTranslator } from "./event-translator.js";

function translator() {
  return new ClaudeEventTranslator({ sessionId: "sess-a" });
}

const INIT = {
  type: "system",
  subtype: "init",
  session_id: "72b26192-fdde-4dfa-8055-2ec9982abbad",
  tools: [],
};
const MESSAGE_START = { type: "stream_event", event: { type: "message_start" } };
const textDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const toolStart = (id: string, name: string) => ({
  type: "stream_event",
  event: {
    type: "content_block_start",
    content_block: { type: "tool_use", id, name, input: {}, caller: { type: "direct" } },
  },
});
const inputDelta = (partial: string) => ({
  type: "stream_event",
  event: {
    type: "content_block_delta",
    delta: { type: "input_json_delta", partial_json: partial },
  },
});
const BLOCK_STOP = { type: "stream_event", event: { type: "content_block_stop" } };
const toolResult = (id: string, content: string, isError = false) => ({
  type: "user",
  message: {
    role: "user",
    content: [{ tool_use_id: id, type: "tool_result", content, is_error: isError }],
  },
});
const result = (subtype: string, isError = false) => ({
  type: "result",
  subtype,
  is_error: isError,
  terminal_reason: "completed",
});

describe("ClaudeEventTranslator", () => {
  test("system/init keeps the business session id and records Claude's resume id separately", () => {
    const t = translator();
    const events = t.translate(INIT);
    expect(events).toEqual([{ type: "session_started", sessionId: "sess-a", promptTokens: 0 }]);
    expect(t.runtimeSessionId).toBe(INIT.session_id);
  });

  test("session_started fires only once", () => {
    const t = translator();
    t.translate(INIT);
    expect(t.translate(INIT)).toEqual([]);
  });

  test("message_start opens a stream request and turns increment", () => {
    const t = translator();
    expect(t.translate(MESSAGE_START)).toEqual([{ type: "stream_request_start", turnNumber: 1 }]);
    expect(t.translate(MESSAGE_START)).toEqual([{ type: "stream_request_start", turnNumber: 2 }]);
  });

  test("text deltas stream through", () => {
    const t = translator();
    expect(t.translate(textDelta("I"))).toEqual([{ type: "text_delta", text: "I" }]);
    expect(t.translate(textDelta("'ll run that."))).toEqual([
      { type: "text_delta", text: "'ll run that." },
    ]);
  });

  test("the assistant message is ignored so text is not doubled", () => {
    // `assistant` repeats the full message text the deltas already delivered.
    const t = translator();
    t.translate(textDelta("hello"));
    const events = t.translate({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    });
    expect(events).toEqual([]);
  });

  test("a native tool call produces a start, buffered args, and a result", () => {
    const t = translator();
    expect(t.translate(toolStart("toolu_1", "Bash"))).toEqual([
      { type: "tool_use_start", toolCall: { id: "toolu_1", toolName: "Bash", args: {} } },
    ]);
    // Arguments arrive as JSON fragments; nothing is emitted until they parse.
    expect(t.translate(inputDelta('{"command": "echo hi'))).toEqual([]);
    expect(t.translate(inputDelta('", "description": "Echo hi'))).toEqual([]);
    expect(t.translate(inputDelta('"}'))).toEqual([]);
    expect(t.translate(BLOCK_STOP)).toEqual([
      {
        type: "tool_use_args_delta",
        toolCallId: "toolu_1",
        args: { command: "echo hi", description: "Echo hi" },
      },
    ]);
    expect(t.translate(toolResult("toolu_1", "hi"))).toEqual([
      { type: "tool_result", result: { id: "toolu_1", toolName: "Bash", result: "hi" } },
    ]);
  });

  test("a truncated argument fragment does not fail the turn", () => {
    const t = translator();
    t.translate(toolStart("toolu_2", "Bash"));
    t.translate(inputDelta('{"command": "unterminated'));
    expect(t.translate(BLOCK_STOP)).toEqual([]);
  });

  test("a tool error is marked as one", () => {
    const t = translator();
    t.translate(toolStart("toolu_3", "Bash"));
    expect(t.translate(toolResult("toolu_3", "boom", true))).toEqual([
      {
        type: "tool_result",
        result: { id: "toolu_3", toolName: "Bash", result: "boom", isError: true },
      },
    ]);
  });

  test("a CodeShell Host Tool gets NO card from this side", () => {
    // §15.2: ToolExecutor already emits the lifecycle. A second card from here
    // would show one operation twice, from two unsynchronised sources.
    const t = translator();
    expect(t.translate(toolStart("toolu_9", "mcp__codeshell_tools__Panel"))).toEqual([]);
    t.translate(inputDelta('{"action": "list"}'));
    expect(t.translate(BLOCK_STOP)).toEqual([]);
    expect(t.translate(toolResult("toolu_9", "quickChat"))).toEqual([]);
  });

  test("a THIRD-PARTY mcp tool still gets a card", () => {
    // Other servers have no CodeShell-side lifecycle, so suppressing them would
    // lose the card entirely.
    const t = translator();
    const events = t.translate(toolStart("toolu_8", "mcp__figma__get_file"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "tool_use_start" });
  });

  test("a suppressed tool's arg deltas do not leak into the next tool", () => {
    const t = translator();
    t.translate(toolStart("toolu_a", "mcp__codeshell_tools__Panel"));
    t.translate(inputDelta('{"action":"list"}'));
    t.translate(BLOCK_STOP);
    t.translate(toolStart("toolu_b", "Bash"));
    t.translate(inputDelta('{"command":"ls"}'));
    expect(t.translate(BLOCK_STOP)).toEqual([
      { type: "tool_use_args_delta", toolCallId: "toolu_b", args: { command: "ls" } },
    ]);
  });

  test.each([
    ["success", false, "completed"],
    ["error_max_turns", false, "max_turns"],
    ["error_during_execution", false, "model_error"],
    ["success", true, "model_error"],
  ])("result subtype %p (is_error=%p) maps to %p", (subtype, isError, expected) => {
    // max_turns must not be reported as a model error — that sends a reader
    // looking for an outage that never happened.
    const t = translator();
    expect(t.translate(result(subtype, isError))).toEqual([
      { type: "turn_complete", reason: expected as never },
    ]);
  });

  test("a duplicate result closes the turn only once", () => {
    const t = translator();
    expect(t.translate(result("success"))).toHaveLength(1);
    expect(t.translate(result("success"))).toEqual([]);
  });

  test("a second turn reports its own terminal event", () => {
    const t = translator();
    expect(t.translate(result("success"))).toHaveLength(1);
    t.beginTurn();
    expect(t.translate(result("success"))).toEqual([
      { type: "turn_complete", reason: "completed" },
    ]);
  });

  test("result preserves usage and execution error detail", () => {
    const t = translator();
    expect(
      t.translate({
        ...result("error_during_execution", true),
        result: "permission denied",
        usage: {
          input_tokens: 20,
          output_tokens: 3,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 2,
        },
      }),
    ).toEqual([
      {
        type: "usage_update",
        promptTokens: 20,
        completionTokens: 3,
        cacheReadTokens: 10,
        cacheCreationTokens: 2,
        promptTokensSource: "provider_usage",
        promptTokensConfidence: "high",
      },
      { type: "error", error: "permission denied" },
      { type: "turn_complete", reason: "model_error" },
    ]);
  });

  test("unknown and malformed lines are ignored rather than throwing", () => {
    const t = translator();
    expect(t.translate({ type: "rate_limit_event", rate_limit_info: {} })).toEqual([]);
    expect(t.translate({ type: "some_future_type" })).toEqual([]);
    expect(t.translate({ type: "stream_event" })).toEqual([]);
    expect(t.translate(null)).toEqual([]);
    expect(t.translate("not an object")).toEqual([]);
    expect(t.translate({})).toEqual([]);
  });
});
