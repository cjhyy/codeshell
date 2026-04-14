/**
 * Simple file logger for debug/runtime logs.
 *
 * Logs go to ~/.code-shell/logs/YYYY-MM-DD.log
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private logDir: string;
  private minLevel: LogLevel;
  private enabled: boolean;

  constructor() {
    this.logDir = join(homedir(), ".code-shell", "logs");
    this.minLevel = (process.env.CODE_SHELL_LOG_LEVEL as LogLevel) ?? "info";
    this.enabled = process.env.CODE_SHELL_LOG !== "0";
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log("debug", msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.log("info", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.log("warn", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.log("error", msg, data);
  }

  private log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (!this.enabled) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const now = new Date();
    const timestamp = now.toISOString();
    const dateStr = timestamp.split("T")[0];

    const entry: Record<string, unknown> = {
      t: timestamp,
      l: level,
      msg,
    };
    if (data) entry.d = data;

    try {
      if (!existsSync(this.logDir)) {
        mkdirSync(this.logDir, { recursive: true });
      }
      const logFile = join(this.logDir, `${dateStr}.log`);
      appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // Don't crash on log failure
    }
  }
}

export const logger = new Logger();
