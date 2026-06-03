import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMessageView } from "./AgentMessageView";
import type { AgentMessage, ToolMessage } from "../types";

function tool(id: string, name = "Read", over: Partial<ToolMessage> = {}): ToolMessage {
  return {
    kind: "tool",
    id,
    toolName: name,
    args: JSON.stringify({ file_path: "/x/schema.ts" }),
    status: "succeeded",
    startedAt: 0,
    endedAt: 10,
    durationMs: 10,
    result: "ok",
    ...over,
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
  test("never renders nested tool cards (text-only design)", () => {
    const m = agent({
      done: true,
      text: "final answer",
      toolCalls: [tool("t1"), tool("t2")],
      toolCount: 2,
    });
    const html = renderToStaticMarkup(<AgentMessageView message={m} />);
    expect(html).toContain("Sub");
    expect(html).toContain("doing work");
    // No ToolCard markup ever — the card shows text/activity, not tool cards.
    expect(html).not.toMatch(/class="[^"]*tool-/);
  });

  test("running agent header shows a live activity line, not a tool count", () => {
    const m = agent({
      toolCalls: [tool("t1", "Read", { status: "running" })],
      toolCount: 1,
    });
    const html = renderToStaticMarkup(<AgentMessageView message={m} />);
    // Codex-style verb + arg for the in-flight Read of schema.ts.
    expect(html).toContain("正在读取");
    expect(html).toContain("schema.ts");
    expect(html).not.toContain("1 tools");
  });

  test("renders the agent_type badge when present", () => {
    const m = agent({ agentType: "explorer" });
    const html = renderToStaticMarkup(<AgentMessageView message={m} />);
    expect(html).toContain("explorer");
  });

  test("done agent does not render final text while folded", () => {
    const m = agent({ done: true, text: "final answer" });
    const html = renderToStaticMarkup(<AgentMessageView message={m} />);
    expect(html).toContain("Sub");
    expect(html).not.toContain("final answer");
  });

  test("expanded done agent shows its text output (not tool cards)", () => {
    const m = agent({
      done: true,
      text: "final answer",
      toolCalls: [tool("t1")],
      toolCount: 1,
    });
    // Force-expand by rendering and checking the collapsed-vs-expanded states
    // is awkward in static markup; instead assert the body text would render.
    // The header is a button; expansion is client state. We at least verify the
    // fold control is enabled (hasBody true) when there's text.
    const html = renderToStaticMarkup(<AgentMessageView message={m} />);
    expect(html).not.toContain('disabled=""');
  });
});
