import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { applyPatchTool } from "./index.js";
import { fileCache } from "@cjhyy/code-shell-core/internal";
import type { ToolContext } from "@cjhyy/code-shell-core";

// Regression: apply-patch invalidated the file cache using the RAW relative
// patch path (hunk.path), but the cache is keyed by ABSOLUTE path. So after a
// patch, a stale cached copy of the file survived and a subsequent Read could
// return pre-patch content (review-2026-05-30, high-severity at index.ts:109).
// The fix invalidates by the resolved absolute path.

describe("coding applyPatch invalidates the file cache by absolute path", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-applypatch-"));
    fileCache.clear();
  });
  afterEach(() => {
    fileCache.clear();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a relative-path patch invalidates the absolute-keyed cache entry", async () => {
    const abs = join(dir, "f.txt");
    writeFileSync(abs, "old\n");
    const mtime = statSync(abs).mtimeMs;
    // Seed the cache as Read would: keyed by absolute path with stale content.
    fileCache.set(abs, "old\n", mtime);
    expect(await fileCache.get(abs)).toBe("old\n");

    // Patch refers to the file by a RELATIVE path; ctx.cwd makes it resolve
    // to the same absolute file.
    const patch =
      "*** Begin Patch\n" + "*** Update File: f.txt\n" + "-old\n" + "+new\n" + "*** End Patch\n";
    const ctx = { cwd: dir } as unknown as ToolContext;
    const out = await applyPatchTool({ patch }, ctx);
    expect(out).toContain("applied");

    // The absolute-keyed entry must be REMOVED from the cache map. We assert
    // `has(abs)` (the specific key), NOT `get()` — get() self-heals via mtime,
    // which would mask a missing manual invalidation. We also avoid asserting
    // `size===0`: fileCache is a shared module singleton, so a concurrent test
    // touching it would flake an exact-count assertion. has(abs)===false tests
    // exactly the contract (this key was invalidated) and is concurrency-safe.
    // invalidate(abs) deletes the key; invalidate(relative) would miss it.
    expect(resolve(dir, "f.txt")).toBe(abs); // sanity: same file
    expect(fileCache.has(abs)).toBe(false);
  });
});
