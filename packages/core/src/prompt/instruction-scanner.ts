/**
 * Instruction scanner — discovers instruction files up the directory tree.
 *
 * Supports layered instruction files with priority ordering:
 *   1. managed  — shipped defaults (~/.code-shell/CODESHELL.md)
 *   2. user     — user-level (~/.code-shell/CODESHELL.md, ~/.code-shell/rules/)
 *   3. project  — project-level (from the host-provided boundary to cwd, walking down)
 *   4. local    — local overrides (CODESHELL.local.md, not version-controlled)
 *
 * Entries carry a `depth` field: 0 = project boundary / top-most, increasing toward cwd.
 *
 * File name search order per directory:
 *   CODESHELL.md → .codeshell/CODESHELL.md → .codeshell/rules/*.md
 *   CLAUDE.md    → .claude/CLAUDE.md       → .claude/rules/*.md      (compat)
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, parse, resolve } from "node:path";
import { userHome } from "../settings/manager.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface InstructionEntry {
  /** Absolute path to the file */
  path: string;
  /** Raw file content */
  content: string;
  /** Where the file came from */
  source: "managed" | "user" | "project" | "local";
  /**
   * Depth relative to the project root.
   * 0 = project boundary (or scan ceiling), increases toward cwd.
   * user/managed entries have depth -1.
   */
  depth: number;
}

export interface ScanOptions {
  /** Primary instruction file name (default: "CODESHELL.md") */
  fileName?: string;
  /** Extra directory names to probe alongside .codeshell/ */
  scanDirs?: string[];
  /** Compatibility file names to also look for (default: ["CLAUDE.md"]) */
  compatFileNames?: string[];
  /** If true, ignore a supplied project boundary and scan all the way to the filesystem root. */
  ignoreGitBoundary?: boolean;
  /** Domain/host-provided project boundary. Core itself assumes only cwd. */
  boundaryFinder?: (cwd: string) => string | null;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Scan for instruction files from cwd up to the project root,
 * plus user-level and managed-level instructions.
 *
 * Returns entries ordered by priority: managed → user → project (root→cwd) → local.
 */
export function scanInstructions(cwd: string, options: ScanOptions = {}): InstructionEntry[] {
  const fileName = options.fileName ?? "CODESHELL.md";
  const compatNames = options.compatFileNames ?? ["CLAUDE.md", "AGENTS.md"];
  const allNames = [fileName, ...compatNames];
  const configDirs = [".codeshell", ...(options.scanDirs ?? []), ".claude"];

  const entries: InstructionEntry[] = [];

  // 1. User-level instructions
  // userHome() (not raw homedir(), bun-cached) so a test/host HOME override
  // scans the intended user-level dirs, not the developer's real ~/.code-shell.
  const homeConfigDir = join(userHome(), ".code-shell");
  const homeCompatDir = join(userHome(), ".claude");
  for (const name of allNames) {
    tryAddFile(join(homeConfigDir, name), "user", -1, entries);
  }
  tryAddRulesDir(join(homeConfigDir, "rules"), "user", -1, entries);
  // compat: ~/.claude/
  for (const name of compatNames) {
    tryAddFile(join(homeCompatDir, name), "user", -1, entries);
  }
  tryAddRulesDir(join(homeCompatDir, "rules"), "user", -1, entries);

  // 2. Determine scan ceiling. A generic harness must not infer a Git project
  // or execute a VCS command. Domain packs can inject their own boundary.
  const ceiling = options.ignoreGitBoundary
    ? parse(resolve(cwd)).root
    : (options.boundaryFinder?.(cwd) ?? resolve(cwd));

  // 3. Collect directories from ceiling down to cwd
  const dirs = collectDirsDownward(resolve(cwd), ceiling);

  // 4. Walk directories root→cwd (depth 0, 1, 2, ...)
  for (let depth = 0; depth < dirs.length; depth++) {
    const dir = dirs[depth];

    // Primary + compat file names at directory level
    for (const name of allNames) {
      tryAddFile(join(dir, name), "project", depth, entries);
    }

    // Config subdirectories (.codeshell/, .claude/)
    for (const cfgDir of configDirs) {
      for (const name of allNames) {
        tryAddFile(join(dir, cfgDir, name), "project", depth, entries);
      }
      tryAddRulesDir(join(dir, cfgDir, "rules"), "project", depth, entries);
    }

    // Local instructions (not version controlled)
    for (const name of allNames) {
      const localName = name.replace(/\.md$/, ".local.md");
      tryAddFile(join(dir, localName), "local", depth, entries);
    }
  }

  return dedup(entries);
}

/**
 * Combine all instruction entries into a single string.
 *
 * Entries are grouped by source with headers, making it clear
 * where each instruction block originates.
 */
export function combineInstructions(entries: InstructionEntry[]): string {
  if (entries.length === 0) return "";

  // For a single entry, just return the content directly
  if (entries.length === 1) return entries[0].content;

  return entries
    .map((e) => {
      const label = sourceLabel(e);
      return `<!-- ${label} -->\n${e.content}`;
    })
    .join("\n\n---\n\n");
}

// ─── Internals ──────────────────────────────────────────────────────

function tryAddFile(
  path: string,
  source: InstructionEntry["source"],
  depth: number,
  entries: InstructionEntry[],
): void {
  if (!existsSync(path)) return;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return;
    const content = readFileSync(path, "utf-8").trim();
    if (content) {
      entries.push({ path, content, source, depth });
    }
  } catch {
    // Skip unreadable files
  }
}

function tryAddRulesDir(
  dir: string,
  source: InstructionEntry["source"],
  depth: number,
  entries: InstructionEntry[],
): void {
  if (!existsSync(dir)) return;
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    for (const file of files) {
      tryAddFile(join(dir, file), source, depth, entries);
    }
  } catch {
    // Skip unreadable dirs
  }
}

/**
 * Collect all directories from `ceiling` down to `target`, inclusive.
 * Returns [ceiling, ..., target] — root-first order.
 */
function collectDirsDownward(target: string, ceiling: string): string[] {
  const resolvedCeiling = resolve(ceiling);
  const resolvedTarget = resolve(target);

  // Walk up from target, collecting dirs until we reach ceiling
  const dirs: string[] = [];
  let dir = resolvedTarget;

  while (true) {
    dirs.push(dir);
    if (dir === resolvedCeiling) break;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  // Reverse so root comes first (depth 0)
  return dirs.reverse();
}

/**
 * Remove duplicate entries (same file path), keeping the first occurrence.
 */
function dedup(entries: InstructionEntry[]): InstructionEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.path)) return false;
    seen.add(e.path);
    return true;
  });
}

/**
 * Human-readable label for an instruction entry.
 */
function sourceLabel(entry: InstructionEntry): string {
  switch (entry.source) {
    case "managed":
      return "managed";
    case "user":
      return "user-level";
    case "project":
      return `project (depth ${entry.depth})`;
    case "local":
      return `local override (depth ${entry.depth})`;
  }
}
