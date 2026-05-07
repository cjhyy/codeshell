// Adapted from openai/codex codex-rs/apply-patch (Apache-2.0).
// Original Rust source: https://github.com/openai/codex/tree/main/codex-rs/apply-patch
// See LICENSE-codex in this directory.

/**
 * V4A patch AST. A parsed patch is a list of Hunks; each Hunk targets one file.
 *
 * Three variants:
 *   - AddFile:    create a new file with the given contents
 *   - DeleteFile: remove an existing file
 *   - UpdateFile: in-place edit (optionally with a rename via movePath),
 *                 expressed as one or more UpdateFileChunks.
 */
export type Hunk =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | {
      kind: "update";
      path: string;
      movePath?: string;
      chunks: UpdateFileChunk[];
    };

export interface UpdateFileChunk {
  /** Optional `@@ <context>` anchor that narrows where this chunk applies. */
  changeContext?: string;
  /** Lines that must match in the existing file (` ` and `-` markers). */
  oldLines: string[];
  /** Lines that should appear after the edit (` ` and `+` markers). */
  newLines: string[];
  /** True if this chunk ended with `*** End of File`; matches only at EOF. */
  isEndOfFile: boolean;
}

export class PatchParseError extends Error {
  readonly kind: "InvalidPatch" | "InvalidHunk";
  readonly lineNumber?: number;

  constructor(
    kind: "InvalidPatch" | "InvalidHunk",
    message: string,
    lineNumber?: number,
  ) {
    super(message);
    this.name = "PatchParseError";
    this.kind = kind;
    this.lineNumber = lineNumber;
  }
}

/**
 * Result of staging (dry-run) a single file's planned change.
 *
 * A rename is represented as two PlannedFileChange entries: one for the
 * source path with `newContent: null` (delete) and one for the destination
 * path with the new content.
 */
export interface PlannedFileChange {
  path: string;
  /** null = delete; string = create-or-overwrite with this content. */
  newContent: string | null;
}
