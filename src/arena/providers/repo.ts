/**
 * RepoProvider — collects evidence from the code repository:
 * directory trees, key files, grep results.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ArenaPlan, ArenaArtifact, ArenaContextProvider } from "../types.js";
import { logger } from "../../logging/logger.js";

const MAX_FILE_CHARS = 8_000;
// Per-grep ceiling. We run up to 5 hints in parallel, so the worst-case
// wall time is ~3s rather than the previous 5×10s = 50s in series.
const GREP_TIMEOUT_MS = 3_000;
// Hard cap on tree-walk work — large monorepos (or recursive symlinks)
// could otherwise blow up readdirSync/statSync time.
const MAX_TREE_NODES = 400;

const execFileAsync = promisify(execFile);

export const repoProvider: ArenaContextProvider = {
  kind: "repo",

  async collect(plan: ArenaPlan, topic: string): Promise<ArenaArtifact[]> {
    const artifacts: ArenaArtifact[] = [];
    const targets = plan.sources.find((s) => s.kind === "repo")?.targets ?? [];

    // Project tree overview
    const tree = await buildTree(".", 2);
    if (tree) {
      artifacts.push({
        id: "repo-tree",
        kind: "tree",
        source: "repo",
        title: "Project Structure",
        preview: tree,
      });
    }

    // If specific targets provided, read them
    for (const target of targets) {
      if (!existsSync(target)) continue;
      const st = statSync(target);
      if (st.isDirectory()) {
        const dirTree = await buildTree(target, 3);
        if (dirTree) {
          artifacts.push({
            id: `repo-tree-${target}`,
            kind: "tree",
            source: "repo",
            title: `Directory: ${target}`,
            preview: dirTree,
          });
        }
        // Read entry files
        for (const file of (await collectEntryFiles(target)).slice(0, 3)) {
          const content = safeReadFile(file);
          if (content) {
            artifacts.push({
              id: `repo-file-${file}`,
              kind: "file",
              source: "repo",
              title: file,
              ref: file,
              preview: truncate(content),
            });
          }
        }
      } else {
        const content = safeReadFile(target);
        if (content) {
          artifacts.push({
            id: `repo-file-${target}`,
            kind: "file",
            source: "repo",
            title: target,
            ref: target,
            preview: truncate(content),
          });
        }
      }
    }

    // Search for topic-related files if no specific targets.
    // Fan out hints in parallel — the previous serial loop was the
    // single biggest contributor to Arena's startup latency.
    if (targets.length === 0) {
      const hints = extractSearchHints(topic).slice(0, 5);
      const grepResults = await Promise.all(hints.map((h) => safeGrep(h)));
      for (let i = 0; i < hints.length; i++) {
        const hint = hints[i]!;
        const result = grepResults[i] ?? "";
        if (!result) continue;
        const files = result.split("\n").filter(Boolean).slice(0, 10);
        for (const file of files) {
          if (!artifacts.some((a) => a.ref === file)) {
            artifacts.push({
              id: `repo-grep-${hint}-${file}`,
              kind: "grep",
              source: "repo",
              title: `Match: ${hint} → ${file}`,
              ref: file,
              preview: file,
            });
          }
        }
      }
    }

    // Recent git activity — only if git source is not already active (avoids duplicate)
    const hasGitSource = plan.sources.some((s) => s.kind === "git");
    if (!hasGitSource) {
      const recentLog = await gitLog();
      if (recentLog) {
        artifacts.push({
          id: "repo-recent-activity",
          kind: "doc",
          source: "repo",
          title: "Recent Git Activity",
          preview: recentLog,
        });
      }
    }

    logger.info("arena.provider.repo", { artifactCount: artifacts.length });
    return artifacts;
  },
};

async function buildTree(dir: string, maxDepth: number): Promise<string> {
  // Async + node-capped walk. The previous *Sync variant blocked the
  // event loop while the new collectEvidence runs providers in
  // parallel, partially defeating the parallelism win.
  const lines: string[] = [];
  const counter = { n: 0 };
  await walkTree(dir, maxDepth, 0, "", lines, counter);
  return lines.filter(Boolean).join("\n");
}

async function walkTree(
  dir: string,
  maxDepth: number,
  depth: number,
  prefix: string,
  out: string[],
  counter: { n: number },
): Promise<void> {
  if (depth >= maxDepth) return;
  if (counter.n >= MAX_TREE_NODES) return;
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter(
      (e) => !e.startsWith(".") && e !== "node_modules" && e !== "dist" && e !== "__pycache__",
    );
  } catch {
    return;
  }
  for (const entry of entries.slice(0, 30)) {
    if (counter.n >= MAX_TREE_NODES) return;
    counter.n++;
    const fullPath = join(dir, entry);
    let isDir = false;
    try { isDir = (await stat(fullPath)).isDirectory(); } catch { continue; }
    out.push(`${prefix}${isDir ? "/" : ""} ${entry}`);
    if (isDir && depth < maxDepth - 1) {
      await walkTree(fullPath, maxDepth, depth + 1, prefix + "  ", out, counter);
    }
  }
}

async function collectEntryFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(dir);
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

function safeReadFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const st = statSync(filePath);
    if (st.size > 500_000) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function truncate(content: string): string {
  if (content.length <= MAX_FILE_CHARS) return content;
  const t = content.slice(0, MAX_FILE_CHARS);
  const lastNl = t.lastIndexOf("\n");
  return t.slice(0, lastNl) + `\n... (truncated, ${content.length} chars total)`;
}

async function safeGrep(pattern: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("grep", [
      "-rl",
      "--include=*.ts", "--include=*.js", "--include=*.py", "--include=*.md",
      "-i", pattern, ".",
    ], { encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: GREP_TIMEOUT_MS });
    return stdout.trim();
  } catch (err) {
    // grep exits 1 when there are no matches — that's the expected
    // "no hits" path. Anything else (signal kill on timeout, ENOENT
    // because grep isn't installed, permission denied, etc.) is a
    // real failure that the caller should know about, otherwise
    // Arena silently degrades with zero artifacts.
    const e = err as { code?: number | string; killed?: boolean; signal?: string };
    if (e?.code === 1) return "";
    logger.warn("arena.provider.grep_failed", {
      pattern,
      code: e?.code,
      killed: e?.killed,
      signal: e?.signal,
    });
    return "";
  }
}

async function gitLog(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["log", "--oneline", "-10"], {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

function extractSearchHints(topic: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "have", "has",
    "do", "does", "did", "will", "would", "could", "should", "may", "might",
    "to", "of", "in", "for", "on", "with", "at", "by", "from", "about",
    "and", "but", "or", "not", "this", "that", "my", "your", "what", "how",
    "review", "discuss", "plan", "help", "please", "look", "check",
    "一下", "看看", "帮", "我", "的", "是否", "怎么", "如何", "讨论", "规划", "审查",
  ]);
  return topic
    .split(/[\s,;:]+/)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9_\-/]/g, ""))
    .filter((w) => w.length > 2 && !stopWords.has(w));
}
