import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentGroupCard } from "./AgentGroupCard";
import type { AgentGroup } from "./agentGroup";
import type { AgentMessage, ToolMessage } from "../types";

const agent = (id: string, o: Partial<AgentMessage> = {}): AgentMessage => ({
  kind: "agent",
  id,
  name: id,
  description: `desc-${id}`,
  done: true,
  startedAt: 0,
  endedAt: 1000,
  toolCalls: Array.from(
    { length: o.toolCount ?? 2 },
    (_, index): ToolMessage => ({
      kind: "tool",
      id: `${id}-tool-${index}`,
      toolName: "Bash",
      args: JSON.stringify({ command: `bun test retained-${id}-${index}` }),
      status: "succeeded",
      startedAt: 0,
      result: "Retained operation output",
    }),
  ),
  textBuffer: "",
  toolCount: 2,
  ...o,
});

describe("AgentGroupCard", () => {
  test("renders group counts and elapsed time without tool metrics or records", () => {
    const group: AgentGroup = {
      kind: "agent_group",
      id: "ag-a",
      agents: [
        agent("a", { done: true, endedAt: 3000, startedAt: 0, toolCount: 4 }),
        agent("b", { error: "boom", done: true, endedAt: 2000, startedAt: 500, toolCount: 3 }),
      ],
    };
    const html = renderToStaticMarkup(<AgentGroupCard group={group} />);
    expect(html).toContain("2 个子代理");
    expect(html).not.toContain("次工具调用");
    expect(html).not.toContain("tools");
    expect(html).not.toContain('data-message-kind="tool"');
    expect(html).not.toContain("bun test retained");
    expect(group.agents.map((member) => member.toolCalls.length)).toEqual([4, 3]);
    expect(html).toContain("1 已完成");
    expect(html).toContain("1 失败");
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("aria-controls=");
    expect(html).not.toContain("desc-a");
    // wall-clock 3000-0 = 3.0s, shown because nothing is running.
    expect(html).toContain("3.0s");
  });

  test("a running member opens the card and member names are visible", () => {
    const group: AgentGroup = {
      kind: "agent_group",
      id: "ag-x",
      agents: [
        agent("explorer", { done: true, endedAt: 1000 }),
        agent("worker", { done: false, endedAt: undefined }),
      ],
    };
    const html = renderToStaticMarkup(<AgentGroupCard group={group} />);
    expect(html).toContain("运行中");
    expect(html).toContain("1 已完成");
    expect(html).toContain("1 运行中");
    expect(html).not.toContain("次工具调用");
    expect(html).not.toContain('data-message-kind="tool"');
    // Default-open while running → member cards (names) render.
    expect(html).toContain("explorer");
    expect(html).toContain("worker");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("cs-agent-group-body");
  });
});
