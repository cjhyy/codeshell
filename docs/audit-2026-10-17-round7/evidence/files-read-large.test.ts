import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool } from "../../../packages/core/src/tool-system/builtin/read.ts";
import { fileCache } from "../../../packages/core/src/tool-system/builtin/file-cache.ts";
import type { ToolContext } from "../../../packages/core/src/tool-system/context.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "audit-r7-read-large-")); });
afterEach(() => { fileCache.clear(); rmSync(dir, { recursive: true, force: true }); });
const ctx = () => ({ cwd: dir }) as ToolContext;

test("FILES-R7-04 Read's advertised offset/limit recovery repeats the same size rejection", async () => {
  const path = join(dir, "large.txt");
  writeFileSync(path, "first\nsecond\n" + "a".repeat(6 * 1024 * 1024));
  const original = await readTool({ file_path: path }, ctx());
  expect(original).toContain("File is too large");
  expect(original).toContain("provide offset and limit to read a portion");
  const page = await readTool({ file_path: path, offset: 1, limit: 2 }, ctx());
  expect(page).toBe(original);
  expect(page).not.toContain("1\tfirst");
});

test("the same paging arguments work below the fixed text-size cap", async () => {
  const path = join(dir, "small.txt");
  writeFileSync(path, "first\nsecond\nthird");
  const page = await readTool({ file_path: path, offset: 1, limit: 2 }, ctx());
  expect(page).toContain("1\tfirst\n2\tsecond");
  expect(page).not.toContain("3\tthird");
});
