import { expect, test } from "bun:test";
import { groupToolActivity, type ActivityTool } from "./toolActivityGroups.js";
import type { ChatItem } from "../src/lib/streamReducer.js";

const tool = (id: string, extra: Partial<ActivityTool> = {}): ActivityTool => ({
  kind: "tool",
  id,
  name: "Read",
  done: true,
  activityGroupKey: "owned/run-1/turn-1/main",
  ...extra,
});

test("only adjacent completed tools with explicit equal run/turn/source identity form one group", () => {
  const items = [
    tool("a"),
    tool("b"),
    tool("c", { activityGroupKey: "owned/run-2/turn-1/main" }),
    tool("d", { activityGroupKey: "owned/run-2/turn-1/main" }),
  ];
  const rows = groupToolActivity(items);
  expect(rows.map((row) => row.kind)).toEqual(["tool_group", "tool_group"]);
  expect(rows.flatMap((row) => (row.kind === "tool_group" ? row.items : [row]))).toEqual(items);
  expect(rows[0].id).toBe(groupToolActivity([...items.slice(0, 2), tool("new")])[0].id);
});

test("unknown identities, different agents, duplicate IDs, running and failed tools stay independent", () => {
  for (const items of [
    [tool("a", { activityGroupKey: undefined }), tool("b", { activityGroupKey: undefined })],
    [tool("a"), tool("b", { agentId: "worker" })],
    [tool("a"), tool("a")],
    [tool("a"), tool("b", { done: false }), tool("c")],
    [tool("a"), tool("b", { error: true }), tool("c")],
  ])
    expect(groupToolActivity(items)).toEqual(items);
});

test("grouping never crosses text, subagent or system/approval boundaries", () => {
  const boundaries: ChatItem[] = [
    {
      kind: "user",
      id: "u",
      text: "keep my text",
      attachments: [{ name: "keep.txt", path: "keep.txt", size: 4 }],
    },
    { kind: "assistant", id: "a", text: "answer", reasoning: "", done: true },
    { kind: "system", id: "s", text: "approval recorded" },
    { kind: "subagent", id: "sub", agentId: "worker", label: "worker", status: "running" },
  ];
  for (const boundary of boundaries) {
    const items = [tool("one"), boundary, tool("two")];
    expect(groupToolActivity(items)).toEqual(items);
  }
});
