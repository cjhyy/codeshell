import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseUnifiedDiff } from "../renderer/diff/parseUnifiedDiff.js";

type SharedElectronMockState = {
  sessions?: Map<
    string,
    { session: Electron.Session; onFromPartition?: (partition: string) => void }
  >;
  openExternal?: (...args: unknown[]) => Promise<void>;
  openPath?: (...args: unknown[]) => Promise<string>;
  showItemInFolder?: (...args: unknown[]) => void;
};

const electronMockGlobal = globalThis as typeof globalThis & {
  __codeshellElectronMockState?: SharedElectronMockState;
};

// Keep the first Electron mock compatible with other Main-process test shards.
mock.module("electron", () => ({
  session: {
    fromPartition(partition: string) {
      const entry = electronMockGlobal.__codeshellElectronMockState?.sessions?.get(partition);
      entry?.onFromPartition?.(partition);
      return (
        entry?.session ??
        ({
          cookies: { get: async () => [], set: async () => undefined },
          clearStorageData: async () => undefined,
        } as Electron.Session)
      );
    },
  },
  shell: {
    openExternal: (...args: unknown[]) =>
      electronMockGlobal.__codeshellElectronMockState?.openExternal?.(...args) ?? Promise.resolve(),
    showItemInFolder: (...args: unknown[]) =>
      electronMockGlobal.__codeshellElectronMockState?.showItemInFolder?.(...args),
    openPath: (...args: unknown[]) =>
      electronMockGlobal.__codeshellElectronMockState?.openPath?.(...args) ?? Promise.resolve(""),
  },
}));

const { getGitDiffForReview, getGitRangeDiff, getGitCommitDiff } =
  await import("./desktop-services.js");
const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "CodeShell Test",
  GIT_AUTHOR_EMAIL: "codeshell@example.test",
  GIT_COMMITTER_NAME: "CodeShell Test",
  GIT_COMMITTER_EMAIL: "codeshell@example.test",
};

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, env: GIT_ENV, encoding: "utf8" })).stdout.trim();
}

let root: string;
let repo: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "codeshell-review-diff-")));
  repo = join(root, "repo");
  await fs.mkdir(repo);
  await git(repo, ["init", "-q"]);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function commitInitial(): Promise<void> {
  await fs.writeFile(join(repo, "tracked.txt"), "committed\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "initial"]);
}

function paths(diff: string): Array<string | null> {
  return parseUnifiedDiff(diff).map((file) => file.newPath ?? file.oldPath);
}

describe("getGitDiffForReview real Git snapshots", () => {
  test("all and unstaged include untracked content while staged preserves index scope", async () => {
    await commitInitial();
    await fs.writeFile(join(repo, "tracked.txt"), "staged\n");
    await git(repo, ["add", "tracked.txt"]);
    await fs.writeFile(join(repo, "tracked.txt"), "working\n");
    await fs.writeFile(join(repo, "new.txt"), "new content\n");

    const all = await getGitDiffForReview(repo, "all");
    expect(paths(all)).toEqual(["tracked.txt", "new.txt"]);
    expect(all).toContain("-committed\n+working\n");
    expect(all).toContain("+new content\n");

    const unstaged = await getGitDiffForReview(repo, "unstaged");
    expect(paths(unstaged)).toEqual(["tracked.txt", "new.txt"]);
    expect(unstaged).toContain("-staged\n+working\n");

    const staged = await getGitDiffForReview(repo, "staged");
    expect(paths(staged)).toEqual(["tracked.txt"]);
    expect(staged).toContain("-committed\n+staged\n");
    expect(staged).not.toContain("new content");
  });

  test("untracked-only repositories are reviewable and clean repositories remain empty", async () => {
    await commitInitial();
    expect(await getGitDiffForReview(repo)).toBe("");
    await fs.writeFile(join(repo, "only-new.ts"), "export const added = true;\n");
    expect(paths(await getGitDiffForReview(repo))).toEqual(["only-new.ts"]);
    expect(await getGitDiffForReview(repo, "staged")).toBe("");
  });

  test("unborn all reads the current worktree once and staged reads the index", async () => {
    await fs.writeFile(join(repo, "added.txt"), "index version\n");
    await git(repo, ["add", "added.txt"]);
    await fs.writeFile(join(repo, "added.txt"), "worktree version\n");
    await fs.writeFile(join(repo, "untracked.txt"), "new version\n");

    const all = await getGitDiffForReview(repo, "all");
    expect(paths(all)).toEqual(["added.txt", "untracked.txt"]);
    expect(all).toContain("+worktree version\n");
    expect(all).not.toContain("index version");
    expect(parseUnifiedDiff(all).every((file) => file.status === "added")).toBe(true);

    const staged = await getGitDiffForReview(repo, "staged");
    expect(paths(staged)).toEqual(["added.txt"]);
    expect(staged).toContain("+index version\n");

    const unstaged = await getGitDiffForReview(repo, "unstaged");
    expect(paths(unstaged)).toEqual(["added.txt", "untracked.txt"]);
    expect(unstaged).toContain("-index version\n+worktree version\n");
  });

  test("a file named HEAD cannot be mistaken for the requested revision", async () => {
    await fs.writeFile(join(repo, "HEAD"), "head file\n");
    await fs.writeFile(join(repo, "staged.txt"), "staged file\n");
    await git(repo, ["add", "staged.txt"]);
    expect(paths(await getGitDiffForReview(repo)).sort()).toEqual(["HEAD", "staged.txt"]);
    await commitInitial();
    await fs.writeFile(join(repo, "HEAD"), "changed head file\n");
    expect(paths(await getGitDiffForReview(repo))).toEqual(["HEAD"]);
  });

  test("empty unborn repositories and staged additions deleted from the worktree have no final content", async () => {
    expect(await getGitDiffForReview(repo)).toBe("");
    await fs.mkdir(join(repo, "removed"));
    await fs.writeFile(join(repo, "removed", "added.txt"), "staged\n");
    await git(repo, ["add", "-A"]);
    await fs.rm(join(repo, "removed"), { recursive: true });
    expect(await getGitDiffForReview(repo, "all")).toBe("");
    expect(paths(await getGitDiffForReview(repo, "staged"))).toEqual(["removed/added.txt"]);
    expect(parseUnifiedDiff(await getGitDiffForReview(repo, "unstaged"))[0]?.status).toBe(
      "deleted",
    );
  });

  test("added paths preserve spaces, Unicode, quotes, tabs, newlines and backslashes through the UI parser", async () => {
    await commitInitial();
    const filenames = ["new file.txt", "中文 文档.txt", 'quote"\\\t\nname.txt', " trailing .txt "];
    for (const filename of filenames) await fs.writeFile(join(repo, filename), "added\n");
    const diff = await getGitDiffForReview(repo);
    expect(paths(diff).sort()).toEqual([...filenames].sort());
    expect(parseUnifiedDiff(diff).every((file) => file.oldPath === null)).toBe(true);
  });

  test("empty and binary additions retain metadata instead of disappearing", async () => {
    await commitInitial();
    await fs.writeFile(join(repo, "empty.txt"), "");
    await fs.writeFile(join(repo, "binary.dat"), Buffer.from([0, 1, 2]));
    await fs.writeFile(join(repo, "invalid-utf8.dat"), Buffer.from([255, 254]));
    const diff = await getGitDiffForReview(repo);
    expect(paths(diff).sort()).toEqual(["binary.dat", "empty.txt", "invalid-utf8.dat"]);
    expect(diff).toContain('Binary files /dev/null and "b/binary.dat" differ');
    expect(diff).toContain('Binary files /dev/null and "b/invalid-utf8.dat" differ');
    expect(
      parseUnifiedDiff(diff).every((file) => file.status === "added" && !file.hunks.length),
    ).toBe(true);
  });

  test("executable mode and missing-final-newline markers are preserved", async () => {
    await commitInitial();
    await fs.writeFile(join(repo, "run.sh"), "#!/bin/sh\necho hello");
    await fs.chmod(join(repo, "run.sh"), 0o755);
    const diff = await getGitDiffForReview(repo);
    expect(diff).toContain("new file mode 100755");
    expect(diff).toContain(
      "@@ -0,0 +1,2 @@\n+#!/bin/sh\n+echo hello\n\\ No newline at end of file\n",
    );
    expect(parseUnifiedDiff(diff)[0]?.hunks[0]?.lines.at(-1)?.kind).toBe("meta");
  });

  test("UTF-8 BOM and non-newline Unicode separators preserve the exact added text", async () => {
    await commitInitial();
    const text = "\uFEFFfirst\u2028line\r\n\nend";
    await fs.writeFile(join(repo, "unicode.txt"), text);
    const file = parseUnifiedDiff(await getGitDiffForReview(repo))[0];
    expect(file?.hunks[0]?.newCount).toBe(3);
    expect(
      file?.hunks[0]?.lines.filter((line) => line.kind === "add").map((line) => line.text),
    ).toEqual(["\uFEFFfirst\u2028line\r", "", "end"]);
  });

  test("symbolic links are reviewed as link text without reading their targets", async () => {
    await commitInitial();
    const outside = join(root, "outside-secret.txt");
    await fs.writeFile(outside, "PRIVATE TARGET\n".repeat(200_000));
    await fs.symlink(outside, join(repo, "outside-link"));
    await fs.symlink(join(root, "missing"), join(repo, "broken-link"));
    const diff = await getGitDiffForReview(repo);
    expect(paths(diff).sort()).toEqual(["broken-link", "outside-link"]);
    expect(diff).toContain("new file mode 120000");
    expect(diff).toContain(`+${outside}\n`);
    expect(diff).not.toContain("PRIVATE TARGET");
  });

  test("ignored files stay out of the review snapshot", async () => {
    await fs.writeFile(join(repo, ".gitignore"), "ignored/\n");
    await commitInitial();
    await fs.mkdir(join(repo, "ignored"));
    await fs.writeFile(join(repo, "ignored", "secret.txt"), "ignored content\n");
    expect(await getGitDiffForReview(repo)).toBe("");
  });

  test("Git external diff and textconv programs cannot run during Review", async () => {
    await commitInitial();
    const marker = join(root, "unexpected-diff-command");
    const program = join(root, "external.sh");
    await fs.writeFile(program, `#!/bin/sh\ntouch '${marker}'\necho REPLACED\n`);
    await fs.chmod(program, 0o755);
    await git(repo, ["config", "diff.external", program]);
    await git(repo, ["config", "diff.review.textconv", program]);
    await fs.writeFile(join(repo, ".gitattributes"), "tracked.txt diff=review\n");
    await fs.writeFile(join(repo, "tracked.txt"), "working\n");
    await git(repo, ["config", "diff.noprefix", "true"]);
    await git(repo, ["config", "diff.relative", "true"]);
    const diff = await getGitDiffForReview(repo);
    expect(diff).toContain("-committed\n+working\n");
    expect(paths(diff)).toContain("tracked.txt");
    expect(
      await fs.stat(marker).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("committed and branch-range review cannot execute repository diff or textconv programs", async () => {
    await commitInitial();
    await fs.writeFile(join(repo, "tracked.txt"), "committed change\n");
    await fs.writeFile(join(repo, ".gitattributes"), "tracked.txt diff=review\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "change"]);
    const marker = join(root, "unexpected-range-command");
    const program = join(root, "external-range.sh");
    await fs.writeFile(program, `#!/bin/sh\ntouch '${marker}'\necho REPLACED\n`);
    await fs.chmod(program, 0o755);
    await git(repo, ["config", "diff.external", program]);
    await git(repo, ["config", "diff.review.textconv", program]);
    await git(repo, ["config", "diff.noprefix", "true"]);
    await git(repo, ["config", "diff.relative", "true"]);
    const patches = [
      await getGitRangeDiff(repo, "HEAD~1..HEAD"),
      await getGitRangeDiff(repo, "HEAD~1..HEAD", "tracked.txt"),
      await getGitCommitDiff(repo, "HEAD"),
    ];
    for (const diff of patches) {
      expect(diff).toContain("-committed\n+committed change\n");
      expect(paths(diff)).toContain("tracked.txt");
    }
    expect(
      await fs.stat(marker).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("file count limits reject the snapshot rather than dropping later additions", async () => {
    await commitInitial();
    await Promise.all(
      Array.from({ length: 513 }, (_, index) => fs.writeFile(join(repo, `new-${index}.txt`), "")),
    );
    await expect(getGitDiffForReview(repo)).rejects.toThrow("512 file limit");
  });

  test("oversize new files report a visible error with the affected filename", async () => {
    await commitInitial();
    await fs.writeFile(join(repo, "too-large.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, 120));
    await expect(getGitDiffForReview(repo)).rejects.toThrow(
      '"too-large.txt": file exceeds the 2 MiB content limit',
    );
  });

  test("aggregate new binary content is bounded even when metadata diffs are small", async () => {
    await commitInitial();
    const binary = Buffer.alloc(2 * 1024 * 1024);
    for (let index = 0; index < 5; index++) await fs.writeFile(join(repo, `${index}.dat`), binary);
    await expect(getGitDiffForReview(repo)).rejects.toThrow(
      "new file content exceeds the 8 MiB limit",
    );
  });

  test("large tracked diffs report a visible error rather than returning an incomplete patch", async () => {
    await commitInitial();
    await fs.writeFile(join(repo, "tracked.txt"), "large line\n".repeat(850_000));
    await expect(getGitDiffForReview(repo)).rejects.toThrow("8 MiB size limit");
  });

  test.skipIf(process.getuid?.() === 0)(
    "unreadable additions report a repository error",
    async () => {
      await commitInitial();
      const file = join(repo, "unreadable.txt");
      await fs.writeFile(file, "cannot read\n");
      await fs.chmod(file, 0o000);
      try {
        await expect(getGitDiffForReview(repo)).rejects.toThrow(
          'Cannot collect Review diff for "unreadable.txt"',
        );
      } finally {
        await fs.chmod(file, 0o600);
      }
    },
  );

  test("unmerged entries fail explicitly instead of producing an ignored combined diff", async () => {
    await commitInitial();
    const originalBranch = await git(repo, ["branch", "--show-current"]);
    await git(repo, ["checkout", "-q", "-b", "review-conflict"]);
    await fs.writeFile(join(repo, "tracked.txt"), "branch content\n");
    await git(repo, ["commit", "-q", "-am", "branch change"]);
    await git(repo, ["checkout", "-q", originalBranch]);
    await fs.writeFile(join(repo, "tracked.txt"), "main content\n");
    await git(repo, ["commit", "-q", "-am", "main change"]);
    await expect(git(repo, ["merge", "--no-edit", "review-conflict"])).rejects.toThrow();
    for (const mode of ["all", "unstaged", "staged"] as const) {
      await expect(getGitDiffForReview(repo, mode)).rejects.toThrow("Resolve merge conflicts");
    }
  });

  test("a broken HEAD ref cannot masquerade as an unborn repository", async () => {
    await commitInitial();
    const branchRef = await git(repo, ["symbolic-ref", "HEAD"]);
    await fs.writeFile(join(repo, ".git", branchRef), "broken reference\n");
    await expect(getGitDiffForReview(repo)).rejects.toThrow();
  });

  test("Git execution failures remain visible", async () => {
    await expect(getGitDiffForReview(root)).rejects.toThrow();
  });
});
