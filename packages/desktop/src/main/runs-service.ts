/**
 * Read run snapshots/events/checkpoints from ~/.code-shell/runs/<id>/.
 *
 * The core's FileRunStore is the writer; this service is read-only.
 * Layout (per FileRunStore.ts):
 *   <runs-dir>/<runId>/
 *     run.json            — RunSnapshot
 *     events.jsonl        — append-only event log
 *     checkpoints/        — one file per checkpoint
 *     artifacts/          — per-run artifact metadata
 *
 * Mutating runs (cancel/resume) requires the worker process to drive
 * its RunManager; we don't poke at on-disk state. Cancel here returns
 * an error so the renderer surface is honest.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const RUNS_DIR = path.join(os.homedir(), ".code-shell", "runs");
const MAX_RUN_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_RUN_EVENTS_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const MAX_RUN_DIRECTORIES = 10_000;
const MAX_CHECKPOINTS = 1_000;
const MAX_ARTIFACTS = 10_000;

export interface RunSummary {
  runId: string;
  objective: string;
  preset?: string;
  cwd: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  sessionId: string | null;
  error: string | null;
  summary: string | null;
  /** "automation" for cron-triggered runs (from run.json metadata.source). */
  source?: string;
  /** Display name of the originating cron job, when source === "automation". */
  cronJobName?: string;
}

export interface RunDetail extends RunSummary {
  attemptCount: number;
  latestCheckpointId: string | null;
  latestApprovalId: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  events: Array<{
    eventId: string;
    type: string;
    timestamp: number;
    data: Record<string, unknown>;
  }>;
  checkpoints: Array<{
    checkpointId: string;
    createdAt: number;
    phase: string;
    summary: string;
    nextAction: string | null;
  }>;
  artifacts: string[];
}

async function readBoundedFile(file: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("file exceeds the size limit");
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, total, buffer.byteLength - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error("file exceeds the size limit");
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readTailFile(file: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("not a regular file");
    const length = Math.min(stat.size, maxBytes);
    const start = stat.size - length;
    const buffer = Buffer.allocUnsafe(length);
    let total = 0;
    while (total < length) {
      const { bytesRead } = await handle.read(buffer, total, length - total, start + total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    let window = buffer.subarray(0, total);
    if (start > 0) {
      const newline = window.indexOf(0x0a);
      if (newline < 0) return "";
      window = window.subarray(newline + 1);
    }
    return window.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readSnapshot(runId: string, baseDir: string = RUNS_DIR): Promise<unknown | null> {
  try {
    assertSafeRunId(runId);
    const dir = path.join(baseDir, runId);
    const dirInfo = await fs.lstat(dir);
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return null;
    const file = path.join(dir, "run.json");
    const fileInfo = await fs.lstat(file);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) return null;
    const raw = await readBoundedFile(file, MAX_RUN_SNAPSHOT_BYTES);
    return JSON.parse(raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function snapshotToSummary(snap: Record<string, unknown>, authoritativeRunId: string): RunSummary {
  const meta =
    snap.metadata && typeof snap.metadata === "object" && !Array.isArray(snap.metadata)
      ? (snap.metadata as Record<string, unknown>)
      : {};
  return {
    runId: authoritativeRunId,
    objective: typeof snap.objective === "string" ? snap.objective.slice(0, 1_000_000) : "",
    preset: typeof snap.preset === "string" ? snap.preset : undefined,
    cwd: typeof snap.cwd === "string" ? snap.cwd.slice(0, 32_768) : "",
    status: typeof snap.status === "string" ? snap.status.slice(0, 128) : "unknown",
    createdAt:
      typeof snap.createdAt === "number" && Number.isFinite(snap.createdAt) ? snap.createdAt : 0,
    updatedAt:
      typeof snap.updatedAt === "number" && Number.isFinite(snap.updatedAt) ? snap.updatedAt : 0,
    startedAt:
      typeof snap.startedAt === "number" && Number.isFinite(snap.startedAt)
        ? snap.startedAt
        : null,
    finishedAt:
      typeof snap.finishedAt === "number" && Number.isFinite(snap.finishedAt)
        ? snap.finishedAt
        : null,
    sessionId: typeof snap.sessionId === "string" ? snap.sessionId.slice(0, 4_096) : null,
    error: typeof snap.error === "string" ? snap.error.slice(0, 1_000_000) : null,
    summary: typeof snap.summary === "string" ? snap.summary.slice(0, 1_000_000) : null,
    source: typeof meta.source === "string" ? meta.source : undefined,
    cronJobName: typeof meta.cronJobName === "string" ? meta.cronJobName : undefined,
  };
}

export async function listRuns(baseDir: string = RUNS_DIR): Promise<RunSummary[]> {
  let entries;
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: RunSummary[] = [];
  for (const e of entries.slice(0, MAX_RUN_DIRECTORIES)) {
    if (!e.isDirectory()) continue;
    try {
      assertSafeRunId(e.name);
    } catch {
      continue;
    }
    const snap = await readSnapshot(e.name, baseDir);
    if (snap && typeof snap === "object") {
      out.push(snapshotToSummary(snap as Record<string, unknown>, e.name));
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

function assertSafeRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("invalid run id: must be a non-empty string");
  }
  if (runId.includes("/") || runId.includes("\\")) {
    throw new Error(`invalid run id: contains path separator: ${runId}`);
  }
  if (runId === "." || runId === ".." || runId.includes("..")) {
    throw new Error(`invalid run id: contains parent-dir token: ${runId}`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(runId)) {
    throw new Error(`invalid run id: unexpected characters: ${runId}`);
  }
  if (runId.length > 128) {
    throw new Error("invalid run id: too long (max 128 chars)");
  }
}

/**
 * Remove a run's on-disk directory (~/.code-shell/runs/<runId>/).
 * `baseDir` overridable for tests; no-op for missing dirs.
 */
export async function deleteRunDir(runId: string, baseDir: string = RUNS_DIR): Promise<void> {
  assertSafeRunId(runId);
  await fs.rm(path.join(baseDir, runId), { recursive: true, force: true });
}

export async function getRun(runId: string, baseDir: string = RUNS_DIR): Promise<RunDetail | null> {
  assertSafeRunId(runId);
  const snap = await readSnapshot(runId, baseDir);
  if (!snap || typeof snap !== "object") return null;
  const s = snap as Record<string, unknown>;
  const base = snapshotToSummary(s, runId);

  // Events
  let events: RunDetail["events"] = [];
  try {
    const raw = await readTailFile(
      path.join(baseDir, runId, "events.jsonl"),
      MAX_RUN_EVENTS_SCAN_BYTES,
    );
    events = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
          const event = parsed as Record<string, unknown>;
          if (
            typeof event.eventId !== "string" ||
            event.eventId.length > 512 ||
            typeof event.type !== "string" ||
            event.type.length > 256 ||
            typeof event.timestamp !== "number" ||
            !Number.isFinite(event.timestamp) ||
            !event.data ||
            typeof event.data !== "object" ||
            Array.isArray(event.data)
          ) {
            return null;
          }
          return event as unknown as RunDetail["events"][number];
        } catch {
          return null;
        }
      })
      .filter((x): x is RunDetail["events"][number] => x !== null)
      .slice(-200); // cap so a runaway log doesn't bury the UI
  } catch {
    // no events file yet
  }

  // Checkpoints
  let checkpoints: RunDetail["checkpoints"] = [];
  try {
    const cpDir = path.join(baseDir, runId, "checkpoints");
    const cpEntries = await fs.readdir(cpDir);
    const items = await Promise.all(
      cpEntries
        .filter((n) => /^[A-Za-z0-9_.-]{1,256}\.json$/.test(n) && !n.includes(".."))
        .slice(0, MAX_CHECKPOINTS)
        .map(async (n) => {
          try {
            const checkpointFile = path.join(cpDir, n);
            const info = await fs.lstat(checkpointFile);
            if (info.isSymbolicLink() || !info.isFile()) return null;
            const cpRaw = await readBoundedFile(checkpointFile, MAX_CHECKPOINT_BYTES);
            const cp = JSON.parse(cpRaw) as Record<string, unknown>;
            return {
              checkpointId: String(cp.checkpointId ?? n.replace(/\.json$/, "")),
              createdAt: Number(cp.createdAt ?? 0),
              phase: String(cp.phase ?? ""),
              summary: String(cp.summary ?? ""),
              nextAction: (cp.nextAction as string | null) ?? null,
            };
          } catch {
            return null;
          }
        }),
    );
    checkpoints = items.filter((x): x is RunDetail["checkpoints"][number] => x !== null);
    checkpoints.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    // no checkpoints dir
  }

  // Artifacts (just filenames; data lives elsewhere)
  let artifacts: string[] = [];
  try {
    const artDir = path.join(baseDir, runId, "artifacts");
    artifacts = (await fs.readdir(artDir))
      .filter((n) => !n.startsWith(".") && n.length <= 512 && !n.includes("\0"))
      .slice(0, MAX_ARTIFACTS);
  } catch {
    // none
  }

  return {
    ...base,
    attemptCount:
      typeof s.attemptCount === "number" && Number.isSafeInteger(s.attemptCount) && s.attemptCount >= 0
        ? s.attemptCount
        : 0,
    latestCheckpointId:
      typeof s.latestCheckpointId === "string" ? s.latestCheckpointId.slice(0, 512) : null,
    latestApprovalId:
      typeof s.latestApprovalId === "string" ? s.latestApprovalId.slice(0, 512) : null,
    tags: Array.isArray(s.tags)
      ? s.tags
          .filter((tag): tag is string => typeof tag === "string")
          .slice(0, 100)
          .map((tag) => tag.slice(0, 512))
      : [],
    metadata:
      s.metadata && typeof s.metadata === "object" && !Array.isArray(s.metadata)
        ? (s.metadata as Record<string, unknown>)
        : {},
    events,
    checkpoints,
    artifacts,
  };
}
