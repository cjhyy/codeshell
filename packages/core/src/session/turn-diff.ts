/** Execution-owned original-to-latest file state for one logical user turn. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { TurnDiffFile, TurnDiffSnapshot } from "../types.js";
import { writeFileAtomic } from "../utils/file-mutex.js";

export const TURN_DIFF_LIMITS = {
  fileBytes: 1024 * 1024,
  fileLines: 50_000,
  totalBytes: 8 * 1024 * 1024,
  diffBytes: 2 * 1024 * 1024,
  stateBytes: 32 * 1024 * 1024,
  files: 512,
  toolCalls: 4096,
  alignmentSteps: 1_000_000,
} as const;

type FileState =
  | { exists: false }
  | { exists: true; content: string; mode: string }
  | { error: string };
interface TrackedFile {
  path: string;
  before: FileState;
  after: FileState;
  committed: boolean;
}
interface StoredState {
  version: 1;
  turnId: string;
  cwd: string;
  capturedAt?: number;
  files: TrackedFile[];
  toolCallIds: string[];
  pending: { toolCallId: string; paths: string[] }[];
  issue?: string;
}

/** No-follow, bounded descriptor read; an unreadable file is never treated as absent. */
function readBounded(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("not a regular file");
    if (stat.size > maxBytes) throw new Error("size limit exceeded");
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, stat.size + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (bytes === 0) break;
      offset += bytes;
    }
    if (offset > maxBytes || offset > stat.size) throw new Error("file changed while capturing");
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

function bytes(state: FileState): number {
  return "content" in state ? Buffer.byteLength(state.content) : 0;
}

function same(a: FileState, b: FileState): boolean {
  if ("error" in a || "error" in b) return false;
  return (
    a.exists === b.exists &&
    (!a.exists || (b.exists && a.content === b.content && a.mode === b.mode))
  );
}

/** Canonicalize existing regular leaves, retaining spelling for absent or symlink leaves. */
function canonicalPath(path: string, cwd: string): string {
  const absolute = resolve(cwd, path);
  try {
    const before = lstatSync(absolute, { bigint: true });
    if (before.isFile() && !before.isSymbolicLink()) {
      // The JS implementation can retain the caller's casing on macOS. Native
      // realpath supplies the actual directory-entry spelling on insensitive FS.
      const canonical = realpathSync.native(absolute);
      const current = lstatSync(absolute, { bigint: true }),
        resolved = lstatSync(canonical, { bigint: true });
      if (
        [current, resolved].every(
          (info) =>
            info.isFile() &&
            !info.isSymbolicLink() &&
            info.dev === before.dev &&
            info.ino === before.ino,
        )
      )
        return canonical;
    }
  } catch {
    // A missing/unstable leaf is captured by the existing no-follow path below.
  }
  let parent = dirname(absolute);
  const tail = [basename(absolute)];
  while (true) {
    try {
      return resolve(realpathSync.native(parent), ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(parent) === parent)
        return absolute;
      tail.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
}

function withinLineLimit(content: string): boolean {
  let lines = content.length && !content.endsWith("\n") ? 1 : 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n" && ++lines > TURN_DIFF_LIMITS.fileLines) return false;
  }
  return lines <= TURN_DIFF_LIMITS.fileLines;
}

function capture(path: string, remaining: number): FileState {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return { error: "not a regular file" };
    const buffer = readBounded(path, Math.min(TURN_DIFF_LIMITS.fileBytes, Math.max(0, remaining)));
    if (buffer.includes(0)) return { error: "binary file" };
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      return { error: "non-UTF-8 file" };
    }
    if (!withinLineLimit(content)) return { error: "line limit exceeded" };
    return { exists: true, content, mode: info.mode & 0o111 ? "100755" : "100644" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { exists: false };
    return { error: error instanceof Error ? error.message : "capture failed" };
  }
}

function validFileState(value: unknown): value is FileState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    (typeof state.error === "string" && state.error.length <= 1024) ||
    state.exists === false ||
    (state.exists === true &&
      typeof state.content === "string" &&
      Buffer.byteLength(state.content) <= TURN_DIFF_LIMITS.fileBytes &&
      withinLineLimit(state.content) &&
      (state.mode === "100644" || state.mode === "100755"))
  );
}

/**
 * First baseline and latest observed after-state are immutable between tool receipts.
 * Reloading a historical turn never reads its current workspace contents.
 */
export class TurnDiffTracker {
  private readonly turnId: string;
  private readonly cwd: string;
  private readonly statePath?: string;
  private readonly files = new Map<string, TrackedFile>();
  private readonly pending = new Map<string, string[]>();
  private readonly toolCallIds = new Set<string>();
  private readonly diffCache = new Map<
    string,
    { before: FileState; after: FileState; diff: TurnDiffFile }
  >();
  private issue?: string;
  private unavailableBaseline = false;
  private capturedAt?: number;

  constructor(options: { turnId: string; cwd: string; sessionDir?: string }) {
    this.turnId = options.turnId;
    try {
      this.cwd = realpathSync(resolve(options.cwd));
    } catch {
      this.cwd = resolve(options.cwd);
    }
    if (options.sessionDir) {
      const directory = join(options.sessionDir, "turn-diff");
      this.statePath = join(
        directory,
        `${createHash("sha256").update(this.turnId).digest("hex")}.json`,
      );
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
          throw new Error("unsafe state directory");
        }
        this.load();
      } catch (error) {
        this.files.clear();
        this.toolCallIds.clear();
        this.issue = `Turn diff state unavailable: ${error instanceof Error ? error.message : "read failed"}`;
        this.unavailableBaseline = true;
      }
    }
  }

  begin(toolCallId: string, targets: readonly string[]): void {
    this.reconcileAliases();
    const paths: string[] = [];
    for (const target of targets) {
      const path = canonicalPath(target, this.cwd);
      if (paths.includes(path)) continue;
      if (!this.files.has(path)) {
        if (this.files.size >= TURN_DIFF_LIMITS.files) {
          this.issue = "Turn diff file limit exceeded";
          continue;
        }
        const before = this.unavailableBaseline
          ? { error: "original state unavailable" }
          : capture(path, Math.floor((TURN_DIFF_LIMITS.totalBytes - this.size()) / 2));
        this.files.set(path, { path, before, after: before, committed: false });
      }
      paths.push(path);
    }
    if (paths.length || this.issue) {
      this.pending.set(toolCallId, paths);
      // Save the original before dispatching the tool. A crash before its receipt
      // must not turn the already-mutated file into a fresh initial baseline.
      this.persist();
    }
  }

  end(toolCallId: string, success: boolean): TurnDiffSnapshot | undefined {
    this.reconcileAliases();
    const paths = this.pending.get(toolCallId);
    if (!paths) return undefined;
    this.pending.delete(toolCallId);
    let changed = false;
    for (const path of paths) {
      const file = this.files.get(path)!;
      const after = capture(path, TURN_DIFF_LIMITS.totalBytes - this.size() + bytes(file.after));
      // A failed tool may still have applied part of a multi-file operation.
      if (success || !same(file.after, after)) {
        this.diffCache.delete(path);
        file.after = after;
        file.committed = true;
        changed = true;
      } else if (
        !file.committed &&
        ![...this.pending.values()].some((items) => items.includes(path))
      ) {
        this.files.delete(path);
      }
    }
    if (!changed && !this.issue) {
      this.persist();
      return undefined;
    }
    this.capturedAt = Date.now();
    if (this.toolCallIds.size < TURN_DIFF_LIMITS.toolCalls) this.toolCallIds.add(toolCallId);
    else this.issue = "Turn diff tool-call limit exceeded";
    this.persist();
    return this.snapshot();
  }

  /** Saved evidence is publishable on resume, even when no new writes occur. */
  current(): TurnDiffSnapshot | undefined {
    return this.issue || [...this.files.values()].some((file) => file.committed)
      ? this.snapshot()
      : undefined;
  }

  /** Observe settled work on known paths (for example a foreground child tool). */
  refresh(): TurnDiffSnapshot | undefined {
    this.reconcileAliases();
    const pendingPaths = new Set([...this.pending.values()].flat());
    let changed = false;
    for (const file of this.files.values()) {
      // An interrupted or unsupported capture cannot be promoted to complete by
      // an unrelated tool. Only a fresh receipt for that path may resolve it.
      if (
        !file.committed ||
        pendingPaths.has(file.path) ||
        "error" in file.before ||
        "error" in file.after
      )
        continue;
      const after = capture(
        file.path,
        TURN_DIFF_LIMITS.totalBytes - this.size() + bytes(file.after),
      );
      if (!same(file.after, after)) {
        this.diffCache.delete(file.path);
        file.after = after;
        changed = true;
      }
    }
    if (!changed) return undefined;
    this.capturedAt = Date.now();
    this.persist();
    return this.snapshot();
  }

  private size(): number {
    let total = 0;
    for (const file of this.files.values()) total += bytes(file.before) + bytes(file.after);
    return total;
  }

  /** A previously absent leaf can acquire its actual spelling during execution. */
  private reconcileAliases(): void {
    const paths = new Map<string, string>();
    const merged = new Map<string, TrackedFile>();
    let changed = false;
    for (const file of this.files.values()) {
      const path = canonicalPath(file.path, this.cwd);
      paths.set(file.path, path);
      const earlier = merged.get(path);
      if (earlier) {
        // Map order is baseline capture order. A later alias must never replace
        // the first before-state, including a known absent creation baseline.
        if (file.committed) earlier.after = file.after;
        earlier.committed ||= file.committed;
        changed = true;
      } else merged.set(path, { ...file, path });
      changed ||= path !== file.path;
    }
    if (!changed) return;
    this.files.clear();
    for (const [path, file] of merged) this.files.set(path, file);
    for (const [id, pending] of this.pending)
      this.pending.set(id, [...new Set(pending.map((path) => paths.get(path) ?? path))]);
    this.diffCache.clear();
  }

  private snapshot(): TurnDiffSnapshot {
    const files: TurnDiffFile[] = [];
    const trackedPaths: string[] = [];
    const omissions: { path: string; reason: string }[] = [];
    if (this.issue) omissions.push({ path: this.cwd, reason: this.issue });
    let diffBytes = 0;
    for (const file of this.files.values()) {
      if (!file.committed) continue;
      trackedPaths.push(file.path);
      const { before, after } = file;
      if ("error" in before || "error" in after) {
        omissions.push({
          path: file.path,
          reason: "error" in before ? before.error : (after as { error: string }).error,
        });
        continue;
      }
      if (same(before, after)) continue;
      // Publishing a cumulative snapshot should only realign changed files.
      // The captured states are replaced, never edited, so identity is sufficient.
      const cached = this.diffCache.get(file.path);
      const generated =
        cached?.before === before && cached.after === after
          ? cached.diff
          : fileDiff(file.path, before, after);
      this.diffCache.set(file.path, { before, after, diff: generated });
      diffBytes += Buffer.byteLength(generated.diff);
      if (diffBytes > TURN_DIFF_LIMITS.diffBytes) {
        omissions.push({ path: file.path, reason: "Turn diff output limit exceeded" });
      } else files.push(generated);
    }
    return {
      turnId: this.turnId,
      cwd: this.cwd,
      capturedAt: this.capturedAt,
      files,
      trackedPaths,
      toolCallIds: [...this.toolCallIds],
      complete: omissions.length === 0,
      omissions,
    };
  }

  private persist(): void {
    if (!this.statePath) return;
    try {
      const state: StoredState = {
        version: 1,
        turnId: this.turnId,
        cwd: this.cwd,
        capturedAt: this.capturedAt,
        files: [...this.files.values()],
        toolCallIds: [...this.toolCallIds],
        pending: [...this.pending].map(([toolCallId, paths]) => ({ toolCallId, paths })),
        ...(this.issue ? { issue: this.issue } : {}),
      };
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized) > TURN_DIFF_LIMITS.stateBytes)
        throw new Error("state size limit exceeded");
      writeFileAtomic(this.statePath, serialized, 0o600);
    } catch (error) {
      this.issue = `Turn diff state not saved: ${error instanceof Error ? error.message : "write failed"}`;
    }
  }

  private load(): void {
    let raw: Buffer;
    try {
      raw = readBounded(this.statePath!, TURN_DIFF_LIMITS.stateBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const state = JSON.parse(raw.toString("utf8")) as StoredState;
    if (
      state.version !== 1 ||
      state.turnId !== this.turnId ||
      state.cwd !== this.cwd ||
      (state.capturedAt !== undefined &&
        (!Number.isFinite(state.capturedAt) || state.capturedAt < 0)) ||
      !Array.isArray(state.files) ||
      state.files.length > TURN_DIFF_LIMITS.files ||
      !Array.isArray(state.pending) ||
      state.pending.length > TURN_DIFF_LIMITS.toolCalls ||
      !Array.isArray(state.toolCallIds) ||
      state.toolCallIds.length > TURN_DIFF_LIMITS.toolCalls ||
      state.toolCallIds.some((id) => typeof id !== "string") ||
      (state.issue !== undefined && typeof state.issue !== "string")
    )
      throw new Error("invalid state");
    let total = 0;
    for (const file of state.files) {
      if (
        !file ||
        typeof file.path !== "string" ||
        !isAbsolute(file.path) ||
        typeof file.committed !== "boolean" ||
        !validFileState(file.before) ||
        !validFileState(file.after) ||
        this.files.has(file.path)
      )
        throw new Error("invalid file state");
      total += bytes(file.before) + bytes(file.after);
      if (total > TURN_DIFF_LIMITS.totalBytes) throw new Error("state content limit exceeded");
      this.files.set(file.path, file);
    }
    for (const id of state.toolCallIds) this.toolCallIds.add(id);
    for (const pending of state.pending) {
      if (
        !pending ||
        typeof pending.toolCallId !== "string" ||
        !Array.isArray(pending.paths) ||
        pending.paths.length > TURN_DIFF_LIMITS.files ||
        pending.paths.some((path) => typeof path !== "string" || !this.files.has(path))
      ) {
        throw new Error("invalid pending receipt");
      }
      this.toolCallIds.add(pending.toolCallId);
      for (const path of pending.paths) {
        const file = this.files.get(path)!;
        file.committed = true;
        file.after = { error: "interrupted file-change receipt; latest state unavailable" };
      }
    }
    this.issue = state.issue;
    this.capturedAt = state.capturedAt;
  }
}

type KnownState = Exclude<FileState, { error: string }>;
interface Row {
  marker: " " | "-" | "+";
  text: string;
}

/** Git-compatible quoted path tokens (UTF-8 text is accepted without octal escaping). */
function quotePath(path: string): string {
  return /[\s"\\]/.test(path) ? JSON.stringify(path) : path;
}
function splitLines(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Bounded Myers alignment: distant small edits do not require a quadratic table. */
function align(a: string[], b: string[]): Row[] | undefined {
  const trace: Map<number, number>[] = [];
  const frontier = new Map<number, number>([[1, 0]]);
  let work = 0;
  for (let distance = 0; distance <= a.length + b.length; distance++) {
    work += frontier.size;
    if (work > TURN_DIFF_LIMITS.alignmentSteps) return undefined;
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++work > TURN_DIFF_LIMITS.alignmentSteps) return undefined;
      let x =
        diagonal === -distance ||
        (diagonal !== distance &&
          (frontier.get(diagonal - 1) ?? -Infinity) < (frontier.get(diagonal + 1) ?? -Infinity))
          ? (frontier.get(diagonal + 1) ?? 0)
          : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        if (++work > TURN_DIFF_LIMITS.alignmentSteps) return undefined;
        x++;
        y++;
      }
      frontier.set(diagonal, x);
      if (x >= a.length && y >= b.length) {
        const rows: Row[] = [];
        x = a.length;
        y = b.length;
        for (let d = trace.length - 1; d >= 0; d--) {
          const previous = trace[d];
          const k = x - y;
          const previousK =
            k === -d ||
            (k !== d && (previous.get(k - 1) ?? -Infinity) < (previous.get(k + 1) ?? -Infinity))
              ? k + 1
              : k - 1;
          const previousX = previous.get(previousK) ?? 0;
          const previousY = previousX - previousK;
          while (x > previousX && y > previousY) {
            rows.push({ marker: " ", text: a[--x] });
            y--;
          }
          if (d === 0) break;
          if (x === previousX) rows.push({ marker: "+", text: b[--y] });
          else rows.push({ marker: "-", text: a[--x] });
        }
        return rows.reverse();
      }
    }
  }
  return undefined;
}

/** Equal outer ranges keep whole-file writes cheap, even for a full replacement. */
function diffRows(a: string[], b: string[]): Row[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]
  )
    suffix++;
  const oldEnd = a.length - suffix,
    newEnd = b.length - suffix;
  const rows: Row[] = a.slice(0, prefix).map((text) => ({ marker: " ", text }));
  const aligned = align(a.slice(prefix, oldEnd), b.slice(prefix, newEnd));
  if (aligned) {
    for (const row of aligned) rows.push(row);
  } else {
    // Bounded fallback is still an exact patch; it never invents snippet coordinates.
    for (let i = prefix; i < oldEnd; i++) rows.push({ marker: "-", text: a[i] });
    for (let i = prefix; i < newEnd; i++) rows.push({ marker: "+", text: b[i] });
  }
  for (let i = oldEnd; i < a.length; i++) rows.push({ marker: " ", text: a[i] });
  return rows;
}

function fileDiff(path: string, before: KnownState, after: KnownState): TurnDiffFile {
  // Keep the execution workspace identity in the patch itself: historical
  // rendering must not resolve this file against the chat's later cwd.
  const label = path.split(sep).join("/");
  const oldPath = quotePath(`a/${label}`),
    newPath = quotePath(`b/${label}`);
  const status = !before.exists ? "added" : !after.exists ? "deleted" : "modified";
  const lines = [`diff --git ${oldPath} ${newPath}`];
  if (!before.exists && after.exists) lines.push(`new file mode ${after.mode}`);
  else if (before.exists && !after.exists) lines.push(`deleted file mode ${before.mode}`);
  else if (before.exists && after.exists && before.mode !== after.mode)
    lines.push(`old mode ${before.mode}`, `new mode ${after.mode}`);
  lines.push(
    `--- ${before.exists ? oldPath : "/dev/null"}`,
    `+++ ${after.exists ? newPath : "/dev/null"}`,
  );
  const rows = diffRows(
    splitLines(before.exists ? before.content : ""),
    splitLines(after.exists ? after.content : ""),
  );
  const oldPositions = [0],
    newPositions = [0];
  let added = 0,
    removed = 0;
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    oldPositions.push(oldPositions[i] + (row.marker === "+" ? 0 : 1));
    newPositions.push(newPositions[i] + (row.marker === "-" ? 0 : 1));
    if (row.marker === "+") added++;
    if (row.marker === "-") removed++;
    if (row.marker === " ") continue;
    const start = Math.max(0, i - 3),
      end = Math.min(rows.length, i + 4);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) last.end = end;
    else ranges.push({ start, end });
  }
  for (const { start, end } of ranges) {
    const oldCount = oldPositions[end] - oldPositions[start];
    const newCount = newPositions[end] - newPositions[start];
    const oldStart = oldPositions[start] + (oldCount === 0 ? 0 : 1);
    const newStart = newPositions[start] + (newCount === 0 ? 0 : 1);
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let i = start; i < end; i++) {
      const row = rows[i];
      lines.push(`${row.marker}${row.text.endsWith("\n") ? row.text.slice(0, -1) : row.text}`);
      if (!row.text.endsWith("\n")) lines.push("\\ No newline at end of file");
    }
  }
  return { path, status, diff: `${lines.join("\n")}\n`, added, removed };
}
