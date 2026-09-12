import type { PanelProcessOwner } from "./process-service.js";

export const processLimits = Object.freeze({
  maxArguments: 256,
  maxArgumentLength: 8_192,
  maxArgumentBytes: 64 * 1024,
  maxConcurrentProcesses: 3,
  maxFileArguments: 8,
  maxEventChars: 16_384,
  maxOutputBytes: 4 * 1024 * 1024,
  maxLifetimeMs: 24 * 60 * 60 * 1_000,
  receiptTtlMs: 5 * 60 * 1_000,
  maxRetainedProcesses: 128,
  maxRetainedProcessesPerGuest: 32,
  maxEventsPerProcess: 256,
  maxRetainedOutputBytes: 256 * 1024,
  maxStdinChunkBytes: 16 * 1024,
  maxStdinBytes: 2 * 1024 * 1024 + 8 * 1024,
  maxStdinPendingBytes: 64 * 1024,
  maxStdinPendingWrites: 4,
  stdinWriteTimeoutMs: 10_000,
  maxEntryBytes: 16 * 1024 * 1024,
  maxEntryHandlesPerGuest: 64,
});

export type ProcessEvent = "process.output" | "process.exit";
export interface PanelProcessEvent {
  event: ProcessEvent;
  sequence: number;
  payload: Record<string, unknown>;
}
export interface ProcessRecord {
  owner: Pick<PanelProcessOwner, "guestId" | "appId" | "revision">;
  processId: string;
  status: "running" | "stopping" | "exited";
  startedAt: number;
  exitedAt?: number;
  expiresAt?: number;
  code?: number | null;
  signal?: string | null;
  cancelRequested: boolean;
  sequence: number;
  events: PanelProcessEvent[];
  eventBytes: number;
}

export function sameProcessOwner(
  a: Pick<PanelProcessOwner, "guestId" | "appId" | "revision">,
  b: Pick<PanelProcessOwner, "guestId" | "appId" | "revision">,
): boolean {
  return a.guestId === b.guestId && a.appId === b.appId && a.revision === b.revision;
}

/** Only terminal receipts are retained here; live process admission has its own limit. */
export class ProcessReceipts {
  private readonly records = new Map<string, ProcessRecord>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly now: () => number = Date.now) {}

  get(id: string): ProcessRecord | undefined {
    this.prune();
    return this.records.get(id);
  }

  add(record: ProcessRecord): void {
    this.prune();
    record.expiresAt = this.now() + processLimits.receiptTtlMs;
    this.records.set(record.processId, record);
    const owned = [...this.records.values()].filter(
      (item) => item.owner.guestId === record.owner.guestId,
    );
    while (owned.length > processLimits.maxRetainedProcessesPerGuest)
      this.records.delete(owned.shift()!.processId);
    while (this.records.size > processLimits.maxRetainedProcesses)
      this.records.delete(this.records.keys().next().value!);
    this.arm();
  }

  revokeGuest(guestId: number): void {
    for (const [id, record] of this.records)
      if (record.owner.guestId === guestId) this.records.delete(id);
    this.arm();
  }

  close(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.records.clear();
  }

  private prune(): void {
    for (const [id, record] of this.records)
      if (record.expiresAt! <= this.now()) this.records.delete(id);
  }

  private arm(): void {
    clearTimeout(this.timer);
    const first = this.records.values().next().value;
    if (!first) return;
    this.timer = setTimeout(
      () => {
        this.prune();
        this.arm();
      },
      Math.max(1, first.expiresAt! - this.now()),
    );
    this.timer.unref();
  }
}

export function appendProcessEvent(
  record: ProcessRecord,
  event: ProcessEvent,
  payload: Record<string, unknown>,
): PanelProcessEvent {
  const sequence = ++record.sequence;
  const item = { event, sequence, payload: { ...payload, sequence } };
  record.events.push(item);
  record.eventBytes += Buffer.byteLength(JSON.stringify(item));
  while (
    record.events.length > processLimits.maxEventsPerProcess ||
    record.eventBytes > processLimits.maxRetainedOutputBytes
  ) {
    record.eventBytes -= Buffer.byteLength(JSON.stringify(record.events.shift()!));
  }
  return item;
}
