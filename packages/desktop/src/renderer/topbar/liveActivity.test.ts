import { describe, expect, test } from "bun:test";
import { summarizeLiveActivity, describeActivity } from "./liveActivity";
import type { Message, ToolMessage } from "../types";

function tool(over: Partial<ToolMessage>): ToolMessage {
  return {
    kind: "tool",
    id: over.id ?? "t1",
    toolName: over.toolName ?? "Bash",
    args: over.args ?? "{}",
    status: over.status ?? "running",
    startedAt: over.startedAt ?? 1000,
    ...over,
  };
}

function user(id: string): Message {
  return { kind: "user", id, text: "go", startedAt: 0 } as unknown as Message;
}

describe("summarizeLiveActivity", () => {
  test("returns the running tool as primary, only counting the current turn", () => {
    const msgs: Message[] = [
      tool({ id: "old", toolName: "Read", status: "succeeded", startedAt: 1 }),
      user("u1"),
      tool({ id: "a", toolName: "Glob", status: "succeeded", startedAt: 100 }),
      tool({ id: "b", toolName: "Bash", status: "running", startedAt: 200 }),
    ];
    const a = summarizeLiveActivity(msgs);
    expect(a.toolCount).toBe(2); // pre-user Read excluded
    expect(a.toolInFlight).toBe(true);
    expect(a.lastToolName).toBe("Bash");
    expect(a.lastTool?.id).toBe("b");
    expect(a.turnStartedAt).toBe(100);
  });

  test("no tools yet → thinking state", () => {
    const a = summarizeLiveActivity([user("u1")]);
    expect(a.lastTool).toBeNull();
    expect(a.toolInFlight).toBe(false);
    expect(a.toolCount).toBe(0);
  });
});

describe("describeActivity", () => {
  test("thinking when no tool", () => {
    expect(describeActivity(summarizeLiveActivity([user("u")]))).toBe("正在思考…");
  });

  test("Bash shows the command with a present-tense verb while running", () => {
    const a = summarizeLiveActivity([
      user("u"),
      tool({ toolName: "Bash", status: "running", args: JSON.stringify({ command: "bunx vite --host 127.0.0.1" }) }),
    ]);
    expect(describeActivity(a)).toBe("正在运行 bunx vite --host 127.0.0.1");
  });

  test("Edit shows just the basename, not the full path", () => {
    const a = summarizeLiveActivity([
      user("u"),
      tool({ toolName: "Edit", status: "running", args: JSON.stringify({ file_path: "/a/b/ChatView.tsx" }) }),
    ]);
    expect(describeActivity(a)).toBe("正在编辑 ChatView.tsx");
  });

  test("completed tool uses the past-ish verb", () => {
    const a = summarizeLiveActivity([
      user("u"),
      tool({ toolName: "Read", status: "succeeded", args: JSON.stringify({ file_path: "x/types.ts" }) }),
    ]);
    expect(describeActivity(a)).toBe("已读取 types.ts");
  });

  test("prefers argsLive (streaming) over the frozen args snapshot", () => {
    const a = summarizeLiveActivity([
      user("u"),
      tool({
        toolName: "Bash",
        status: "running",
        args: JSON.stringify({ command: "ol" }),
        argsLive: { command: "older-then-newer" },
      }),
    ]);
    expect(describeActivity(a)).toBe("正在运行 older-then-newer");
  });

  test("unknown tool with no recognized arg falls back to verb + tool name", () => {
    const a = summarizeLiveActivity([
      user("u"),
      tool({ toolName: "TodoWrite", status: "running", args: "{}" }),
    ]);
    expect(describeActivity(a)).toBe("正在运行 TodoWrite");
  });
});
