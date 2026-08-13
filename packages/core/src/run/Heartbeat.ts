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

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { assertSafeRunId } from "./ids.js";

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

const MAX_HEARTBEAT_BYTES = 64 * 1024;

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
    assertSafeRunId(runId);
    const existing = this.timers.get(runId);
    if (existing) {
      clearInterval(existing);
      this.timers.delete(runId);
    }
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
    assertSafeRunId(runId);
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
    assertSafeRunId(runId);
    const filePath = this.filePath(runId);
    try {
      const parentInfo = lstatSync(dirname(filePath));
      if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) return null;
    } catch {
      return null;
    }
    if (!existsSync(filePath)) return null;
    let fd: number | undefined;
    try {
      const entry = lstatSync(filePath);
      if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_HEARTBEAT_BYTES) return null;
      fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_HEARTBEAT_BYTES) return null;
      const value = JSON.parse(readFileSync(fd, "utf-8")) as Partial<HeartbeatData>;
      if (
        value.runId !== runId ||
        !Number.isSafeInteger(value.pid) ||
        (value.pid ?? 0) <= 0 ||
        !Number.isSafeInteger(value.timestamp) ||
        (value.timestamp ?? -1) < 0
      ) {
        return null;
      }
      return value as HeartbeatData;
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /**
   * Check if a run's heartbeat is stale (older than threshold).
   * Returns true if stale or missing, false if recent.
   */
  isStale(runId: string, thresholdMs?: number): boolean {
    assertSafeRunId(runId);
    const threshold = thresholdMs ?? this.intervalMs * 3;
    const data = this.read(runId);
    if (!data) return true;
    return Date.now() - data.timestamp > threshold;
  }

  /**
   * Check if the process that wrote the heartbeat is still alive.
   */
  isProcessAlive(runId: string): boolean {
    assertSafeRunId(runId);
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
    const filePath = this.filePath(runId);
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const parent = dirname(filePath);
      const parentInfo = lstatSync(parent);
      if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) return;
      try {
        const targetInfo = lstatSync(filePath);
        if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      }
      writeFileSync(temporary, JSON.stringify(data), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, filePath);
    } catch {
      // Run directory may have been deleted
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private remove(runId: string): void {
    try {
      const filePath = this.filePath(runId);
      const parentInfo = lstatSync(dirname(filePath));
      if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) return;
      if (existsSync(filePath)) {
        const targetInfo = lstatSync(filePath);
        if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) return;
        unlinkSync(filePath);
      }
    } catch {
      // Already removed
    }
  }

  private filePath(runId: string): string {
    assertSafeRunId(runId);
    return join(this.runsDir, runId, "heartbeat");
  }
}
