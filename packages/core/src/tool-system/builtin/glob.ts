/**
 * Built-in Glob file search tool.
 */

import { Glob } from "glob";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { classifyPath } from "../path-policy.js";

export const globToolDef: ToolDefinition = {
  name: "Glob",
  description:
    "Fast file pattern matching. Returns matching file paths sorted by modification time. " +
    'Supports patterns like "**/*.ts" or "src/**/*.tsx". ' +
    "Use this to discover project structure before reading specific files.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match files against" },
      path: { type: "string", description: "Directory to search in (default: cwd)" },
    },
    required: ["pattern"],
  },
};

export async function globTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const pattern = args.pattern as string;
  if (!pattern) return "Error: pattern is required";

  // A4: resolve search root against ctx.cwd. Relative args.path is
  // resolved against ctx.cwd; absolute args.path is used as-is.
  const baseDir = ctx?.cwd ?? process.cwd();
  const argPath = args.path as string | undefined;
  const cwd = argPath
    ? path.isAbsolute(argPath)
      ? argPath
      : path.resolve(baseDir, argPath)
    : baseDir;

  try {
    const matcher = new Glob(pattern, {
      cwd,
      absolute: true,
      nodir: true,
      dot: false,
      follow: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**", "**/coverage/**"],
    });
    for (const parsedPattern of matcher.patterns) {
      const expandedPattern = parsedPattern.globString();
      if (
        parsedPattern.isAbsolute() ||
        path.posix.isAbsolute(expandedPattern) ||
        path.win32.isAbsolute(expandedPattern)
      ) {
        return "Error: Glob pattern must be relative to the search path.";
      }
      if (expandedPattern.split(/[\\/]/).includes("..")) {
        return "Error: Glob pattern cannot contain a '..' path segment.";
      }
    }

    const searchRoot = classifyPath(cwd, { workspaceRoot: cwd, operation: "read" }).resolvedPath;
    const matches = (await matcher.walk()).filter((filePath) => {
      const resolved = classifyPath(filePath, {
        workspaceRoot: cwd,
        operation: "read",
      }).resolvedPath;
      const relativeToRoot = path.relative(searchRoot, resolved);
      return (
        relativeToRoot === "" ||
        (relativeToRoot !== ".." &&
          !relativeToRoot.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relativeToRoot))
      );
    });

    if (matches.length === 0) {
      return "No files matched the pattern.";
    }

    // Get file stats for sorting and display
    const withStats = await Promise.all(
      matches.slice(0, 200).map(async (filePath) => {
        try {
          const s = await stat(filePath);
          return { path: filePath, size: s.size, mtime: s.mtimeMs };
        } catch {
          return { path: filePath, size: 0, mtime: 0 };
        }
      }),
    );

    // Sort by modification time (newest first)
    withStats.sort((a, b) => b.mtime - a.mtime);

    // Format with relative paths and sizes
    const cwdPrefix = cwd.endsWith("/") ? cwd : cwd + "/";
    const lines = withStats.map((f) => {
      const rel = f.path.startsWith(cwdPrefix) ? f.path.slice(cwdPrefix.length) : f.path;
      const sizeStr = f.size < 1024 ? `${f.size}B` : `${Math.round(f.size / 1024)}KB`;
      return `${rel}  (${sizeStr})`;
    });

    let result = lines.join("\n");
    if (matches.length > 200) {
      result += `\n\n... and ${matches.length - 200} more files (${matches.length} total)`;
    } else {
      result = `${matches.length} files matched:\n${result}`;
    }
    return result;
  } catch (err) {
    return `Error in glob: ${(err as Error).message}`;
  }
}
