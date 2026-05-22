/**
 * Heartbeat — periodic timestamp writer for run liveness detection.
 *
 * While a run is executing, the heartbeat writes a timestamp file at regular
 * intervals. Crash recovery uses this to determine if a "running" run is
 * actually alive or if its process died without cleanup.
 *
 * File: ~/.code-shell/runs/<runId>/heartbeat
 * Content: JSON { pid, timestamp, runId }
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface HeartbeatConfig {
  runsDir?: string;
  /** Heartbeat interval in ms. Default: 5_000 (5 seconds) */
  intervalMs?: number;
}

export interface HeartbeatData {
  pid: number;
  timestamp: number;
  runId: string;
}

export class Heartbeat {
  private readonly runsDir: string;
  private readonly intervalMs: number;
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(config?: HeartbeatConfig) {
    this.runsDir = config?.runsDir ?? join(homedir(), ".code-shell", "runs");
    this.intervalMs = config?.intervalMs ?? 5_000;
  }

  /**
   * Start heartbeat for a run. Writes immediately, then repeats on interval.
   */
  start(runId: string): void {
    // Write first heartbeat immediately
    this.write(runId);

    // Schedule periodic heartbeats
    const timer = setInterval(() => this.write(runId), this.intervalMs);
    // Unref so the timer doesn't prevent process exit
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
    this.timers.set(runId, timer);
  }

  /**
   * Stop heartbeat for a run and remove the heartbeat file.
   */
  stop(runId: string): void {
    const timer = this.timers.get(runId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(runId);
    }
    this.remove(runId);
  }

  /**
   * Stop all heartbeats.
   */
  stopAll(): void {
    for (const [runId] of this.timers) {
      this.stop(runId);
    }
  }

  /**
   * Read the last heartbeat for a run. Returns null if no heartbeat exists.
   */
  read(runId: string): HeartbeatData | null {
    const filePath = this.filePath(runId);
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, "utf-8")) as HeartbeatData;
    } catch {
      return null;
    }
  }

  /**
   * Check if a run's heartbeat is stale (older than threshold).
   * Returns true if stale or missing, false if recent.
   */
  isStale(runId: string, thresholdMs?: number): boolean {
    const threshold = thresholdMs ?? this.intervalMs * 3;
    const data = this.read(runId);
    if (!data) return true;
    return Date.now() - data.timestamp > threshold;
  }

  /**
   * Check if the process that wrote the heartbeat is still alive.
   */
  isProcessAlive(runId: string): boolean {
    const data = this.read(runId);
    if (!data) return false;
    try {
      // Sending signal 0 checks if process exists without actually signaling it
      process.kill(data.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private write(runId: string): void {
    const data: HeartbeatData = {
      pid: process.pid,
      timestamp: Date.now(),
      runId,
    };
    try {
      writeFileSync(this.filePath(runId), JSON.stringify(data), "utf-8");
    } catch {
      // Run directory may have been deleted
    }
  }

  private remove(runId: string): void {
    try {
      const filePath = this.filePath(runId);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch {
      // Already removed
    }
  }

  private filePath(runId: string): string {
    return join(this.runsDir, runId, "heartbeat");
  }
}
