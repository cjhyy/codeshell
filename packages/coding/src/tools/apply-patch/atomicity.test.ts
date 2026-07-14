import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyPatch } from "./applier.js";
import { parsePatch } from "./parser.js";

// TODO.md §3.5 / P1: ApplyPatch must be a transaction — either every hunk in a
// multi-file patch applies, or none do. These tests pin both failure phases:
//   - plan phase: a later hunk fails to match  → nothing is written at all
//   - commit phase: a write fails after an earlier file was already written
//                   → the earlier file is rolled back to its original content
//
// The default (allowPartialOnCommit unset) is all-or-nothing; the codex-parity
// escape hatch is covered separately.

describe("coding applyPatch atomicity (all-or-nothing)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-applypatch-atomic-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("plan-phase failure on a later hunk leaves ALL files untouched", async () => {
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    writeFileSync(a, "alpha\n");
    writeFileSync(b, "beta\n");

    // First hunk matches a.txt; second hunk's context does NOT exist in b.txt,
    // so planning throws before any write happens.
    const patch =
      "*** Begin Patch\n" +
      "*** Update File: a.txt\n" +
      "-alpha\n" +
      "+ALPHA\n" +
      "*** Update File: b.txt\n" +
      "-this-line-does-not-exist\n" +
      "+whatever\n" +
      "*** End Patch\n";
    const { hunks } = parsePatch(patch);

    await expect(applyPatch(hunks, { cwd: dir })).rejects.toThrow();

    // Neither file changed: planning failed before commit.
    expect(readFileSync(a, "utf-8")).toBe("alpha\n");
    expect(readFileSync(b, "utf-8")).toBe("beta\n");
  });

  test("commit-phase write failure rolls back an already-written file", async () => {
    const a = join(dir, "a.txt");
    // b's parent is a FILE, so writing dir/b_parent/b.txt fails at mkdir/write
    // time — i.e. during commit, AFTER a.txt has already been written.
    const bParent = join(dir, "b_parent");
    writeFileSync(a, "alpha\n");
    writeFileSync(bParent, "i am a file, not a dir\n");

    const patch =
      "*** Begin Patch\n" +
      "*** Update File: a.txt\n" +
      "-alpha\n" +
      "+ALPHA\n" +
      "*** Add File: b_parent/b.txt\n" +
      "+new file under a non-dir parent\n" +
      "*** End Patch\n";
    const { hunks } = parsePatch(patch);

    await expect(applyPatch(hunks, { cwd: dir })).rejects.toThrow();

    // a.txt was written then rolled back to its original content.
    expect(readFileSync(a, "utf-8")).toBe("alpha\n");
    // The doomed add did not leave a stray file (bParent is still the original file).
    expect(readFileSync(bParent, "utf-8")).toBe("i am a file, not a dir\n");
    expect(existsSync(join(bParent, "b.txt"))).toBe(false);
  });

  test("rollback removes a newly-added file when a later write fails", async () => {
    // First hunk ADDS new.txt (originalContent === null). Second hunk's write
    // fails. Rollback must unlink new.txt rather than restore stale content.
    const added = join(dir, "new.txt");
    const bParent = join(dir, "b_parent");
    writeFileSync(bParent, "blocking file\n");

    const patch =
      "*** Begin Patch\n" +
      "*** Add File: new.txt\n" +
      "+freshly added\n" +
      "*** Add File: b_parent/b.txt\n" +
      "+doomed\n" +
      "*** End Patch\n";
    const { hunks } = parsePatch(patch);

    await expect(applyPatch(hunks, { cwd: dir })).rejects.toThrow();

    // new.txt must NOT survive — it didn't exist before the patch.
    expect(existsSync(added)).toBe(false);
  });

  test("allowPartialOnCommit leaves partial work on disk (codex parity)", async () => {
    const a = join(dir, "a.txt");
    const bParent = join(dir, "b_parent");
    writeFileSync(a, "alpha\n");
    writeFileSync(bParent, "blocking file\n");

    const patch =
      "*** Begin Patch\n" +
      "*** Update File: a.txt\n" +
      "-alpha\n" +
      "+ALPHA\n" +
      "*** Add File: b_parent/b.txt\n" +
      "+doomed\n" +
      "*** End Patch\n";
    const { hunks } = parsePatch(patch);

    await expect(applyPatch(hunks, { cwd: dir, allowPartialOnCommit: true })).rejects.toThrow();

    // With partial commits, a.txt's edit survives even though b's write failed.
    expect(readFileSync(a, "utf-8")).toBe("ALPHA\n");
  });
});
