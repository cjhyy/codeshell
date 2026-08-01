// MEMORY.md must never lose entries to a stale in-memory index.
//
// MemoryManager caches the index per instance to avoid an O(N²) re-read on every
// save. But several managers exist for the same directory (desktop main, agent
// worker, TUI, a second desktop instance), and writeIndex() used to serialize
// whatever that instance's cache happened to hold:
//
//   A saves a → B loads {a}, saves b → A still holds {a}, saves c
//   → a.md, b.md, c.md all exist on disk, but MEMORY.md lists only a and c.
//
// The prompt is fed from MEMORY.md, so a dropped line means the agent stops
// seeing a memory that is sitting right there on disk. writeIndex now re-derives
// the index from disk inside a lock, treating the .md files as the truth.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "cs-memory-conc-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function manager(): MemoryManager {
  return new MemoryManager({ baseDir: base, scope: "user" });
}

function indexBody(): string {
  return readFileSync(join(base, "memory", "user", "MEMORY.md"), "utf-8");
}

/** MemoryEntry requires `type`; these tests only care about name/description. */
function entry(name: string, description: string, content: string) {
  return { name, description, content, type: "project" as const };
}

describe("MEMORY.md index under multiple managers", () => {
  test("interleaved saves from two instances keep every entry", () => {
    const a = manager();
    const b = manager();

    a.save(entry("alpha", "first", "a"));
    // B builds its cache now — it sees only alpha.
    b.save(entry("beta", "second", "b"));
    // A still holds a cache containing only alpha; this write used to drop beta.
    a.save(entry("gamma", "third", "c"));

    const index = indexBody();
    expect(index).toContain("alpha");
    expect(index).toContain("beta");
    expect(index).toContain("gamma");
    // And the index agrees with what is actually on disk.
    expect(a.loadAll().map((e) => e.name).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("a delete from one instance is not resurrected by another's stale cache", () => {
    const a = manager();
    const b = manager();

    a.save(entry("keep", "stays", "1"));
    a.save(entry("drop", "goes", "2"));
    // B caches both entries.
    b.save(entry("later", "third", "3"));

    expect(a.delete("drop")).toBe(true);

    // B writes with a cache that still remembers `drop`; the re-scan must not
    // bring the deleted entry back into the index.
    b.save(entry("after-delete", "fourth", "4"));

    const index = indexBody();
    expect(index).toContain("keep");
    expect(index).toContain("later");
    expect(index).toContain("after-delete");
    expect(index).not.toContain("](drop");
  });

  test("a delete is reflected even when the deleting instance has a warm cache", () => {
    const a = manager();
    a.save(entry("one", "1", "x"));
    a.save(entry("two", "2", "y"));
    expect(a.delete("one")).toBe(true);

    const index = indexBody();
    expect(index).not.toContain("](one");
    expect(index).toContain("two");
  });

  test("48 concurrent processes each saving a distinct memory lose none", async () => {
    const total = 48;
    const script = (name: string) => `
      import { MemoryManager } from ${JSON.stringify(join(import.meta.dir, "memory.ts"))};
      const m = new MemoryManager({ baseDir: ${JSON.stringify(base)}, scope: "user" });
      m.save({ name: ${JSON.stringify(name)}, description: "d", content: "c", type: "project" });
    `;
    const procs = Array.from({ length: total }, (_, i) =>
      Bun.spawn([process.execPath, "-e", script(`mem-${i}`)], { stdout: "pipe", stderr: "pipe" }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes.every((c) => c === 0)).toBe(true);

    const index = indexBody();
    const missing: string[] = [];
    for (let i = 0; i < total; i += 1) {
      if (!index.includes(`mem-${i}`)) missing.push(`mem-${i}`);
    }
    expect(missing).toEqual([]);
  }, 120_000);
});
