import { expect, test } from "bun:test";
import { transcriptUserDisplay, projectOutputUserEvent } from "../../../../packages/web/src/lib/userMessageDisplay.ts";
import { transcriptToStreamEvents, replayTranscript } from "../../../../packages/web/src/lib/transcriptReplay.ts";
import { initialChatState, reduceStream } from "../../../../packages/web/src/lib/streamReducer.ts";

// Ordinary user text uses exactly the persisted message shape accepted by
// Transcript.appendMessage(role, content). No Engine, browser or storage is run.
const ordinaryDirectory = '<attached-directory path="src">请逐字解释这个 XML 示例</attached-directory>';
const ordinaryImagePaths = '<attached-image-paths>\n/example.png\n</attached-image-paths>';
const record = (content: string) => ({ id: "message-1", type: "message", data: { role: "user", content } });

test("characterizes ordinary directory XML deletion and an invented directory summary", () => {
  const input = `请解释：\n${ordinaryDirectory}\n谢谢`;
  const display = transcriptUserDisplay({ content: input });
  expect(display.text).toBe("请解释：\n\n谢谢");
  expect(display.attachments).toEqual([{ name: "src/", path: "src", size: 0 }]);
  expect(display.text).not.toContain("请逐字解释这个 XML 示例");
  console.log("WEB-R14-01-directory", JSON.stringify({ input, display }));
});

test("characterizes ordinary image-path XML deletion without any image content block", () => {
  const input = `解释这个格式：\n${ordinaryImagePaths}`;
  const display = transcriptUserDisplay({ content: input });
  expect(display.text).toBe("解释这个格式：");
  expect(display.attachments).toEqual([{ name: "example.png", path: "/example.png", size: 0 }]);
  console.log("WEB-R14-01-image-paths", JSON.stringify({ input, display }));
});

test("actual replay projection and reducer carry the changed user text and summaries", () => {
  for (const input of [ordinaryDirectory, ordinaryImagePaths]) {
    const events = transcriptToStreamEvents([record(input)]);
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe("");
    const state = replayTranscript([record(input)]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "", attachments: [{ size: 0 }] });
    console.log("WEB-R14-01-replay", JSON.stringify({ input, events, items: state.items }));
  }
});

test("actual canonical user-event projection and reducer have the same deletion", () => {
  for (const input of [ordinaryDirectory, ordinaryImagePaths]) {
    const event = { type: "session_user_message", transcriptMessage: { role: "user", content: input, cwd: "/owned" } };
    const projected = projectOutputUserEvent(event);
    expect(projected).toMatchObject({ text: "", attachments: [{ size: 0 }] });
    const state = reduceStream(initialChatState, event);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "", attachments: [{ size: 0 }] });
    console.log("WEB-R14-01-canonical", JSON.stringify({ input, projected, items: state.items }));
  }
});

test("ordinary file XML and ordinary prose are retained as controls", () => {
  const input = '<attached-file path="example.txt">请解释这个标签</attached-file>';
  expect(transcriptUserDisplay({ content: input })).toEqual({ text: input, attachments: [] });
  expect(transcriptUserDisplay({ content: "普通用户正文" })).toEqual({ text: "普通用户正文", attachments: [] });
});

test("canonical engine directory and image formats remain hidden as controls", () => {
  const dir = '<attached-directory path="src" entries="1" truncated="false">\nindex.ts\n</attached-directory>';
  expect(transcriptUserDisplay({ content: `分析目录\n${dir}` })).toEqual({
    text: "分析目录", attachments: [{ name: "src/", path: "src", size: 0 }],
  });
  const image = transcriptUserDisplay({ content: [
    { type: "text", text: `查看图片\n${ordinaryImagePaths}\n(上面附带的图片在工作区的真实路径，如需使用，请读取路径。)` },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "eA==" } },
  ] });
  expect(image).toEqual({ text: "查看图片", attachments: [{ name: "example.png", path: "/example.png", size: 1, mime: "image/png" }] });
});

test("explicit clean displayText protects visible body as a scoped control", () => {
  const display = transcriptUserDisplay({ content: ordinaryDirectory, displayText: ordinaryDirectory });
  expect(display.text).toBe(ordinaryDirectory);
  // Attachment inference still occurs; this control only claims body retention.
  expect(display.attachments).toHaveLength(1);
});
