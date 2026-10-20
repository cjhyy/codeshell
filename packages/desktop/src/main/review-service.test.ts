import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewWorkspace } from "./review-service.js";

mock.module("electron", () => ({
  shell: {
    openExternal: async () => undefined,
    showItemInFolder: () => undefined,
    openPath: async () => "",
  },
}));

const { ReviewService } = await import("./review-service.js");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "CodeShell Test",
  GIT_AUTHOR_EMAIL: "codeshell@example.test",
  GIT_COMMITTER_NAME: "CodeShell Test",
  GIT_COMMITTER_EMAIL: "codeshell@example.test",
};

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "codeshell-review-"));
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

function repo(name: string, relativeFile = "src/shared.ts"): string {
  const root = join(fixtureRoot, name);
  mkdirSync(join(root, "src"), { recursive: true });
  git(root, ["init", "-q"]);
  writeFileSync(join(root, relativeFile), `export const value = "${name}";\n`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "initial"]);
  writeFileSync(join(root, relativeFile), `export const value = "${name}-changed";\n`);
  return realpathSync(root);
}

function workspace(
  roots: Array<{ id: string; path: string; role?: "primary" | "secondary" }>,
  options: { projectId?: string | null; mainRootId?: string } = {},
): ReviewWorkspace {
  return {
    projectId: options.projectId === undefined ? "project-1" : options.projectId,
    mainRootId: options.mainRootId ?? roots[0]!.id,
    roots: roots.map((root, index) => ({
      ...root,
      role: root.role ?? (index === 0 ? "primary" : "secondary"),
    })),
  };
}

describe("ReviewService multi-repository aggregation", () => {
  test("prepares a review with authoritative repository identity and user focus", async () => {
    const repository = repo("ai-review");
    const before = git(repository, ["status", "--porcelain"]);
    const service = new ReviewService({
      resolveWorkspace: async () => workspace([{ id: "root-a", path: repository }]),
    });
    const result = await service.preparePrompt("session-1", {
      kind: "git",
      scope: { kind: "working", mode: "all" },
      instructions: "Focus on concurrency regressions",
    });
    expect(result.truncated).toBe(false);
    expect(result.prompt).toContain(repository);
    expect(result.prompt).toContain("ai-review-changed");
    expect(result.prompt).toContain("Focus on concurrency regressions");
    expect(result.prompt).toContain("read-only review");
    expect(git(repository, ["status", "--porcelain"])).toBe(before);
  });

  test("does not generate an AI review from partial repository success or an empty diff", async () => {
    const repository = repo("partial-review");
    const service = new ReviewService({
      resolveWorkspace: async () => workspace([{ id: "root-a", path: repository }]),
      getGitDiff: async () => {
        throw new Error("cannot read the index");
      },
    });
    await expect(
      service.preparePrompt("session-1", {
        kind: "git",
        scope: { kind: "working", mode: "all" },
      }),
    ).rejects.toThrow("cannot read the index");
    await expect(
      service.preparePrompt("session-1", {
        kind: "snapshot",
        diff: "  \n",
      }),
    ).rejects.toThrow("No changes to review");
  });

  test("reviews historical snapshot bytes without querying the live Git diff", async () => {
    const repository = repo("snapshot-review");
    const sessions: string[] = [];
    const service = new ReviewService({
      resolveWorkspace: async (sessionId) => {
        sessions.push(sessionId);
        return workspace([{ id: "root-a", path: repository }]);
      },
      getGitDiff: async () => {
        throw new Error("must not query live Git");
      },
    });
    const result = await service.preparePrompt("session-1", {
      kind: "snapshot",
      diff: "+historical-value",
      label: "saved.ts",
    });
    expect(sessions).toEqual(["session-1"]);
    expect(result.prompt).toContain("historical turn snapshot: saved.ts");
    expect(result.prompt).toContain("+historical-value");
    expect(result.prompt).not.toContain("snapshot-review-changed");
  });

  test("bounds drafts even with huge Markdown fences and reports incomplete coverage", async () => {
    const service = new ReviewService({
      resolveWorkspace: async () => workspace([{ id: "root-a", path: "/repo" }]),
    });
    for (const diff of ["x".repeat(25_000), "`".repeat(24_000)]) {
      const result = await service.preparePrompt("session-1", { kind: "snapshot", diff });
      expect(result.prompt.length).toBeLessThanOrEqual(32_000);
      expect(result.truncated).toBe(true);
      expect(result.prompt).toContain("Coverage is incomplete");
    }
    await expect(
      service.preparePrompt("session-1", {
        kind: "snapshot",
        diff: "x",
        instructions: "x".repeat(2_001),
      }),
    ).rejects.toThrow("2000");
    await expect(
      service.preparePrompt("session-1", {
        kind: "snapshot",
        diff: "x".repeat(2_000_001),
      }),
    ).rejects.toThrow("maximum");
  });

  test("selected root and latest commits expose their additions through real Git", async () => {
    const repository = repo("initial-commit");
    const hash = git(repository, ["rev-parse", "HEAD"]);
    const service = new ReviewService({
      resolveWorkspace: async () => workspace([{ id: "root-a", path: repository }]),
    });
    for (const request of [
      { kind: "committed", rootId: "root-a", commitHash: hash },
      { kind: "committed" },
    ] as const) {
      const result = await service.getDiff("session-1", request);
      expect(result.errors).toEqual([]);
      expect(result.repositories[0]?.diff).toContain('export const value = "initial-commit";');
      expect(result.repositories[0]?.diff).toContain("new file mode");
      expect(result.repositories[0]?.diff).not.toContain("initial-commit-changed");
    }
  });

  test("invalid committed objects and branch ranges remain observable repository errors", async () => {
    const repository = repo("failed-range");
    const service = new ReviewService({
      resolveWorkspace: async () => workspace([{ id: "root-a", path: repository }]),
      getGitBranchBase: async () => "missing-review-base",
    });
    for (const request of [
      { kind: "committed", rootId: "root-a", commitHash: "1234abcd" },
      { kind: "branch" },
    ] as const) {
      const result = await service.getDiff("session-1", request);
      expect(result.repositories).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        operation: "diff",
        rootId: "root-a",
        repoRoot: repository,
      });
    }
  });

  test("merge commit review shows the first-parent patch", async () => {
    const repository = repo("merge-commit");
    const main = git(repository, ["branch", "--show-current"]);
    git(repository, ["checkout", "-b", "fixture-topic"]);
    writeFileSync(join(repository, "topic.txt"), "topic addition\n");
    git(repository, ["add", "topic.txt"]);
    git(repository, ["commit", "-q", "-m", "topic"]);
    git(repository, ["checkout", main]);
    git(repository, ["merge", "--no-ff", "fixture-topic", "-m", "merge topic"]);
    const service = new ReviewService({
      resolveWorkspace: async () => workspace([{ id: "root-a", path: repository }]),
    });
    const result = await service.getDiff("session-1", { kind: "committed" });
    expect(result.errors).toEqual([]);
    expect(result.repositories[0]?.diff).toContain("+topic addition");
    expect(result.repositories[0]?.diff).not.toContain("merge-commit-changed");
  });

  test("fans out to two independent repositories and returns stable root/repository context", async () => {
    const repoB = repo("repo-b");
    const repoA = repo("repo-a");
    const resolvedSessionIds: string[] = [];
    const service = new ReviewService({
      resolveWorkspace: async (sessionId) => {
        resolvedSessionIds.push(sessionId);
        return workspace([
          { id: "root-b", path: repoB },
          { id: "root-a", path: repoA },
        ]);
      },
    });

    const status = await service.getStatus("session-1");

    expect(resolvedSessionIds).toEqual(["session-1"]);
    expect(status.errors).toEqual([]);
    expect(status.repositories.map((entry) => entry.repoRoot)).toEqual([repoA, repoB]);
    expect(status.repositories.map((entry) => entry.rootId)).toEqual(["root-a", "root-b"]);
    expect(status.repositories.flatMap((entry) => entry.entries)).toEqual([
      { code: " M", path: "src/shared.ts", rootId: "root-a", repoRoot: repoA },
      { code: " M", path: "src/shared.ts", rootId: "root-b", repoRoot: repoB },
    ]);
  });

  test("folds two mounted roots in one repository into one Git operation while retaining root ids", async () => {
    const repository = repo("mono");
    const app = join(repository, "apps", "app");
    const packageRoot = join(repository, "packages", "pkg");
    mkdirSync(app, { recursive: true });
    mkdirSync(packageRoot, { recursive: true });
    let statusCalls = 0;
    const service = new ReviewService({
      resolveWorkspace: async () =>
        workspace([
          { id: "app-root", path: app },
          { id: "package-root", path: packageRoot },
        ]),
      getGitStatus: async () => {
        statusCalls += 1;
        return { branch: "main", entries: [], clean: true };
      },
    });

    const status = await service.getStatus("session-1");

    expect(statusCalls).toBe(1);
    expect(status.repositories).toHaveLength(1);
    expect(status.repositories[0]).toMatchObject({
      rootId: "app-root",
      rootIds: ["app-root", "package-root"],
      repoRoot: repository,
    });
  });

  test("skips a non-Git mounted root without failing a Git repository", async () => {
    const repository = repo("git-root");
    const plain = join(fixtureRoot, "plain-root");
    mkdirSync(plain);
    const service = new ReviewService({
      resolveWorkspace: async () =>
        workspace([
          { id: "git-root", path: repository },
          { id: "plain-root", path: plain },
        ]),
    });

    const status = await service.getStatus("session-1");

    expect(status.errors).toEqual([]);
    expect(status.repositories).toHaveLength(1);
    expect(status.repositories[0]).toMatchObject({ rootId: "git-root", repoRoot: repository });
  });

  test("keeps same-named relative files from separate repositories distinct", async () => {
    const repoA = repo("same-a");
    const repoB = repo("same-b");
    const service = new ReviewService({
      resolveWorkspace: async () =>
        workspace([
          { id: "root-a", path: repoA },
          { id: "root-b", path: repoB },
        ]),
    });

    const result = await service.getDiff("session-1", { kind: "working", mode: "all" });

    expect(result.errors).toEqual([]);
    expect(result.repositories).toHaveLength(2);
    expect(result.repositories.map((entry) => [entry.rootId, entry.repoRoot])).toEqual([
      ["root-a", repoA],
      ["root-b", repoB],
    ]);
    for (const entry of result.repositories) {
      expect(entry.diff).toContain("src/shared.ts");
    }
  });

  test("isolates one repository failure and includes repository/root context in the error", async () => {
    const repoA = repo("healthy");
    const repoB = repo("broken");
    const service = new ReviewService({
      resolveWorkspace: async () =>
        workspace([
          { id: "healthy-root", path: repoA },
          { id: "broken-root", path: repoB },
        ]),
      getGitDiff: async (repoRoot) => {
        if (repoRoot === repoB) throw new Error("simulated Git failure");
        return "healthy diff";
      },
    });

    const result = await service.getDiff("session-1", { kind: "working", mode: "all" });

    expect(result.repositories).toEqual([
      {
        rootId: "healthy-root",
        rootIds: ["healthy-root"],
        repoRoot: repoA,
        diff: "healthy diff",
      },
    ]);
    expect(result.errors).toEqual([
      {
        operation: "diff",
        rootId: "broken-root",
        rootIds: ["broken-root"],
        repoRoot: repoB,
        message: "simulated Git failure",
      },
    ]);
  });

  test("keeps a legacy unbound Session on the single-root Review path", async () => {
    const repository = repo("legacy");
    const service = new ReviewService({
      resolveWorkspace: async (sessionId) =>
        workspace([{ id: `legacy:${sessionId}`, path: repository }], {
          projectId: null,
          mainRootId: `legacy:${sessionId}`,
        }),
    });

    const status = await service.getStatus("legacy-session");

    expect(status.errors).toEqual([]);
    expect(status.repositories).toHaveLength(1);
    expect(status.repositories[0]).toMatchObject({
      rootId: "legacy:legacy-session",
      rootIds: ["legacy:legacy-session"],
      repoRoot: repository,
    });
  });
});
