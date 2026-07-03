import { afterEach, describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectRoot } from "./utils.js";
import { setGitPathOverride } from "../utils/exec.js";

describe("resolveProjectRoot", () => {
  afterEach(() => {
    setGitPathOverride(null);
    delete process.env.CSH_FAKE_GIT_TOP;
  });

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

  test("a symlinked repo path resolves to the real repo root", () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "csh-git-real-")));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const link = join(tmpdir(), `csh-git-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    symlinkSync(repo, link, "dir");
    expect(resolveProjectRoot(link)).toBe(repo);
  });

  test("uses the configured git.path override when resolving the project root", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-git-override-root-")));
    const sub = join(root, "pkg");
    mkdirSync(sub);
    const binDir = realpathSync(mkdtempSync(join(tmpdir(), "csh-fake-git-bin-")));
    const fakeGit = join(binDir, "git");
    writeFileSync(
      fakeGit,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"rev-parse\" ] && [ \"$2\" = \"--show-toplevel\" ]; then",
        `  printf '%s\\n' ${JSON.stringify(root)}`,
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(fakeGit, 0o755);
    setGitPathOverride(fakeGit);

    expect(resolveProjectRoot(sub)).toBe(root);
  });

  test("a non-existent path does not throw (falls back to the input)", () => {
    const bogus = join(tmpdir(), "csh-does-not-exist-xyz", "deep");
    expect(resolveProjectRoot(bogus)).toBe(bogus);
  });
});
