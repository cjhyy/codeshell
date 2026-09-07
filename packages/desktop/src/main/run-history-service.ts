/**
 * Activity history combines legacy managed runs with durable Session run receipts.
 * A Session snapshot is not a run: drafts and interrupted runs without a receipt
 * must not be presented as completed. The session:<sid>:<event-id> address names
 * an existing run_result event, never a new RunStore entry.
 */
import { sessionsRoot } from "@cjhyy/code-shell-core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getRun, listRuns, type RunDetail, type RunSummary } from "./runs-service.js";
import { assertDesktopSessionId } from "./session-validation.js";

const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_BYTES = 256 * 1024 * 1024;
const MAX_SESSIONS = 2_000;
const MAX_HISTORY = 1_000;
const MAX_TEXT = 16_000;
const SESSION_RUN_PREFIX = "session:";

interface HistoryOptions {
  sessionsDir?: string;
  runsDir?: string;
}

interface Event {
  id: string;
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value.slice(0, MAX_TEXT);
  if (!Array.isArray(value)) return "";
  return value
    .filter((block) => record(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text.slice(0, MAX_TEXT))
    .join("")
    .slice(0, MAX_TEXT);
}

/** Read a fixed snapshot length; reject links and keep only complete JSONL rows. */
async function readWindow(file: string, maxBytes: number, tail = false): Promise<string> {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (!tail && info.size > maxBytes)) {
    throw new Error("invalid history file");
  }
  const handle = await fs.open(file, "r");
  try {
    const length = Math.min(info.size, maxBytes);
    const start = tail ? info.size - length : 0;
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    let window = buffer.subarray(0, read);
    if (start > 0) {
      const boundary = window.indexOf(0x0a);
      if (boundary < 0) return "";
      window = window.subarray(boundary + 1);
    }
    return window.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readState(baseDir: string, sessionId: string) {
  assertDesktopSessionId(sessionId);
  const dir = path.join(baseDir, sessionId);
  const info = await fs.lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) return null;
  const state: unknown = JSON.parse(
    await readWindow(path.join(dir, "state.json"), MAX_STATE_BYTES),
  );
  if (
    !record(state) ||
    state.ephemeral === true ||
    sessionId.startsWith("qchat-") ||
    sessionId.startsWith("pet-") ||
    sessionId.startsWith("panel-task-") ||
    sessionId.startsWith(".pending-fork-") ||
    (state.kind !== undefined && state.kind !== "work") ||
    (typeof state.parentSessionId === "string" && state.parentSessionId.length > 0) ||
    state.origin === "subagent" ||
    state.origin === "pet"
  ) {
    return null;
  }
  return state;
}

function parseEvents(raw: string): Event[] {
  const events: Event[] = [];
  for (const line of raw.split("\n")) {
    try {
      const event: unknown = JSON.parse(line);
      if (
        !record(event) ||
        typeof event.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(event.id) ||
        typeof event.type !== "string" ||
        event.type.length > 128 ||
        typeof event.timestamp !== "number" ||
        !Number.isFinite(event.timestamp) ||
        !record(event.data)
      )
        continue;
      events.push(event as unknown as Event);
    } catch {
      // One torn or malformed event must not hide the surrounding history.
    }
  }
  return events;
}

function statusForReason(reason: string): string {
  if (reason === "completed") return "completed";
  if (reason === "aborted_streaming" || reason === "aborted_tools") return "cancelled";
  if (["model_error", "prompt_too_long", "image_error"].includes(reason)) return "failed";
  if (
    ["max_turns", "goal_budget_exhausted", "hook_stopped", "stop_hook_prevented"].includes(reason)
  ) {
    return "blocked";
  }
  return "unknown";
}

function receipts(sessionId: string, state: Record<string, unknown>, events: Event[]): RunDetail[] {
  const inputs = new Map<string, { event: Event; index: number }>();
  const results = new Map<string, RunDetail>();
  for (const [index, event] of events.entries()) {
    const clientMessageId = event.data.clientMessageId;
    if (typeof clientMessageId !== "string" || !clientMessageId || clientMessageId.length > 512) {
      continue;
    }
    if (event.type === "message" && event.data.role === "user") {
      inputs.set(clientMessageId, { event, index });
      continue;
    }
    if (event.type !== "run_result") continue;
    const result = event.data.result;
    if (
      !record(result) ||
      result.sessionId !== sessionId ||
      typeof result.reason !== "string" ||
      result.reason.length > 128 ||
      typeof result.text !== "string" ||
      !Number.isSafeInteger(result.turnCount) ||
      (result.turnCount as number) < 0 ||
      !record(result.usage) ||
      ![result.usage.promptTokens, result.usage.completionTokens, result.usage.totalTokens].every(
        (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
      )
    )
      continue;
    const input = inputs.get(clientMessageId);
    const status = statusForReason(result.reason);
    const start = input?.event.timestamp ?? null;
    results.set(clientMessageId, {
      runId: `${SESSION_RUN_PREFIX}${sessionId}:${event.id}`,
      objective: input ? text(input.event.data.displayText ?? input.event.data.content) : "",
      cwd: text(state.cwd),
      status,
      createdAt: start ?? event.timestamp,
      updatedAt: event.timestamp,
      startedAt: start,
      finishedAt: event.timestamp,
      sessionId,
      error: status === "failed" ? result.reason : null,
      summary: text(result.text) || null,
      source: typeof state.origin === "string" ? state.origin : "session",
      attemptCount: 1,
      latestCheckpointId: null,
      latestApprovalId: null,
      tags: [],
      metadata: {
        historySource: "session_receipt",
        clientMessageId,
        receiptEventId: event.id,
        terminalReason: result.reason,
        turnCount: result.turnCount,
        usage: result.usage,
      },
      // When an input lies outside the tail window, the receipt alone is known.
      events: events.slice(Math.max(input?.index ?? index, index - 199), index + 1).map((item) => ({
        eventId: item.id,
        type: item.type,
        timestamp: item.timestamp,
        data: {},
      })),
      checkpoints: [],
      artifacts: [],
    });
  }
  return [...results.values()];
}

/** Recent receipts only; limits bound both IO and the renderer response size. */
export async function listRunHistory(options: HistoryOptions = {}): Promise<RunSummary[]> {
  const legacy = await listRuns(options.runsDir);
  const linkedSessions = new Set(legacy.map((run) => run.sessionId).filter(Boolean));
  const baseDir = options.sessionsDir ?? sessionsRoot();
  let entries;
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return legacy;
    throw error;
  }
  const candidates: Array<{ sessionId: string; size: number; mtime: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || linkedSessions.has(entry.name)) continue;
    try {
      assertDesktopSessionId(entry.name);
      const info = await fs.lstat(path.join(baseDir, entry.name, "transcript.jsonl"));
      if (!info.isFile() || info.isSymbolicLink()) continue;
      candidates.push({ sessionId: entry.name, size: info.size, mtime: info.mtimeMs });
    } catch {
      // Ignore individual unavailable or invalid sessions.
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const history: RunSummary[] = [...legacy];
  let remaining = MAX_SCAN_BYTES;
  for (const candidate of candidates.slice(0, MAX_SESSIONS)) {
    if (remaining <= 0) break;
    try {
      const state = await readState(baseDir, candidate.sessionId);
      if (!state) continue;
      const budget = Math.min(candidate.size, MAX_TRANSCRIPT_BYTES, remaining);
      remaining -= budget;
      const raw = await readWindow(
        path.join(baseDir, candidate.sessionId, "transcript.jsonl"),
        budget,
        true,
      );
      for (const detail of receipts(candidate.sessionId, state, parseEvents(raw))) {
        const {
          attemptCount: _attempts,
          latestCheckpointId: _checkpoint,
          latestApprovalId: _approval,
          tags: _tags,
          metadata: _metadata,
          events: _events,
          checkpoints: _checkpoints,
          artifacts: _artifacts,
          ...summary
        } = detail;
        history.push(summary);
      }
    } catch {
      // An old/corrupt session must not prevent reading healthy run receipts.
    }
  }
  return history.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_HISTORY);
}

/** Automation import/delete callers must continue seeing only managed runs. */
export function listRunsForUi(
  query?: { includeSessions?: boolean },
  storage: HistoryOptions = {},
): Promise<RunSummary[]> {
  return query?.includeSessions === true ? listRunHistory(storage) : listRuns(storage.runsDir);
}

export async function getRunHistory(
  runId: string,
  options: HistoryOptions = {},
): Promise<RunDetail | null> {
  if (!runId.startsWith(SESSION_RUN_PREFIX)) return getRun(runId, options.runsDir);
  const parts = runId.split(":");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{1,128}$/.test(parts[2])) {
    throw new Error("invalid session run id");
  }
  const sessionId = parts[1];
  assertDesktopSessionId(sessionId);
  const baseDir = options.sessionsDir ?? sessionsRoot();
  try {
    const state = await readState(baseDir, sessionId);
    if (!state) return null;
    const raw = await readWindow(
      path.join(baseDir, sessionId, "transcript.jsonl"),
      MAX_TRANSCRIPT_BYTES,
      true,
    );
    return receipts(sessionId, state, parseEvents(raw)).find((run) => run.runId === runId) ?? null;
  } catch {
    return null;
  }
}
