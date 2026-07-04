/**
 * Built-in Grep content search tool.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, join, relative, resolve, sep, isAbsolute } from "node:path";
import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";

const execFileAsync = promisify(execFile);

type ExecFileAsync = typeof execFileAsync;
let execFileForTest: ExecFileAsync = execFileAsync;

export function _setGrepExecFileForTest(fn?: ExecFileAsync): void {
  execFileForTest = fn ?? execFileAsync;
}

/**
 * Strip the cwd prefix from each line so results display as relative
 * paths (e.g. "src/ui/App.tsx" instead of an absolute path). Lines that
 * don't start with the cwd are left untouched.
 */
function relativizeOutput(stdout: string, cwd: string): string {
  const root = resolve(cwd);
  const prefix = root.endsWith(sep) ? root : root + sep;
  return stdout
    .split("\n")
    .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
    .join("\n");
}

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

export async function grepTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const pattern = args.pattern as string;
  if (!pattern) return "Error: pattern is required";

  // A4: resolve search path against ctx.cwd. Relative args.path is
  // resolved against ctx.cwd; absolute args.path is used as-is.
  const baseDir = ctx?.cwd ?? process.cwd();
  const argPath = args.path as string | undefined;
  const searchPath = argPath
    ? isAbsolute(argPath)
      ? argPath
      : resolve(baseDir, argPath)
    : baseDir;
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
      return await runGrep(pattern, searchPath, fileGlob, context, maxResults, outputMode, caseInsensitive);
    } catch (grepErr) {
      if (isNoMatchExit(grepErr)) return "No matches found.";
      if (isCommandNotFound(rgErr) || isCommandNotFound(grepErr)) {
        return await runNodeGrep(pattern, searchPath, fileGlob, context, maxResults, outputMode, caseInsensitive);
      }
      return `Error in search: ${(grepErr as Error).message}`;
    }
  }
}

function isCommandNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
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

  const { stdout } = await execFileForTest("rg", args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });

  const result = relativizeOutput(stdout, path).trim();
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
  fileGlob: string | undefined,
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
  // Honor the file glob so the grep fallback matches ripgrep's --glob behavior
  // (previously the glob was silently dropped on the fallback path).
  if (fileGlob) args.push(`--include=${fileGlob}`);
  args.push("-E", pattern);
  args.push("--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=dist");
  args.push(path);

  const { stdout } = await execFileForTest("grep", args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });

  const result = relativizeOutput(stdout, path).trim();
  if (!result) return "No matches found.";

  const lines = result.split("\n");
  if (lines.length > 200) {
    return lines.slice(0, 200).join("\n") + `\n\n... ${lines.length - 200} more results`;
  }
  return result;
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

async function runNodeGrep(
  pattern: string,
  path: string,
  fileGlob: string | undefined,
  context: number,
  maxResults: number,
  outputMode: string,
  caseInsensitive: boolean,
): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseInsensitive ? "i" : "");
  } catch (err) {
    return `Error in search: ${(err as Error).message}`;
  }

  const matches: string[] = [];
  await walkTextFiles(path, fileGlob, async (file) => {
    if (matches.length >= maxResults) return;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return;
    }
    const lines = text.split(/\r?\n/);
    const matchingLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) matchingLines.push(i);
    }
    if (matchingLines.length === 0) return;

    const rel = relative(path, file) || basename(file);
    if (outputMode === "files_with_matches") {
      matches.push(rel);
    } else if (outputMode === "count") {
      matches.push(`${rel}:${matchingLines.length}`);
    } else {
      const emitted = new Set<number>();
      for (const lineIndex of matchingLines) {
        const start = Math.max(0, lineIndex - context);
        const end = Math.min(lines.length - 1, lineIndex + context);
        for (let i = start; i <= end; i++) {
          if (emitted.has(i)) continue;
          emitted.add(i);
          matches.push(`${rel}:${i + 1}:${lines[i]}`);
          if (matches.length >= maxResults) return;
        }
      }
    }
  });

  if (matches.length === 0) return "No matches found.";
  if (matches.length > 200) return matches.slice(0, 200).join("\n") + `\n\n... ${matches.length - 200} more results`;
  return matches.join("\n");
}

async function walkTextFiles(
  root: string,
  fileGlob: string | undefined,
  visit: (file: string) => Promise<void>,
): Promise<void> {
  const info = await stat(root).catch(() => null);
  if (!info) return;
  if (info.isFile()) {
    if (!fileGlob || matchesSimpleGlob(basename(root), fileGlob)) await visit(root);
    return;
  }
  if (!info.isDirectory()) return;

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walkTextFiles(join(root, entry.name), fileGlob, visit);
    } else if (entry.isFile()) {
      if (!fileGlob || matchesSimpleGlob(entry.name, fileGlob)) await visit(join(root, entry.name));
    }
  }
}

function matchesSimpleGlob(name: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(name);
}
