/**
 * Built-in Edit file tool — exact string replacement.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ToolDefinition } from "../../types.js";
import { fileCache } from "./file-cache.js";

export const editToolDef: ToolDefinition = {
  name: "Edit",
  description:
    "Perform exact string replacements in a file. " +
    "The old_string must match exactly (including whitespace/indentation) and be unique in the file. " +
    "IMPORTANT: Keep old_string as SHORT as possible while still being unique — " +
    "include just enough surrounding context lines to uniquely identify the location. " +
    "Do NOT copy entire functions or large blocks when a few lines suffice.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to edit" },
      old_string: {
        type: "string",
        description:
          "The exact string to find. Keep it SHORT — only enough lines to be unique in the file. " +
          "Include 1-2 lines of surrounding context if needed for uniqueness.",
      },
      new_string: { type: "string", description: "The replacement string" },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences (default: false)",
        default: false,
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
};

export async function editTool(args: Record<string, unknown>): Promise<string> {
  const filePath = args.file_path as string;
  const oldString = args.old_string as string;
  const newString = args.new_string as string;
  const replaceAll = (args.replace_all as boolean) ?? false;

  if (!filePath) return "Error: file_path is required";
  if (oldString === undefined) return "Error: old_string is required";
  if (newString === undefined) return "Error: new_string is required";
  if (oldString === newString) return "Error: old_string and new_string must be different";
  if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;

  try {
    const content = await readFile(filePath, "utf-8");

    if (!content.includes(oldString)) {
      return "Error: old_string not found in file";
    }

    if (!replaceAll) {
      const firstIdx = content.indexOf(oldString);
      const lastIdx = content.lastIndexOf(oldString);
      if (firstIdx !== lastIdx) {
        return "Error: old_string is not unique in the file. Provide more context or use replace_all.";
      }
    }

    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    await writeFile(filePath, updated, "utf-8");
    fileCache.invalidate(filePath);

    const count = replaceAll
      ? (content.split(oldString).length - 1)
      : 1;

    // Generate a compact diff summary
    const oldLines = oldString.split("\n");
    const newLines = newString.split("\n");
    const diffSummary = generateCompactDiff(oldLines, newLines, filePath);

    return `Successfully edited ${filePath} (${count} replacement${count > 1 ? "s" : ""})\n${diffSummary}`;
  } catch (err) {
    return `Error editing file: ${(err as Error).message}`;
  }
}

function generateCompactDiff(oldLines: string[], newLines: string[], filePath: string): string {
  const lines: string[] = [];
  const maxShow = 8;

  // Show removed lines (prefix with -)
  const removedCount = oldLines.length;
  const showRemoved = oldLines.slice(0, maxShow);
  for (const line of showRemoved) {
    lines.push(`  - ${line}`);
  }
  if (removedCount > maxShow) {
    lines.push(`  ... +${removedCount - maxShow} more removed`);
  }

  // Show added lines (prefix with +)
  const addedCount = newLines.length;
  const showAdded = newLines.slice(0, maxShow);
  for (const line of showAdded) {
    lines.push(`  + ${line}`);
  }
  if (addedCount > maxShow) {
    lines.push(`  ... +${addedCount - maxShow} more added`);
  }

  return lines.join("\n");
}
