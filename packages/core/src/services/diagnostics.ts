/**
 * Diagnostics service — error tracking and system health monitoring.
 *
 * Collects and reports diagnostic information for debugging.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DiagnosticEntry {
  timestamp: string;
  level: "error" | "warn" | "info";
  category: string;
  message: string;
  metadata?: Record<string, unknown>;
  stack?: string;
}

class DiagnosticsTracker {
  private logDir: string;
  private entries: DiagnosticEntry[] = [];

  constructor() {
    this.logDir = join(homedir(), ".code-shell", "diagnostics");
  }

  /**
   * Record a diagnostic event.
   */
  record(
    level: DiagnosticEntry["level"],
    category: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    const entry: DiagnosticEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      metadata,
    };

    this.entries.push(entry);
    this.persist(entry);
  }

  /**
   * Record an error with stack trace.
   */
  recordError(category: string, error: Error, metadata?: Record<string, unknown>): void {
    const entry: DiagnosticEntry = {
      timestamp: new Date().toISOString(),
      level: "error",
      category,
      message: error.message,
      stack: error.stack,
      metadata,
    };

    this.entries.push(entry);
    this.persist(entry);
  }

  /**
   * Get recent diagnostic entries.
   */
  getRecent(count = 50): DiagnosticEntry[] {
    return this.entries.slice(-count);
  }

  /**
   * Get entries by category.
   */
  getByCategory(category: string): DiagnosticEntry[] {
    return this.entries.filter((e) => e.category === category);
  }

  /**
   * Generate a diagnostic report for troubleshooting.
   */
  generateReport(): string {
    const lines: string[] = [
      "=== Code Shell Diagnostic Report ===",
      `Generated: ${new Date().toISOString()}`,
      `Platform: ${process.platform} ${process.arch}`,
      `Node: ${process.version}`,
      `Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      "",
    ];

    const errors = this.entries.filter((e) => e.level === "error");
    const warnings = this.entries.filter((e) => e.level === "warn");

    lines.push(`Errors: ${errors.length}`);
    lines.push(`Warnings: ${warnings.length}`);
    lines.push(`Total events: ${this.entries.length}`);
    lines.push("");

    if (errors.length > 0) {
      lines.push("Recent Errors:");
      for (const err of errors.slice(-10)) {
        lines.push(`  [${err.timestamp}] ${err.category}: ${err.message}`);
        if (err.stack) {
          lines.push(`    ${err.stack.split("\n")[1]?.trim() ?? ""}`);
        }
      }
    }

    return lines.join("\n");
  }

  private persist(entry: DiagnosticEntry): void {
    try {
      if (!existsSync(this.logDir)) {
        mkdirSync(this.logDir, { recursive: true });
      }
      const dateStr = entry.timestamp.split("T")[0];
      const logFile = join(this.logDir, `${dateStr}.jsonl`);
      appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // Best-effort persistence
    }
  }
}

export const diagnostics = new DiagnosticsTracker();
