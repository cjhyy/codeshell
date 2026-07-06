import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { enterWorktreeTool, exitWorktreeTool, getActiveWorktree } from "./worktree.js";
import { removeWorktree } from "../../git/worktree.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

describe("ExitWorktree cleanup actions", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cs-wt-tool-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
  });
  afterEach(async () => {
    const active = getActiveWorktree();
    if (active) await exitWorktreeTool({ action: "discard" });
    rmSync(repo, { recursive: true, force: true });
    rmSync(join(repo, "..", ".worktrees"), { recursive: true, force: true });
  });

  test("keep preserves the directory and branch", async () => {
    await enterWorktreeTool({ slug: "keep", __cwd: repo, __sessionId: "keep123456" });
    const active = getActiveWorktree()!;

    const out = await exitWorktreeTool({ action: "keep" });

    expect(out).toContain("preserved");
    expect(existsSync(active.worktreePath)).toBe(true);
    expect(git(repo, ["branch", "--list", active.worktreeBranch])).toContain(active.worktreeBranch);
    expect(getActiveWorktree()).toBeUndefined();
    removeWorktree(active.worktreePath, true);
  });

  test("detach removes the directory and keeps the branch", async () => {
    await enterWorktreeTool({ slug: "detach", __cwd: repo, __sessionId: "detach123456" });
    const active = getActiveWorktree()!;

    const out = await exitWorktreeTool({ action: "detach" });

    expect(out).toContain("Branch");
    expect(existsSync(active.worktreePath)).toBe(false);
    expect(git(repo, ["branch", "--list", active.worktreeBranch])).toContain(active.worktreeBranch);
    expect(getActiveWorktree()).toBeUndefined();
  });

  test("discard removes the directory and deletes the branch", async () => {
    await enterWorktreeTool({ slug: "discard", __cwd: repo, __sessionId: "discard123456" });
    const active = getActiveWorktree()!;

    const out = await exitWorktreeTool({ action: "discard" });

    expect(out).toContain("deleted");
    expect(existsSync(active.worktreePath)).toBe(false);
    expect(git(repo, ["branch", "--list", active.worktreeBranch])).toBe("");
    expect(getActiveWorktree()).toBeUndefined();
  });

  test("omitted action auto-detaches a clean worktree", async () => {
    await enterWorktreeTool({ slug: "auto", __cwd: repo, __sessionId: "auto123456" });
    const active = getActiveWorktree()!;

    const out = await exitWorktreeTool({});

    expect(out).toContain("auto");
    expect(existsSync(active.worktreePath)).toBe(false);
    expect(git(repo, ["branch", "--list", active.worktreeBranch])).toContain(active.worktreeBranch);
    expect(getActiveWorktree()).toBeUndefined();
  });

  test("omitted action refuses to clean a worktree with uncommitted changes", async () => {
    await enterWorktreeTool({ slug: "dirty", __cwd: repo, __sessionId: "dirty123456" });
    const active = getActiveWorktree()!;
    writeFileSync(join(active.worktreePath, "dirty.txt"), "dirty\n");

    const out = await exitWorktreeTool({});

    expect(out.toLowerCase()).toContain("error");
    expect(out).toContain("keep");
    expect(out).toContain("discard");
    expect(existsSync(active.worktreePath)).toBe(true);
    expect(getActiveWorktree()).toEqual(active);
  });

  test("detach refuses to drop uncommitted changes", async () => {
    await enterWorktreeTool({ slug: "dirty-detach", __cwd: repo, __sessionId: "dirtydt123456" });
    const active = getActiveWorktree()!;
    writeFileSync(join(active.worktreePath, "dirty.txt"), "dirty\n");

    const out = await exitWorktreeTool({ action: "detach" });

    expect(out.toLowerCase()).toContain("error");
    expect(out).toContain("keep");
    expect(out).toContain("discard");
    expect(existsSync(active.worktreePath)).toBe(true);
    expect(getActiveWorktree()).toEqual(active);
  });
});
