import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch } from "./applier.js";
import { patchDiffTargets } from "./backup-targets.js";
import { parsePatch } from "./parser.js";

describe("ApplyPatch diff targets match filesystem changes", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-patch-diff-targets-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const content = (path: string): string | null =>
    existsSync(path) ? readFileSync(path, "utf8") : null;

  async function execute(body: string) {
    const patch = `*** Begin Patch\n${body}\n*** End Patch`;
    const targets = patchDiffTargets(patch, dir);
    const before = targets.map(content);
    await applyPatch(parsePatch(patch).hunks, { cwd: dir });
    return targets.map((path, index) => ({ path, before: before[index], after: content(path) }));
  }

  test("captures the real before/after paths for create, repeated edit, move, and delete", async () => {
    const source = join(dir, "source.txt");
    const destination = join(dir, "nested", "destination.txt");
    expect(await execute("*** Add File: source.txt\n+first")).toEqual([
      { path: source, before: null, after: "first\n" },
    ]);
    expect(await execute("*** Update File: source.txt\n@@\n-first\n+second")).toEqual([
      { path: source, before: "first\n", after: "second\n" },
    ]);
    expect(
      await execute(
        "*** Update File: source.txt\n*** Move to: nested/destination.txt\n@@\n-second\n+final",
      ),
    ).toEqual([
      { path: source, before: "second\n", after: null },
      { path: destination, before: null, after: "final\n" },
    ]);
    expect(await execute("*** Delete File: nested/destination.txt")).toEqual([
      { path: destination, before: "final\n", after: null },
    ]);
  });

  test("an add targeting an existing file captures its contents before overwrite", async () => {
    const target = join(dir, "existing.txt");
    writeFileSync(target, "existing\n");
    expect(await execute("*** Add File: existing.txt\n+replacement")).toEqual([
      { path: target, before: "existing\n", after: "replacement\n" },
    ]);
  });
});
