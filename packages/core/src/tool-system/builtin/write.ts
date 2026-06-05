/**
 * Built-in Write file tool.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { fileCache } from "./file-cache.js";
import { enforcePathPolicyWithApproval } from "../path-policy.js";

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
): Promise<string> {
  const filePath = args.file_path as string;
  const content = args.content as string;
  if (!filePath) return "Error: file_path is required";
  if (content === undefined) return "Error: content is required";

  // Path policy gate: deny writes to sensitive paths, refuse writes outside
  // workspace until approved. See tool-system/path-policy.ts.
  const blocked = await enforcePathPolicyWithApproval(filePath, "write", ctx);
  if (blocked) return blocked;

  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
    fileCache.invalidate(filePath);
    return `Successfully wrote to ${filePath}`;
  } catch (err) {
    return `Error writing file: ${(err as Error).message}`;
  }
}
