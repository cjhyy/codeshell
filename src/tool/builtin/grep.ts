/**
 * Built-in Grep content search tool.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "../../types.js";

const execFileAsync = promisify(execFile);

/** rg and grep exit with code 1 when no matches found — that's not an error */
function isNoMatchExit(err: unknown): boolean {
  const e = err as { code?: number; stdout?: string };
  return e?.code === 1 && (!e.stdout || e.stdout.trim() === "");
}

export const grepToolDef: ToolDefinition = {
  name: "Grep",
  description:
    "Search file contents using regex patterns. Uses ripgrep (rg) if available, falls back to grep. " +
    "Default output_mode is 'files_with_matches' which only returns file paths — use this for broad searches. " +
    "Use output_mode 'content' to see matching lines with context.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression pattern to search for" },
      path: { type: "string", description: "File or directory to search in (default: cwd)" },
      glob: { type: "string", description: 'Glob pattern to filter files (e.g. "*.ts")' },
      context: { type: "number", description: "Lines of context around matches (only with output_mode content)" },
      max_results: { type: "number", description: "Maximum number of results (default: 50)" },
      output_mode: {
        type: "string",
        description: 'Output mode: "files_with_matches" (default, just file paths), "content" (matching lines), "count" (match counts per file)',
      },
      case_insensitive: { type: "boolean", description: "Case-insensitive search" },
    },
    required: ["pattern"],
  },
};

export async function grepTool(args: Record<string, unknown>): Promise<string> {
  const pattern = args.pattern as string;
  if (!pattern) return "Error: pattern is required";

  const searchPath = (args.path as string) || process.cwd();
  const fileGlob = args.glob as string | undefined;
  const context = (args.context as number) || 0;
  const maxResults = (args.max_results as number) || 50;
  const outputMode = (args.output_mode as string) || "files_with_matches";
  const caseInsensitive = (args.case_insensitive as boolean) || false;

  try {
    return await runRipgrep(pattern, searchPath, fileGlob, context, maxResults, outputMode, caseInsensitive);
  } catch (rgErr) {
    // rg/grep exit code 1 = no matches (not an error)
    if (isNoMatchExit(rgErr)) return "No matches found.";
    try {
      return await runGrep(pattern, searchPath, context, maxResults, outputMode, caseInsensitive);
    } catch (grepErr) {
      if (isNoMatchExit(grepErr)) return "No matches found.";
      return `Error in search: ${(grepErr as Error).message}`;
    }
  }
}

async function runRipgrep(
  pattern: string,
  path: string,
  fileGlob: string | undefined,
  context: number,
  maxResults: number,
  outputMode: string,
  caseInsensitive: boolean,
): Promise<string> {
  const args = ["--color=never"];

  if (caseInsensitive) args.push("-i");

  if (outputMode === "files_with_matches") {
    args.push("--files-with-matches");
  } else if (outputMode === "count") {
    args.push("--count");
  } else {
    // content mode
    args.push("--line-number", "--no-heading");
    if (context > 0) args.push("-C", String(context));
  }

  args.push("-m", String(maxResults));
  if (fileGlob) args.push("--glob", fileGlob);

  // Ignore common non-source dirs
  args.push("--glob", "!node_modules", "--glob", "!.git", "--glob", "!dist", "--glob", "!coverage");

  args.push("--", pattern, path);

  const { stdout } = await execFileAsync("rg", args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });

  const result = stdout.trim();
  if (!result) return "No matches found.";

  // Limit output lines
  const lines = result.split("\n");
  if (lines.length > 200) {
    return lines.slice(0, 200).join("\n") + `\n\n... ${lines.length - 200} more results`;
  }
  return result;
}

async function runGrep(
  pattern: string,
  path: string,
  context: number,
  maxResults: number,
  outputMode: string,
  caseInsensitive: boolean,
): Promise<string> {
  const args = ["-r", "--color=never"];

  if (caseInsensitive) args.push("-i");

  if (outputMode === "files_with_matches") {
    args.push("-l");
  } else if (outputMode === "count") {
    args.push("-c");
  } else {
    args.push("-n");
    if (context > 0) args.push("-C", String(context));
  }

  args.push("-m", String(maxResults));
  args.push("-E", pattern);
  args.push("--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=dist");
  args.push(path);

  const { stdout } = await execFileAsync("grep", args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });

  const result = stdout.trim();
  if (!result) return "No matches found.";

  const lines = result.split("\n");
  if (lines.length > 200) {
    return lines.slice(0, 200).join("\n") + `\n\n... ${lines.length - 200} more results`;
  }
  return result;
}
