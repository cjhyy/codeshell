/**
 * Built-in Write file tool.
 */

import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import type { ToolFailure } from "./index.js";
import { fileCache } from "./file-cache.js";
import {
  getFinalWritePathSnapshot,
  revalidateFinalWritePath,
  writeFileNoFollow,
} from "../path-policy.js";

export const writeToolDef: ToolDefinition = {
  name: "Write",
  description:
    "Write content to a file. Creates the file if it doesn't exist, " +
    "overwrites if it does. Creates parent directories as needed.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to write" },
      content: { type: "string", description: "The content to write to the file" },
    },
    required: ["file_path", "content"],
  },
};

export async function writeTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string | ToolFailure> {
  const rawPath = args.file_path as string;
  const content = args.content as string;
  if (!rawPath) return "Error: file_path is required";
  if (content === undefined) return "Error: content is required";
  const cwd = ctx?.cwd ?? process.cwd();
  const filePath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);

  try {
    const approvedPath = getFinalWritePathSnapshot(args, filePath, cwd);
    const beforeMkdir = revalidateFinalWritePath(filePath, cwd, approvedPath);
    if ("error" in beforeMkdir) return { ok: false, error: beforeMkdir.error };
    await mkdir(dirname(beforeMkdir.resolvedPath), { recursive: true });

    // mkdir may have crossed an existing symlink in a missing parent chain;
    // resolve again immediately before opening the final file.
    const beforeWrite = revalidateFinalWritePath(filePath, cwd, approvedPath);
    if ("error" in beforeWrite) return { ok: false, error: beforeWrite.error };
    await writeFileNoFollow(beforeWrite.resolvedPath, content);
    fileCache.invalidate(filePath);
    return `Successfully wrote to ${filePath}`;
  } catch (err) {
    return { ok: false, error: `Error writing file: ${(err as Error).message}` };
  }
}
