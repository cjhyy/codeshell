/**
 * SharedFactCollector — collects base context (facts only, no conclusions).
 *
 * Design principle: keep the initial context LEAN. Provide just enough
 * for participants to orient (diff stat, top changed files, directory
 * clusters, truncated diff). Models use tools to read details on demand.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ArenaBaseContext, ArenaScopeSpec } from "../types.js";
import { logger } from "../../logging/logger.js";

/** Max chars of raw diff to include — models can read_file for details */
const MAX_DIFF_CHARS = 20_000;
/** Max changed files to list (top-level orientation) */
const MAX_CHANGED_FILES = 30;
/** Max file content chars for non-git modes */
const MAX_FILE_CHARS = 8_000;

/**
 * Collect base context from a resolved scope.
 * Returns only verifiable facts — no LLM interpretation.
 */
export function collectSharedFacts(scope: ArenaScopeSpec): ArenaBaseContext {
  switch (scope.kind) {
    case "git":
      return collectGitFacts(scope);
    case "module":
      return collectModuleFacts(scope);
    case "files":
      return collectFileFacts(scope);
    case "topic":
      return collectTopicFacts(scope);
    default:
      return emptyContext(scope);
  }
}

// ─── Git Facts ─────────────────────────────────────────────────
// Keep it lean: diff stat + directory clusters + truncated diff.
// No file summaries, no full file list — models use tools for that.

function collectGitFacts(scope: ArenaScopeSpec): ArenaBaseContext {
  const ctx = emptyContext(scope);
  const gitSpec = scope.git;
  if (!gitSpec) return ctx;

  const currentBranch = git("git rev-parse --abbrev-ref HEAD");

  ctx.gitFacts = {
    currentBranch: currentBranch || undefined,
    baseRef: gitSpec.baseRef,
    headRef: gitSpec.headRef,
  };

  // Commit log (max 20)
  const logCmd = gitSpec.baseRef
    ? `git log --oneline ${gitSpec.baseRef}..${gitSpec.headRef ?? "HEAD"} --max-count=20`
    : "git log --oneline -10";
  const log = git(logCmd);
  if (log) {
    ctx.gitFacts.commitLog = log.split("\n").filter(Boolean);
  }

  // Diff stat — compact overview, always included
  const statCmd = gitSpec.includeWorkingTree
    ? "git diff --stat HEAD"
    : `git diff --stat ${gitSpec.baseRef}...${gitSpec.headRef ?? "HEAD"}`;
  const stat = git(statCmd) || (gitSpec.includeWorkingTree ? git("git diff --stat --cached") : "");
  if (stat) {
    ctx.gitFacts.diffStat = stat;
  }

  // Changed files — only top N, grouped by directory
  const filesCmd = gitSpec.includeWorkingTree
    ? "git diff --name-status HEAD"
    : `git diff --name-status ${gitSpec.baseRef}...${gitSpec.headRef ?? "HEAD"}`;
  const changedFiles = git(filesCmd) || (gitSpec.includeWorkingTree ? git("git diff --name-status --cached") : "");
  if (changedFiles) {
    const allChanged = changedFiles.split("\n").filter(Boolean);
    const allPaths = allChanged
      .map((line) => line.split("\t").slice(1).join("\t"))
      .filter(Boolean);

    // Store limited list for the prompt
    ctx.gitFacts.changedFiles = allChanged.slice(0, MAX_CHANGED_FILES);
    if (allChanged.length > MAX_CHANGED_FILES) {
      ctx.gitFacts.changedFiles.push(`... and ${allChanged.length - MAX_CHANGED_FILES} more files`);
    }

    // Key files: just the paths (no content), limited
    ctx.codeFacts.keyFiles = allPaths.slice(0, MAX_CHANGED_FILES);

    // Directory clustering — show which dirs have the most changes
    const dirCounts = clusterByDirectory(allPaths);
    if (dirCounts.length > 0) {
      ctx.rawArtifacts.push({
        kind: "doc",
        id: "dir-clusters",
        preview: `Changed files by directory (${allPaths.length} total):\n` +
          dirCounts.slice(0, 15).map(([dir, count]) => `  ${dir}/ (${count} files)`).join("\n"),
      });
    }
  }

  // Raw diff — truncated, models use read_file for full context
  const diffCmd = gitSpec.includeWorkingTree
    ? "git diff HEAD"
    : `git diff ${gitSpec.baseRef}...${gitSpec.headRef ?? "HEAD"}`;
  let diff = git(diffCmd);
  if (!diff && gitSpec.includeWorkingTree) {
    diff = git("git diff --cached");
  }
  if (!diff && gitSpec.baseRef && !gitSpec.includeWorkingTree) {
    diff = git(`git diff origin/${gitSpec.baseRef}...${gitSpec.headRef ?? "HEAD"}`);
  }

  if (diff) {
    const truncated = diff.length > MAX_DIFF_CHARS;
    const preview = truncated
      ? diff.slice(0, MAX_DIFF_CHARS).slice(0, diff.slice(0, MAX_DIFF_CHARS).lastIndexOf("\n"))
      : diff;
    ctx.rawArtifacts.push({
      kind: "diff",
      id: "main-diff",
      preview: preview + (truncated
        ? `\n\n... TRUNCATED (${diff.length} chars total, showing first ${MAX_DIFF_CHARS}). Use read_file to inspect specific files.`
        : ""),
    });
  }

  // If no diff found, include git status
  if (!diff && !stat) {
    const status = git("git status --short");
    if (status) {
      ctx.rawArtifacts.push({
        kind: "doc",
        id: "git-status",
        preview: status,
      });
    }
  }

  // NO file summaries, NO file content reads for git mode.
  // Models have tools to read_file on demand.

  logger.info("arena.shared_facts", {
    kind: "git",
    changedFiles: ctx.gitFacts.changedFiles?.length ?? 0,
    diffChars: diff?.length ?? 0,
    truncated: (diff?.length ?? 0) > MAX_DIFF_CHARS,
    artifacts: ctx.rawArtifacts.length,
  });

  return ctx;
}

/** Cluster file paths by top-level directory, sorted by count desc */
function clusterByDirectory(paths: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const p of paths) {
    // Use first 2 path segments as the directory key
    const parts = p.split("/");
    const dir = parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0];
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// ─── Module Facts ──────────────────────────────────────────────

function collectModuleFacts(scope: ArenaScopeSpec): ArenaBaseContext {
  const ctx = emptyContext(scope);
  const modules = scope.modules ?? [];

  for (const mod of modules) {
    if (!existsSync(mod)) continue;

    // Directory tree
    const tree = buildTree(mod, 3);
    ctx.rawArtifacts.push({
      kind: "tree",
      id: `tree-${mod}`,
      preview: tree,
    });

    // Key files in module
    const files = collectModuleFiles(mod);
    ctx.codeFacts.keyFiles.push(...files);

    // Read entry files only (index, main)
    for (const file of files.slice(0, 3)) {
      const content = safeReadFile(file);
      if (content) {
        ctx.rawArtifacts.push({
          kind: "file",
          id: `file-${file}`,
          preview: truncateContent(content),
        });
      }
    }
  }

  return ctx;
}

// ─── File Facts ────────────────────────────────────────────────

function collectFileFacts(scope: ArenaScopeSpec): ArenaBaseContext {
  const ctx = emptyContext(scope);
  const files = scope.files ?? [];

  for (const filePath of files) {
    if (!existsSync(filePath)) continue;
    ctx.codeFacts.keyFiles.push(filePath);
    const content = safeReadFile(filePath);
    if (content) {
      ctx.rawArtifacts.push({
        kind: "file",
        id: `file-${filePath}`,
        preview: truncateContent(content),
      });
    }
  }

  return ctx;
}

// ─── Topic Facts ───────────────────────────────────────────────

function collectTopicFacts(scope: ArenaScopeSpec): ArenaBaseContext {
  const ctx = emptyContext(scope);
  const hints = scope.searchHints ?? [];

  // Project structure overview
  const tree = buildTree(".", 2);
  ctx.rawArtifacts.push({
    kind: "tree",
    id: "project-tree",
    preview: tree,
  });

  // Grep for search hints to find relevant files
  for (const hint of hints.slice(0, 5)) {
    const grepResult = git(`grep -rl --include='*.ts' --include='*.js' --include='*.py' -i ${JSON.stringify(hint)} . 2>/dev/null | head -10`);
    if (grepResult) {
      const files = grepResult.split("\n").filter(Boolean);
      ctx.codeFacts.keyFiles.push(...files);
    }
  }

  ctx.codeFacts.keyFiles = [...new Set(ctx.codeFacts.keyFiles)];

  // Git recent activity
  const recentLog = git("git log --oneline -10");
  if (recentLog) {
    ctx.rawArtifacts.push({
      kind: "doc",
      id: "recent-git-log",
      preview: recentLog,
    });
  }

  return ctx;
}

// ─── Helpers ───────────────────────────────────────────────────

function emptyContext(scope: ArenaScopeSpec): ArenaBaseContext {
  return {
    scope,
    codeFacts: { keyFiles: [], fileSummaries: [] },
    rawArtifacts: [],
  };
}

function git(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 10_000 }).trim();
  } catch {
    return "";
  }
}

function safeReadFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const stat = statSync(filePath);
    if (stat.size > 500_000) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function truncateContent(content: string): string {
  if (content.length <= MAX_FILE_CHARS) return content;
  const truncated = content.slice(0, MAX_FILE_CHARS);
  const lastNewline = truncated.lastIndexOf("\n");
  return truncated.slice(0, lastNewline) + `\n... (truncated, ${content.length} chars total)`;
}

function buildTree(dir: string, maxDepth: number, depth = 0, prefix = ""): string {
  if (depth >= maxDepth) return "";
  try {
    const entries = readdirSync(dir).filter((e) => !e.startsWith(".") && e !== "node_modules" && e !== "dist" && e !== "__pycache__");
    const lines: string[] = [];
    for (const entry of entries.slice(0, 30)) {
      const fullPath = join(dir, entry);
      const isDir = statSync(fullPath).isDirectory();
      lines.push(`${prefix}${isDir ? "/" : ""} ${entry}`);
      if (isDir && depth < maxDepth - 1) {
        lines.push(buildTree(fullPath, maxDepth, depth + 1, prefix + "  "));
      }
    }
    return lines.filter(Boolean).join("\n");
  } catch {
    return "";
  }
}

function collectModuleFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir);
    const priority = ["index.ts", "index.js", "main.ts", "main.js", "mod.ts", "__init__.py"];
    for (const p of priority) {
      if (entries.includes(p)) files.push(join(dir, p));
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (/\.(ts|js|tsx|jsx|py)$/.test(entry) && !files.includes(full)) {
        files.push(full);
      }
    }
  } catch { /* ignore */ }
  return files;
}
