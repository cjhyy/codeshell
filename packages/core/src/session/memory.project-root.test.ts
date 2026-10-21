// OM5: project memory roots must not be shared by distinct project paths.
//
// The old root was projects/<key>/memory with key = path with every separator
// replaced by "-", so /w/team/api and /w/team-api shared one store: one
// project's facts were injected as the other's "this repo" memories. New roots
// use a collision-free key; a legacy store is copied forward only when exactly
// one known project maps to its key, and is otherwise left untouched and unread.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryManager } from "./memory.js";

const MEMORY_MODULE = fileURLToPath(new URL("./memory.ts", import.meta.url));

let root: string;
let baseDir: string;
let projectA: string;
let projectB: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cs-memory-project-root-"));
  baseDir = join(root, "state");
  projectA = join(root, "workspace", "team", "api");
  projectB = join(root, "workspace", "team-api");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function legacyRoot(projectDir: string): string {
  return join(baseDir, "projects", projectDir.replace(/[/\\:]/g, "-").replace(/^-/, ""), "memory");
}

function note(id: string, description: string) {
  return { id, name: id, description, type: "project" as const, content: `${description}.` };
}

/** A store written by the pre-fix layout, shared by every path with its key. */
function seedLegacy(projectDir: string, ...entries: ReturnType<typeof note>[]): string {
  const scratch = join(root, "scratch");
  const writer = new MemoryManager({ baseDir: scratch });
  for (const entry of entries) writer.save(entry);
  const legacy = legacyRoot(projectDir);
  mkdirSync(dirname(legacy), { recursive: true });
  cpSync(join(scratch, "memory"), legacy, { recursive: true });
  rmSync(scratch, { recursive: true, force: true });
  return legacy;
}

/** Register a project the way the session store records it. */
function recordSession(id: string, cwd: string): void {
  const dir = join(baseDir, "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ sessionId: id, cwd, workspace: { root: cwd, kind: "main" } }),
  );
}

function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
      else files[`${prefix}${entry.name}`] = readFileSync(path, "utf-8");
    }
  };
  walk(dir, "");
  return files;
}

describe("project memory root key", () => {
  test("a nested path and its hyphenated sibling keep separate memories", () => {
    expect(legacyRoot(projectA)).toBe(legacyRoot(projectB));
    const a = new MemoryManager({ baseDir, projectDir: projectA });
    const b = new MemoryManager({ baseDir, projectDir: projectB });
    expect(a.getMemoryDir()).not.toBe(b.getMemoryDir());

    a.save(note("project-a-note", "Project A uses schema v1"));
    expect(b.loadAll()).toEqual([]);
    b.save(note("project-b-note", "Project B uses schema v2"));

    const coldB = new MemoryManager({ baseDir, projectDir: projectB });
    expect(coldB.loadAll().map((entry) => entry.id)).toEqual(["project-b-note"]);
    const indexB = MemoryManager.buildInjectionIndex({ baseDir, projectDir: projectB });
    expect(indexB).toContain("Project B uses schema v2");
    expect(indexB).not.toContain("Project A uses schema v1");
    // Nothing is written under the lossy legacy key any more.
    expect(existsSync(join(baseDir, "projects"))).toBe(false);
  });

  test("the new key is readable, bounded and distinct from the legacy layout", () => {
    const rootA = MemoryManager.memoryRootFor({ baseDir, projectDir: projectA });
    const rootB = MemoryManager.memoryRootFor({ baseDir, projectDir: projectB });
    expect(rootA).not.toBe(rootB);
    expect(rootA).not.toBe(legacyRoot(projectA));
    expect(rootA.startsWith(join(baseDir, "projects"))).toBe(false);
    const keyA = rootA.slice(dirname(rootA).length + 1);
    expect(keyA).toMatch(/^api-[0-9a-f]{16}$/);
    expect(rootB.slice(dirname(rootB).length + 1)).toMatch(/^team-api-[0-9a-f]{16}$/);
    // Equivalent spellings of one directory resolve to one root.
    expect(MemoryManager.memoryRootFor({ baseDir, projectDir: `${projectA}/` })).toBe(rootA);
    // Resolving is read-only.
    expect(existsSync(baseDir)).toBe(false);
    // The manager uses exactly that root.
    expect(new MemoryManager({ baseDir, projectDir: projectA }).getMemoryDir()).toBe(
      join(rootA, "user"),
    );
    expect(MemoryManager.memoryRootFor({ baseDir })).toBe(join(baseDir, "memory"));
  });
});

describe("legacy project memory migration", () => {
  test("an unambiguous legacy store is copied forward, then the new root is used", () => {
    const legacy = seedLegacy(projectA, note("legacy-note", "Legacy fact for A"));
    recordSession("s-a", projectA);
    const before = snapshot(legacy);

    const a = new MemoryManager({ baseDir, projectDir: projectA });
    expect(a.getMemoryDir()).not.toContain(legacy);
    expect(a.loadAll().map((entry) => entry.id)).toEqual(["legacy-note"]);
    expect(MemoryManager.buildInjectionIndex({ baseDir, projectDir: projectA })).toContain(
      "Legacy fact for A",
    );
    // Dream scope shares the migrated root.
    expect(new MemoryManager({ baseDir, projectDir: projectA, scope: "dream" }).loadAll()).toEqual(
      [],
    );

    a.save(note("new-note", "Written after migration"));
    // Copy, not move: the legacy store is byte-for-byte unchanged and no longer written.
    expect(snapshot(legacy)).toEqual(before);
    // No staging directories are left beside the new root.
    const parent = dirname(MemoryManager.memoryRootFor({ baseDir, projectDir: projectA }));
    expect(readdirSync(parent).filter((name) => name.startsWith("."))).toEqual([]);

    // Once migrated, a legacy edit is never re-imported.
    rmSync(join(legacy, "user"), { recursive: true, force: true });
    const cold = new MemoryManager({ baseDir, projectDir: projectA });
    expect(
      cold
        .loadAll()
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["legacy-note", "new-note"]);
  });

  test("a legacy store claimed by two known projects is left untouched and not read", () => {
    const legacy = seedLegacy(projectA, note("shared-note", "Fact of unknown ownership"));
    recordSession("s-a", projectA);
    recordSession("s-b", projectB);
    const before = snapshot(legacy);

    const b = new MemoryManager({ baseDir, projectDir: projectB });
    expect(b.loadAll()).toEqual([]);
    expect(MemoryManager.buildInjectionIndex({ baseDir, projectDir: projectB })).not.toContain(
      "Fact of unknown ownership",
    );
    const a = new MemoryManager({ baseDir, projectDir: projectA });
    expect(a.loadAll()).toEqual([]);
    a.save(note("a-note", "A starts fresh"));
    expect(b.loadAll()).toEqual([]);
    expect(snapshot(legacy)).toEqual(before);
  });

  test("the Desktop project registry also counts as a claimant", () => {
    const legacy = seedLegacy(projectB, note("shared-note", "Registry-ambiguous fact"));
    mkdirSync(join(baseDir, "desktop"), { recursive: true });
    writeFileSync(
      join(baseDir, "desktop", "projects.json"),
      JSON.stringify({
        version: 2,
        projects: [
          { id: "p1", roots: [{ id: "r1", path: projectA }] },
          { id: "p2", roots: [{ id: "r2", path: projectB }] },
        ],
      }),
    );
    const before = snapshot(legacy);
    expect(new MemoryManager({ baseDir, projectDir: projectB }).loadAll()).toEqual([]);
    expect(snapshot(legacy)).toEqual(before);
  });

  test("concurrent first opens copy the legacy store exactly once", async () => {
    seedLegacy(projectA, note("legacy-note", "Legacy fact for A"));
    recordSession("s-a", projectA);
    const script = `
      import { MemoryManager } from ${JSON.stringify(MEMORY_MODULE)};
      const m = new MemoryManager({ baseDir: ${JSON.stringify(baseDir)}, projectDir: ${JSON.stringify(projectA)} });
      if (m.loadAll().length !== 1) throw new Error("migrated store not visible");
    `;
    const procs = Array.from({ length: 12 }, () =>
      Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    const errors = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
    expect({ codes, errors: errors.filter(Boolean) }).toEqual({
      codes: codes.map(() => 0),
      errors: [],
    });
    const rootA = MemoryManager.memoryRootFor({ baseDir, projectDir: projectA });
    expect(readdirSync(join(rootA, "user")).filter((name) => name.endsWith(".md")).length).toBe(2);
    expect(readdirSync(dirname(rootA)).filter((name) => name.startsWith("."))).toEqual([]);
  }, 60_000);
});
