/**
 * ScopeResolver — maps ArenaIntentSpec to an executable ArenaScopeSpec.
 *
 * Validates that targets (branches, modules, files) actually exist,
 * then decides the context collection strategy.
 */

import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { ArenaIntentSpec, ArenaScopeSpec } from "./types.js";
import { logger } from "../logging/logger.js";

/**
 * Resolve intent into a validated, executable scope.
 */
export function resolveScope(intent: ArenaIntentSpec): ArenaScopeSpec {
  switch (intent.targetType) {
    case "git_worktree":
      return resolveGitWorktree();

    case "git_branch_compare":
      return resolveGitBranchCompare(intent);

    case "module_compare":
      return resolveModuleCompare(intent);

    case "file_compare":
      return resolveFileCompare(intent);

    case "topic_exploration":
      return resolveTopicExploration(intent);

    case "architecture_review":
      return resolveArchitectureReview(intent);

    default:
      return resolveGitWorktree();
  }
}

function resolveGitWorktree(): ArenaScopeSpec {
  const currentBranch = git("git rev-parse --abbrev-ref HEAD") || "HEAD";
  return {
    kind: "git",
    label: `Working tree changes on ${currentBranch}`,
    git: {
      includeWorkingTree: true,
    },
  };
}

function resolveGitBranchCompare(intent: ArenaIntentSpec): ArenaScopeSpec {
  const base = intent.baseRef ?? "main";
  const head = intent.headRef ?? "HEAD";

  // Validate base ref exists
  const validBase = validateGitRef(base);
  if (!validBase) {
    // Try with origin/ prefix
    const originBase = `origin/${base}`;
    const validOrigin = validateGitRef(originBase);
    if (validOrigin) {
      return buildGitCompareScope(originBase, head, base);
    }
    logger.warn("arena.scope_resolver", { msg: `Base ref '${base}' not found, falling back to worktree` });
    return resolveGitWorktree();
  }

  return buildGitCompareScope(base, head, base);
}

function buildGitCompareScope(base: string, head: string, label: string): ArenaScopeSpec {
  // Find merge base for 3-dot diff
  const mergeBase = git(`git merge-base ${base} ${head}`);

  return {
    kind: "git",
    label: `${label}...${head}`,
    git: {
      baseRef: base,
      headRef: head,
      mergeBase: mergeBase || undefined,
      includeWorkingTree: false,
    },
  };
}

function resolveModuleCompare(intent: ArenaIntentSpec): ArenaScopeSpec {
  const targets = intent.targets ?? [];
  const validModules: string[] = [];

  for (const target of targets) {
    // Try common paths
    const candidates = [target, `src/${target}`, `lib/${target}`, `packages/${target}`];
    for (const candidate of candidates) {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        validModules.push(candidate);
        break;
      }
    }
  }

  return {
    kind: "module",
    label: validModules.length > 0
      ? `Comparing modules: ${validModules.join(" vs ")}`
      : `Module comparison: ${targets.join(" vs ")}`,
    modules: validModules.length > 0 ? validModules : targets,
    searchHints: targets,
  };
}

function resolveFileCompare(intent: ArenaIntentSpec): ArenaScopeSpec {
  const targets = intent.targets ?? [];
  const validFiles = targets.filter((f) => existsSync(f));

  return {
    kind: "files",
    label: validFiles.length > 0
      ? `Comparing files: ${validFiles.join(" vs ")}`
      : `File comparison: ${targets.join(" vs ")}`,
    files: validFiles.length > 0 ? validFiles : targets,
  };
}

function resolveTopicExploration(intent: ArenaIntentSpec): ArenaScopeSpec {
  return {
    kind: "topic",
    label: intent.rawTopic,
    searchHints: intent.targets ?? extractSearchHints(intent.rawTopic),
  };
}

function resolveArchitectureReview(intent: ArenaIntentSpec): ArenaScopeSpec {
  return {
    kind: "topic",
    label: `Architecture review: ${intent.rawTopic}`,
    searchHints: intent.targets ?? extractSearchHints(intent.rawTopic),
  };
}

// ─── Helpers ───────────────────────────────────────────────────

function git(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 10_000 }).trim();
  } catch {
    return "";
  }
}

function validateGitRef(ref: string): boolean {
  return git(`git rev-parse --verify ${ref} 2>/dev/null`) !== "";
}

/** Extract likely search keywords from a topic string */
function extractSearchHints(topic: string): string[] {
  // Remove common stop words and short tokens
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "about", "into", "through", "during", "before", "after", "above",
    "below", "between", "and", "but", "or", "not", "no", "if", "then",
    "this", "that", "these", "those", "my", "your", "his", "her", "its",
    "our", "their", "what", "which", "who", "whom", "how", "why", "when",
    "where", "review", "discuss", "plan", "help", "please", "look", "check",
    "一下", "看看", "帮", "我", "的", "是否", "是不是", "怎么", "如何",
    "讨论", "规划", "审查", "对比",
  ]);

  return topic
    .split(/[\s,;:]+/)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9_\-/]/g, ""))
    .filter((w) => w.length > 2 && !stopWords.has(w));
}
