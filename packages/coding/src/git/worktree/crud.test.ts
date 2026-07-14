import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, lockWorktree, removeWorktree, unlockWorktree } from "./crud.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

describe("coding worktree CRUD", () => {
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

  test("a failed create never deletes a pre-existing directory at the worktree path", async () => {
    // A leftover directory (e.g. a prior crashed run, or manual work) sits at the
    // exact worktree path this call would use. `git worktree add` will fail with
    // "already exists"; rollback must NOT rm -rf the directory or its contents.
    const slug = "leftover";
    const sessionId = "sess123456";
    const worktreePath = join(root, ".worktrees", `${slug}-${sessionId.slice(0, 8)}`);
    mkdirSync(worktreePath, { recursive: true });
    const precious = join(worktreePath, "uncommitted.txt");
    writeFileSync(precious, "do not delete me\n");

    await expect(createWorktree(repo, slug, sessionId)).rejects.toThrow();

    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(precious)).toBe(true);
    expect(readFileSync(precious, "utf-8")).toBe("do not delete me\n");
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

  test("creates from an explicit base ref and records its immutable base commit", async () => {
    const original = git(repo, ["branch", "--show-current"]);
    git(repo, ["checkout", "-q", "-b", "stable"]);
    writeFileSync(join(repo, "stable.txt"), "from stable\n");
    git(repo, ["add", "stable.txt"]);
    git(repo, ["commit", "-q", "-m", "stable base"]);
    const stableCommit = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-q", original]);

    const wt = await createWorktree(repo, "based", "base123456", { baseRef: "stable" });

    expect(readFileSync(join(wt.worktreePath, "stable.txt"), "utf8")).toBe("from stable\n");
    expect(wt.baseRef).toBe(stableCommit);
    expect(wt.baseRefLabel).toBe("stable");
    removeWorktree(wt.worktreePath, true);
  });

  test("copies gitignored files selected by .worktreeinclude and explicit include patterns", async () => {
    writeFileSync(join(repo, ".gitignore"), ".env\nsecrets/\nlocal/\n");
    writeFileSync(join(repo, ".worktreeinclude"), ".env\nsecrets/*.json\n");
    git(repo, ["add", ".gitignore", ".worktreeinclude"]);
    git(repo, ["commit", "-q", "-m", "worktree include policy"]);
    writeFileSync(join(repo, ".env"), "TOKEN=test\n");
    mkdirSync(join(repo, "secrets"));
    writeFileSync(join(repo, "secrets", "app.json"), "{}\n");
    writeFileSync(join(repo, "secrets", "skip.txt"), "skip\n");
    mkdirSync(join(repo, "local"));
    writeFileSync(join(repo, "local", "override.json"), '{"local":true}\n');

    const wt = await createWorktree(repo, "includes", "incl123456", {
      include: ["local/*.json"],
    });

    expect(readFileSync(join(wt.worktreePath, ".env"), "utf8")).toBe("TOKEN=test\n");
    expect(readFileSync(join(wt.worktreePath, "secrets", "app.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(wt.worktreePath, "secrets", "skip.txt"))).toBe(false);
    expect(readFileSync(join(wt.worktreePath, "local", "override.json"), "utf8")).toContain(
      "local",
    );
    expect(wt.includedFiles?.sort()).toEqual([".env", "local/override.json", "secrets/app.json"]);
    removeWorktree(wt.worktreePath, true);
  });

  test("worktree locks block cleanup until the DriveAgent owner unlocks", async () => {
    const wt = await createWorktree(repo, "locked", "lock123456");
    lockWorktree(wt.worktreePath, "test owner");

    expect(() => removeWorktree(wt.worktreePath, true)).toThrow(/locked/i);
    expect(existsSync(wt.worktreePath)).toBe(true);

    unlockWorktree(wt.worktreePath);
    removeWorktree(wt.worktreePath, true);
    expect(existsSync(wt.worktreePath)).toBe(false);
  });
});
