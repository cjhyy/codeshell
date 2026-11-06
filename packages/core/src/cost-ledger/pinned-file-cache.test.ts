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
