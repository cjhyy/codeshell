/**
 * Context tools — read-only tools that arena participants can use
 * to fetch additional source context during research.
 *
 * Security: All shell commands use execFileSync with argument arrays
 * to prevent command injection. File paths are validated against the
 * repository boundary to prevent path traversal.
 */

import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join, dirname, basename } from "node:path";
import { isWithinRoot } from "./within-root.js";
import type { ToolDefinition, ToolCall } from "@cjhyy/code-shell-core/extension";

export const MAX_TOOL_RESULT = 15_000; // chars per tool call
// 5 was too generous for thinking-mode models — they'd spend the
// entire budget on read_file with textLen=0, then need an
// expensive force_conclude round to actually emit findings (logs
// consistently showed 5/5 rounds + 70-150s force_conclude). Capping
// at 3 makes the participant commit to a conclusion much sooner.
export const MAX_TOOL_ROUNDS = 3;

/** Repository root boundary — all file access is restricted to this directory */
const REPO_ROOT = resolve(".");

export const CONTEXT_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Read a file from the repository. Use this when you need to see the full source of a file " +
      "referenced in the context, or to check surrounding code (callers, type definitions, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path from repo root" },
        offset: { type: "number", description: "Start line (1-based, optional)" },
        limit: { type: "number", description: "Max lines to read (optional, default 200)" },
      },
      required: ["path"],
    },
  },
  {
    name: "grep_code",
    description:
      "Search for a pattern across the codebase. Use this to find callers, references, " +
      "type definitions, or usages of symbols.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        glob: { type: "string", description: "File glob filter, e.g. '*.ts' (optional)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "list_files",
    description:
      "List files in a directory. Use this to understand project structure around relevant files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to repo root (default: '.')" },
      },
      required: [],
    },
  },
  {
    name: "git_show",
    description:
      "Show a git object (commit, file at a ref, etc.). Use for inspecting specific commits " +
      "or viewing a file at a different branch/commit.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Git ref, e.g. 'HEAD~3', 'main:src/foo.ts', commit hash" },
      },
      required: ["ref"],
    },
  },
  {
    name: "git_blame",
    description:
      "Show git blame for a file. Use to understand who changed what and when.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        lines: { type: "string", description: "Line range, e.g. '10,20' (optional)" },
      },
      required: ["path"],
    },
  },
];

/**
 * Execute a context tool call and return the result string.
 */
export function executeContextTool(tc: ToolCall): string {
  try {
    switch (tc.toolName) {
      case "read_file":
        return executeReadFile(tc.args);
      case "grep_code":
        return executeGrepCode(tc.args);
      case "list_files":
        return executeListFiles(tc.args);
      case "git_show":
        return executeGitShow(tc.args);
      case "git_blame":
        return executeGitBlame(tc.args);
      default:
        return `Unknown tool: ${tc.toolName}`;
    }
  } catch (err) {
    return `Tool error: ${(err as Error).message}`;
  }
}

/**
 * Validate that a file path resolves within the repository root.
 * Returns the resolved absolute path, or null if outside the boundary.
 */
function validatePath(filePath: string): string | null {
  const resolved = resolve(filePath);
  // Realpath both sides so a symlink planted inside the repo that points OUTSIDE
  // can't pass a lexical containment check (isWithinRoot assumes resolved input
  // and won't catch a link escape on its own). Matches fs-service's discipline.
  // Reads are read-only, but a contained-looking symlink would still leak an
  // out-of-repo file into arena context. Fall back to the lexical check when the
  // target doesn't exist yet (a read of a missing file fails downstream anyway).
  let realRoot: string;
  try {
    realRoot = realpathSync(REPO_ROOT);
  } catch {
    realRoot = REPO_ROOT;
  }
  let realTarget: string;
  try {
    realTarget = realpathSync(resolved);
  } catch {
    // Target doesn't exist yet. Compare REAL-vs-REAL by resolving the existing
    // parent dir's realpath and rejoining the missing leaf — comparing realRoot
    // (a real path) against a lexical `resolved` would false-reject valid files
    // whenever REPO_ROOT (or any ancestor) is reached through a symlink.
    let realParent: string;
    try {
      realParent = realpathSync(dirname(resolved));
    } catch {
      // Parent missing too — no realpath available; fall back to lexical-vs-lexical
      // so both operands share the same (unresolved) mode.
      return isWithinRoot(resolve(REPO_ROOT), resolved) ? resolved : null;
    }
    const candidate = join(realParent, basename(resolved));
    return isWithinRoot(realRoot, candidate) ? candidate : null;
  }
  return isWithinRoot(realRoot, realTarget) ? realTarget : null;
}

function executeReadFile(args: Record<string, unknown>): string {
  const filePath = args.path as string;
  if (!validatePath(filePath)) return `Error: path outside repository: ${filePath}`;
  if (!existsSync(filePath)) return `Error: file not found: ${filePath}`;
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");
  const offset = Math.max(0, ((args.offset as number) ?? 1) - 1);
  // Guard `limit` before slicing: a negative limit makes lines.slice count
  // "from the end" and silently drop the file's tail (reader thinks the file is
  // shorter). A missing/NaN limit falls back to the default; a non-positive
  // limit reads nothing.
  const rawLimit = args.limit as number | undefined;
  const limit =
    rawLimit === undefined || !Number.isFinite(rawLimit)
      ? 200
      : rawLimit > 0
        ? Math.floor(rawLimit)
        : 0;
  const slice = lines.slice(offset, offset + limit);
  const numbered = slice.map((l, i) => `${offset + i + 1}\t${l}`).join("\n");
  return truncateResult(numbered);
}

function executeGrepCode(args: Record<string, unknown>): string {
  const pattern = args.pattern as string;
  const glob = args.glob as string | undefined;

  const grepArgs = ["-rn", "-E", "--"];
  if (glob) {
    grepArgs.splice(1, 0, `--include=${glob}`);
  }
  grepArgs.push(pattern, ".");

  const result = execFileSafe("grep", grepArgs, 80);
  return result || "No matches found.";
}

function executeListFiles(args: Record<string, unknown>): string {
  const dir = (args.path as string) || ".";
  if (!validatePath(dir)) return `Error: path outside repository: ${dir}`;

  try {
    const entries = readdirSync(dir);
    const lines: string[] = [];
    for (const entry of entries.slice(0, 50)) {
      const fullPath = join(dir, entry);
      try {
        const st = statSync(fullPath);
        const type = st.isDirectory() ? "d" : "-";
        const size = st.isDirectory() ? "" : ` ${st.size}`;
        lines.push(`${type} ${entry}${size}`);
      } catch {
        lines.push(`? ${entry}`);
      }
    }
    return lines.join("\n") || `Empty directory: ${dir}`;
  } catch {
    return `Directory not found: ${dir}`;
  }
}

function executeGitShow(args: Record<string, unknown>): string {
  const ref = sanitizeGitRef(args.ref as string);
  if (!ref) return "Error: invalid git ref";

  const result = execFileSafe("git", ["show", "--", ref], 200);
  return truncateResult(result || `Could not resolve: ${ref}`);
}

function executeGitBlame(args: Record<string, unknown>): string {
  const filePath = args.path as string;
  if (!validatePath(filePath)) return `Error: path outside repository: ${filePath}`;

  const lines = args.lines as string | undefined;
  const gitArgs = ["blame"];
  if (lines && /^\d+,\d+$/.test(lines)) {
    gitArgs.push(`-L`, lines);
  }
  gitArgs.push("--", filePath);

  const result = execFileSafe("git", gitArgs, 50);
  return result || `Could not blame: ${filePath}`;
}

/**
 * Sanitize a git ref string from LLM output.
 * Only allows safe git ref characters.
 */
function sanitizeGitRef(ref: string): string | null {
  if (!ref || ref.length > 200) return null;
  // Only allow alphanumeric, /, -, _, ~, ^, ., :
  const cleaned = ref.replace(/[^a-zA-Z0-9/_\-~^.:]/g, "");
  // Block shell metacharacters and path traversal attempts
  if (/\.\.\/|;\s|&&|\|\||`|\$\(/.test(cleaned)) return null;
  return cleaned || null;
}

/**
 * Execute a command safely using execFileSync (no shell interpretation).
 * Optionally limits output to maxLines.
 */
function execFileSafe(cmd: string, args: string[], maxLines?: number): string {
  try {
    const raw = execFileSync(cmd, args, {
      encoding: "utf-8",
      maxBuffer: 512 * 1024,
      timeout: 10_000,
    }).trim();

    if (maxLines) {
      const lines = raw.split("\n");
      if (lines.length > maxLines) {
        return lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more lines)`;
      }
    }
    return raw;
  } catch {
    return "";
  }
}

function truncateResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT) return text;
  return text.slice(0, MAX_TOOL_RESULT) + "\n... (truncated)";
}
