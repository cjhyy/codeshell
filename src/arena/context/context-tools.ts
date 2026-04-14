/**
 * Context tools — read-only tools that arena participants can use
 * to fetch additional source context during research.
 *
 * Extracted from arena.ts and enhanced for the V2 pipeline.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import type { ToolDefinition, ToolCall } from "../../types.js";

export const MAX_TOOL_RESULT = 15_000; // chars per tool call
export const MAX_TOOL_ROUNDS = 5;

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

function executeReadFile(args: Record<string, unknown>): string {
  const filePath = args.path as string;
  if (!existsSync(filePath)) return `Error: file not found: ${filePath}`;
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");
  const offset = Math.max(0, ((args.offset as number) ?? 1) - 1);
  const limit = (args.limit as number) ?? 200;
  const slice = lines.slice(offset, offset + limit);
  const numbered = slice.map((l, i) => `${offset + i + 1}\t${l}`).join("\n");
  return truncateResult(numbered);
}

function executeGrepCode(args: Record<string, unknown>): string {
  const pattern = args.pattern as string;
  const glob = args.glob as string | undefined;
  const includeFlag = glob ? `--include=${JSON.stringify(glob)}` : "--include='*'";
  const cmd = `grep -rn ${includeFlag} -E ${JSON.stringify(pattern)} . 2>/dev/null | head -80`;
  const result = shell(cmd);
  return result || "No matches found.";
}

function executeListFiles(args: Record<string, unknown>): string {
  const dir = (args.path as string) || ".";
  const result = shell(`ls -la ${JSON.stringify(dir)} 2>/dev/null | head -50`);
  return result || `Directory not found: ${dir}`;
}

function executeGitShow(args: Record<string, unknown>): string {
  const ref = args.ref as string;
  const result = shell(`git show ${JSON.stringify(ref)} 2>/dev/null | head -200`);
  return truncateResult(result || `Could not resolve: ${ref}`);
}

function executeGitBlame(args: Record<string, unknown>): string {
  const filePath = args.path as string;
  const lines = args.lines as string | undefined;
  const lineFlag = lines ? `-L ${lines}` : "";
  const result = shell(`git blame ${lineFlag} ${JSON.stringify(filePath)} 2>/dev/null | head -50`);
  return result || `Could not blame: ${filePath}`;
}

function shell(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", maxBuffer: 512 * 1024, timeout: 10_000 }).trim();
  } catch {
    return "";
  }
}

function truncateResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT) return text;
  return text.slice(0, MAX_TOOL_RESULT) + "\n... (truncated)";
}
