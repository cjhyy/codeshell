import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../../../packages/core/src/session/memory.ts";
import { listSessionMemories, saveSessionMemory } from "../../../packages/core/src/services/session-memory.ts";

const roots: string[] = [];
function root() {
  const value = mkdtempSync(join(tmpdir(), "codeshell-audit-ops-memory-"));
  roots.push(value);
  return value;
}
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

test("observation: legal offset timestamps reverse physical recency", () => {
  const baseDir = root();
  const older = { sessionId: "older", summary: "older", keyTopics: [], decisions: [], createdAt: "2026-10-17T01:00:00+08:00" };
  const newer = { sessionId: "newer", summary: "newer", keyTopics: [], decisions: [], createdAt: "2026-10-16T23:00:00Z" };
  expect(Date.parse(newer.createdAt)).toBeGreaterThan(Date.parse(older.createdAt));
  saveSessionMemory(older, baseDir);
  saveSessionMemory(newer, baseDir);
  const actual = listSessionMemories(10, baseDir).map((entry) => entry.sessionId);
  console.log(JSON.stringify({ observation: "recency-offset", expected: ["newer", "older"], actual }));
  expect(actual).toEqual(["older", "newer"]);
});

test("observation: stale same-name recall TTL prunes the pinned sibling", () => {
  const baseDir = root();
  const mm = new MemoryManager({ baseDir });
  mm.save({ id: "a-pinned", name: "same-topic", description: "keep this pinned note", type: "project", content: "PINNED FRESH BODY", pinned: true, lastUsedAt: "2026-10-16T00:00:00Z" });
  mm.save({ id: "b-expired", name: "same-topic", description: "expire this note", type: "project", content: "EXPIRED BODY", lastUsedAt: "2026-01-01T00:00:00Z" });
  expect(mm.loadAll().map((entry) => entry.id)).toEqual(["a-pinned", "b-expired"]);
  const pruned = mm.pruneByRecall(30, new Date("2026-10-17T00:00:00Z"));
  const remaining = mm.loadAll().map((entry) => ({ id: entry.id, pinned: entry.pinned, content: entry.content }));
  console.log(JSON.stringify({ observation: "ttl-same-name", expectedRemaining: ["a-pinned"], pruned, remaining }));
  expect(mm.findById("a-pinned")).toBeUndefined();
  expect(mm.findById("b-expired")?.content).toBe("EXPIRED BODY");
});

test("observation: promote selected filename copies B but deletes same-name A", () => {
  const baseDir = root();
  const mm = new MemoryManager({ baseDir, projectDir: join(baseDir, "project") });
  mm.save({ id: "a-other", name: "same-topic", description: "other item", type: "user", content: "A BODY" });
  const selected = mm.save({ id: "b-selected", name: "same-topic", description: "selected item", type: "user", content: "B BODY" });
  const promoted = mm.promoteToGlobal(selected);
  const global = new MemoryManager({ baseDir });
  console.log(JSON.stringify({ observation: "promote-same-name", selected, promoted, project: mm.loadAll().map((entry) => ({ id: entry.id, content: entry.content })), global: global.loadAll().map((entry) => entry.content) }));
  expect(global.loadAll().map((entry) => entry.content)).toEqual(["B BODY"]);
  expect(mm.findById("a-other")).toBeUndefined();
  expect(mm.findById("b-selected")?.content).toBe("B BODY");
});

test("observation: approve selected pending id copies B but deletes same-name A", () => {
  const baseDir = root();
  const pending = new MemoryManager({ baseDir, scope: "pending" });
  pending.save({ id: "a-other", name: "same-topic", description: "from project A", type: "user", content: "A BODY", originProject: join(baseDir, "project-a"), origin: "dream" });
  pending.save({ id: "b-selected", name: "same-topic", description: "from project B", type: "user", content: "B BODY", originProject: join(baseDir, "project-b"), origin: "dream" });
  const approved = pending.approvePending("b-selected");
  const dream = new MemoryManager({ baseDir, scope: "dream" });
  console.log(JSON.stringify({ observation: "approve-same-name", approved, remaining: pending.loadAll().map((entry) => ({ id: entry.id, content: entry.content })), dream: dream.loadAll().map((entry) => entry.content) }));
  expect(dream.loadAll().map((entry) => entry.content)).toEqual(["B BODY"]);
  expect(pending.findById("a-other")).toBeUndefined();
  expect(pending.findById("b-selected")?.content).toBe("B BODY");
});
