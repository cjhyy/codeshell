import { describe, test, expect } from "bun:test";
import { runWriteJobInWorktree, type WriteJobGitOps } from "./write-run.js";

function fakeGit(): { ops: WriteJobGitOps; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ops: {
      createWorktree(root, slug) {
        calls.push(`create:${root}:${slug}`);
        return { path: `/wt/${slug}`, branch: `automation/${slug}` };
      },
      hasChanges(path) {
        calls.push(`changes:${path}`);
        return true;
      },
      openPr(path, branch, title) {
        calls.push(`pr:${path}:${branch}:${title}`);
        return { url: `https://example/pr/1` };
      },
      removeWorktree(path) {
        calls.push(`remove:${path}`);
      },
    },
  };
}

describe("runWriteJobInWorktree", () => {
  test("creates a worktree, runs in it, opens a PR when there are changes, cleans up", async () => {
    const { ops, calls } = fakeGit();
    let ranIn = "";
    const result = await runWriteJobInWorktree({
      gitRoot: "/proj",
      slug: "nightly-fix",
      prTitle: "Automated: nightly fix",
      git: ops,
      run: async (cwd) => {
        ranIn = cwd;
        return { text: "done", reason: "completed" };
      },
    });
    expect(ranIn).toBe("/wt/nightly-fix"); // ran inside the worktree, not /proj
    expect(result.prUrl).toBe("https://example/pr/1");
    expect(calls).toEqual([
      "create:/proj:nightly-fix",
      "changes:/wt/nightly-fix",
      "pr:/wt/nightly-fix:automation/nightly-fix:Automated: nightly fix",
      "remove:/wt/nightly-fix",
    ]);
  });

  test("skips PR when the run made no changes", async () => {
    const { ops, calls } = fakeGit();
    ops.hasChanges = () => false;
    const result = await runWriteJobInWorktree({
      gitRoot: "/proj",
      slug: "noop",
      prTitle: "x",
      git: ops,
      run: async () => ({ text: "", reason: "completed" }),
    });
    expect(result.prUrl).toBeNull();
    expect(calls.some((c) => c.startsWith("pr:"))).toBe(false);
    // Worktree is still cleaned up.
    expect(calls.some((c) => c.startsWith("remove:"))).toBe(true);
  });

  test("cleans up the worktree even when the run throws", async () => {
    const { ops, calls } = fakeGit();
    await expect(
      runWriteJobInWorktree({
        gitRoot: "/proj",
        slug: "boom",
        prTitle: "x",
        git: ops,
        run: async () => {
          throw new Error("run failed");
        },
      }),
    ).rejects.toThrow("run failed");
    expect(calls.some((c) => c.startsWith("remove:"))).toBe(true);
  });
});
