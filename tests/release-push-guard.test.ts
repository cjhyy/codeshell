import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releasePushError } from "../scripts/release-push-guard";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function repo(): { root: string; git: (...args: string[]) => void } {
  const root = mkdtempSync(join(tmpdir(), "cs-release-guard-"));
  roots.push(root);
  const git = (...args: string[]) => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture Author");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  return { root, git };
}

describe("release --push guard", () => {
  test("allows pushing from main", () => {
    expect(releasePushError(repo().root)).toBeNull();
  });

  test("refuses a task branch, whose release commit and tag would bypass main", () => {
    const { root, git } = repo();
    git("checkout", "-q", "-b", "codex/scope/topic");
    expect(releasePushError(root)).toContain("codex/scope/topic");
  });

  test("refuses a detached HEAD", () => {
    const { root, git } = repo();
    git("checkout", "-q", "--detach");
    expect(releasePushError(root)).toContain("detached");
  });

  test("release.ts checks the guard before editing anything", () => {
    const source = readFileSync(join(import.meta.dir, "..", "scripts", "release.ts"), "utf8");
    const guard = source.indexOf("releasePushError(ROOT)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(source.indexOf("rewriteManifestVersion(rel, current, target)"));
  });
});
