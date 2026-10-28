import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { codeShellHome } from "../../session/session-manager.js";
import type { BackgroundJobEntry, ExternalCliKind } from "./background-jobs.js";

const MAX_SNAPSHOTS = 500;
const MAX_SNAPSHOT_BYTES = 128 * 1024;
/** Distinguishes this process from a later one that reuses its pid. */
const OWNER_TOKEN = randomUUID();
const INTERRUPTED_NOTE =
  "[interrupted] The process that owned this task exited before the task finished.";

type Snapshot = Omit<BackgroundJobEntry, "abort">;
type StoredSnapshot = Snapshot & { ownerPid?: number; ownerToken?: string };

/** Why a non-terminal snapshot without a live controller is still unresolved. */
export type BackgroundJobUnknownReason = "other-process" | "orphaned-process";
export type BackgroundJobHistorySnapshot = Snapshot & {
  unknownReason?: BackgroundJobUnknownReason;
};

function isActive(status: string): boolean {
  return status === "running" || status === "cancelling";
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function normalizeSnapshot(item: Snapshot): Snapshot {
  const clean: Snapshot = {
    jobId: item.jobId,
    sessionId: item.sessionId,
    description: item.description,
    status: item.status,
    startedAt: item.startedAt,
  };
  for (const key of [
    "finalText",
    "ccSessionId",
    "launchCwd",
    "cwd",
    "effectiveWorkspaceCwd",
    "workspaceRoot",
    "effectiveWorkspaceRoot",
    "gitCommonDir",
    "promptSummary",
    "worktreePath",
    "worktreeBranch",
    "worktreeBaseRef",
    "worktreeBranchPrefix",
    "originClientMessageId",
  ] as const) {
    if (typeof item[key] === "string")
      clean[key] = item[key].slice(0, key === "finalText" ? 16_000 : 4096);
  }
  for (const [key, values] of Object.entries({
    kind: ["drive-agent", "video", "job"],
    cli: ["claude", "codex"],
    isolation: ["current", "worktree", "none"],
    effectiveWorkspaceKind: ["git-worktree", "cwd"],
    worktreeCleanup: ["auto", "keep", "detach", "discard"],
    worktreeLifecycle: ["running", "kept", "detached", "discarded", "cleanup-failed"],
  })) {
    const value = (item as unknown as Record<string, unknown>)[key];
    if (typeof value === "string" && values.includes(value))
      (clean as unknown as Record<string, unknown>)[key] = value;
  }
  if (typeof item.finishedAt === "number" && Number.isFinite(item.finishedAt))
    clean.finishedAt = item.finishedAt;
  if (Array.isArray(item.changedFiles))
    clean.changedFiles = item.changedFiles.filter((path) => typeof path === "string").slice(0, 100);
  const progress = item.progress;
  if (
    progress &&
    Number.isFinite(progress.lastActivityAt) &&
    Number.isSafeInteger(progress.eventCount) &&
    progress.eventCount >= 0
  ) {
    clean.progress = { lastActivityAt: progress.lastActivityAt, eventCount: progress.eventCount };
    if (
      typeof progress.phase === "string" &&
      ["starting", "thinking", "tool", "responding"].includes(progress.phase)
    )
      clean.progress.phase = progress.phase;
    if (typeof progress.summary === "string")
      clean.progress.summary = progress.summary.slice(0, 240);
    if (Array.isArray(progress.recentEvents))
      clean.progress.recentEvents = progress.recentEvents
        .filter((event) => event && Number.isFinite(event.at) && typeof event.summary === "string")
        .slice(-8)
        .map((event) => ({ at: event.at, summary: event.summary.slice(0, 240) }));
  }
  return clean;
}

/** These files are history, never evidence that a process is alive. Per-job
 * atomic files avoid competing read/modify/write operations across workers.
 * Only the owning process writes a job's file while it runs; any reader may
 * finalize it once both that owner and the external CLI are gone. */
export class BackgroundJobHistory {
  private cache = new Map<string, { mtimeMs: number; size: number; item: StoredSnapshot | null }>();

  constructor(
    private readonly directory?: string,
    private readonly isAlive: (pid: unknown) => boolean = pidAlive,
  ) {}

  private root(): string {
    return this.directory ?? join(codeShellHome(), "background-job-history");
  }

  private file(jobId: string): string {
    return join(this.root(), `${createHash("sha256").update(jobId).digest("hex")}.json`);
  }

  write(entry: BackgroundJobEntry, owner?: { pid: number; token?: string }): void {
    const { abort: _abort, ...snapshot } = entry;
    this.writeSnapshot({
      ...snapshot,
      ownerPid: owner?.pid ?? process.pid,
      ownerToken: owner ? owner.token : OWNER_TOKEN,
    });
  }

  private writeSnapshot(snapshot: StoredSnapshot): void {
    let temporary: string | undefined;
    try {
      const file = this.file(snapshot.jobId);
      let existed = false;
      try {
        existed = statSync(file).isFile();
      } catch {
        /* first snapshot */
      }
      mkdirSync(this.root(), { recursive: true, mode: 0o700 });
      // The full final result remains in the parent conversation/transcript.
      const data = JSON.stringify({
        ...snapshot,
        finalText: snapshot.finalText?.slice(0, 16_000),
        changedFiles: snapshot.changedFiles?.slice(0, 100),
      });
      if (Buffer.byteLength(data) > MAX_SNAPSHOT_BYTES) return;
      temporary = `${file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
      renameSync(temporary, file);
      if (!existed) this.prune();
    } catch {
      // History is optional. A filesystem failure must not fail a running job.
    } finally {
      if (temporary) {
        try {
          rmSync(temporary, { force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }

  /** Non-terminal rows are reconciled against owner and CLI liveness: a row
   * whose owner and external process are both gone is finalized on disk, so
   * a crash or restart can never leave a permanent "unknown" task behind. */
  list(sessionId?: string): BackgroundJobHistorySnapshot[] {
    const snapshots: BackgroundJobHistorySnapshot[] = [];
    for (const item of this.readAll()) {
      if (sessionId && item.sessionId !== sessionId) continue;
      if (!isActive(item.status)) {
        snapshots.push(normalizeSnapshot(item));
        continue;
      }
      const reason = this.unknownReason(item);
      if (reason === undefined) {
        snapshots.push(normalizeSnapshot(this.finalizeInterrupted(item)));
        continue;
      }
      snapshots.push({ ...normalizeSnapshot(item), unknownReason: reason });
    }
    return snapshots;
  }

  /** Explicit user resolution for a task no live controller reports. The
   * caller must already have confirmed that no reachable process owns it. */
  markInterrupted(jobId: string, sessionId: string, startedAt: number): boolean {
    const item = this.readAll().find(
      (candidate) =>
        candidate.jobId === jobId &&
        candidate.sessionId === sessionId &&
        candidate.startedAt === startedAt,
    );
    if (!item || !isActive(item.status)) return false;
    this.finalizeInterrupted(item);
    return true;
  }

  /** The non-terminal job that may still be writing this external session. */
  findActiveForExternalSession(
    cli: ExternalCliKind,
    externalSessionId: string,
  ): BackgroundJobHistorySnapshot | undefined {
    return this.list().find(
      (item) => isActive(item.status) && item.cli === cli && item.ccSessionId === externalSessionId,
    );
  }

  dropForSession(sessionId: string): void {
    for (const item of this.readAll()) {
      if (item.sessionId !== sessionId) continue;
      try {
        rmSync(this.file(item.jobId), { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  private unknownReason(item: StoredSnapshot): BackgroundJobUnknownReason | undefined {
    const ownerAlive =
      item.ownerPid === process.pid ? item.ownerToken === OWNER_TOKEN : this.isAlive(item.ownerPid);
    if (ownerAlive) return "other-process";
    return this.isAlive(item.processId) ? "orphaned-process" : undefined;
  }

  private finalizeInterrupted(item: StoredSnapshot): StoredSnapshot {
    const finalized: StoredSnapshot = {
      ...item,
      status: "failed",
      finishedAt: Math.max(item.startedAt, item.progress?.lastActivityAt ?? item.startedAt),
      finalText: item.finalText ? `${item.finalText}\n\n${INTERRUPTED_NOTE}` : INTERRUPTED_NOTE,
    };
    this.writeSnapshot(finalized);
    return finalized;
  }

  /** Viewers poll this; only files whose mtime/size changed are re-parsed. */
  private readAll(): StoredSnapshot[] {
    const files = this.files().map((name) => join(this.root(), name));
    const present = new Set(files);
    for (const file of this.cache.keys()) if (!present.has(file)) this.cache.delete(file);
    const snapshots: StoredSnapshot[] = [];
    for (const file of files) {
      try {
        const stat = statSync(file);
        let cached = this.cache.get(file);
        if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
          cached = { mtimeMs: stat.mtimeMs, size: stat.size, item: this.parse(file, stat.size) };
          this.cache.set(file, cached);
        }
        if (cached.item) snapshots.push(cached.item);
      } catch {
        this.cache.delete(file);
      }
    }
    return snapshots;
  }

  private parse(file: string, size: number): StoredSnapshot | null {
    if (size > MAX_SNAPSHOT_BYTES) return null;
    try {
      const item = JSON.parse(readFileSync(file, "utf8")) as StoredSnapshot;
      if (
        !item ||
        typeof item.jobId !== "string" ||
        typeof item.sessionId !== "string" ||
        typeof item.description !== "string" ||
        !Number.isFinite(item.startedAt) ||
        !["running", "cancelling", "completed", "failed", "cancelled"].includes(item.status) ||
        this.file(item.jobId) !== file
      )
        return null;
      return item;
    } catch {
      // Missing or corrupt history is not runtime state.
      return null;
    }
  }

  private files(): string[] {
    try {
      return readdirSync(this.root()).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    } catch {
      return [];
    }
  }

  private prune(): void {
    const files = this.files()
      .flatMap((name) => {
        try {
          return [{ name, mtime: statSync(join(this.root(), name)).mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const { name } of files.slice(MAX_SNAPSHOTS)) {
      try {
        rmSync(join(this.root(), name), { force: true });
      } catch {
        /* another writer may have pruned it */
      }
    }
  }
}

export const backgroundJobHistory = new BackgroundJobHistory();
