import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectRoot } from "./utils.js";

describe("resolveProjectRoot", () => {
  test("a subdirectory of a git repo resolves to the repo top-level", () => {
    // This test file lives inside the codeshell git repo. Its directory is a
    // subdir of the repo; resolveProjectRoot must snap to the repo root, so a
    // subdir and the root map to the SAME project (the whole point of the fix).
    const here = import.meta.dir; // …/packages/core/src/git
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: here,
      encoding: "utf-8",
    }).trim();
    expect(resolveProjectRoot(here)).toBe(top);
    // The repo root resolves to itself (idempotent).
    expect(resolveProjectRoot(top)).toBe(top);
  });

  test("a non-git directory returns itself unchanged", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "csh-nogit-")));
    const sub = join(dir, "sub");
    mkdirSync(sub);
    // Not a git repo → returned as-is (each non-git folder is its own project).
    expect(resolveProjectRoot(dir)).toBe(dir);
    expect(resolveProjectRoot(sub)).toBe(sub);
  });

  test("a non-existent path does not throw (falls back to the input)", () => {
    const bogus = join(tmpdir(), "csh-does-not-exist-xyz", "deep");
    expect(resolveProjectRoot(bogus)).toBe(bogus);
  });
});
