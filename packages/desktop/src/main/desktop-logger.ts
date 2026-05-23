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
 * Sink: ~/.code-shell/logs/desktop-YYYY-MM-DD.log (JSONL).
 *
 * Source field on every line distinguishes who logged:
 *   "main"     — Electron main process direct log
 *   "bridge"   — AgentBridge broker plumbing
 *   "renderer" — forwarded over IPC channel "desktop:log"
 *   "agent"    — child stderr forwarded by AgentBridge
 *
 * Tail in one terminal:
 *   tail -f ~/.code-shell/logs/desktop-$(date +%F).log
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
  return join(homedir(), ".code-shell", "logs", `desktop-${yyyy}-${mm}-${dd}.log`);
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

export function dlog(source: LogSource, msg: string, data?: Record<string, unknown>): void {
  const line =
    JSON.stringify({ t: new Date().toISOString(), src: source, msg, ...(data ?? {}) }) + "\n";
  try {
    appendFileSync(logPath(), line, "utf-8");
  } catch {
    // Never crash the desktop because logging failed. Swallow and move on.
  }
}
