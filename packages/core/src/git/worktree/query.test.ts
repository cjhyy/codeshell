import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWorktree } from "./crud.js";
import { listWorktrees, listWorktreesFast } from "./query.js";
import type { SessionWorkspace } from "../../types.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

describe("listWorktreesFast", () => {
  let repo: string;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cs-wt-query-root-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    git(repo, ["branch", "-M", "main"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("returns empty list for a non-git directory", async () => {
    const nonGit = mkdtempSync(join(tmpdir(), "cs-wt-non-git-"));
    try {
      expect(await listWorktreesFast(nonGit)).toEqual([]);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  test("returns ownership and managed metadata without diff summaries", async () => {
    const wt = await createWorktree(repo, "ui", "session123456", { prefix: "agent/" });
    writeFileSync(join(wt.worktreePath, "dirty.txt"), "dirty\n");

    const externalPath = resolve(repo, "..", ".worktrees", "external");
    git(repo, ["worktree", "add", "-b", "external/feature", externalPath]);

    const workspace: SessionWorkspace = {
      root: wt.worktreePath,
      kind: "worktree",
      worktree: {
        path: wt.worktreePath,
        branch: wt.worktreeBranch,
        baseRef: "main",
        createdBy: "codeshell",
      },
    };

    const entries = await listWorktreesFast(repo, {
      prefix: "agent/",
      currentSessionId: "current-session",
      workspaceOwners: [{ sessionId: "other-session", workspace }],
    });

    const main = entries.find((entry) => entry.isMain);
    expect(main?.isMain).toBe(true);
    expect(main?.diff).toBeUndefined();

    const managed = entries.find((entry) => entry.path === wt.worktreePath);
    expect(managed?.isManaged).toBe(true);
    expect(managed?.diff).toBeUndefined();
    expect(managed?.occupiedBySessionIds).toEqual(["other-session"]);
    expect(managed?.occupiedByOtherSession).toBe(true);

    const external = entries.find((entry) => entry.branch === "external/feature");
    expect(external?.isManaged).toBe(false);

    await expect(listWorktrees(repo, { includeDiffSummary: true })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: wt.worktreePath, diff: expect.any(Object) }),
      ]),
    );
  });
});
