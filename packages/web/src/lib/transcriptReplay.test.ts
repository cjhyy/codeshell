import { describe, expect, test } from "bun:test";
import { Transcript } from "../../../core/src/session/transcript.js";
import {
  appendUserMessage,
  initialChatState,
  reduceStream,
  type ChatState,
} from "./streamReducer.js";
import {
  replayTranscript,
  transcriptToStreamEvents,
  transcriptUserDisplay,
} from "./transcriptReplay.js";

function visible(state: ChatState) {
  return state.items
    .filter((item) => item.kind !== "assistant" || item.text || item.reasoning)
    .map(({ id: _id, ...item }) => item);
}

describe("Core transcript browser replay", () => {
  test("real Transcript events reproduce live user, reasoning, tool and assistant content without duplicate tools", () => {
    const transcript = Transcript.inMemory("web-replay-fixture");
    transcript.append("session_meta", { sessionId: "fixture", cwd: "/workspace" });
    transcript.appendMessage("user", "检查文件", { clientMessageId: "user-1" });
    transcript.appendTurnBoundary();
    transcript.appendMessage("assistant", [
      { type: "reasoning", reasoningContent: "先检查目录。" },
      { type: "text", text: "我来读取文件。" },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
    ]);
    transcript.appendToolUse("Read", "tool-1", { file_path: "README.md" });
    transcript.appendToolResult(
      "tool-1",
      "Read",
      "# CodeShell\n<system-reminder>internal</system-reminder>\n",
    );
    transcript.appendTurnBoundary();
    transcript.appendMessage("assistant", [
      { type: "text", text: "这是一个 **CodeShell** 项目。" },
    ]);

    let live = appendUserMessage(initialChatState(), "检查文件", undefined, "user-1");
    for (const event of [
      { type: "stream_request_start" },
      { type: "thinking_delta", text: "先检查目录。" },
      { type: "text_delta", text: "我来读取文件。" },
      {
        type: "tool_use_start",
        toolCall: { id: "tool-1", toolName: "Read", args: { file_path: "README.md" } },
      },
      { type: "assistant_message" },
      {
        type: "tool_result",
        result: {
          id: "tool-1",
          result: "# CodeShell\n<system-reminder>internal</system-reminder>\n",
        },
      },
      { type: "stream_request_start" },
      { type: "text_delta", text: "这是一个 **CodeShell** 项目。" },
      { type: "assistant_message" },
      { type: "turn_complete", reason: "completed" },
    ])
      live = reduceStream(live, event);

    const replay = replayTranscript(transcript.getEvents());
    expect(visible(replay)).toEqual(visible(live));
    expect(replay.items.filter((item) => item.kind === "tool")).toHaveLength(1);
    expect(replay.items.some((item) => item.kind === "assistant" && !item.done)).toBe(false);
    expect(replay.run).toBe("idle");
    const continued = reduceStream(replay, { type: "text_delta", text: "新的回复" });
    expect(new Set(continued.items.map((item) => item.id)).size).toBe(continued.items.length);
  });

  test("restores attachment-only images without putting base64 or model path hints into visible text", () => {
    const transcript = Transcript.inMemory("web-image-fixture");
    transcript.appendMessage("user", [
      {
        type: "text",
        text: "\n\n<attached-image-paths>\n/workspace/.code-shell/attachments/s1/0123456789abcdef-shot.png\n</attached-image-paths>\n(上面附带的图片在工作区的真实路径，如需把它们作为工具输入（例如 GenerateImage 的 referenceImages、图生图参考图），直接使用这些路径。)",
      },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "eA==" } },
    ]);
    const replay = replayTranscript(transcript.getEvents());
    expect(replay.items).toEqual([
      {
        kind: "user",
        id: "u-1",
        text: "",
        attachments: [
          {
            name: "shot.png",
            size: 1,
            mime: "image/png",
            path: "/workspace/.code-shell/attachments/s1/0123456789abcdef-shot.png",
          },
        ],
      },
    ]);
    expect(JSON.stringify(replay.items)).not.toContain("eA==");
  });

  test("restores files and human displayText while preserving ordinary user-written XML", () => {
    const transcript = Transcript.inMemory("web-file-fixture");
    transcript.appendMessage(
      "user",
      '分析下面的文件\n\n<attached-file path=".code-shell/attachments/s1/0123456789abcdef-notes.txt">\nabsolutePath: /workspace/.code-shell/attachments/s1/0123456789abcdef-notes.txt\nmime: text/plain\nsize: 42\nsha256: test-hash\norigin: mobile\n</attached-file>',
      { displayText: "看看笔记" },
    );
    const user = replayTranscript(transcript.getEvents()).items[0];
    expect(user).toMatchObject({
      kind: "user",
      text: "看看笔记",
      attachments: [{ name: "notes.txt", size: 42, mime: "text/plain" }],
    });
    expect(
      transcriptUserDisplay({
        content: '<attached-file path="example.txt">请解释这个标签</attached-file>',
      }).text,
    ).toContain("请解释这个标签");
  });

  test("filters engine-injected user messages, checkpoints and duplicate event IDs", () => {
    const transcript = Transcript.inMemory("web-injected-fixture");
    const user = transcript.appendMessage("user", "真实问题");
    transcript.appendMessage("user", "internal background notification", { injected: true });
    transcript.appendMessage("user", "agent direction", {
      authority: "agent",
      source: "agent-direction",
    });
    transcript.appendMessage("user", "<system-reminder>legacy notification</system-reminder>");
    transcript.append("context_checkpoint", {
      messages: [{ role: "user", content: "checkpoint copy" }],
    });
    const replay = replayTranscript([
      ...transcript.getEvents(),
      user,
      null,
      [],
      { type: "message", data: [] },
    ]);
    expect(replay.items).toEqual([{ kind: "user", id: "u-1", text: "真实问题" }]);
  });

  test("replays tool errors, structured text results and out-of-order results by ID", () => {
    const transcript = Transcript.inMemory("web-tools-fixture");
    transcript.appendToolResult("t-error", "Bash", undefined, "exit code 1");
    transcript.appendToolUse("Bash", "t-error", { command: "false" });
    transcript.appendToolUse("Read", "t-blocks", { path: "example.png" });
    transcript.appendToolResult("t-blocks", "Read", undefined, undefined, [
      { type: "text", text: "Image dimensions: 2×2" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "private-image-data" },
      },
    ]);
    const tools = replayTranscript(transcript.getEvents()).items.filter(
      (item) => item.kind === "tool",
    );
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      name: "Bash",
      args: { command: "false" },
      done: true,
      error: true,
      result: "exit code 1",
    });
    expect(tools[1]).toMatchObject({ name: "Read", done: true, result: "Image dimensions: 2×2" });
    expect(JSON.stringify(tools)).not.toContain("private-image-data");
  });

  test("provider-shaped tool_result messages never become phantom user bubbles", () => {
    const replay = replayTranscript([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "hello" }] },
    ]);
    expect(replay.items).toHaveLength(1);
    expect(replay.items[0]).toMatchObject({ kind: "tool", result: "hello", done: true });
  });

  test("subagent anchors remain visible without claiming an old child is still running", () => {
    const transcript = Transcript.inMemory("web-child-fixture");
    transcript.appendSubagent("child-1", "资料整理", "整理资料");
    expect(replayTranscript(transcript.getEvents()).items).toEqual([
      {
        kind: "subagent",
        id: "sub-child-1",
        agentId: "child-1",
        label: "资料整理",
        status: "recorded",
      },
    ]);
  });

  test("start-of-turn boundaries never finish the following tool prematurely", () => {
    const transcript = Transcript.inMemory("web-boundary-fixture");
    transcript.appendTurnBoundary();
    transcript.appendToolUse("Write", "pending", { path: "new.txt" });
    const events = transcriptToStreamEvents(transcript.getEvents());
    expect(events.some((event) => event.type === "turn_complete")).toBe(false);
    expect(replayTranscript(transcript.getEvents()).items[0]).toMatchObject({
      kind: "tool",
      done: false,
    });
  });

  test("clientMessageId deduplicates a persisted or broadcast local echo but preserves repeated deliberate text", () => {
    let state = appendUserMessage(initialChatState(), "继续", undefined, "client-1");
    state = reduceStream(state, {
      type: "session_user_message",
      text: "继续",
      clientMessageId: "client-1",
    });
    state = reduceStream(state, {
      type: "user_message",
      text: "继续",
      clientMessageId: "client-2",
    });
    expect(state.items).toHaveLength(2);
    expect(() =>
      reduceStream(state, {
        type: "user_message",
        text: "附件",
        attachments: [null, {}, { name: "bad", size: -1 }],
      }),
    ).not.toThrow();
  });
});
