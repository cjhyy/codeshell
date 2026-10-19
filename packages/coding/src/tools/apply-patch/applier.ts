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

import { chmod, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { Hunk, PlannedFileChange, UpdateFileChunk } from "./types.js";
import { seekSequence } from "./seek-sequence.js";
import { detectEol, toLf, applyEol } from "./eol.js";

export interface ApplyPatchOptions {
  /** Working directory for resolving relative paths in the patch. */
  cwd: string;
  /** Immutable roots authorized for this run. Relative patch paths still resolve from cwd. */
  workspaceRoots?: readonly string[];
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

  const planned = await planHunks(hunks, options.cwd, options.workspaceRoots ?? [options.cwd]);
  return commitPlanned(planned, !!options.allowPartialOnCommit);
}

// ─── Phase 1: planning ────────────────────────────────────────────

interface FileSnapshot {
  content: Buffer;
  mode: number;
}

interface PlannedChangeWithSnapshot extends PlannedFileChange {
  /** Original bytes and permissions captured during planning, or null if absent. */
  original: FileSnapshot | null;
  /** A moved file inherits its source permissions, even when overwriting a target. */
  newMode?: number;
}

interface PlannedSet {
  /** Resolved absolute path → planned change. Iteration order = insertion order. */
  byPath: Map<string, PlannedChangeWithSnapshot>;
  /** For summarising at the end. */
  added: string[];
  modified: string[];
  deleted: string[];
}

async function planHunks(
  hunks: Hunk[],
  cwd: string,
  workspaceRoots: readonly string[],
): Promise<PlannedSet> {
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
    const sourcePath = resolveAgainst(original, cwd, workspaceRoots);

    if (hunk.kind === "add") {
      const existed = await readSnapshotIfExists(sourcePath);
      schedule(sourcePath, {
        path: sourcePath,
        newContent: hunk.contents,
        original: existed,
      });
      set.added.push(original);
      continue;
    }

    if (hunk.kind === "delete") {
      const snapshot = await readSnapshotIfExists(sourcePath);
      if (!snapshot) throw new Error(`Failed to delete file: ${sourcePath} not found`);
      schedule(sourcePath, {
        path: sourcePath,
        newContent: null,
        original: snapshot,
      });
      set.deleted.push(original);
      continue;
    }

    // Update (with optional rename).
    const snapshot = await readSnapshotIfExists(sourcePath);
    if (!snapshot) {
      throw new Error(`Failed to update file: ${sourcePath} does not exist`);
    }
    const originalRaw = snapshot.content.toString("utf-8");
    // CRLF handling: patch context lines are LF (the model emits LF). Match in
    // LF space, then write back in the file's original EOL so a CRLF file isn't
    // silently converted to LF (which would diff the whole file). originalText
    // (LF) is what we compare; the undecoded snapshot is preserved for rollback
    // so a restore writes back the exact bytes. See eol.ts.
    const eol = detectEol(originalRaw);
    const originalText = toLf(originalRaw);
    const newText = applyEol(applyChunksToText(originalText, hunk.chunks, sourcePath), eol);

    if (hunk.movePath !== undefined) {
      const destPath = resolveAgainst(hunk.movePath, cwd, workspaceRoots);
      if (destPath === sourcePath) {
        // Rename to self → degenerate update.
        schedule(sourcePath, {
          path: sourcePath,
          newContent: newText,
          original: snapshot,
        });
      } else {
        const destOriginal = await readSnapshotIfExists(destPath);
        schedule(sourcePath, {
          path: sourcePath,
          newContent: null,
          original: snapshot,
        });
        schedule(destPath, {
          path: destPath,
          newContent: newText,
          original: destOriginal,
          newMode: snapshot.mode,
        });
      }
      set.modified.push(original);
    } else {
      schedule(sourcePath, {
        path: sourcePath,
        newContent: newText,
        original: snapshot,
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
        throw new Error(`Failed to find context '${chunk.changeContext}' in ${pathForError}`);
      }
      lineIndex = found + 1;
    }

    if (chunk.oldLines.length === 0) {
      // Pure addition — append at end. Mirrors codex behavior: even when the
      // chunk has a `@@ <context>` anchor, pure additions are inserted at
      // EOF rather than near the anchor. Models should include at least one
      // `-` or ` ` line if they want positional insertion.
      const insertionIdx =
        lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
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

async function commitPlanned(set: PlannedSet, allowPartial: boolean): Promise<ApplyPatchResult> {
  // Iterate insertion order (Map iteration is spec-guaranteed).
  const ordered = [...set.byPath.values()];

  if (allowPartial) {
    for (const change of ordered) {
      await writeChange(change);
    }
    return { added: set.added, modified: set.modified, deleted: set.deleted };
  }

  // Include the current attempt: writeFile may write partially before failing,
  // and chmod can fail after the new content has already been written. Restore
  // the bytes and permissions captured during planning, without re-reading.
  const attempted: PlannedChangeWithSnapshot[] = [];
  try {
    for (const change of ordered) {
      attempted.push(change);
      await writeChange(change);
    }
  } catch (err) {
    for (let i = attempted.length - 1; i >= 0; i--) {
      const c = attempted[i];
      try {
        if (c.original === null) {
          // File did not exist before we wrote it — remove our write.
          if (existsSync(c.path)) await unlink(c.path);
        } else {
          await restoreSnapshot(c.path, c.original);
        }
      } catch {
        // Best-effort restore — surface the original error to the caller.
      }
    }
    throw err;
  }

  return { added: set.added, modified: set.modified, deleted: set.deleted };
}

async function restoreSnapshot(path: string, snapshot: FileSnapshot): Promise<void> {
  const writableMode = snapshot.mode | 0o200;
  try {
    // A successful move may have made an existing target read-only. writeFile's
    // mode only applies to new files, so temporarily allow restoring its bytes.
    try {
      await chmod(path, writableMode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(path, snapshot.content, { mode: writableMode });
  } finally {
    // Also restore a read-only snapshot's mode if writing its bytes fails.
    await chmod(path, snapshot.mode);
  }
}

async function writeChange(change: PlannedChangeWithSnapshot): Promise<void> {
  if (change.newContent === null) {
    if (existsSync(change.path)) await unlink(change.path);
    return;
  }
  const parent = dirname(change.path);
  if (!existsSync(parent)) {
    await mkdir(parent, { recursive: true });
  }
  await writeFile(change.path, change.newContent, { encoding: "utf-8", mode: change.newMode });
  if (change.newMode !== undefined) {
    // The creation mode is masked by umask and ignored for existing targets.
    await chmod(change.path, change.newMode);
  }
}

// ─── helpers ──────────────────────────────────────────────────────

/**
 * Resolve a patch-relative (or absolute) path against cwd, then HARD-ENFORCE
 * that the result stays inside cwd.
 *
 * This is the applier's own containment guard, independent of the executor-level
 * pathPolicy. apply-patch is reachable with the path gate bypassed (e.g.
 * bypassPermissions, or a direct call), so the last line of defense lives here.
 *
 * Containment is checked against the REAL paths: we realpath cwd and walk the
 * target up to its nearest existing ancestor and realpath that. This defeats a
 * symlink planted inside cwd that points outside — a plain string `resolve()`
 * would look contained while the write follows the link out.
 */
function resolveAgainst(p: string, cwd: string, workspaceRoots: readonly string[]): string {
  const resolved = isAbsolute(p) ? p : resolve(cwd, p);
  const realTarget = nearestRealPath(resolved);
  const realRoots = workspaceRoots.map(nearestRealPath);
  if (!realRoots.some((root) => isInside(realTarget, root))) {
    throw new Error(
      `Refusing to apply patch outside the workspace roots: "${p}" resolves to "${realTarget}".`,
    );
  }
  return resolved;
}

/**
 * Realpath the nearest existing ancestor of `abs`, then re-attach the
 * not-yet-existing trailing segments. Mirrors path-policy.safeRealpath so
 * symlinked ancestors are resolved even when the leaf doesn't exist yet.
 */
function nearestRealPath(abs: string): string {
  let candidate = abs;
  const segments: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(candidate);
      if (segments.length === 0) return real;
      return resolve(real, ...segments.reverse());
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return abs;
      segments.push(candidate.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      candidate = parent;
    }
  }
  return abs;
}

function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(p);
}

async function readSnapshotIfExists(path: string): Promise<FileSnapshot | null> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
  try {
    const stats = await file.stat();
    if (stats.isDirectory()) throw new Error(`Cannot apply patch to directory: ${path}`);
    return { content: await file.readFile(), mode: stats.mode & 0o7777 };
  } finally {
    await file.close();
  }
}
