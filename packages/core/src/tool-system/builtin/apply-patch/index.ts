/**
 * ApplyPatch tool — atomic, multi-file V4A patch application.
 *
 * Adapted from openai/codex codex-rs/apply-patch (Apache-2.0). See LICENSE-codex.
 *
 * Compared to Codex's reference implementation:
 *   - We dry-run all hunks first; nothing is written until every hunk
 *     successfully resolves.
 *   - On commit we snapshot every target file, so a write failure rolls back
 *     to the pre-patch state instead of leaving partial changes.
 *
 * Compared to CodeShell's existing Edit:
 *   - Multi-file in one call (cuts LLM round-trips for large changes).
 *   - Supports create / update / delete / rename in one transaction.
 *   - Context-anchor matching tolerates whitespace and Unicode quirks.
 */

import type { ToolDefinition } from "../../../types.js";
import { fileCache } from "../file-cache.js";
import { applyPatch } from "./applier.js";
import { parsePatch } from "./parser.js";

export const applyPatchToolDef: ToolDefinition = {
  name: "ApplyPatch",
  description:
    "Apply a V4A-format patch atomically across one or more files. " +
    "Supports create, update, delete, and rename operations in a single call. " +
    "If any hunk fails to apply, the entire patch is rejected and no files are modified. " +
    "Patch envelope:\n" +
    "  *** Begin Patch\n" +
    "  *** Add File: <path>\n" +
    "  +<line>\n" +
    "  *** Update File: <path>\n" +
    "  *** Move to: <new path>   # optional rename\n" +
    "  @@ <context>              # optional anchor\n" +
    "   <unchanged line>\n" +
    "  -<removed line>\n" +
    "  +<added line>\n" +
    "  *** End of File           # optional, anchors to file end\n" +
    "  *** Delete File: <path>\n" +
    "  *** End Patch\n" +
    "Use relative paths; they resolve against the working directory.",
  inputSchema: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description:
          "Full patch text including '*** Begin Patch' and '*** End Patch' markers. " +
          "All paths must be relative (preferred) or absolute. " +
          "Each Update hunk must include enough context lines (' '-prefixed) " +
          "to uniquely locate the change within the file.",
      },
    },
    required: ["patch"],
  },
};

export async function applyPatchTool(args: Record<string, unknown>): Promise<string> {
  const patchText = args.patch;
  if (typeof patchText !== "string" || patchText.length === 0) {
    return "Error: patch is required and must be a non-empty string";
  }

  let parsed;
  try {
    parsed = parsePatch(patchText, "lenient");
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }

  if (parsed.hunks.length === 0) {
    return "Error: patch contains no hunks";
  }

  let result;
  try {
    result = await applyPatch(parsed.hunks, { cwd: process.cwd() });
  } catch (err) {
    return `Error applying patch: ${(err as Error).message}`;
  }

  // Invalidate file cache for every touched path.
  for (const hunk of parsed.hunks) {
    fileCache.invalidate(hunk.path);
    if (hunk.kind === "update" && hunk.movePath) {
      fileCache.invalidate(hunk.movePath);
    }
  }

  const parts: string[] = [];
  if (result.added.length > 0) parts.push(`added ${result.added.length}`);
  if (result.modified.length > 0) parts.push(`modified ${result.modified.length}`);
  if (result.deleted.length > 0) parts.push(`deleted ${result.deleted.length}`);
  const summary = parts.join(", ");

  const lines: string[] = [`Patch applied successfully — ${summary}`];
  for (const p of result.added) lines.push(`  A ${p}`);
  for (const p of result.modified) lines.push(`  M ${p}`);
  for (const p of result.deleted) lines.push(`  D ${p}`);
  return lines.join("\n");
}
