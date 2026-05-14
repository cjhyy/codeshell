/**
 * Unified file logger for code-shell.
 *
 * Sinks (JSON Lines), routed by `cat`:
 *   ~/.code-shell/logs/ui-ink-YYYY-MM-DD.log
 *     — UI/ink chatter: stream events, ctx render, ink screen diffs.
 *   ~/.code-shell/logs/engine-YYYY-MM-DD.log
 *     — everything else: engine, llm, tool, context, mcp, sandbox, ...
 *
 * Routing is by entry `cat`: cat ∈ {ui, ink, render, stream} → ui-ink bucket;
 * anything else → engine bucket. Run scripts/logs.sh to query both at once
 * (merge sorted by timestamp, filter by sid, etc).
 *
 * Level defaults:
 *   - Local dev (CODE_SHELL_DEV=1, or running from src/, or --debug)   → "debug"
 *   - Otherwise                                                         → "info"
 *   - CODE_SHELL_LOG_LEVEL overrides everything.
 *
 * Category filter (--debug=mcp,api or CODE_SHELL_DEBUG=mcp,api):
 *   When set, only debug logs whose `cat` matches are written.
 *
 * Disable entirely: CODE_SHELL_LOG=0
 */

import {
  appendFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOGS_DIR = join(homedir(), ".code-shell", "logs");
const MAX_LOG_FILES = 7;
const MAX_IN_MEMORY_ERRORS = 100;

/**
 * Map a log entry's `cat` to a file bucket: "ui-ink" for UI/render logs,
 * "engine" for everything else (engine, llm, tool, context, mcp, ...).
 * Buckets are date-suffixed: ui-ink-2026-05-14.log / engine-2026-05-14.log.
 *
 * UI/ink lives in its own file because it's the chattiest (200ms spinner
 * ticks, every stream event) and was drowning out engine traces. Keeping
 * both date-suffixed lets one `grep "sid":"<id>"` over both files
 * reconstruct a full session timeline if needed.
 */
const INK_CATS = new Set(["ui", "ink", "render", "stream"]);
function routeBucket(
  cat: string | undefined,
  fallbackCat: string | undefined,
): "ui-ink" | "engine" {
  const c = (cat ?? fallbackCat ?? "").toLowerCase();
  if (INK_CATS.has(c)) return "ui-ink";
  return "engine";
}

// ─── Local-dev detection ───────────────────────────────────────────

function isLocalDev(): boolean {
  if (process.env.CODE_SHELL_DEV === "1") return true;
  if (process.argv.includes("--debug") || process.argv.includes("-d")) return true;
  if (process.argv.some((a) => a.startsWith("--debug="))) return true;
  // Don't silently raise the level under tests — they have their own
  // diagnostic story and shouldn't spam the daily log file.
  if (process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1") return false;
  if (process.argv.some((a) => a.includes("/tests/") || a.endsWith(".test.ts"))) return false;
  // Running directly from src/ (bun run src/cli/main.ts) — not a packaged install.
  const entry = process.argv[1] ?? "";
  if (entry.includes(`${"/"}src${"/"}`)) return true;
  return false;
}

function resolveDefaultLevel(): LogLevel {
  const raw = process.env.CODE_SHELL_LOG_LEVEL?.toLowerCase().trim();
  if (raw && Object.hasOwn(LEVEL_ORDER, raw)) return raw as LogLevel;
  return isLocalDev() ? "debug" : "info";
}

// ─── Category filter (--debug=mcp,api) ─────────────────────────────

function resolveCategoryFilter(): Set<string> | null {
  // CLI: --debug=a,b
  const cliArg = process.argv.find((a) => a.startsWith("--debug="));
  let raw: string | undefined;
  if (cliArg) raw = cliArg.slice("--debug=".length);
  // Env: CODE_SHELL_DEBUG=a,b (but "1" / "true" mean "all on", not a filter)
  else {
    const env = process.env.CODE_SHELL_DEBUG;
    if (env && env !== "1" && env !== "true") raw = env;
  }
  if (!raw) return null;
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return set.size > 0 ? set : null;
}

// ─── Process-wide session id (overrides per-logger context.sid) ────
//
// The Engine calls setSid() with the authoritative session id once a run
// has resolved it (resume vs. create). Every log line written after that
// point — from any logger instance, including child loggers created
// before the call — picks it up via _currentSid.
//
// Why a module-level value rather than per-instance state? Because
// child loggers snapshot context at construction time; if we kept sid
// on each instance, callers that imported the root logger early would
// keep writing the stale tag forever.

let _currentSid: string = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function setCurrentSid(sid: string): void {
  _currentSid = sid;
}

export function getCurrentSid(): string {
  return _currentSid;
}

// ─── In-memory error ring (for bug reports) ─────────────────────────

const inMemoryErrors: Array<{ msg: string; t: string; data?: unknown }> = [];

export function getInMemoryErrors(): ReadonlyArray<{ msg: string; t: string; data?: unknown }> {
  return inMemoryErrors;
}

// ─── ErrorLogSink (kept for external integrations) ──────────────────

export type ErrorLogSink = {
  logError: (error: Error) => void;
  logMCPError: (serverName: string, error: unknown) => void;
  logMCPDebug: (serverName: string, message: string) => void;
  getErrorsPath: () => string;
  getMCPLogsPath: (serverName: string) => string;
};

let errorLogSink: ErrorLogSink | null = null;
export function attachErrorLogSink(sink: ErrorLogSink): void {
  if (errorLogSink !== null) return;
  errorLogSink = sink;
}

// ─── Logger ────────────────────────────────────────────────────────

export interface LogContext {
  cat?: string;
  sid?: string;
  [key: string]: unknown;
}

class Logger {
  private readonly enabled: boolean;
  private readonly minLevel: LogLevel;
  private readonly categoryFilter: Set<string> | null;
  private readonly stderrEcho: boolean;
  private dirReady = false;

  constructor(private readonly context: LogContext = {}) {
    this.enabled = process.env.CODE_SHELL_LOG !== "0";
    this.minLevel = resolveDefaultLevel();
    this.categoryFilter = resolveCategoryFilter();
    this.stderrEcho =
      process.env.CODE_SHELL_DEBUG === "1" ||
      process.argv.includes("--debug-to-stderr") ||
      process.argv.includes("-d2e");
  }

  child(extra: LogContext): Logger {
    return new Logger({ ...this.context, ...extra });
  }

  /**
   * Set the session id stamped on every subsequent log entry written by
   * any logger in the process. Called by Engine once a run's
   * authoritative session id is known.
   */
  setSid(sid: string): void {
    setCurrentSid(sid);
  }

  getSid(): string {
    return getCurrentSid();
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.write("debug", msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.write("info", msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.write("warn", msg, data);
  }

  error(msgOrErr: string | Error | unknown, data?: Record<string, unknown> | Error): void {
    let msg: string;
    let entryData: Record<string, unknown> | undefined;
    let errObj: Error | undefined;

    if (typeof msgOrErr === "string") {
      msg = msgOrErr;
      if (data instanceof Error) {
        errObj = data;
        entryData = { error: data.message, stack: data.stack };
      } else {
        entryData = data;
      }
    } else if (msgOrErr instanceof Error) {
      msg = msgOrErr.message;
      errObj = msgOrErr;
      entryData = { stack: msgOrErr.stack };
    } else {
      msg = String(msgOrErr);
    }

    this.recordError(msg, entryData);
    this.write("error", msg, entryData);
    if (errObj) errorLogSink?.logError(errObj);
  }

  private recordError(msg: string, data?: Record<string, unknown>): void {
    if (inMemoryErrors.length >= MAX_IN_MEMORY_ERRORS) inMemoryErrors.shift();
    inMemoryErrors.push({ msg, t: new Date().toISOString(), data });
  }

  private write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (!this.enabled) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const cat = (data?.cat as string | undefined) ?? this.context.cat;
    // Category filter narrows the *debug* firehose only — info/warn/error
    // always go through so a `--debug=mcp` invocation doesn't accidentally
    // swallow unrelated errors.
    if (level === "debug" && this.categoryFilter) {
      if (!cat || !this.categoryFilter.has(cat.toLowerCase())) return;
    }

    const t = new Date().toISOString();
    const entry: Record<string, unknown> = { t, l: level, msg, ...this.context };
    if (cat && !entry.cat) entry.cat = cat;
    // Stamp the current process-wide session id unless this logger's
    // own context overrode it (rare). Doing it at write time means
    // children created before Engine.run() still pick up the real sid.
    if (entry.sid === undefined) entry.sid = _currentSid;
    if (data) entry.d = data;

    const line = JSON.stringify(entry) + "\n";

    if (this.stderrEcho) {
      process.stderr.write(line);
      return;
    }

    try {
      if (!this.dirReady) {
        if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
        this.dirReady = true;
      }
      const dateStr = t.slice(0, 10);
      // Route to per-area file. UI / ink events go to ui-ink-*.log so the
      // engine log isn't drowned by 200ms spinner ticks and per-event traces.
      // Everything else lands in engine-*.log (engine, turn-loop, llm, tool,
      // context, mcp, sandbox, settings, ...). One-line grep across both with
      // scripts/logs.sh.
      const bucket = routeBucket(cat, this.context.cat as string | undefined);
      const file = join(LOGS_DIR, `${bucket}-${dateStr}.log`);
      appendFileSync(file, line, "utf-8");
    } catch {
      // Best-effort.
    }
  }

  getMinLevel(): LogLevel {
    return this.minLevel;
  }
  isCategoryActive(cat: string): boolean {
    return !this.categoryFilter || this.categoryFilter.has(cat.toLowerCase());
  }

  /**
   * Open a span: writes a `<name>.begin` debug entry now and returns a handle
   * whose `end()` writes `<name>.end` with `duration_ms` populated. Use for
   * any "I want begin → end + how long" pattern (tool exec, LLM request,
   * permission ask, etc.) so the begin/end pair is grouped under one cat
   * and the duration is computed once instead of by hand from timestamps.
   */
  span(name: string, data?: Record<string, unknown>): LogSpan {
    const startedAt = Date.now();
    this.write("debug", `${name}.begin`, data);
    return {
      end: (extra?: Record<string, unknown>) => {
        const duration_ms = Date.now() - startedAt;
        this.write("info", `${name}.end`, { ...data, ...extra, duration_ms });
      },
      fail: (err: unknown, extra?: Record<string, unknown>) => {
        const duration_ms = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        this.write("error", `${name}.fail`, { ...data, ...extra, duration_ms, error: message });
      },
    };
  }
}

export interface LogSpan {
  end(extra?: Record<string, unknown>): void;
  fail(err: unknown, extra?: Record<string, unknown>): void;
}

export const logger = new Logger();

// ─── Maintenance helpers ───────────────────────────────────────────

export function getLogsDir(): string {
  return LOGS_DIR;
}

export function getRecentLogs(n = 50): string[] {
  const dateStr = new Date().toISOString().slice(0, 10);
  // Merge across all buckets (engine + ui-ink) for the day, sort by
  // timestamp so the tail represents a real chronological tail.
  const all: Array<{ t: string; line: string }> = [];
  for (const bucket of ["engine", "ui-ink"]) {
    const file = join(LOGS_DIR, `${bucket}-${dateStr}.log`);
    if (!existsSync(file)) continue;
    try {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        if (!line) continue;
        // Cheap timestamp extraction: lines start with {"t":"<iso>",...
        const m = line.match(/^\{"t":"([^"]+)"/);
        all.push({ t: m?.[1] ?? "", line });
      }
    } catch {
      /* ignore */
    }
  }
  all.sort((a, b) => a.t.localeCompare(b.t));
  return all.slice(-n).map((x) => x.line);
}

export function rotateLogs(): void {
  try {
    if (!existsSync(LOGS_DIR)) return;
    const files = readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith(".log"))
      .sort();
    if (files.length <= MAX_LOG_FILES) return;
    for (const f of files.slice(0, files.length - MAX_LOG_FILES)) {
      try {
        unlinkSync(join(LOGS_DIR, f));
      } catch {
        /* ignore */
      }
    }
  } catch {
    // Best-effort.
  }
}

/** @internal — for tests */
export function _resetLoggerStateForTesting(): void {
  inMemoryErrors.length = 0;
  errorLogSink = null;
}

// dirname is exported only to satisfy unused-import rules if reorganized later.
void dirname;
