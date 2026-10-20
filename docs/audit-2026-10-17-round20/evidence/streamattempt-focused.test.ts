import { expect, test } from "bun:test";
import { StreamAttempt } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/ui/stream-attempt.ts";
import type { ChatEntry } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/ui/store.ts";

const prose = (id: string, text = id): ChatEntry => ({
  id,
  type: "assistant_text",
  text,
  streaming: true,
});

test("a wrong tombstone leaves the tracked attempt available for its matching tombstone", () => {
  const attempt = new StreamAttempt();
  const entries = [prose("partial")];
  attempt.begin("request-current", []);
  expect(attempt.revoke("request-old", entries)).toBeNull();
  expect(attempt.revoke("request-current", entries)).toEqual([]);
  expect(attempt.revoke("request-current", entries)).toBeNull();
});

test("begin snapshots IDs rather than retaining a mutable caller array", () => {
  const attempt = new StreamAttempt();
  const original = prose("original");
  const entries = [original];
  attempt.begin("request", entries);
  entries.push(prose("new-after-begin"));
  expect(attempt.revoke("request", entries)).toEqual([original]);
  expect(entries).toHaveLength(2);
});

test("pre-existing rows survive even when their type is a provisional model-row type", () => {
  const before: ChatEntry[] = [
    prose("old-prose"),
    { id: "old-thought", type: "thinking", content: "earlier" },
    { id: "old-start", type: "tool_start", toolName: "Read", args: {} },
    { id: "old-running", type: "tool_running", toolName: "Read" },
  ];
  const attempt = new StreamAttempt();
  attempt.begin("request", before);
  const result = attempt.revoke("request", [...before, prose("partial")]);
  expect(result).toEqual(before);
  expect(result?.every((row, index) => row === before[index])).toBe(true);
});

test("new rows outside the four provisional model types retain their order and identity", () => {
  const retained: ChatEntry[] = [
    { id: "user", type: "user", text: "queued" },
    { id: "result", type: "tool_result", toolName: "Read", result: "old tool completion" },
    { id: "error", type: "error", error: "background notice" },
    { id: "status", type: "status", reason: "waiting" },
    { id: "system", type: "system", subtype: "info", text: "notice" },
    { id: "child-start", type: "agent_start", agentId: "child", description: "work" },
    { id: "child-end", type: "agent_end", agentId: "child", description: "work" },
  ];
  const attempt = new StreamAttempt();
  attempt.begin("request", []);
  const result = attempt.revoke("request", [prose("partial-a"), ...retained, prose("partial-b")]);
  expect(result).toEqual(retained);
  expect(result?.every((row, index) => row === retained[index])).toBe(true);
});

test("every new provisional child row is preserved while equivalent main rows are removed", () => {
  const child: ChatEntry[] = [
    { ...prose("child-prose"), agentId: "child" },
    { id: "child-thought", type: "thinking", agentId: "child" },
    { id: "child-tool", type: "tool_start", toolName: "Read", args: {}, agentId: "child" },
    { id: "child-running", type: "tool_running", toolName: "Read", agentId: "child" },
  ];
  const main: ChatEntry[] = [
    prose("main-prose"),
    { id: "main-thought", type: "thinking" },
    { id: "main-tool", type: "tool_start", toolName: "Read", args: {} },
    { id: "main-running", type: "tool_running", toolName: "Read" },
  ];
  const attempt = new StreamAttempt();
  attempt.begin("request", []);
  expect(attempt.revoke("request", [...child, ...main])).toEqual(child);
});

test("revoke creates a new survivor array and never mutates caller entries or rows", () => {
  const original = Object.freeze(prose("original"));
  const partial = Object.freeze(prose("partial"));
  const entries = [original, partial];
  const attempt = new StreamAttempt();
  attempt.begin("request", Object.freeze([original]));
  const remaining = attempt.revoke("request", entries);
  expect(remaining).not.toBe(entries);
  expect(remaining).toEqual([original]);
  expect(entries).toEqual([original, partial]);
  expect(remaining?.[0]).toBe(original);
});

test("clear cancels the old snapshot and a later begin owns a fresh baseline", () => {
  const attempt = new StreamAttempt();
  const old = prose("old");
  attempt.begin("old-request", [old]);
  attempt.clear();
  expect(attempt.revoke("old-request", [old])).toBeNull();
  const newBaseline = prose("new-baseline");
  attempt.begin("new-request", [newBaseline]);
  expect(attempt.revoke("new-request", [old, newBaseline, prose("partial")])).toEqual([newBaseline]);
});

test("a revoked request can reopen with the same correlation ID and a new baseline", () => {
  const attempt = new StreamAttempt();
  const initial = prose("initial");
  attempt.begin("request", [initial]);
  const afterFailed = attempt.revoke("request", [initial, prose("failed")]);
  expect(afterFailed).toEqual([initial]);
  expect(attempt.revoke("request", afterFailed!)).toBeNull();
  attempt.begin("request", afterFailed!);
  expect(attempt.revoke("request", [initial, prose("replacement")])).toEqual([initial]);
});

test("optional missing request ID does not match a string tombstone or block the next known request", () => {
  const attempt = new StreamAttempt();
  attempt.begin(undefined, []);
  const entries = [prose("untracked")];
  expect(attempt.revoke("request", entries)).toBeNull();
  attempt.begin("request", entries);
  expect(attempt.revoke("request", [...entries, prose("partial")])).toEqual(entries);
});

test("independent instances keep request correlation and baselines separate", () => {
  const a = new StreamAttempt();
  const b = new StreamAttempt();
  const previousA = prose("previous-a");
  const previousB = prose("previous-b");
  a.begin("request", [previousA]);
  b.begin("request", [previousB]);
  expect(a.revoke("request", [previousA, prose("partial-a")])).toEqual([previousA]);
  expect(b.revoke("request", [previousB, prose("partial-b")])).toEqual([previousB]);
  expect(a.revoke("request", [])).toBeNull();
});
