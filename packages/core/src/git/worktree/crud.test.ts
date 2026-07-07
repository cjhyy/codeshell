import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, removeWorktree } from "./crud.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

describe("worktree CRUD", () => {
  let repo: string;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cs-wt-crud-root-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("errors clearly before git tries to check out a branch already used by a worktree", async () => {
    const first = await createWorktree(repo, "dup", "session123456");

    await expect(createWorktree(repo, "dup", "session123456")).rejects.toThrow(
      new RegExp(
        `branch ${first.worktreeBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} already checked out at `,
      ),
    );
  });

  test("symlinks root node_modules and workspace package node_modules into the worktree", async () => {
    // Root-level shared dir (existing behavior).
    mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
    // Monorepo workspace packages, each with its own private node_modules
    // that is NOT hoisted to the root (e.g. electron in packages/desktop).
    mkdirSync(join(repo, "packages", "core", "node_modules", "dep-a"), { recursive: true });
    mkdirSync(join(repo, "packages", "desktop", "node_modules", "electron"), { recursive: true });
    // A package WITHOUT node_modules must not gain a broken/empty link.
    mkdirSync(join(repo, "packages", "cdp"), { recursive: true });

    const wt = await createWorktree(repo, "mono", "abcd1234ef");

    const rootLink = join(wt.worktreePath, "node_modules");
    expect(lstatSync(rootLink).isSymbolicLink()).toBe(true);
    expect(existsSync(join(rootLink, "left-pad"))).toBe(true);

    const coreLink = join(wt.worktreePath, "packages", "core", "node_modules");
    expect(lstatSync(coreLink).isSymbolicLink()).toBe(true);
    expect(existsSync(join(coreLink, "dep-a"))).toBe(true);

    const desktopLink = join(wt.worktreePath, "packages", "desktop", "node_modules");
    expect(lstatSync(desktopLink).isSymbolicLink()).toBe(true);
    expect(existsSync(join(desktopLink, "electron"))).toBe(true);

    expect(existsSync(join(wt.worktreePath, "packages", "cdp", "node_modules"))).toBe(false);
  });

  test("removeBranch=true deletes managed branches with the default prefix", async () => {
    const wt = await createWorktree(repo, "feat", "abcd1234ef");
    expect(existsSync(wt.worktreePath)).toBe(true);
    expect(git(repo, ["branch", "--list", wt.worktreeBranch])).toContain("feat");

    removeWorktree(wt.worktreePath, true);

    expect(existsSync(wt.worktreePath)).toBe(false);
    expect(git(repo, ["branch", "--list", wt.worktreeBranch])).toBe("");
  });

  test("removeBranch=true allows configured prefixes and historical worktree prefixes", async () => {
    const custom = await createWorktree(repo, "custom", "abcd1234ef", { prefix: "agent/" });
    removeWorktree(custom.worktreePath, true, { prefix: "agent/" });
    expect(git(repo, ["branch", "--list", custom.worktreeBranch])).toBe("");

    const historical = await createWorktree(repo, "old", "abcd1234ef");
    removeWorktree(historical.worktreePath, true, { prefix: "agent/" });
    expect(git(repo, ["branch", "--list", historical.worktreeBranch])).toBe("");
  });

  test("removeBranch=true refuses external branches", () => {
    const externalPath = join(repo, "..", ".worktrees", "external-crud");
    git(repo, ["worktree", "add", "-b", "external/feature", externalPath]);

    expect(() => removeWorktree(externalPath, true, { prefix: "agent/" })).toThrow(
      /refusing to delete non-CodeShell worktree branch/i,
    );
    expect(existsSync(externalPath)).toBe(true);
  });
});
