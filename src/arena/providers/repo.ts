/**
 * RepoProvider — collects evidence from the code repository:
 * directory trees, key files, grep results.
 */

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { ArenaPlan, ArenaArtifact, ArenaContextProvider } from "../types.js";
import { logger } from "../../logging/logger.js";

const MAX_FILE_CHARS = 8_000;

export const repoProvider: ArenaContextProvider = {
  kind: "repo",

  collect(plan: ArenaPlan, topic: string): ArenaArtifact[] {
    const artifacts: ArenaArtifact[] = [];
    const targets = plan.sources.find((s) => s.kind === "repo")?.targets ?? [];

    // Project tree overview
    const tree = buildTree(".", 2);
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
        const dirTree = buildTree(target, 3);
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
        for (const file of collectEntryFiles(target).slice(0, 3)) {
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

    // Search for topic-related files if no specific targets
    if (targets.length === 0) {
      const hints = extractSearchHints(topic);
      for (const hint of hints.slice(0, 5)) {
        const grepResult = safeGrep(hint);
        if (grepResult) {
          const files = grepResult.split("\n").filter(Boolean).slice(0, 10);
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
    }

    // Recent git activity — only if git source is not already active (avoids duplicate)
    const hasGitSource = plan.sources.some((s) => s.kind === "git");
    if (!hasGitSource) {
      const recentLog = gitLog();
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

function buildTree(dir: string, maxDepth: number, depth = 0, prefix = ""): string {
  if (depth >= maxDepth) return "";
  try {
    const entries = readdirSync(dir).filter(
      (e) => !e.startsWith(".") && e !== "node_modules" && e !== "dist" && e !== "__pycache__",
    );
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

function collectEntryFiles(dir: string): string[] {
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

function safeGrep(pattern: string): string {
  try {
    const result = execFileSync("grep", [
      "-rl",
      "--include=*.ts", "--include=*.js", "--include=*.py", "--include=*.md",
      "-i", pattern, ".",
    ], { encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 10_000 });
    return result.trim();
  } catch {
    return "";
  }
}

function gitLog(): string {
  try {
    return execFileSync("git", ["log", "--oneline", "-10"], {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    }).trim();
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
