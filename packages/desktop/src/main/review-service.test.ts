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
