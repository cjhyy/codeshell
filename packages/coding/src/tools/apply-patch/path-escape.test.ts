import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyPatch } from "./applier.js";
import { parsePatch } from "./parser.js";

// Security: the applier is the last line of defense. Even when the executor-level
// pathPolicy gate is bypassed (bypassPermissions, direct call), a patch must NOT
// be able to write outside its cwd — neither via ../ traversal nor via a symlink
// planted inside the cwd that points elsewhere.

describe("coding applyPatch path containment", () => {
  let base: string;
  let work: string; // the cwd the patch runs in
  let outside: string; // a sibling dir the patch must never reach

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "cs-applypatch-escape-"));
    work = join(base, "work");
    outside = join(base, "outside");
    mkdirSync(work, { recursive: true });
    mkdirSync(outside, { recursive: true });
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("rejects ../ traversal that escapes cwd (add)", async () => {
    const patch =
      "*** Begin Patch\n" + "*** Add File: ../outside/pwned.txt\n" + "+owned\n" + "*** End Patch\n";
    const { hunks } = parsePatch(patch);

    await expect(applyPatch(hunks, { cwd: work })).rejects.toThrow(/outside|escape|cwd|workspace/i);
    expect(existsSync(join(outside, "pwned.txt"))).toBe(false);
  });

  test("rejects an absolute path outside cwd (add)", async () => {
    const target = join(outside, "abs-pwned.txt");
    const patch =
      "*** Begin Patch\n" + `*** Add File: ${target}\n` + "+owned\n" + "*** End Patch\n";
    const { hunks } = parsePatch(patch);

    await expect(applyPatch(hunks, { cwd: work })).rejects.toThrow(/outside|escape|cwd|workspace/i);
    expect(existsSync(target)).toBe(false);
  });

  test("rejects writing through a symlink that points outside cwd", async () => {
    // Plant a symlink INSIDE the cwd pointing at the outside dir, then patch a
    // file "under" the symlink. A naive resolve() stays string-inside-cwd but
    // the write follows the link out.
    const link = join(work, "escape");
    symlinkSync(outside, link, "dir");
    const patch =
      "*** Begin Patch\n" +
      "*** Add File: escape/via-symlink.txt\n" +
      "+owned\n" +
      "*** End Patch\n";
    const { hunks } = parsePatch(patch);

    await expect(applyPatch(hunks, { cwd: work })).rejects.toThrow(
      /outside|escape|cwd|workspace|symlink/i,
    );
    expect(existsSync(join(outside, "via-symlink.txt"))).toBe(false);
  });

  test("still allows a normal write inside cwd", async () => {
    const patch =
      "*** Begin Patch\n" + "*** Add File: sub/ok.txt\n" + "+fine\n" + "*** End Patch\n";
    const { hunks } = parsePatch(patch);

    await applyPatch(hunks, { cwd: work });
    expect(readFileSync(join(work, "sub", "ok.txt"), "utf-8")).toBe("fine\n");
  });

  test("rejects a rename whose destination escapes cwd", async () => {
    const src = join(work, "src.txt");
    writeFileSync(src, "data\n");
    const patch =
      "*** Begin Patch\n" +
      "*** Update File: src.txt\n" +
      "*** Move to: ../outside/moved.txt\n" +
      "-data\n" +
      "+data2\n" +
      "*** End Patch\n";
    const { hunks } = parsePatch(patch);

    await expect(applyPatch(hunks, { cwd: work })).rejects.toThrow(/outside|escape|cwd|workspace/i);
    expect(existsSync(join(outside, "moved.txt"))).toBe(false);
    expect(readFileSync(src, "utf-8")).toBe("data\n");
  });
});
