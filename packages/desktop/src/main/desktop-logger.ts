/**
 * Tiny shared logger for the desktop processes.
 *
 * Why a desktop-local logger instead of reusing core's logger:
 *   - core's logger is meant for the agent worker (writes engine-*.log).
 *   - main process logs (broker lifecycle, IPC traffic, child stdio
 *     plumbing) belong in their own bucket so they don't drown out
 *     engine logs and don't depend on core being import-able.
 *   - Renderer can't write to disk directly anyway; main has to do it
 *     on its behalf through a dedicated IPC channel.
 *
 * Sinks (both written for every event):
 *   ~/.code-shell/logs/desktop/desktop-YYYY-MM-DD.log
 *     — process-wide JSONL, all sources, all events for the day.
 *   ~/.code-shell/logs/desktop/sessions/session-<SID>.jsonl
 *     — written ONLY when the event carries an extractable sessionId
 *       (in `data` directly or inside a JSON-RPC `raw` payload). Mirrors
 *       core's per-session split so `logs.sh repo <SID>` can pick up
 *       the Electron-side timeline (agent/run, status, run.resolved,
 *       streamEvent envelopes) alongside the engine/ui buckets.
 *
 * The dedicated `desktop/` subdirectory keeps these lines out of the
 * top-level logs/ scan paths used by scripts/logs.sh's engine/ui-ink
 * queries, so spinner-tick noise from the renderer can't drown out an
 * engine timeline reconstruction.
 *
 * Source field on every line distinguishes who logged:
 *   "main"     — Electron main process direct log
 *   "bridge"   — AgentBridge broker plumbing
 *   "renderer" — forwarded over IPC channel "desktop:log"
 *   "agent"    — child stderr forwarded by AgentBridge
 *
 * Tail in one terminal:
 *   tail -f ~/.code-shell/logs/desktop/desktop-$(date +%F).log
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redactSecrets } from "./redact-secrets.js";

/**
 * Persistent append streams, keyed by file path. dlog() runs in the Electron
 * main process on the hot path (every worker→renderer JSON-RPC line, i.e. per
 * streaming text chunk). The previous appendFileSync() did a blocking open +
 * write + close on the event loop for every line, freezing IPC/rendering under
 * load. A long-lived createWriteStream buffers writes and flushes off the
 * critical path. Streams are cached and reused; the day-stamped file rolls over
 * to a new stream at midnight (the old one is closed).
 */
const _streams = new Map<string, WriteStream>();

function streamFor(filePath: string): WriteStream | null {
  let s = _streams.get(filePath);
  if (s) return s;
  try {
    s = createWriteStream(filePath, { flags: "a" });
    // Never crash the desktop because a log stream errored (disk full,
    // permission, etc.). Drop the broken stream so the next call can retry.
    s.on("error", () => {
      _streams.delete(filePath);
    });
    _streams.set(filePath, s);
    return s;
  } catch {
    return null;
  }
}

export type LogSource =
  | "main"
  | "bridge"
  | "renderer"
  | "agent"
  | "mcp-probe"
  | "browser"
  | "credentials";

/** YYYY-MM-DD stamp for a date (local time). */
export function dayStamp(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Log file path for a given day stamp. */
export function logPathForDay(stamp: string): string {
  return join(homedir(), ".code-shell", "logs", "desktop", `desktop-${stamp}.log`);
}

let _cachedStamp: string | null = null;
let _cachedPath: string | null = null;
function logPath(): string {
  const stamp = dayStamp(new Date());
  // Recompute when the day changes — a long-running process must roll over to
  // a new file at midnight instead of writing to the start-day's file forever.
  if (_cachedStamp !== stamp || _cachedPath === null) {
    // Day rolled over: close yesterday's stream so it isn't leaked, and let
    // the new path lazily open a fresh stream on next write.
    if (_cachedPath) {
      const prev = _streams.get(_cachedPath);
      if (prev) {
        prev.end();
        _streams.delete(_cachedPath);
      }
    }
    _cachedStamp = stamp;
    _cachedPath = logPathForDay(stamp);
    try {
      mkdirSync(dirname(_cachedPath), { recursive: true });
    } catch {
      // best effort; if logging dir is unwritable the stream write below
      // will error and be swallowed — we still continue running.
    }
  }
  return _cachedPath;
}

const sessionDir = join(homedir(), ".code-shell", "logs", "desktop", "sessions");
const sessionDirsEnsured = new Set<string>();
function sessionPath(sid: string): string {
  if (!sessionDirsEnsured.has(sessionDir)) {
    try {
      mkdirSync(sessionDir, { recursive: true });
    } catch {
      /* best-effort; appendFileSync below will throw and be caught */
    }
    sessionDirsEnsured.add(sessionDir);
  }
  return join(sessionDir, `session-${sid}.jsonl`);
}

/**
 * Best-effort sessionId extraction. dlog callers don't promise to pass
 * `sid` as a top-level data field — the bridge often only knows the id
 * from a `raw` JSON-RPC payload it's about to send. Probe both:
 *   1. Common scalar fields on `data` (sid, sessionId, agentId).
 *   2. A serialized JSON blob in `data.raw` containing `"sessionId":"..."`.
 * If nothing is found, the event is process-scoped (spawn, app boot,
 * renderer console) and never lands in a session file.
 */
function extractSid(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  const direct = data.sid ?? data.sessionId;
  if (typeof direct === "string" && direct) return direct;
  const raw = data.raw;
  if (typeof raw === "string") {
    const m = raw.match(/"sessionId"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return undefined;
}

export function dlog(source: LogSource, msg: string, data?: Record<string, unknown>): void {
  // Mask credential-looking fields so they don't get persisted to the log
  // file. extractSid below reads the original `data` (sid keys aren't secrets).
  const safeData = redactSecrets(data);
  const record = { t: new Date().toISOString(), src: source, msg, ...(safeData ?? {}) };
  const line = JSON.stringify(record) + "\n";
  // Buffered async writes via long-lived append streams — no blocking
  // open/write/close per call. write() returning false (backpressure) is fine;
  // Node buffers internally and we never await. The stream's 'error' handler
  // (in streamFor) swallows failures so logging can never crash the desktop.
  streamFor(logPath())?.write(line);
  const sid = extractSid(data);
  if (sid) {
    streamFor(sessionPath(sid))?.write(line);
  }
}
