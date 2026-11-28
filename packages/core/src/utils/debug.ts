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
