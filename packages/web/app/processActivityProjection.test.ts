import { expect, test } from "bun:test";
import { initialChatState, reduceStream, type ChatItem } from "../src/lib/streamReducer.js";
import {
  projectProcessActivity,
  currentProcessItems,
  type ProcessItem,
} from "./processActivityProjection.js";

const assistant = (id: string, text: string, done = true): ProcessItem => ({
  kind: "assistant",
  id,
  text,
  reasoning: "",
  done,
});
const tool = (id: string, done = true): ProcessItem => ({
  kind: "tool",
  id,
  name: "Read",
  done,
});

test("real reducer narration and tools collapse together while final paragraphs remain outside", () => {
  let state = initialChatState();
  for (const event of [
    { type: "user_message", text: "Original request" },
    { type: "stream_request_start" },
    { type: "text_delta", text: "Before first tool." },
    { type: "tool_use_start", toolCall: { id: "one", toolName: "Read", args: {} } },
    { type: "tool_result", result: { id: "one", result: "one" } },
    { type: "text_delta", text: "Between tools." },
    { type: "tool_use_start", toolCall: { id: "two", toolName: "Read", args: {} } },
    { type: "tool_result", result: { id: "two", result: "two" } },
    { type: "text_delta", text: "Final first paragraph.\n\nFinal second paragraph." },
    { type: "turn_complete", reason: "completed" },
  ])
    state = reduceStream(state, event);
  const rows = projectProcessActivity(state.items);
  expect(rows.map((row) => row.kind)).toEqual(["user", "process", "answer"]);
  if (rows[1].kind !== "process" || rows[2].kind !== "answer") throw new Error("wrong rows");
  expect(rows[1].items.map((item) => item.kind)).toEqual([
    "assistant",
    "tool",
    "assistant",
    "tool",
  ]);
  expect(rows[2].items.map((item) => item.text)).toEqual([
    "Final first paragraph.\n\nFinal second paragraph.",
  ]);
  expect(rows[1].running).toBe(false);
  expect(rows[2].pending).toBe(false);
});

test("process identity is stable from live tool through terminal hydration; final answer streams outside", () => {
  const items = [assistant("lead", "Checking."), tool("one", false)];
  const live = projectProcessActivity(items, { running: true });
  const final = projectProcessActivity(
    [items[0], tool("one"), assistant("answer", "Answer", false)],
    { running: true },
  );
  const history = projectProcessActivity([items[0], tool("one"), assistant("answer", "Answer")]);
  expect(live[0].id).toBe(final[0].id);
  expect(history[0].id).toBe(final[0].id);
  expect(live[0].kind === "process" && live[0].running).toBe(true);
  expect(final[0].kind === "process" && final[0].running).toBe(false);
  expect(final[1].kind === "answer" && final[1].pending).toBe(true);
  expect(history[1].kind === "answer" && history[1].pending).toBe(false);
});

test("pure thinking and conversational fragments share a stable final-answer container", () => {
  const thinking: ProcessItem = {
    kind: "assistant",
    id: "think",
    text: "",
    reasoning: "Compare options",
    done: true,
  };
  const rows = projectProcessActivity([
    thinking,
    assistant("a", "First."),
    assistant("b", "Second."),
  ]);
  expect(rows.map((row) => row.kind)).toEqual(["answer"]);
  expect(rows[0].kind === "answer" && rows[0].items.map((item) => item.id)).toEqual([
    "think",
    "a",
    "b",
  ]);
  expect(
    projectProcessActivity([assistant("a", "First."), assistant("b", "Second.")]).map(
      (row) => row.kind,
    ),
  ).toEqual(["answer"]);
});

test("reasoning to answer deltas do not change the final assistant's disclosure identity", () => {
  const thinking: ProcessItem = {
    kind: "assistant",
    id: "final",
    text: "",
    reasoning: "Compare",
    done: false,
  };
  for (const prefix of [[], [tool("one")]]) {
    const before = projectProcessActivity([...prefix, thinking], { running: true });
    const after = projectProcessActivity([...prefix, { ...thinking, text: "The answer" }], {
      running: true,
    });
    expect(before.at(-1)?.id).toBe(after.at(-1)?.id);
    expect(before.at(-1)?.kind).toBe("answer");
    expect(after.at(-1)?.kind).toBe("answer");
  }
});

test("errors, approvals, users and subagents remain visible boundaries in their original order", () => {
  const boundaries: ChatItem[] = [
    { kind: "tool", id: "failure", name: "Bash", error: true, done: true },
    { kind: "system_error", id: "error", text: "Failure needs attention" },
    { kind: "system", id: "approval", text: "Approval needed" },
    { kind: "user", id: "followup", text: "My follow-up" },
    { kind: "subagent", id: "agent", agentId: "child", label: "Child", status: "running" },
  ];
  for (const boundary of boundaries) {
    const rows = projectProcessActivity([tool("one"), boundary, tool("two", false)], {
      running: true,
    });
    expect(rows.map((row) => row.kind)).toEqual(["process", boundary.kind, "process"]);
    expect(rows[1]).toBe(boundary);
    expect(rows[0].kind === "process" && rows[0].running).toBe(false);
    expect(rows[2].kind === "process" && rows[2].running).toBe(true);
  }
});

test("agent changes and ambiguous tool ids cannot be hidden inside a shared process", () => {
  const main = tool("main"),
    child = { ...tool("child"), agentId: "child" };
  expect(projectProcessActivity([main, child]).map((row) => row.kind)).toEqual([
    "process",
    "process",
  ]);
  const duplicate = tool("same");
  expect(projectProcessActivity([duplicate, duplicate])).toEqual([duplicate, duplicate]);
  expect(projectProcessActivity([tool("")])).toEqual([tool("")]);
});

test("partial-history copy stays marked partial until an actual visible user boundary", () => {
  const rows = projectProcessActivity(
    [
      assistant("tail", "Partial previous reply."),
      { kind: "system", id: "notice", text: "Notice" },
      assistant("more", "Still same partial turn."),
      { kind: "user", id: "user", text: "A complete new turn" },
      assistant("full", "A complete reply."),
    ],
    { partial: true },
  );
  expect(rows.filter((row) => row.kind === "answer").map((row) => row.partial)).toEqual([
    true,
    true,
    false,
  ]);
});

test("display projection preserves original references and explicit tool evidence without inventing identity", () => {
  const unknown = tool("unverified"),
    verified = { ...tool("verified"), activityGroupKey: "owned/run/turn" };
  const items = [unknown, verified, assistant("answer", "Done")];
  const original = structuredClone(items);
  const rows = projectProcessActivity(items);
  expect(rows[0].kind === "process" && rows[0].items[0]).toBe(unknown);
  expect(rows[0].kind === "process" && rows[0].items[1]).toBe(verified);
  expect("activityGroupKey" in rows[0]).toBe(false);
  expect(items).toEqual(original);
});

test("current preview preserves every pending operation and otherwise only the latest step", () => {
  const old = tool("old"),
    pending = tool("pending", false),
    second = tool("second", false);
  expect(currentProcessItems([old, pending, second])).toEqual([pending, second]);
  expect(currentProcessItems([old, tool("last")])).toEqual([tool("last")]);
});

test("later system/user boundaries cannot make an earlier process look running", () => {
  for (const boundary of [
    { kind: "system", id: "approval", text: "Approval needed" },
    { kind: "user", id: "user", text: "Next request" },
  ] as ChatItem[]) {
    const rows = projectProcessActivity([tool("one"), boundary], { running: true });
    expect(rows[0].kind === "process" && rows[0].running).toBe(false);
  }
});

test("parallel agents keep pending work live without reviving an older user's unfinished turn", () => {
  const rows = projectProcessActivity(
    [
      tool("old", false),
      { kind: "user", id: "new-user", text: "New turn" },
      tool("main-active", false),
      { ...tool("child-active", false), agentId: "child" },
    ],
    { running: true },
  );
  expect(rows.filter((row) => row.kind === "process").map((row) => row.running)).toEqual([
    false,
    true,
    true,
  ]);
});
