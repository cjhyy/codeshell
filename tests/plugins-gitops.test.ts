import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gitClone, gitRevParseHead, githubRepoToCloneUrl } from "../packages/core/src/plugins/gitOps.js";

function makeBareRepo(dir: string) {
  // Create a local repo with one commit, then bare-clone it so gitClone can pull from it.
  const work = mkdtempSync(join(tmpdir(), "gitops-work-"));
  spawnSync("git", ["init", "-q"], { cwd: work });
  spawnSync("git", ["config", "user.email", "test@test"], { cwd: work });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: work });
  writeFileSync(join(work, "README.md"), "hi");
  spawnSync("git", ["add", "."], { cwd: work });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: work });
  spawnSync("git", ["clone", "--bare", "-q", work, dir]);
  rmSync(work, { recursive: true, force: true });
}

describe("gitOps", () => {
  it("githubRepoToCloneUrl produces https url", () => {
    expect(githubRepoToCloneUrl("anthropics/skills")).toBe("https://github.com/anthropics/skills.git");
  });

  it("gitClone copies from a local bare repo and rev-parse HEAD works", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitops-test-"));
    try {
      const bare = join(root, "src.git");
      makeBareRepo(bare);
      const dest = join(root, "dst");
      const r = await gitClone(bare, dest);
      expect(r.ok).toBe(true);
      const head = await gitRevParseHead(dest);
      expect(head.ok).toBe(true);
      if (head.ok) {
        expect(head.stdout).toMatch(/^[0-9a-f]{40}$/);
      }
      // README.md is present from the source repo
      expect(readFileSync(join(dest, "README.md"), "utf-8")).toBe("hi");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gitClone fails on a non-existent path", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitops-fail-"));
    try {
      const dest = join(root, "dst");
      const r = await gitClone("/no/such/repo/at/all.git", dest);
      expect(r.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
