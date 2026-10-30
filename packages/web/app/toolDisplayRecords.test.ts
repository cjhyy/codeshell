import { expect, test } from "bun:test";
import type { ChatItem } from "../src/lib/streamReducer.js";
import { groupToolActivity, type ActivityTool } from "./toolActivityGroups.js";
import { foldToolDisplayRecords, isInvisibleAssistant } from "./toolDisplayRecords.js";

const tool = (id: string, extra: Partial<ActivityTool> = {}): ActivityTool => ({
  kind: "tool",
  id,
  name: "commandExecution",
  done: true,
  detailRef: `opaque-${id}`,
  ...extra,
});
const empty: Extract<ChatItem, { kind: "assistant" }> = {
  kind: "assistant",
  id: "empty",
  text: "",
  reasoning: "",
  done: true,
};
const fold = (items: ChatItem[]) => foldToolDisplayRecords(groupToolActivity(items));

test("unkeyed live and differently verified tools form display records without inventing identity", () => {
  const items = [
    tool("a"),
    tool("b", { activityGroupKey: "run-one" }),
    tool("c", { activityGroupKey: "run-two" }),
    tool("d", { activityGroupKey: "run-two" }),
  ];
  const original = structuredClone(items);
  expect(groupToolActivity(items).map((row) => row.kind)).toEqual(["tool", "tool", "tool_group"]);
  const rows = fold(items);
  expect(rows).toHaveLength(1);
  expect(rows[0].kind).toBe("tool_records");
  if (rows[0].kind !== "tool_records") throw new Error("expected display records");
  expect(rows[0].items).toEqual(items);
  rows[0].items.forEach((item, index) => expect(item).toBe(items[index]));
  expect(items).toEqual(original);
  expect("activityGroupKey" in rows[0]).toBe(false);
});

test("a lone verified group retains its existing identity and presentation", () => {
  const strict = groupToolActivity([
    tool("a", { activityGroupKey: "same" }),
    tool("b", { activityGroupKey: "same" }),
  ]);
  expect(foldToolDisplayRecords(strict)[0]).toBe(strict[0]);
});

test("only the existing invisible done-assistant shape can be crossed for the same agent", () => {
  const tools = [tool("a"), tool("b")];
  const rows = fold([tools[0], empty, tools[1]]);
  expect(rows).toHaveLength(1);
  expect(rows[0].kind === "tool_records" && rows[0].items).toEqual(tools);
  for (const boundary of [
    { ...empty, done: false },
    { ...empty, text: " " },
    { ...empty, reasoning: "think" },
    { ...empty, textDetailRef: "text" },
    { ...empty, reasoningDetailRef: "reasoning" },
    { ...empty, agentId: "other" },
  ])
    expect(fold([tools[0], boundary, tools[1]])).toEqual([tools[0], boundary, tools[1]]);
  expect(isInvisibleAssistant(empty)).toBe(true);
});

test("errors, running tools, visible records, agents and duplicate IDs keep their boundaries", () => {
  const boundaries: ChatItem[] = [
    tool("error", { error: true }),
    tool("running", { done: false }),
    { kind: "user", id: "user", text: "Original request" },
    { kind: "assistant", id: "answer", text: "Answer", reasoning: "", done: true },
    { kind: "system", id: "approval", text: "Approval recorded" },
    { kind: "system_error", id: "failure", text: "Failure" },
    { kind: "subagent", id: "agent", agentId: "child", label: "Child", status: "running" },
  ];
  for (const boundary of boundaries) {
    const items = [tool("a"), boundary, tool("b")];
    expect(fold(items)).toEqual(items);
  }
  for (const items of [
    [tool("a"), tool("b", { agentId: "child" })],
    [tool("same"), tool("same")],
    [tool(""), tool("b")],
  ])
    expect(fold(items)).toEqual(items);
});

test("a single completed tool stays independently expandable and display group IDs remain stable", () => {
  const first = tool("a"),
    second = tool("b");
  expect(fold([first])).toEqual([first]);
  expect(fold([first, second])[0].id).toBe(fold([first, second, tool("c")])[0].id);
});
