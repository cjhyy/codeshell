/**
 * Built-in Glob file search tool.
 */

import { glob } from "glob";
import { stat } from "node:fs/promises";
import type { ToolDefinition } from "../../types.js";

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

export async function globTool(args: Record<string, unknown>): Promise<string> {
  const pattern = args.pattern as string;
  if (!pattern) return "Error: pattern is required";

  const cwd = (args.path as string) || process.cwd();

  try {
    const matches = await glob(pattern, {
      cwd,
      absolute: true,
      nodir: true,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**", "**/coverage/**"],
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
