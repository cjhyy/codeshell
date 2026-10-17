import { test, expect } from "bun:test";
import { SessionIndex } from "../../../packages/pet/src/session-index";
import { locateClosureWindow } from "../../../packages/pet/src/segment-closure";
import { buildImSessionList, resolveImSessionOrdinal } from "../../../packages/pet/src/im-session-list";

test("Pet projection ignores child terminals and previous-run completion", () => {
  const index = new SessionIndex();
  index.replaceCatalog({ owner: "local-user", sessions: [{ sessionId: "parent", kind: "work", updatedAt: 1 }], observedAt: 1 });
  const send = (version: number, event: any) => index.applyStreamEvent({ sessionId: "parent", generation: 1, version, observedAt: 100 + version, event });
  send(1, { type: "session_started", sessionId: "parent", promptTokens: 0, runId: "old" });
  send(2, { type: "session_started", sessionId: "parent", promptTokens: 0, runId: "current", previousRunId: "old" });
  send(3, { type: "turn_complete", reason: "completed", runId: "old" });
  send(4, { type: "turn_complete", reason: "completed", runId: "child-run", agentId: "child" });
  expect(index.get("parent")).toMatchObject({ runState: "running", runId: "current" });
  expect(index.get("parent")?.terminal).toBeUndefined();
  expect(index.applyStreamEvent({ sessionId: "parent", generation: 1, version: 2, observedAt: 999, event: { type: "turn_complete", reason: "completed", runId: "current" } })).toBe(false);
  send(5, { type: "turn_complete", reason: "completed", runId: "current" });
  expect(index.get("parent")?.terminal).toMatchObject({ status: "completed", runId: "current" });
});

test("Pet segment closure is keyed by exact client identity for repeated prose", () => {
  const messages = [
    { role: "user" as const, text: "continue", clientMessageId: "one" },
    { role: "assistant" as const, text: "same answer" },
    { role: "user" as const, text: "continue", clientMessageId: "two" },
    { role: "assistant" as const, text: "same answer" },
    { role: "user" as const, text: "continue", clientMessageId: "three" },
  ];
  expect(locateClosureWindow(messages, "two", "three")).toEqual({ messages: messages.slice(2, 4), range: { start: 2, end: 4 } });
  expect(locateClosureWindow(messages, "missing", "three")).toBeNull();
  expect(locateClosureWindow(messages, "three", "two")).toBeNull();
});

test("Pet rendered session ordinals use only actual filtered rows", () => {
  const rows = buildImSessionList([
    { selector: "hidden", title: "Archived", runState: "terminal", terminal: { status: "completed", at: 1 }, archived: true, updatedAt: 1 },
    { selector: "active", title: "Active", runState: "running", updatedAt: 2 },
    { selector: "finished", title: "Finished", runState: "terminal", terminal: { status: "completed", at: 3 }, updatedAt: 3 },
  ]);
  expect(rows.map(row => [row.ordinal, row.selector, row.status])).toEqual([[1, "active", "running"], [2, "finished", "completed"]]);
  expect(resolveImSessionOrdinal(rows, 2)?.selector).toBe("finished");
  expect(resolveImSessionOrdinal(rows, 3)).toBeUndefined();
  expect(resolveImSessionOrdinal(rows, 1.5)).toBeUndefined();
});
