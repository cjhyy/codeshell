import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentGroupCard } from "./AgentGroupCard";
import type { AgentGroup } from "./agentGroup";
import type { AgentMessage } from "../types";

const agent = (id: string, o: Partial<AgentMessage> = {}): AgentMessage => ({
  kind: "agent",
  id,
  name: id,
  description: `desc-${id}`,
  done: true,
  startedAt: 0,
  endedAt: 1000,
  toolCalls: [],
  textBuffer: "",
  toolCount: 2,
  ...o,
});

describe("AgentGroupCard", () => {
  test("renders the rollup header: count, success/fail, tool total", () => {
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
    expect(html).toContain("7 tools"); // 4 + 3
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
    // Default-open while running → member cards (names) render.
    expect(html).toContain("explorer");
    expect(html).toContain("worker");
  });
});
