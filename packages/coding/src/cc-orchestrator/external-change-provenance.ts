import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  sanitizeExternalChangedFilesProvenance,
  type ExternalChangedFileRef,
  type ExternalChangedFilesProvenance,
} from "@cjhyy/code-shell-core/extension";
import {
  createReadOnlyGitRunner,
  gitRepositoryId,
  type ReadOnlyGitExecutor,
} from "../git/readonly-git.js";

export interface ExternalChangedFilesProbeOptions {
  cli?: "claude" | "codex";
  budgetMs?: number;
  commandTimeoutMs?: number;
  maxFiles?: number;
  runGit?: ReadOnlyGitExecutor;
}

/** Best effort completion observation. Never a snapshot or evidence of earlier writes. */
export async function probeExternalChangedFiles(
  cwd: string,
  paths: readonly string[],
  opts: ExternalChangedFilesProbeOptions = {},
): Promise<ExternalChangedFilesProvenance> {
  const observedAt = Date.now();
  const files: ExternalChangedFileRef[] = [];
  const controller = new AbortController();
  const budget = Math.max(1, Math.min(4000, opts.budgetMs ?? 4000));
  const deadline = performance.now() + budget;
  const run = createReadOnlyGitRunner({
    deadline,
    signal: controller.signal,
    execute: opts.runGit,
    commandTimeoutMs: opts.commandTimeoutMs,
  });
  const limit = Math.max(0, Math.min(100, opts.maxFiles ?? 100));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const task = async () => {
      const groups = new Map<
        string,
        Array<{
          ref: ExternalChangedFileRef;
          real: string;
          stat: Stats;
        }>
      >();
      // Include every publishable path even if the first filesystem call stalls.
      files.push(
        ...paths.slice(0, 100).map((path) => ({
          path,
          absolutePath: resolve(cwd, path),
          presence: "unknown" as const,
          versionStatus: "skipped-limit" as const,
        })),
      );
      for (const [index, ref] of files.entries()) {
        if (index >= limit || controller.signal.aborted) continue;
        ref.versionStatus = "probe-failed";
        try {
          const stat = await lstat(ref.absolutePath);
          if (controller.signal.aborted) return;
          ref.presence = stat.isFile() && !stat.isSymbolicLink() ? "present" : "not-regular";
          ref.size = stat.size;
          if (ref.presence !== "present") {
            ref.versionStatus = "unsupported";
            continue;
          }
          const real = await realpath(ref.absolutePath);
          const dir = dirname(real);
          const group = groups.get(dir) ?? [];
          group.push({ ref, real, stat });
          groups.set(dir, group);
        } catch (error) {
          ref.presence = ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
            ? "missing"
            : "unknown";
          ref.versionStatus = ref.presence === "missing" ? "unsupported" : "probe-failed";
        }
      }
      for (const [dir, group] of groups) {
        if (controller.signal.aborted) break;
        try {
          let discovery: string[];
          try {
            discovery = (
              await run(dir, [
                "rev-parse",
                "--path-format=absolute",
                "--show-toplevel",
                "--absolute-git-dir",
                "--git-common-dir",
              ])
            )
              .toString("utf8")
              .trimEnd()
              .split("\n");
          } catch (error) {
            if (
              /not a git repository/i.test(String((error as { stderr?: unknown }).stderr ?? error))
            )
              for (const { ref } of group) ref.versionStatus = "outside-repository";
            continue;
          }
          if (discovery.length !== 3) continue;
          const [top, gitDir, commonDir] = await Promise.all(
            discovery.map((path) => realpath(path)),
          );
          const repositoryId = await gitRepositoryId(commonDir!);
          const commit = (await run(top!, ["rev-parse", "--verify", "HEAD^{commit}"]))
            .toString("utf8")
            .trim();
          let branch: string | undefined;
          try {
            branch =
              (await run(top!, ["symbolic-ref", "--quiet", "--short", "HEAD"]))
                .toString("utf8")
                .trim() || undefined;
          } catch {
            /* detached HEAD */
          }
          const candidates = group
            .map((entry) => ({
              ...entry,
              repoPath: relative(top!, entry.real).split(sep).join("/"),
            }))
            .filter(
              (entry) =>
                entry.repoPath &&
                !isAbsolute(entry.repoPath) &&
                !entry.repoPath.split("/").some((part) => part === ".." || part === "." || !part),
            );
          const repoPaths = candidates.map((e) => e.repoPath);
          if (!repoPaths.length) continue;
          // `status` can execute repository clean/process filters, including
          // drivers added concurrently. Plumbing reads the index without filters.
          const indexRows = (
            await run(top!, ["ls-files", "--stage", "-z", "--", ...repoPaths])
          ).toString("utf8");
          const indexEntries = new Map<string, string[][]>();
          for (const row of indexRows.split("\0").filter(Boolean)) {
            const tab = row.indexOf("\t");
            const path = row.slice(tab + 1);
            indexEntries.set(path, [
              ...(indexEntries.get(path) ?? []),
              row.slice(0, tab).split(" "),
            ]);
          }
          const tree = (
            await run(top!, ["ls-tree", "-z", "--full-tree", commit, "--", ...repoPaths])
          ).toString("utf8");
          const blobs = new Map(
            tree
              .split("\0")
              .filter(Boolean)
              .map((row) => {
                const tab = row.indexOf("\t");
                return [row.slice(tab + 1), row.slice(0, tab).split(" ")];
              }),
          );
          for (const { ref, real, stat, repoPath } of candidates) {
            if (controller.signal.aborted) break;
            const indexed = indexEntries.get(repoPath);
            const blob = blobs.get(repoPath);
            if (!blob && !indexed) {
              ref.versionStatus = "untracked";
              continue;
            } // includes ignored files
            if (
              !blob ||
              !indexed ||
              indexed.length !== 1 ||
              indexed[0]![2] !== "0" ||
              indexed[0]![0] !== blob[0] ||
              indexed[0]![1] !== blob[2]
            ) {
              ref.versionStatus = "uncommitted";
              continue;
            }
            if (!["100644", "100755"].includes(blob[0]!) || blob[1] !== "blob") {
              ref.versionStatus = "unsupported";
              continue;
            }
            if (
              process.platform !== "win32" &&
              (blob[0] === "100755") !== ((stat.mode & 0o111) !== 0)
            ) {
              ref.versionStatus = "uncommitted";
              continue;
            }
            // Do not trust the index stat cache/assume-unchanged or normalized filters.
            // Compare raw on-disk bytes, and fence a replacement/write during observation.
            const hash = (await run(top!, ["hash-object", "--no-filters", "--", real]))
              .toString("utf8")
              .trim();
            const after = await lstat(real);
            if (
              hash !== blob[2] ||
              !after.isFile() ||
              after.ino !== stat.ino ||
              after.dev !== stat.dev ||
              after.size !== stat.size ||
              after.mode !== stat.mode ||
              after.mtimeMs !== stat.mtimeMs ||
              after.ctimeMs !== stat.ctimeMs
            ) {
              ref.versionStatus = "uncommitted";
              continue;
            }
            ref.contentRef = {
              kind: "git-blob",
              commit,
              blob: blob[2]!,
              repoPath,
              worktreePath: top!,
              linkedWorktree: gitDir !== commonDir,
              ...(branch ? { branch } : {}),
              repositoryId,
            };
            ref.versionStatus = "recorded";
          }
        } catch {
          for (const { ref } of group) {
            delete ref.contentRef;
            ref.versionStatus = "probe-failed";
          }
        }
      }
    };
    await Promise.race([
      task(),
      new Promise<void>((resolveTimer) => {
        timer = setTimeout(() => {
          controller.abort();
          resolveTimer();
        }, budget);
      }),
    ]);
  } catch {
    /* even malformed runtime input must not block completion */
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
  return (
    sanitizeExternalChangedFilesProvenance(
      { schemaVersion: 1, cli: opts.cli ?? "claude", observedAt, capture: "completion", files },
      paths,
    ) ?? {
      schemaVersion: 1,
      cli: opts.cli ?? "claude",
      observedAt,
      capture: "completion",
      files: [],
    }
  );
}
