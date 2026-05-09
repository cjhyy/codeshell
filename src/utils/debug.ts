/**
 * Debug logging — thin facade over the unified logger.
 *
 * Historically this module wrote to ~/.code-shell/debug/<session>.txt.
 * It now delegates to logger so all output lands in ~/.code-shell/logs/.
 *
 * Activation knobs (still honored, parsed inside logger):
 *   CODE_SHELL_LOG_LEVEL=debug        — explicit level
 *   CODE_SHELL_DEBUG=mcp,api          — category filter
 *   --debug                           — local dev: defaults to debug level
 *   --debug=mcp,api                   — category filter (CLI form)
 *   --debug-to-stderr / -d2e          — echo to stderr instead of file
 */

import { logger, type LogLevel } from "../logging/logger.js";

export type DebugLogLevel = "verbose" | LogLevel;

// ─── Session tag ───────────────────────────────────────────────────
//
// Session id lives on the logger (process-wide). The logger seeds itself
// with a random tag at module load; the Engine overwrites it with the
// authoritative id once a run resolves it (see engine.run → logger.setSid).

export function setDebugSessionId(id: string): void {
  logger.setSid(id);
}

// ─── Mode introspection ────────────────────────────────────────────

export function isDebugMode(): boolean {
  return logger.getMinLevel() === "debug";
}

export function enableDebugLogging(): boolean {
  // Level is fixed at logger construction; flip env so future child loggers
  // (and a fresh process) pick up debug. The current logger keeps its level.
  const wasActive = isDebugMode();
  process.env.CODE_SHELL_LOG_LEVEL = "debug";
  return wasActive;
}

export function isDebugToStdErr(): boolean {
  return (
    process.env.CODE_SHELL_DEBUG === "1" ||
    process.argv.includes("--debug-to-stderr") ||
    process.argv.includes("-d2e")
  );
}

export function getMinDebugLogLevel(): DebugLogLevel {
  const raw = process.env.CODE_SHELL_DEBUG_LOG_LEVEL?.toLowerCase().trim();
  if (raw === "verbose") return "verbose";
  return logger.getMinLevel();
}

// ─── Core API ──────────────────────────────────────────────────────

/**
 * Log a debug message. Optional level via opts.level.
 * Embedded `[category]` tags are extracted into the structured `cat` field.
 */
export function logForDebugging(
  message: string,
  opts?: { level?: DebugLogLevel | string },
): void {
  const requested = (opts?.level ?? "debug") as string;
  const level: LogLevel =
    requested === "error" || requested === "warn" || requested === "info"
      ? requested
      : "debug"; // verbose collapses into debug

  // Extract leading [category] tag if present.
  const match = message.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
  const cat = match ? match[1]!.toLowerCase() : undefined;
  const cleanMsg = match ? match[2]! : message;

  const data: Record<string, unknown> = {};
  if (cat) data.cat = cat;

  switch (level) {
    case "error": logger.error(cleanMsg, data); break;
    case "warn":  logger.warn(cleanMsg, data); break;
    case "info":  logger.info(cleanMsg, data); break;
    default:      logger.debug(cleanMsg, data); break;
  }
}

/**
 * Category-scoped debug logger.
 * Usage: const log = debugCategory("mcp"); log("connecting...");
 */
export function debugCategory(category: string): (msg: string) => void {
  const child = logger.child({ cat: category.toLowerCase() });
  return (msg: string) => child.debug(msg);
}

/**
 * Time a function and log the duration at debug level.
 */
export async function debugTiming<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
  if (!isDebugMode()) return fn();
  const start = performance.now();
  try {
    const result = await fn();
    logger.debug(`${label}: ${(performance.now() - start).toFixed(1)}ms`);
    return result;
  } catch (err) {
    const ms = (performance.now() - start).toFixed(1);
    logger.error(`${label}: FAILED after ${ms}ms — ${(err as Error).message}`);
    throw err;
  }
}

// ─── CC compatibility shims ────────────────────────────────────────

export function logAntError(msg: string, _err?: unknown): void {
  logger.error(msg);
}

export function getDebugFilePath(): string | null { return null; }
export function setHasFormattedOutput(_v: boolean): void { /* no-op */ }
export function getHasFormattedOutput(): boolean { return false; }
export async function flushDebugLogs(): Promise<void> { /* sync writes */ }
