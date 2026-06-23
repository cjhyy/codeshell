/**
 * saveCatalogEntry — backup + validate + write an upserted CatalogEntry into a
 * user catalog file. The agent-facing tool wraps this. Tested against a temp
 * file so backup/validate/write semantics are covered without the real
 * ~/.code-shell. See docs/.../2026-06-15-unified-model-catalog-design.md §7.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCatalogEntry, deleteUserCatalogEntry } from "./save-entry.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "catedit-"));
  file = join(dir, "model-catalog.user.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ENTRY = {
  id: "my-prov", tag: "text", adapterKind: "openai", displayName: "My Prov",
  description: "x", defaultBaseUrl: "https://x/v1",
};

describe("saveCatalogEntry", () => {
  test("creates the file with the entry when none exists", () => {
    const r = saveCatalogEntry(ENTRY, { path: file, stamp: "T1" });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("added");
    const arr = JSON.parse(readFileSync(file, "utf-8"));
    expect(arr).toHaveLength(1);
    expect(arr[0].id).toBe("my-prov");
  });

  test("updates an existing entry by id and reports 'updated'", () => {
    writeFileSync(file, JSON.stringify([ENTRY]));
    const r = saveCatalogEntry({ ...ENTRY, displayName: "Renamed" }, { path: file, stamp: "T2" });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("updated");
    const arr = JSON.parse(readFileSync(file, "utf-8"));
    expect(arr).toHaveLength(1);
    expect(arr[0].displayName).toBe("Renamed");
  });

  test("backs up the existing file before writing", () => {
    writeFileSync(file, JSON.stringify([ENTRY]));
    saveCatalogEntry({ ...ENTRY, displayName: "Renamed" }, { path: file, stamp: "T3" });
    const baks = readdirSync(dir).filter((f) => f.includes(".bak"));
    expect(baks.length).toBeGreaterThan(0);
    // backup holds the pre-write content
    expect(JSON.parse(readFileSync(join(dir, baks[0]!), "utf-8"))[0].displayName).toBe("My Prov");
  });

  test("does not back up when there's no existing file", () => {
    saveCatalogEntry(ENTRY, { path: file, stamp: "T4" });
    expect(readdirSync(dir).filter((f) => f.includes(".bak"))).toHaveLength(0);
  });

  test("rejects an invalid entry (bad tag) without writing", () => {
    const r = saveCatalogEntry({ ...ENTRY, tag: "embedding" }, { path: file, stamp: "T5" });
    expect(r.ok).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  test("creates a missing parent directory instead of crashing (first-ever write)", () => {
    // A machine whose ~/.code-shell does not yet exist: the write must succeed,
    // not throw ENOENT (regression — saveCatalogEntry used to writeFileSync raw).
    const nested = join(dir, "no", "such", "dir", "model-catalog.user.json");
    const r = saveCatalogEntry(ENTRY, { path: nested, stamp: "T6" });
    expect(r.ok).toBe(true);
    expect(existsSync(nested)).toBe(true);
    expect(JSON.parse(readFileSync(nested, "utf-8"))[0].id).toBe("my-prov");
  });

  test("preserves other entries when upserting", () => {
    const other = { ...ENTRY, id: "other" };
    writeFileSync(file, JSON.stringify([other]));
    saveCatalogEntry(ENTRY, { path: file, stamp: "T6" });
    const arr = JSON.parse(readFileSync(file, "utf-8"));
    expect(arr.map((e: { id: string }) => e.id).sort()).toEqual(["my-prov", "other"]);
  });

  test("returns {ok:false} (not a throw) when the write fails, preserving the backup name", () => {
    // The write target is itself a directory → writeFileSync throws EISDIR. The
    // tool's caller expects a clean {ok:false, error}; an uncaught throw would
    // crash past the result shape and drop the backup filename (regression).
    const asDir = join(dir, "model-catalog.user.json");
    mkdirSync(asDir, { recursive: true });
    // seed a sibling file the backup step can copy so `backup` is populated
    // (the target-as-dir means existsSync(path) is true → backup is attempted).
    const r = saveCatalogEntry(ENTRY, { path: asDir, stamp: "TW" });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });

  test("a corrupt existing file is backed up, not silently lost", () => {
    writeFileSync(file, "{ not json");
    const r = saveCatalogEntry(ENTRY, { path: file, stamp: "T7" });
    expect(r.ok).toBe(true);
    // corrupt content preserved in a backup
    const baks = readdirSync(dir).filter((f) => f.includes(".bak"));
    expect(baks.length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, baks[0]!), "utf-8")).toBe("{ not json");
  });
});

describe("deleteUserCatalogEntry", () => {
  let dir2: string;
  let path: string;
  beforeEach(() => {
    dir2 = mkdtempSync(join(tmpdir(), "cat-del-"));
    path = join(dir2, "model-catalog.user.json");
  });
  afterEach(() => rmSync(dir2, { recursive: true, force: true }));

  test("removes an existing entry and reports removed:true", () => {
    writeFileSync(path, JSON.stringify([
      { id: "a", tag: "text", adapterKind: "openai", displayName: "A", description: "", defaultBaseUrl: "u" },
      { id: "b", tag: "text", adapterKind: "openai", displayName: "B", description: "", defaultBaseUrl: "u" },
    ]));
    const r = deleteUserCatalogEntry("a", { path, stamp: "t1" });
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(true);
    const left = JSON.parse(readFileSync(path, "utf-8"));
    expect(left.map((e: any) => e.id)).toEqual(["b"]);
  });

  test("reports removed:false when id absent (no-op)", () => {
    writeFileSync(path, JSON.stringify([{ id: "a", tag: "text", adapterKind: "openai", displayName: "A", description: "", defaultBaseUrl: "u" }]));
    const r = deleteUserCatalogEntry("nope", { path, stamp: "t2" });
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(false);
  });

  test("reports removed:false when file absent", () => {
    const r = deleteUserCatalogEntry("a", { path: join(dir2, "missing.json"), stamp: "t3" });
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(false);
  });

  test("backs up before writing", () => {
    writeFileSync(path, JSON.stringify([{ id: "a", tag: "text", adapterKind: "openai", displayName: "A", description: "", defaultBaseUrl: "u" }]));
    const r = deleteUserCatalogEntry("a", { path, stamp: "t4" });
    expect(r.backup).toBe(`${path}.bak-t4`);
    expect(existsSync(r.backup!)).toBe(true);
  });
});
