import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMessageView } from "./AgentMessageView";
import type { AgentMessage, ToolMessage } from "../types";

function tool(id: string, name = "Read"): ToolMessage {
  return {
    kind: "tool",
    id,
    toolName: name,
    args: "{}",
    status: "succeeded",
    startedAt: 0,
    endedAt: 10,
    durationMs: 10,
    result: "ok",
  };
}

function agent(over: Partial<AgentMessage> = {}): AgentMessage {
  return {
    kind: "agent",
    id: "A",
    name: "Sub",
    description: "doing work",
    done: false,
    startedAt: 0,
    toolCalls: [],
    textBuffer: "",
    toolCount: 0,
    ...over,
  };
}

describe("AgentMessageView", () => {
  test("folded by default — does not render any tool cards", () => {
    const m = agent({ toolCalls: [tool("t1"), tool("t2")], toolCount: 2 });
    const html = renderToStaticMarkup(<AgentMessageView message={m} />);
    expect(html).toContain("Sub");
    expect(html).toContain("doing work");
    // ToolCard renders elements with className containing "tool-" — confirm
    // none are present while folded.
    expect(html).not.toMatch(/class="[^"]*tool-/);
  });

  test("folded header shows tool count when > 0", () => {
    const m = agent({ toolCount: 3 });
    const html = renderToStaticMarkup(<AgentMessageView message={m} />);
    expect(html).toContain("3 tools");
  });

  test("done agent does not render final text while folded", () => {
    const m = agent({ done: true, text: "final answer" });
    const html = renderToStaticMarkup(<AgentMessageView message={m} />);
    // Header still shows; final text is hidden behind the fold.
    expect(html).toContain("Sub");
    expect(html).not.toContain("final answer");
  });
});
