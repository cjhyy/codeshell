import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../../../packages/core/src/session/memory.ts";
import { MemoryOrchestrator } from "../../../packages/core/src/services/memory-orchestrator.ts";
import { applyGlobalDreamPromotionGate } from "../../../packages/core/src/services/global-dream-promotion.ts";

const roots: string[] = [];
function fixture() {
  const baseDir = mkdtempSync(join(tmpdir(), "codeshell-audit-ops-promotion-"));
  roots.push(baseDir);
  return { baseDir, projectDir: join(baseDir, "project") };
}
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

test("observation: an explicit global ADD decision overwrites project dream by name", async () => {
  const storage = fixture();
  const dream = new MemoryManager({ ...storage, scope: "dream" });
  dream.save({ id: "original", name: "retry-policy", description: "charge requests", type: "reference", content: "Do not retry charge requests after an uncertain result.", origin: "auto" });
  const candidate = { name: "retry-policy", description: "read requests", type: "reference", scope: "global", content: "Retry read requests twice after a temporary error." };
  const calls: string[] = [];
  const orchestrator = new MemoryOrchestrator({
    ...storage,
    async callLLM(system) {
      calls.push(system);
      if (system.includes("extraction")) return JSON.stringify([candidate]);
      return JSON.stringify({ action: "ADD", reason: "Different request categories; keep both facts" });
    },
  });
  const result = await orchestrator.run([{ role: "user", content: "Remember the read request policy across projects." }], "promotion-add-session");
  const remaining = dream.loadAll();
  const pending = new MemoryManager({ baseDir: storage.baseDir, scope: "pending" }).loadAll();
  console.log(JSON.stringify({ observation: "global-add-overwrites", decision: "ADD", calls: calls.length, result, remaining: remaining.map((entry) => ({ id: entry.id, content: entry.content })), pending: pending.map((entry) => entry.content) }));
  expect(calls).toHaveLength(2);
  expect(result.extracted).toBe(1);
  expect(remaining).toHaveLength(1);
  expect(remaining[0]?.id).toBe("original");
  expect(remaining[0]?.content).toBe(candidate.content);
  expect(remaining.some((entry) => entry.content.includes("Do not retry charge"))).toBe(false);
  expect(pending[0]?.content).toBe(candidate.content);
});

test("observation: repeated candidate refreshes project evidence but approval lands old pending text", () => {
  const storage = fixture();
  const original = { name: "units", description: "display units", type: "user" as const, scope: "global" as const, content: "Display lengths in centimeters." };
  const updated = { ...original, content: "Display lengths in meters." };
  const first = applyGlobalDreamPromotionGate({ ...storage, candidate: original });
  const second = applyGlobalDreamPromotionGate({ ...storage, candidate: updated });
  const project = new MemoryManager({ ...storage, scope: "dream" }).loadAll();
  const pending = new MemoryManager({ baseDir: storage.baseDir, scope: "pending" });
  const queued = pending.loadAll();
  expect(queued).toHaveLength(1);
  const approved = pending.approvePending(queued[0]!.id!);
  const global = new MemoryManager({ baseDir: storage.baseDir, scope: "dream" }).loadAll();
  console.log(JSON.stringify({ observation: "pending-stale-approval", first, second, project: project.map((entry) => entry.content), queued: queued.map((entry) => entry.content), approved, global: global.map((entry) => entry.content) }));
  expect(first.pendingSuggested).toBe(true);
  expect(second.pendingSuggested).toBe(false);
  expect(project[0]?.content).toBe(updated.content);
  expect(queued[0]?.content).toBe(original.content);
  expect(global[0]?.content).toBe(original.content);
});
