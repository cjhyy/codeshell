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

async function readSnapshot(runId: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(path.join(RUNS_DIR, runId, "run.json"), "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function snapshotToSummary(snap: Record<string, unknown>): RunSummary {
  return {
    runId: String(snap.runId ?? ""),
    objective: String(snap.objective ?? ""),
    preset: typeof snap.preset === "string" ? snap.preset : undefined,
    cwd: String(snap.cwd ?? ""),
    status: String(snap.status ?? "unknown"),
    createdAt: Number(snap.createdAt ?? 0),
    updatedAt: Number(snap.updatedAt ?? 0),
    startedAt: (snap.startedAt as number | null) ?? null,
    finishedAt: (snap.finishedAt as number | null) ?? null,
    sessionId: (snap.sessionId as string | null) ?? null,
    error: (snap.error as string | null) ?? null,
    summary: (snap.summary as string | null) ?? null,
  };
}

export async function listRuns(): Promise<RunSummary[]> {
  let entries;
  try {
    entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: RunSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const snap = await readSnapshot(e.name);
    if (snap && typeof snap === "object") {
      out.push(snapshotToSummary(snap as Record<string, unknown>));
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export async function getRun(runId: string): Promise<RunDetail | null> {
  const clean = runId.replace(/[\\/]/g, "");
  const snap = await readSnapshot(clean);
  if (!snap || typeof snap !== "object") return null;
  const s = snap as Record<string, unknown>;
  const base = snapshotToSummary(s);

  // Events
  let events: RunDetail["events"] = [];
  try {
    const raw = await fs.readFile(path.join(RUNS_DIR, clean, "events.jsonl"), "utf8");
    events = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
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
    const cpDir = path.join(RUNS_DIR, clean, "checkpoints");
    const cpEntries = await fs.readdir(cpDir);
    const items = await Promise.all(
      cpEntries
        .filter((n) => n.endsWith(".json"))
        .map(async (n) => {
          try {
            const cpRaw = await fs.readFile(path.join(cpDir, n), "utf8");
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
    const artDir = path.join(RUNS_DIR, clean, "artifacts");
    artifacts = (await fs.readdir(artDir)).filter((n) => !n.startsWith("."));
  } catch {
    // none
  }

  return {
    ...base,
    attemptCount: Number(s.attemptCount ?? 0),
    latestCheckpointId: (s.latestCheckpointId as string | null) ?? null,
    latestApprovalId: (s.latestApprovalId as string | null) ?? null,
    tags: Array.isArray(s.tags) ? (s.tags as string[]) : [],
    metadata:
      s.metadata && typeof s.metadata === "object" && !Array.isArray(s.metadata)
        ? (s.metadata as Record<string, unknown>)
        : {},
    events,
    checkpoints,
    artifacts,
  };
}
