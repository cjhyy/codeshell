/**
 * Built-in Read file tool.
 */

import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ToolDefinition } from "../../types.js";
import { fileCache } from "./file-cache.js";

export const readToolDef: ToolDefinition = {
  name: "Read",
  description:
    "Read a file from the local filesystem. Returns the file content with line numbers. " +
    "By default reads up to 2000 lines from the beginning. " +
    "Use offset and limit to read specific portions of large files. " +
    "For large files, consider using Grep first to find the relevant lines.\n\n" +
    "Do NOT re-read a file you just edited to verify — Edit/Write would have errored " +
    "if the change failed.\n" +
    "Do NOT re-read a file (or the same range of a file) you've already read earlier in " +
    "this conversation. The content is already in your context. If you need a different " +
    "part of the file, read a different offset; otherwise decide with what you have.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to read" },
      offset: { type: "number", description: "Line number to start reading from (1-based)" },
      limit: { type: "number", description: "Number of lines to read (default: 2000)" },
    },
    required: ["file_path"],
  },
};

const MAX_CONTENT_CHARS = 200_000;

export async function readTool(args: Record<string, unknown>): Promise<string> {
  const filePath = args.file_path as string;
  if (!filePath) return "Error: file_path is required";
  if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;

  try {
    // Get file info first
    const fileInfo = await stat(filePath);
    const sizeKB = Math.round(fileInfo.size / 1024);

    // Skip binary or excessively large files
    if (fileInfo.size > 5 * 1024 * 1024) {
      return `Error: File is too large (${sizeKB}KB). Use Grep to search for specific content, or provide offset and limit to read a portion.`;
    }

    // Try cache first, fall back to disk read
    let content = await fileCache.get(filePath);
    if (content === null) {
      content = await readFile(filePath, "utf-8");
      fileCache.set(filePath, content, fileInfo.mtimeMs);
    }
    const lines = content.split("\n");
    const totalLines = lines.length;
    const offset = Math.max(1, (args.offset as number) || 1);
    const limit = (args.limit as number) || 2000;
    const end = Math.min(totalLines, offset - 1 + limit);
    const selected = lines.slice(offset - 1, end);

    let numbered = selected.map((line, i) => `${offset + i}\t${line}`).join("\n");

    // Truncate if too much content
    if (numbered.length > MAX_CONTENT_CHARS) {
      numbered = numbered.slice(0, MAX_CONTENT_CHARS) + "\n\n... content truncated";
    }

    // Add file metadata header
    let header = "";
    if (totalLines > limit || offset > 1) {
      header = `[${filePath} — ${totalLines} lines total, showing ${offset}-${end}]\n`;
    }

    return header + (numbered || "(empty file)");
  } catch (err) {
    return `Error reading file: ${(err as Error).message}`;
  }
}
