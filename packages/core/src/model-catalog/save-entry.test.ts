/**
 * saveCatalogEntry — backup + validate + write an upserted CatalogEntry into a
 * user catalog file. The agent-facing tool wraps this. Tested against a temp
 * file so backup/validate/write semantics are covered without the real
 * ~/.code-shell. See docs/.../2026-06-15-unified-model-catalog-design.md §7.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCatalogEntry } from "./save-entry.js";

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

  test("preserves other entries when upserting", () => {
    const other = { ...ENTRY, id: "other" };
    writeFileSync(file, JSON.stringify([other]));
    saveCatalogEntry(ENTRY, { path: file, stamp: "T6" });
    const arr = JSON.parse(readFileSync(file, "utf-8"));
    expect(arr.map((e: { id: string }) => e.id).sort()).toEqual(["my-prov", "other"]);
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
