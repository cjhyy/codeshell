import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import type { Snapshot } from "../SessionSnapshotStore.js";
import type { OutputMutation, OutputPublication, OutputResult } from "./stored-output.js";

/** Preserve read-after-write across worker stdout, Main producers and renderer
 * recovery. The shared store thread owns locks, journal joins and memory bounds. */
export class HostOutput {
  private tail: Promise<void> = Promise.resolve();
  private buffered: string[] = [];
  private bufferedBytes = 0;
  private immediate?: NodeJS.Immediate;
  private queuedLines = 0;
  private queuedBytes = 0;
  private paused = false;

  constructor(
    private readonly storage: Promise<StateStorage>,
    private readonly publish: (frames: OutputPublication[]) => void,
    private readonly log: (message: string, data: Record<string, unknown>) => void,
    private readonly pauseWorker: (paused: boolean) => void,
    private readonly fault: (error: unknown) => void,
  ) {}

  push(line: string): void {
    this.buffered.push(line);
    const size = Buffer.byteLength(line);
    this.bufferedBytes += size;
    this.queuedBytes += size;
    this.queuedLines++;
    if (!this.paused && (this.queuedLines >= 256 || this.queuedBytes >= 4 * 1024 * 1024)) {
      this.paused = true;
      this.pauseWorker(true);
    }
    if (this.buffered.length >= 64 || this.bufferedBytes >= 256 * 1024) this.flush();
    else this.immediate ??= setImmediate(() => this.flush());
  }

  private flush() {
    if (this.immediate) clearImmediate(this.immediate);
    this.immediate = undefined;
    const lines = this.buffered;
    if (!lines.length) return;
    const bytes = this.bufferedBytes;
    this.buffered = [];
    this.bufferedBytes = 0;
    void this.enqueue(async () => {
      try {
        await this.apply({ type: "worker", lines });
      } catch (error) {
        this.fault(error);
      } finally {
        this.queuedLines -= lines.length;
        this.queuedBytes -= bytes;
        if (this.paused && this.queuedLines < 128 && this.queuedBytes < 1024 * 1024) {
          this.paused = false;
          this.pauseWorker(false);
        }
      }
    });
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const job = this.tail.then(run);
    this.tail = job.then(
      () => {},
      () => {},
    );
    return job;
  }
  private async apply(command: OutputMutation): Promise<void> {
    const store = await this.storage;
    const result = await store.request<OutputResult>("output/mutate", command);
    if (!result) throw new Error("Desktop output storage unavailable");
    for (const item of result.diagnostics) this.log(item.name, item.details);
    if (result.frames.length) this.publish(result.frames);
  }
  mutate(command: OutputMutation): Promise<void> {
    this.flush();
    return this.enqueue(() => this.apply(command)).catch((error) => {
      if (command.type === "worker-exit") this.fault(error);
      throw error;
    });
  }
  snapshot(sessionId: string, sinceSeq = 0): Promise<Snapshot> {
    this.flush();
    return this.enqueue(async () => {
      const store = await this.storage;
      const snapshot = await store.request<Snapshot>("output/snapshot", { sessionId, sinceSeq });
      if (!snapshot) throw new Error("Desktop output storage unavailable");
      return snapshot;
    });
  }
  drain(): Promise<void> {
    this.flush();
    return this.tail;
  }
}
