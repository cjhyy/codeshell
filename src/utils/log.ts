/**
 * Persistent logging — writes to ~/.code-shell/logs/ with daily rotation.
 *
 * Also provides an in-memory error log (last 100 errors) for bug reports,
 * and a pluggable ErrorLogSink architecture for decoupled error routing.
 */

import {
  mkdirSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOGS_DIR = join(homedir(), ".code-shell", "logs");
const MAX_LOG_FILES = 7; // Keep 7 days of logs

// ─── Directory init ────────────────────────────────────────────────

let _initialized = false;
function ensureDir(): void {
  if (_initialized) return;
  mkdirSync(LOGS_DIR, { recursive: true });
  _initialized = true;
}

function getLogFile(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(LOGS_DIR, `${date}.log`);
}

function timestamp(): string {
  return new Date().toISOString();
}

function writeLine(level: string, msg: string): void {
  ensureDir();
  const line = `[${timestamp()}] [${level}] ${msg}\n`;
  try {
    appendFileSync(getLogFile(), line, "utf-8");
  } catch {
    // Best-effort — don't crash on log write failure
  }
}

// ─── In-memory error log ───────────────────────────────────────────

const MAX_IN_MEMORY_ERRORS = 100;
let inMemoryErrorLog: Array<{ error: string; timestamp: string }> = [];

function addToInMemoryErrorLog(errorInfo: {
  error: string;
  timestamp: string;
}): void {
  if (inMemoryErrorLog.length >= MAX_IN_MEMORY_ERRORS) {
    inMemoryErrorLog.shift(); // Remove oldest error
  }
  inMemoryErrorLog.push(errorInfo);
}

/**
 * Get recent in-memory errors for inclusion in bug reports.
 */
export function getInMemoryErrors(): Array<{ error: string; timestamp: string }> {
  return [...inMemoryErrorLog];
}

// ─── ErrorLogSink architecture ─────────────────────────────────────

/**
 * Sink interface for pluggable error logging backends.
 */
export type ErrorLogSink = {
  logError: (error: Error) => void;
  logMCPError: (serverName: string, error: unknown) => void;
  logMCPDebug: (serverName: string, message: string) => void;
  getErrorsPath: () => string;
  getMCPLogsPath: (serverName: string) => string;
};

type QueuedErrorEvent =
  | { type: "error"; error: Error }
  | { type: "mcpError"; serverName: string; error: unknown }
  | { type: "mcpDebug"; serverName: string; message: string };

const errorQueue: QueuedErrorEvent[] = [];
let errorLogSink: ErrorLogSink | null = null;

/**
 * Attach a sink to receive all error events.
 * Queued events are drained immediately. Idempotent.
 */
export function attachErrorLogSink(newSink: ErrorLogSink): void {
  if (errorLogSink !== null) return;
  errorLogSink = newSink;

  // Drain queued events
  if (errorQueue.length > 0) {
    const queued = [...errorQueue];
    errorQueue.length = 0;
    for (const event of queued) {
      switch (event.type) {
        case "error":
          errorLogSink.logError(event.error);
          break;
        case "mcpError":
          errorLogSink.logMCPError(event.serverName, event.error);
          break;
        case "mcpDebug":
          errorLogSink.logMCPDebug(event.serverName, event.message);
          break;
      }
    }
  }
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Log an error to multiple destinations:
 * - In-memory error log (for bug reports)
 * - Persistent log file
 * - ErrorLogSink (if attached)
 */
export function logError(msgOrError: string | Error | unknown, err?: unknown): void {
  // Normalize arguments: support both logError("msg", err) and logError(err)
  let errorStr: string;
  let errorObj: Error | undefined;

  if (typeof msgOrError === "string") {
    const errDetail =
      err instanceof Error ? `${err.message}\n${err.stack}` : err ? String(err) : "";
    errorStr = errDetail ? `${msgOrError}: ${errDetail}` : msgOrError;
    errorObj = err instanceof Error ? err : undefined;
  } else if (msgOrError instanceof Error) {
    errorStr = msgOrError.stack || msgOrError.message;
    errorObj = msgOrError;
  } else {
    errorStr = String(msgOrError);
    errorObj = undefined;
  }

  // Always add to in-memory log
  addToInMemoryErrorLog({
    error: errorStr,
    timestamp: new Date().toISOString(),
  });

  // Write to persistent log
  writeLine("ERROR", errorStr);

  // Route to sink if available
  if (errorObj) {
    if (errorLogSink) {
      errorLogSink.logError(errorObj);
    } else {
      errorQueue.push({ type: "error", error: errorObj });
    }
  }

  if (process.env.CODE_SHELL_DEBUG === "1") {
    console.error(`[error] ${errorStr}`);
  }
}

export function logInfo(msg: string): void {
  writeLine("INFO", msg);
}

export function logWarn(msg: string): void {
  writeLine("WARN", msg);
}

export function logMCPDebug(serverNameOrMsg: string, message?: string): void {
  if (message !== undefined) {
    // Called as logMCPDebug(serverName, message)
    writeLine("MCP:DEBUG", `[${serverNameOrMsg}] ${message}`);
    if (errorLogSink) {
      errorLogSink.logMCPDebug(serverNameOrMsg, message);
    } else {
      errorQueue.push({ type: "mcpDebug", serverName: serverNameOrMsg, message });
    }
  } else {
    // Called as logMCPDebug(msg) — backward compat
    writeLine("MCP:DEBUG", serverNameOrMsg);
  }
}

export function logMCPError(serverNameOrMsg: string, err?: unknown): void {
  if (err !== undefined) {
    // Called as logMCPError(serverName, error)
    const errStr = err instanceof Error ? err.message : err ? String(err) : "";
    writeLine("MCP:ERROR", `[${serverNameOrMsg}] ${errStr}`);
    if (errorLogSink) {
      errorLogSink.logMCPError(serverNameOrMsg, err);
    } else {
      errorQueue.push({ type: "mcpError", serverName: serverNameOrMsg, error: err });
    }
  } else {
    // Called as logMCPError(msg) — backward compat
    writeLine("MCP:ERROR", serverNameOrMsg);
  }
}

/**
 * Read the most recent N lines from today's log.
 */
export function getRecentLogs(n = 50): string[] {
  ensureDir();
  const file = getLogFile();
  if (!existsSync(file)) return [];
  try {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

/**
 * Clean up old log files (keep last MAX_LOG_FILES days).
 */
export function rotateLogs(): void {
  ensureDir();
  try {
    const files = readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith(".log"))
      .sort();
    if (files.length > MAX_LOG_FILES) {
      const toDelete = files.slice(0, files.length - MAX_LOG_FILES);
      for (const f of toDelete) {
        unlinkSync(join(LOGS_DIR, f));
      }
    }
  } catch {
    // Best-effort
  }
}

/**
 * Get the logs directory path.
 */
export function getLogsDir(): string {
  return LOGS_DIR;
}

/**
 * Reset error log state for testing purposes only.
 * @internal
 */
export function _resetErrorLogForTesting(): void {
  errorLogSink = null;
  errorQueue.length = 0;
  inMemoryErrorLog = [];
}
