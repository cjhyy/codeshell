// Atomic patch applier — dry-runs all hunks, then commits all-or-nothing.
//
// This deliberately diverges from codex-rs/apply-patch which applies hunks
// one-by-one and leaves partial changes on disk if a later hunk fails (see
// fixture 015_failure_after_partial_success_leaves_changes for codex's
// behavior). We treat the patch as a transaction: either every hunk applies
// or none do. Set `allowPartialOnCommit` to mimic codex semantics for the
// rare case where you want it.
//
// Algorithm uses code adapted from codex-rs/apply-patch/src/lib.rs (Apache-2.0)
// for the chunk-replacement phase (compute_replacements, apply_replacements).

import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Hunk, PlannedFileChange, UpdateFileChunk } from "./types.js";
import { seekSequence } from "./seek-sequence.js";

export interface ApplyPatchOptions {
  /** Working directory for resolving relative paths in the patch. */
  cwd: string;
  /**
   * If true, skip the snapshot/rollback safety net and apply each planned
   * change one at a time, leaving partial work on disk if a later write
   * fails. Mostly useful for codex-parity testing. Default: false.
   */
  allowPartialOnCommit?: boolean;
}

export interface ApplyPatchResult {
  added: string[];
  modified: string[];
  deleted: string[];
}

/**
 * Plan and commit the patch atomically.
 *
 * Phase 1 (plan): walk every hunk, compute the resulting file content in
 * memory. Throws if any hunk cannot be applied; nothing is written.
 *
 * Phase 2 (commit): write all planned changes. If any write fails, restore
 * from the in-memory snapshot captured in phase 1 and rethrow.
 */
export async function applyPatch(
  hunks: Hunk[],
  options: ApplyPatchOptions,
): Promise<ApplyPatchResult> {
  if (hunks.length === 0) {
    throw new Error("No files were modified.");
  }

  const planned = await planHunks(hunks, options.cwd);
  return commitPlanned(planned, !!options.allowPartialOnCommit);
}

// ─── Phase 1: planning ────────────────────────────────────────────

interface PlannedChangeWithSnapshot extends PlannedFileChange {
  /** Original file content captured during planning, or null if absent. */
  originalContent: string | null;
}

interface PlannedSet {
  /** Resolved absolute path → planned change. Iteration order = insertion order. */
  byPath: Map<string, PlannedChangeWithSnapshot>;
  /** For summarising at the end. */
  added: string[];
  modified: string[];
  deleted: string[];
}

async function planHunks(hunks: Hunk[], cwd: string): Promise<PlannedSet> {
  const set: PlannedSet = {
    byPath: new Map(),
    added: [],
    modified: [],
    deleted: [],
  };

  function schedule(path: string, change: PlannedChangeWithSnapshot): void {
    if (set.byPath.has(path)) {
      throw new Error(
        `Patch references ${path} more than once. Combine the operations into a single hunk.`,
      );
    }
    set.byPath.set(path, change);
  }

  for (const hunk of hunks) {
    const original = hunk.path;
    const sourcePath = resolveAgainst(original, cwd);

    if (hunk.kind === "add") {
      const existed = await readIfExists(sourcePath);
      schedule(sourcePath, {
        path: sourcePath,
        newContent: hunk.contents,
        originalContent: existed,
      });
      set.added.push(original);
      continue;
    }

    if (hunk.kind === "delete") {
      const stats = await safeStat(sourcePath);
      if (!stats) throw new Error(`Failed to delete file: ${sourcePath} not found`);
      if (stats.isDirectory()) {
        throw new Error(`Failed to delete file: ${sourcePath} is a directory`);
      }
      const content = await readFile(sourcePath, "utf-8");
      schedule(sourcePath, {
        path: sourcePath,
        newContent: null,
        originalContent: content,
      });
      set.deleted.push(original);
      continue;
    }

    // Update (with optional rename).
    const stats = await safeStat(sourcePath);
    if (!stats) {
      throw new Error(`Failed to update file: ${sourcePath} does not exist`);
    }
    const originalText = await readFile(sourcePath, "utf-8");
    const newText = applyChunksToText(originalText, hunk.chunks, sourcePath);

    if (hunk.movePath !== undefined) {
      const destPath = resolveAgainst(hunk.movePath, cwd);
      if (destPath === sourcePath) {
        // Rename to self → degenerate update.
        schedule(sourcePath, {
          path: sourcePath,
          newContent: newText,
          originalContent: originalText,
        });
      } else {
        const destOriginal = await readIfExists(destPath);
        schedule(sourcePath, {
          path: sourcePath,
          newContent: null,
          originalContent: originalText,
        });
        schedule(destPath, {
          path: destPath,
          newContent: newText,
          originalContent: destOriginal,
        });
      }
      set.modified.push(original);
    } else {
      schedule(sourcePath, {
        path: sourcePath,
        newContent: newText,
        originalContent: originalText,
      });
      set.modified.push(original);
    }
  }

  return set;
}

/** Apply the chunk list to a file's text and return the new text. */
function applyChunksToText(
  original: string,
  chunks: UpdateFileChunk[],
  pathForError: string,
): string {
  // split('\n') leaves an empty trailing element when the file ends with \n;
  // drop it so line indices match standard diff semantics. We re-add the
  // trailing newline at the end.
  const lines = original.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  // Each replacement: [startIndex, oldLen, newLines]
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const found = seekSequence(lines, [chunk.changeContext], lineIndex, false);
      if (found === null) {
        throw new Error(
          `Failed to find context '${chunk.changeContext}' in ${pathForError}`,
        );
      }
      lineIndex = found + 1;
    }

    if (chunk.oldLines.length === 0) {
      // Pure addition — append at end. Mirrors codex behavior: even when the
      // chunk has a `@@ <context>` anchor, pure additions are inserted at
      // EOF rather than near the anchor. Models should include at least one
      // `-` or ` ` line if they want positional insertion.
      const insertionIdx =
        lines.length > 0 && lines[lines.length - 1] === ""
          ? lines.length - 1
          : lines.length;
      replacements.push([insertionIdx, 0, [...chunk.newLines]]);
      continue;
    }

    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);

    if (found === null && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      // Retry without trailing empty sentinel that represents the file's final newline.
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (found === null) {
      throw new Error(
        `Failed to find expected lines in ${pathForError}:\n${chunk.oldLines.join("\n")}`,
      );
    }

    replacements.push([found, pattern.length, [...newSlice]]);
    lineIndex = found + pattern.length;
  }

  // Apply in descending start-index order so indices stay valid.
  replacements.sort((a, b) => a[0] - b[0]);
  const working = lines.slice();
  for (let i = replacements.length - 1; i >= 0; i--) {
    const [start, oldLen, newSeg] = replacements[i];
    working.splice(start, oldLen, ...newSeg);
  }

  // Always end with a trailing newline.
  if (working.length === 0 || working[working.length - 1] !== "") {
    working.push("");
  }
  return working.join("\n");
}

// ─── Phase 2: commit ──────────────────────────────────────────────

async function commitPlanned(
  set: PlannedSet,
  allowPartial: boolean,
): Promise<ApplyPatchResult> {
  // Iterate insertion order (Map iteration is spec-guaranteed).
  const ordered = [...set.byPath.values()];

  if (allowPartial) {
    for (const change of ordered) {
      await writeChange(change);
    }
    return { added: set.added, modified: set.modified, deleted: set.deleted };
  }

  // Track which writes have completed so rollback only touches them. We use
  // the originalContent captured during plan() rather than re-reading from
  // disk — this avoids a TOCTOU window between planning and committing.
  const committed: PlannedChangeWithSnapshot[] = [];
  try {
    for (const change of ordered) {
      await writeChange(change);
      committed.push(change);
    }
  } catch (err) {
    for (let i = committed.length - 1; i >= 0; i--) {
      const c = committed[i];
      try {
        if (c.originalContent === null) {
          // File did not exist before we wrote it — remove our write.
          if (existsSync(c.path)) await unlink(c.path);
        } else {
          await writeFile(c.path, c.originalContent, "utf-8");
        }
      } catch {
        // Best-effort restore — surface the original error to the caller.
      }
    }
    throw err;
  }

  return { added: set.added, modified: set.modified, deleted: set.deleted };
}

async function writeChange(change: PlannedFileChange): Promise<void> {
  if (change.newContent === null) {
    if (existsSync(change.path)) await unlink(change.path);
    return;
  }
  const parent = dirname(change.path);
  if (!existsSync(parent)) {
    await mkdir(parent, { recursive: true });
  }
  await writeFile(change.path, change.newContent, "utf-8");
}

// ─── helpers ──────────────────────────────────────────────────────

function resolveAgainst(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

async function safeStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}
