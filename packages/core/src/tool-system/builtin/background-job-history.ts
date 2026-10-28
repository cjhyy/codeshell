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
import type { BackgroundJobEntry } from "./background-jobs.js";

const MAX_SNAPSHOTS = 500;
const MAX_SNAPSHOT_BYTES = 128 * 1024;
type Snapshot = Omit<BackgroundJobEntry, "abort">;

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
 * atomic files avoid competing read/modify/write operations across workers. */
export class BackgroundJobHistory {
  constructor(private readonly directory?: string) {}

  private root(): string {
    return this.directory ?? join(codeShellHome(), "background-job-history");
  }

  private file(jobId: string): string {
    return join(this.root(), `${createHash("sha256").update(jobId).digest("hex")}.json`);
  }

  write(entry: BackgroundJobEntry): void {
    let temporary: string | undefined;
    try {
      const file = this.file(entry.jobId);
      let existed = false;
      try {
        existed = statSync(file).isFile();
      } catch {
        /* first snapshot */
      }
      mkdirSync(this.root(), { recursive: true, mode: 0o700 });
      const { abort: _abort, ...snapshot } = entry;
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

  list(sessionId?: string): Snapshot[] {
    const snapshots: Snapshot[] = [];
    for (const name of this.files()) {
      try {
        const file = join(this.root(), name);
        if (statSync(file).size > MAX_SNAPSHOT_BYTES) continue;
        const item = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
        if (
          !item ||
          typeof item.jobId !== "string" ||
          typeof item.sessionId !== "string" ||
          typeof item.description !== "string" ||
          !Number.isFinite(item.startedAt) ||
          !["running", "cancelling", "completed", "failed", "cancelled"].includes(item.status) ||
          this.file(item.jobId) !== file ||
          (sessionId && item.sessionId !== sessionId)
        )
          continue;
        snapshots.push(normalizeSnapshot(item));
      } catch {
        /* missing or corrupt history is not runtime state */
      }
    }
    return snapshots;
  }

  dropForSession(sessionId: string): void {
    for (const item of this.list(sessionId)) {
      try {
        rmSync(this.file(item.jobId), { force: true });
      } catch {
        /* best effort */
      }
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
