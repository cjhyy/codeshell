/**
 * Debug logging — category-filtered, leveled output with file support.
 *
 * Activation:
 *   CODE_SHELL_DEBUG=1          — all debug output to stderr
 *   --debug                     — all debug output to file (~/.code-shell/debug/<session>.txt)
 *   --debug=api,hooks           — filtered categories only
 *   --debug-file=/path/to/file  — explicit output file
 *   --debug-to-stderr / -d2e    — force stderr output
 *
 * Levels: verbose < debug < info < warn < error
 *   Set CODE_SHELL_DEBUG_LOG_LEVEL=verbose to include high-volume diagnostics.
 */

import { appendFileSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ─── Types ─────────────────────────────────────────────────────────

export type DebugLogLevel = "verbose" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<DebugLogLevel, number> = {
  verbose: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

// ─── Debug filter (--debug=api,hooks) ──────────────────────────────

type DebugFilter = {
  categories: Set<string>;
};

function parseDebugFilter(pattern: string): DebugFilter {
  const categories = new Set(
    pattern
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return { categories };
}

function shouldShowDebugMessage(message: string, filter: DebugFilter | null): boolean {
  if (!filter || filter.categories.size === 0) return true;
  // Check if message contains [category] tag matching any filter
  const match = message.match(/\[([^\]]+)\]/);
  if (!match) return true; // No category tag — always show
  return filter.categories.has(match[1]!.toLowerCase());
}

// ─── State ─────────────────────────────────────────────────────────

let runtimeDebugEnabled = false;
let _isDebugMode: boolean | null = null;
let _debugFilter: DebugFilter | null | undefined = undefined; // undefined = not parsed yet
let _minLevel: DebugLogLevel | null = null;
let _debugFilePath: string | null | undefined = undefined;
let _isDebugToStdErr: boolean | null = null;
let _symlinkUpdated = false;

// ─── Session ID (lightweight — no import cycle with bootstrap/state) ──

let _sessionTag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
export function setDebugSessionId(id: string): void {
  _sessionTag = id;
}

// ─── Accessors (memoized via lazy init) ────────────────────────────

export function getMinDebugLogLevel(): DebugLogLevel {
  if (_minLevel !== null) return _minLevel;
  const raw = process.env.CODE_SHELL_DEBUG_LOG_LEVEL?.toLowerCase().trim();
  _minLevel = raw && Object.hasOwn(LEVEL_ORDER, raw) ? (raw as DebugLogLevel) : "debug";
  return _minLevel;
}

export function isDebugMode(): boolean {
  if (_isDebugMode !== null) return _isDebugMode;
  _isDebugMode =
    runtimeDebugEnabled ||
    process.env.CODE_SHELL_DEBUG === "1" ||
    process.env.DEBUG === "1" ||
    process.argv.includes("--debug") ||
    process.argv.includes("-d") ||
    isDebugToStdErr() ||
    process.argv.some((arg) => arg.startsWith("--debug=")) ||
    getDebugFilePath() !== null;
  return _isDebugMode;
}

/**
 * Enable debug logging mid-session (e.g. via /debug command).
 * Returns true if logging was already active.
 */
export function enableDebugLogging(): boolean {
  const wasActive = isDebugMode();
  runtimeDebugEnabled = true;
  _isDebugMode = null; // force re-eval
  return wasActive;
}

export function isDebugToStdErr(): boolean {
  if (_isDebugToStdErr !== null) return _isDebugToStdErr;
  _isDebugToStdErr =
    process.env.CODE_SHELL_DEBUG === "1" ||
    process.argv.includes("--debug-to-stderr") ||
    process.argv.includes("-d2e");
  return _isDebugToStdErr;
}

export function getDebugFilter(): DebugFilter | null {
  if (_debugFilter !== undefined) return _debugFilter;
  const debugArg = process.argv.find((arg) => arg.startsWith("--debug="));
  _debugFilter = debugArg ? parseDebugFilter(debugArg.substring("--debug=".length)) : null;
  return _debugFilter;
}

export function getDebugFilePath(): string | null {
  if (_debugFilePath !== undefined) return _debugFilePath;
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i]!;
    if (arg.startsWith("--debug-file=")) {
      _debugFilePath = arg.substring("--debug-file=".length);
      return _debugFilePath;
    }
    if (arg === "--debug-file" && i + 1 < process.argv.length) {
      _debugFilePath = process.argv[i + 1]!;
      return _debugFilePath;
    }
  }
  _debugFilePath = null;
  return null;
}

function getDebugLogPath(): string {
  if (getDebugFilePath()) return getDebugFilePath()!;

  const logsDir =
    process.env.CODE_SHELL_DEBUG_LOGS_DIR ??
    join(homedir(), ".code-shell", "debug");

  return join(logsDir, `${_sessionTag}.txt`);
}

function updateLatestSymlink(): void {
  if (_symlinkUpdated) return;
  _symlinkUpdated = true;
  try {
    const logPath = getDebugLogPath();
    const latestPath = join(dirname(logPath), "latest");
    try { unlinkSync(latestPath); } catch { /* ok */ }
    symlinkSync(logPath, latestPath);
  } catch { /* ok */ }
}

// ─── Core logging ──────────────────────────────────────────────────

function shouldLog(message: string): boolean {
  if (!isDebugMode()) return false;
  return shouldShowDebugMessage(message, getDebugFilter());
}

/**
 * Log a debug message with optional level.
 * Output goes to stderr (--debug-to-stderr / CODE_SHELL_DEBUG=1)
 * or to a file (~/.code-shell/debug/<session>.txt).
 */
export function logForDebugging(
  message: string,
  opts?: { level?: DebugLogLevel | string },
): void {
  const level = (opts?.level ?? "debug") as DebugLogLevel;
  if (LEVEL_ORDER[level] !== undefined && LEVEL_ORDER[level] < LEVEL_ORDER[getMinDebugLogLevel()]) {
    return;
  }
  if (!shouldLog(message)) return;

  const timestamp = new Date().toISOString();
  const output = `${timestamp} [${level.toUpperCase()}] ${message.trim()}\n`;

  if (isDebugToStdErr()) {
    process.stderr.write(output);
    return;
  }

  // Write to file
  const path = getDebugLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, output);
    updateLatestSymlink();
  } catch { /* best-effort */ }
}

/**
 * Category-scoped debug logger.
 * Usage: const log = debugCategory("mcp"); log("connecting...");
 */
export function debugCategory(category: string): (msg: string) => void {
  return (msg: string) => {
    logForDebugging(`[${category}] ${msg}`);
  };
}

/**
 * Time a function and log the duration.
 */
export async function debugTiming<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
  if (!isDebugMode()) return fn();
  const start = performance.now();
  try {
    const result = await fn();
    const ms = (performance.now() - start).toFixed(1);
    logForDebugging(`${label}: ${ms}ms`);
    return result;
  } catch (err) {
    const ms = (performance.now() - start).toFixed(1);
    logForDebugging(`${label}: FAILED after ${ms}ms — ${(err as Error).message}`, { level: "error" });
    throw err;
  }
}

/**
 * CC compatibility: log errors for Anthropic internal users.
 * In Code Shell this is a debug-level error log.
 */
export function logAntError(msg: string, _err?: unknown): void {
  logForDebugging(msg, { level: "error" });
}

/**
 * CC compatibility exports.
 */
export function setHasFormattedOutput(_value: boolean): void { /* no-op */ }
export function getHasFormattedOutput(): boolean { return false; }
export async function flushDebugLogs(): Promise<void> { /* sync writes, nothing to flush */ }
