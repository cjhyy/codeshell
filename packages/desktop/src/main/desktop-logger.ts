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

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LogSource = "main" | "bridge" | "renderer" | "agent";

function todayLogPath(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return join(homedir(), ".code-shell", "logs", "desktop", `desktop-${yyyy}-${mm}-${dd}.log`);
}

let _path: string | null = null;
function logPath(): string {
  if (_path === null) {
    _path = todayLogPath();
    try {
      mkdirSync(dirname(_path), { recursive: true });
    } catch {
      // best effort; if logging dir is unwritable the appendFileSync below
      // will throw and be caught — we still continue running.
    }
  }
  return _path;
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
  const record = { t: new Date().toISOString(), src: source, msg, ...(data ?? {}) };
  const line = JSON.stringify(record) + "\n";
  try {
    appendFileSync(logPath(), line, "utf-8");
  } catch {
    // Never crash the desktop because logging failed. Swallow and move on.
  }
  const sid = extractSid(data);
  if (sid) {
    try {
      appendFileSync(sessionPath(sid), line, "utf-8");
    } catch {
      /* same swallow rationale as above */
    }
  }
}
