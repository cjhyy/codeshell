import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

type SharedElectronMockState = {
  sessions: Map<
    string,
    {
      session: Electron.Session;
      onFromPartition?: (partition: string) => void;
    }
  >;
};

const electronMockGlobal = globalThis as typeof globalThis & {
  __codeshellElectronMockState?: SharedElectronMockState;
};

// Bun keeps the first mock.module("electron") result in its process-wide
// module cache. Keep this early mock compatible with the partition-aware tests
// that may run later in the same `bun test packages/desktop` process.
mock.module("electron", () => ({
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString("utf-8"),
  },
  session: {
    fromPartition(partition: string) {
      const entry = electronMockGlobal.__codeshellElectronMockState?.sessions.get(partition);
      entry?.onFromPartition?.(partition);
      return (
        entry?.session ??
        ({
          cookies: {
            get: async () => [],
            set: async () => undefined,
          },
          clearStorageData: async () => undefined,
        } as Electron.Session)
      );
    },
  },
  shell: {
    openExternal: async () => {},
    showItemInFolder: () => {},
    openPath: async () => "",
  },
}));

const { cleanupStaleWorktrees } = await import("./desktop-services.js");

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

function stale(paths: string[]): void {
  const old = new Date(Date.now() - 60 * 60_000);
  for (const path of paths) {
    utimesSync(path, old, old);
  }
}

describe("cleanupStaleWorktrees", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cs-desktop-stale-wt-"));
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

  test("removes clean merged managed worktrees and keeps external/detached ones", async () => {
    const worktreesDir = resolve(repo, "..", ".worktrees");
    const configuredPath = join(worktreesDir, "configured");
    const historicalPath = join(worktreesDir, "historical");
    const externalPath = join(worktreesDir, "external");
    const detachedPath = join(worktreesDir, "detached");

    git(repo, ["worktree", "add", "-b", "agent/configured", configuredPath]);
    git(repo, ["worktree", "add", "-b", "worktree/historical", historicalPath]);
    git(repo, ["worktree", "add", "-b", "external/feature", externalPath]);
    git(repo, ["worktree", "add", "--detach", detachedPath, "HEAD"]);

    stale([configuredPath, historicalPath, externalPath, detachedPath]);

    const result = await cleanupStaleWorktrees(repo, 1, "agent/");

    expect(result.removed.map((path) => basename(path)).sort()).toEqual([
      "configured",
      "historical",
    ]);
    expect(result.skipped).toEqual([]);
    expect(existsSync(configuredPath)).toBe(false);
    expect(existsSync(historicalPath)).toBe(false);
    expect(existsSync(externalPath)).toBe(true);
    expect(existsSync(detachedPath)).toBe(true);
    expect(git(repo, ["branch", "--list", "agent/configured"])).toBe("");
    expect(git(repo, ["branch", "--list", "worktree/historical"])).toBe("");
    expect(git(repo, ["branch", "--list", "external/feature"])).toContain("external/feature");
  });

  test("keeps dirty and untracked managed worktrees", async () => {
    const worktreesDir = resolve(repo, "..", ".worktrees");
    const dirtyPath = join(worktreesDir, "dirty");
    const untrackedPath = join(worktreesDir, "untracked");

    git(repo, ["worktree", "add", "-b", "agent/dirty", dirtyPath]);
    git(repo, ["worktree", "add", "-b", "agent/untracked", untrackedPath]);
    writeFileSync(join(dirtyPath, "f.txt"), "changed\n");
    writeFileSync(join(untrackedPath, "new.txt"), "new\n");
    stale([dirtyPath, untrackedPath]);

    const result = await cleanupStaleWorktrees(repo, 1, "agent/");

    expect(result.removed).toEqual([]);
    expect(result.skipped.map((item) => [basename(item.path), item.reason]).sort()).toEqual([
      ["dirty", "dirty"],
      ["untracked", "dirty"],
    ]);
    expect(existsSync(dirtyPath)).toBe(true);
    expect(existsSync(untrackedPath)).toBe(true);
    expect(git(repo, ["branch", "--list", "agent/dirty"])).toContain("agent/dirty");
    expect(git(repo, ["branch", "--list", "agent/untracked"])).toContain("agent/untracked");
  });

  test("keeps managed worktrees with commits ahead of the base branch", async () => {
    const worktreesDir = resolve(repo, "..", ".worktrees");
    const aheadPath = join(worktreesDir, "ahead");

    git(repo, ["worktree", "add", "-b", "agent/ahead", aheadPath]);
    writeFileSync(join(aheadPath, "ahead.txt"), "ahead\n");
    git(aheadPath, ["add", "-A"]);
    git(aheadPath, ["commit", "-q", "-m", "ahead"]);
    stale([aheadPath]);

    const result = await cleanupStaleWorktrees(repo, 1, "agent/");

    expect(result.removed).toEqual([]);
    expect(result.skipped.map((item) => [basename(item.path), item.reason])).toEqual([
      ["ahead", "unmerged_commits"],
    ]);
    expect(existsSync(aheadPath)).toBe(true);
    expect(git(repo, ["branch", "--list", "agent/ahead"])).toContain("agent/ahead");
  });

  test("keeps managed worktrees when no safe base ref can be resolved", async () => {
    const worktreesDir = resolve(repo, "..", ".worktrees");
    const orphanPath = join(worktreesDir, "orphan");

    git(repo, ["worktree", "add", "-b", "agent/orphan", orphanPath]);
    git(repo, ["switch", "--detach", "HEAD"]);
    git(repo, ["branch", "-D", "main"]);
    stale([orphanPath]);

    const result = await cleanupStaleWorktrees(repo, 1, "agent/");

    expect(result.removed).toEqual([]);
    expect(result.skipped.map((item) => [basename(item.path), item.reason])).toEqual([
      ["orphan", "base_unknown"],
    ]);
    expect(existsSync(orphanPath)).toBe(true);
    expect(git(repo, ["branch", "--list", "agent/orphan"])).toContain("agent/orphan");
  });

  test("keeps a worktree when git worktree remove fails", async () => {
    const worktreesDir = resolve(repo, "..", ".worktrees");
    const lockedPath = join(worktreesDir, "locked");

    git(repo, ["worktree", "add", "-b", "agent/locked", lockedPath]);
    git(repo, ["worktree", "lock", lockedPath]);
    stale([lockedPath]);

    const result = await cleanupStaleWorktrees(repo, 1, "agent/");

    expect(result.removed).toEqual([]);
    expect(result.skipped.map((item) => [basename(item.path), item.reason])).toEqual([
      ["locked", "remove_failed"],
    ]);
    expect(existsSync(lockedPath)).toBe(true);
    expect(git(repo, ["branch", "--list", "agent/locked"])).toContain("agent/locked");
  });

  test("removes a clean worktree but keeps its branch when branch -d fails", async () => {
    const worktreesDir = resolve(repo, "..", ".worktrees");
    const branchKeptPath = join(worktreesDir, "branch-kept");

    git(repo, ["branch", "old-base"]);
    writeFileSync(join(repo, "f.txt"), "updated\n");
    git(repo, ["commit", "-am", "main update"]);
    git(repo, ["worktree", "add", "-b", "agent/branch-kept", branchKeptPath]);
    git(branchKeptPath, ["branch", "--set-upstream-to=old-base"]);
    stale([branchKeptPath]);

    const originalWarn = console.warn;
    console.warn = () => undefined;
    let result!: Awaited<ReturnType<typeof cleanupStaleWorktrees>>;
    try {
      result = await cleanupStaleWorktrees(repo, 1, "agent/");
    } finally {
      console.warn = originalWarn;
    }

    expect(result.removed.map((path) => basename(path))).toEqual(["branch-kept"]);
    expect(result.skipped.map((item) => [basename(item.path), item.reason])).toEqual([
      ["branch-kept", "branch_delete_failed"],
    ]);
    expect(result.skipped[0]?.detail).toContain("not fully merged");
    expect(existsSync(branchKeptPath)).toBe(false);
    expect(git(repo, ["branch", "--list", "agent/branch-kept"])).toContain("agent/branch-kept");
  });
});
