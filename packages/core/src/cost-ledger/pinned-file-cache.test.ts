import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinnedFileCache } from "./pinned-file-cache.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(now: () => number) {
  const root = mkdtempSync(join(tmpdir(), "codeshell-pinned-"));
  roots.push(root);
  const reads: string[] = [];
  const cache = new PinnedFileCache<{ value: number }>({
    maxBytes: 1024,
    settleMs: 2_000,
    now,
    parse: (raw) => JSON.parse(raw) as { value: number },
    readText: (file) => {
      reads.push(file);
      return readFileSync(file, "utf8");
    },
  });
  return { root, reads, cache };
}

test("an unchanged settled file is parsed once", () => {
  const { root, reads, cache } = fixture(() => Date.now() + 60_000);
  const file = join(root, "a.json");
  writeFileSync(file, '{"value":1}');
  for (let index = 0; index < 5; index++) expect(cache.read("a", file)).toEqual({ value: 1 });
  expect(reads).toHaveLength(1);
});

test("a file changed within the settle window is re-read every time", () => {
  const { root, reads, cache } = fixture(() => Date.now());
  const file = join(root, "a.json");
  writeFileSync(file, '{"value":1}');
  cache.read("a", file);
  cache.read("a", file);
  expect(reads).toHaveLength(2);
});

test("a rename-replaced file is re-read and a deleted one is gone", () => {
  const { root, reads, cache } = fixture(() => Date.now() + 60_000);
  const file = join(root, "a.json");
  writeFileSync(file, '{"value":1}');
  utimesSync(file, 1_700_000_000, 1_700_000_000);
  expect(cache.read("a", file)).toEqual({ value: 1 });
  writeFileSync(`${file}.tmp`, '{"value":2}');
  utimesSync(`${file}.tmp`, 1_700_000_000, 1_700_000_000);
  renameSync(`${file}.tmp`, file);
  expect(cache.read("a", file)).toEqual({ value: 2 });
  expect(reads).toHaveLength(2);
  rmSync(file);
  expect(cache.read("a", file)).toBeUndefined();
});

test("retain drops entries whose files were not listed", () => {
  const { root, reads, cache } = fixture(() => Date.now() + 60_000);
  const file = join(root, "a.json");
  writeFileSync(file, '{"value":1}');
  cache.read("a", file);
  cache.retain(new Set(["a"]));
  cache.read("a", file);
  expect(reads).toHaveLength(1);
  cache.retain(new Set());
  cache.read("a", file);
  expect(reads).toHaveLength(2);
});

test("cache entry and byte budgets evict least recently used files", () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-pinned-budget-"));
  roots.push(root);
  let reads = 0;
  const cache = new PinnedFileCache<{ value: number }>({
    maxBytes: 1024,
    maxEntries: 2,
    maxCachedBytes: 22,
    settleMs: 2_000,
    now: () => Date.now() + 60_000,
    parse: (raw) => JSON.parse(raw),
    readText: (file) => {
      reads++;
      return readFileSync(file, "utf8");
    },
  });
  for (const name of ["a", "b", "c"]) writeFileSync(join(root, name), '{"value":1}');
  const read = (name: string) => cache.read(name, join(root, name));
  read("a");
  read("b");
  read("a"); // b is now the least recently used entry.
  read("c");
  read("a");
  expect(reads).toBe(3);
  read("b");
  expect(reads).toBe(4);
  writeFileSync(join(root, "large"), '{"value":123456789012345}');
  expect(read("large")?.value).toBe(123456789012345);
  expect(read("large")?.value).toBe(123456789012345);
  expect(reads).toBe(6); // Individually valid, but larger than the cache budget.
  cache.retain(new Set());
  read("a");
  read("a");
  expect(reads).toBe(7);
});
