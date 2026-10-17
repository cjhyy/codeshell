import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DiffFile } from "./parseUnifiedDiff";

/** Actual owned Git output, without Core, Electron, hooks or model calls. */
export async function withHeaderOnlyGitPatch<T>(
  run: (fixture: {
    cwd: string;
    raw: string;
    unquoted: string;
    expected: DiffFile[];
  }) => T | Promise<T>,
): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), "codeshell-header-only-git-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        `core.hooksPath=${join(cwd, "absent-hooks")}`,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.quotePath=true",
        ...args,
      ],
      { cwd, encoding: "utf8", timeout: 5_000 },
    );
  try {
    git("init", "--quiet");
    git("config", "user.name", "Owned header-only fixture");
    git("config", "user.email", "review@example.invalid");
    git("config", "diff.renames", "false");
    git("config", "core.filemode", "true");
    // Windows chmod does not provide Git's POSIX executable-bit transition.
    const modes = process.platform === "win32" ? [] : ["run.sh", "run with spaces.sh"];
    const binaries = ["binary with spaces.dat", "二进制 中文.dat", "folder b/name.dat"];
    if (process.platform !== "win32")
      binaries.push(" padded file.dat ", 'quote"name.dat', "back\\slash.dat", "tab\tname.dat");
    for (const name of modes) {
      writeFileSync(join(cwd, name), "echo owned\n");
      chmodSync(join(cwd, name), 0o644);
    }
    for (const name of binaries) {
      mkdirSync(dirname(join(cwd, name)), { recursive: true });
      writeFileSync(join(cwd, name), Buffer.from("old\0owned"));
    }
    writeFileSync(join(cwd, "gone empty.txt"), "");
    git("add", ".");
    git("commit", "--quiet", "-m", "Owned baseline");
    for (const name of modes) chmodSync(join(cwd, name), 0o755);
    for (const name of binaries) writeFileSync(join(cwd, name), Buffer.from("new\0owned"));
    rmSync(join(cwd, "gone empty.txt"));
    writeFileSync(join(cwd, "new empty.txt"), "");
    git("add", "--all");
    const expected: DiffFile[] = [
      ...[...modes, ...binaries].map((path) => ({
        oldPath: path,
        newPath: path,
        status: "modified" as const,
        hunks: [],
      })),
      { oldPath: "gone empty.txt", newPath: null, status: "deleted" as const, hunks: [] },
      { oldPath: null, newPath: "new empty.txt", status: "added" as const, hunks: [] },
    ].sort((a, b) => (a.newPath ?? a.oldPath ?? "").localeCompare(b.newPath ?? b.oldPath ?? ""));
    return await run({
      cwd,
      expected,
      raw: git("diff", "--cached", "--no-ext-diff", "--no-color", "--unified=3"),
      unquoted: git(
        "-c",
        "core.quotePath=false",
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-color",
        "--unified=3",
      ),
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
