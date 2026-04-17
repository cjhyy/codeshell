/**
 * GitProvider — collects evidence from git: diffs, commit logs, changed files.
 *
 * Security: All git commands use execFileSync with argument arrays
 * to prevent shell injection. Git refs are sanitized before use.
 */

import { execFileSync } from "node:child_process";
import type { ArenaPlan, ArenaArtifact, ArenaContextProvider } from "../types.js";
import { logger } from "../../logging/logger.js";

const MAX_DIFF_CHARS = 20_000;
const MAX_CHANGED_FILES = 30;

export const gitProvider: ArenaContextProvider = {
  kind: "git",

  collect(plan: ArenaPlan, _topic: string): ArenaArtifact[] {
    const artifacts: ArenaArtifact[] = [];
    const targets = plan.sources.find((s) => s.kind === "git")?.targets;
    const baseRef = sanitizeRef(targets?.[0]);
    const headRef = sanitizeRef(targets?.[1]) ?? "HEAD";
    const isCompare = !!baseRef;

    // Current branch
    const currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (currentBranch) {
      artifacts.push({
        id: "git-branch",
        kind: "doc",
        source: "git",
        title: "Current Branch",
        preview: currentBranch,
      });
    }

    // Commit log
    const logArgs = isCompare
      ? ["log", "--oneline", `${baseRef}..${headRef}`, "--max-count=20"]
      : ["log", "--oneline", "-10"];
    const log = git(logArgs);
    if (log) {
      artifacts.push({
        id: "git-log",
        kind: "doc",
        source: "git",
        title: "Commit Log",
        preview: log,
      });
    }

    // Diff stat
    const statArgs = isCompare
      ? ["diff", "--stat", `${baseRef}...${headRef}`]
      : ["diff", "--stat", "HEAD"];
    let stat = git(statArgs);
    if (!stat && !isCompare) stat = git(["diff", "--stat", "--cached"]);
    if (stat) {
      artifacts.push({
        id: "git-diffstat",
        kind: "doc",
        source: "git",
        title: "Diff Stat",
        preview: stat,
      });
    }

    // Changed files
    const filesArgs = isCompare
      ? ["diff", "--name-status", `${baseRef}...${headRef}`]
      : ["diff", "--name-status", "HEAD"];
    let changedFiles = git(filesArgs);
    if (!changedFiles && !isCompare) changedFiles = git(["diff", "--name-status", "--cached"]);
    if (changedFiles) {
      const allChanged = changedFiles.split("\n").filter(Boolean);
      const limited = allChanged.slice(0, MAX_CHANGED_FILES);
      if (allChanged.length > MAX_CHANGED_FILES) {
        limited.push(`... and ${allChanged.length - MAX_CHANGED_FILES} more files`);
      }
      artifacts.push({
        id: "git-changed-files",
        kind: "doc",
        source: "git",
        title: "Changed Files",
        preview: limited.join("\n"),
        metadata: { totalCount: allChanged.length },
      });

      // Directory clustering
      const paths = allChanged.map((line) => line.split("\t").slice(1).join("\t")).filter(Boolean);
      const dirCounts = clusterByDirectory(paths);
      if (dirCounts.length > 0) {
        artifacts.push({
          id: "git-dir-clusters",
          kind: "doc",
          source: "git",
          title: "Changes by Directory",
          preview: dirCounts.slice(0, 15).map(([dir, count]) => `  ${dir}/ (${count} files)`).join("\n"),
        });
      }
    }

    // Truncated diff
    const diffArgs = isCompare
      ? ["diff", `${baseRef}...${headRef}`]
      : ["diff", "HEAD"];
    let diff = git(diffArgs);
    if (!diff && !isCompare) diff = git(["diff", "--cached"]);
    if (diff) {
      const truncated = diff.length > MAX_DIFF_CHARS;
      const preview = truncated
        ? diff.slice(0, MAX_DIFF_CHARS).slice(0, diff.slice(0, MAX_DIFF_CHARS).lastIndexOf("\n"))
        : diff;
      artifacts.push({
        id: "git-diff",
        kind: "diff",
        source: "git",
        title: "Diff",
        preview: preview + (truncated
          ? `\n\n... TRUNCATED (${diff.length} chars total). Use read_file to inspect specific files.`
          : ""),
        metadata: { totalChars: diff.length, truncated },
      });
    }

    // Fallback: git status
    if (!diff && !stat) {
      const status = git(["status", "--short"]);
      if (status) {
        artifacts.push({
          id: "git-status",
          kind: "doc",
          source: "git",
          title: "Git Status",
          preview: status,
        });
      }
    }

    logger.info("arena.provider.git", {
      artifactCount: artifacts.length,
      hasCompare: isCompare,
    });

    return artifacts;
  },
};

/**
 * Execute a git command safely using execFileSync (no shell interpretation).
 */
function git(args: string[]): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Sanitize a git ref string from LLM output.
 * Strips range operators (.., ...) and shell-unsafe characters so that
 * the ref can be safely interpolated into `git diff baseRef...headRef`.
 */
function sanitizeRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  // Strip range operators that the LLM may have included
  let cleaned = ref.replace(/\.{2,}/g, "");
  // Only allow safe git ref characters: alphanumeric, /, -, _, ~, ^, .
  cleaned = cleaned.replace(/[^a-zA-Z0-9/_\-~^.]/g, "");
  return cleaned || undefined;
}

function clusterByDirectory(paths: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split("/");
    const dir = parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0];
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
