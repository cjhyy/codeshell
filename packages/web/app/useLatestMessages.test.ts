import { expect, test } from "bun:test";
import type { ChatItem } from "../src/lib/streamReducer.js";
import { outputChanged } from "./useLatestMessages.js";

const assistant: ChatItem = {
  kind: "assistant",
  id: "reply",
  text: "First paragraph",
  reasoning: "",
  done: false,
};
test("unchanged transport replay does not count as new output", () => {
  const tool: ChatItem = {
    kind: "tool",
    id: "tool",
    name: "Read",
    args: { path: "notes.md" },
    done: false,
  };
  for (const item of [assistant, tool, { kind: "system", id: "notice", text: "Ready" } as ChatItem])
    expect(outputChanged(item, structuredClone(item))).toBe(false);
});
test("streaming text, reasoning, results and completion remain visible changes", () => {
  expect(outputChanged(assistant, { ...assistant, text: "First paragraph\nNext paragraph" })).toBe(
    true,
  );
  expect(outputChanged(assistant, { ...assistant, reasoning: "New reasoning" })).toBe(true);
  expect(outputChanged(assistant, { ...assistant, done: true })).toBe(true);
  const tool: ChatItem = { kind: "tool", id: "tool", name: "Read", done: false };
  expect(outputChanged(tool, { ...tool, result: "Read result", done: true })).toBe(true);
  expect(outputChanged(tool, { ...tool, args: { path: "notes.md" } })).toBe(true);
});
test("new output has an identity while optimistic user echoes do not create notices", () => {
  expect(outputChanged(undefined, assistant)).toBe(true);
  expect(outputChanged(undefined, { kind: "user", id: "user", text: "My task" })).toBe(false);
  expect(
    outputChanged(
      { kind: "subagent", id: "child", agentId: "child", label: "Task", status: "running" },
      { kind: "subagent", id: "child", agentId: "child", label: "Task", status: "done" },
    ),
  ).toBe(true);
});
test("completed empty assistant placeholders match the transcript's hidden-message rule", () => {
  expect(outputChanged(undefined, { ...assistant, text: "", reasoning: "", done: true })).toBe(
    false,
  );
  expect(outputChanged(assistant, { ...assistant, text: "", reasoning: "", done: true })).toBe(
    false,
  );
});
