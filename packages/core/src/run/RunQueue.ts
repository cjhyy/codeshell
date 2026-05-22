/**
 * RunQueue — simple in-process FIFO queue with configurable concurrency.
 *
 * Phase 1: single-process, no persistence.
 * The queue holds run IDs; the actual execution is delegated to a callback.
 */

export interface RunQueueConfig {
  concurrency?: number;
}

export type RunQueueExecutor = (runId: string) => Promise<void>;

export class RunQueue {
  private readonly concurrency: number;
  private readonly pending: string[] = [];
  private readonly active = new Set<string>();
  private executor: RunQueueExecutor | null = null;
  private draining = false;

  constructor(config?: RunQueueConfig) {
    this.concurrency = config?.concurrency ?? 1;
  }

  setExecutor(fn: RunQueueExecutor): void {
    this.executor = fn;
  }

  enqueue(runId: string): void {
    if (this.pending.includes(runId) || this.active.has(runId)) return;
    this.pending.push(runId);
    this.drain();
  }

  cancel(runId: string): boolean {
    const idx = this.pending.indexOf(runId);
    if (idx !== -1) {
      this.pending.splice(idx, 1);
      return true;
    }
    return false;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  isPending(runId: string): boolean {
    return this.pending.includes(runId);
  }

  get activeCount(): number {
    return this.active.size;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;

    // Schedule on next microtask to batch enqueues
    queueMicrotask(() => {
      this.draining = false;
      this.processNext();
    });
  }

  private processNext(): void {
    if (!this.executor) return;

    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const runId = this.pending.shift()!;
      this.active.add(runId);

      this.executor(runId)
        .catch((err) => {
          // Executor (RunManager.executeRun) handles state transitions
          // in its own try/catch. Log here as a safety net.
          console.error(`[RunQueue] Executor error for run ${runId}:`, err);
        })
        .finally(() => {
          this.active.delete(runId);
          this.processNext();
        });
    }
  }
}
