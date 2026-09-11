import { expect, test } from "bun:test";
import { StreamAttempt } from "./stream-attempt.js";
import type { ChatEntry } from "./store.js";

test("revoking a failed model request removes its flushed prose and unexecuted tools while preserving unrelated messages", () => {
  const before: ChatEntry[] = [
    { id: "earlier", type: "assistant_text", text: "earlier answer", streaming: false },
  ];
  const concurrent: ChatEntry[] = [
    { id: "child", type: "assistant_text", text: "child", streaming: true, agentId: "child" },
    { id: "user", type: "user", text: "queued user message" },
    { id: "notice", type: "system", subtype: "info", text: "background notice" },
  ];
  const attempt = new StreamAttempt();
  attempt.begin("model-1", before);
  const remaining = attempt.revoke("model-1", [
    ...before,
    { id: "partial", type: "assistant_text", text: "failed partial", streaming: false },
    { id: "thought", type: "thinking" },
    { id: "tool", type: "tool_start", toolName: "Read", args: {}, toolCallId: "tool-1" },
    { id: "running", type: "tool_running", toolName: "Read" },
    ...concurrent,
  ]);
  expect(remaining).toEqual([...before, ...concurrent]);
  expect(attempt.revoke("model-1", remaining!)).toBeNull();
});

test("late or unrelated tombstones cannot remove the current or completed request", () => {
  const attempt = new StreamAttempt();
  attempt.begin("old", []);
  attempt.begin("current", []);
  const entries: ChatEntry[] = [
    { id: "answer", type: "assistant_text", text: "current", streaming: true },
  ];
  expect(attempt.revoke("old", entries)).toBeNull();
  attempt.clear();
  expect(attempt.revoke("current", entries)).toBeNull();
});
