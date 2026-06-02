import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveActivityLine } from "./LiveActivityLine";
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

describe("LiveActivityLine", () => {
  test("running tool shows present-tense text with the shimmer class", () => {
    const msgs: Message[] = [
      user("u"),
      tool({ toolName: "Read", status: "running", args: JSON.stringify({ file_path: "/a/b/automationMemory.ts" }) }),
    ];
    const html = renderToStaticMarkup(<LiveActivityLine messages={msgs} running={true} />);
    expect(html).toContain("正在读取 automationMemory.ts");
    expect(html).toContain("cs-live-shimmer");
  });

  test("not running shows done-tense text and no shimmer class", () => {
    const msgs: Message[] = [
      user("u"),
      tool({ toolName: "Read", status: "succeeded", args: JSON.stringify({ file_path: "/a/b/automationMemory.ts" }) }),
    ];
    const html = renderToStaticMarkup(<LiveActivityLine messages={msgs} running={false} />);
    expect(html).toContain("已读取 automationMemory.ts");
    expect(html).not.toContain("cs-live-shimmer");
  });

  test("no tools yet → thinking text while running", () => {
    const html = renderToStaticMarkup(<LiveActivityLine messages={[user("u")]} running={true} />);
    expect(html).toContain("正在思考");
    expect(html).toContain("cs-live-shimmer");
  });
});
