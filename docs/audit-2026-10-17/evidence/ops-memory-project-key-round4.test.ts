import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../../../packages/core/src/session/memory.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("observation: nested project and hyphenated sibling share persistent memory and injection", () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-audit-ops-project-key-"));
  roots.push(root);
  const baseDir = join(root, "state");
  const projectA = join(root, "workspace", "team", "api");
  const projectB = join(root, "workspace", "team-api");
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  const a = new MemoryManager({ baseDir, projectDir: projectA });
  const b = new MemoryManager({ baseDir, projectDir: projectB });
  expect(projectA).not.toBe(projectB);
  a.save({ id: "project-a-note", name: "team-api-v1", description: "Project A uses schema v1", type: "project", content: "A is a service using schema v1." });
  const initiallyVisibleInB = b.loadAll().map((entry) => entry.id);
  b.save({ id: "project-b-note", name: "team-api-v2", description: "Project B uses schema v2", type: "project", content: "B is a separate service using schema v2." });
  const coldB = new MemoryManager({ baseDir, projectDir: projectB });
  const indexB = MemoryManager.buildInjectionIndex({ baseDir, projectDir: projectB });
  console.log(JSON.stringify({ observation: "project-memory-key-collision", projectA, projectB, memoryDirA: a.getMemoryDir(), memoryDirB: b.getMemoryDir(), initiallyVisibleInB, afterColdB: coldB.loadAll().map((entry) => entry.id), indexB }));
  expect(a.getMemoryDir()).toBe(b.getMemoryDir());
  expect(initiallyVisibleInB).toEqual(["project-a-note"]);
  expect(coldB.loadAll()).toHaveLength(2);
  expect(indexB).toContain("Project A uses schema v1");
  expect(indexB).toContain("Project B uses schema v2");
});
