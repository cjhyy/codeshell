import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalJson } from "./contracts/canonical-json.js";
import {
  ExperimentStore,
  readBoundedFile,
  writeAtomicFile,
  LeaseRecordSchema,
  type LeaseFence,
  type LeaseRecord,
} from "./store.js";

export interface LeaseOptions {
  owner?: string;
  ttlMs?: number;
  now?: () => number;
}
/** Persistent single writer identity; the short file lock never spans async work. */
export class ExperimentLease {
  readonly owner: string;
  readonly ttlMs: number;
  private readonly now: () => number;
  constructor(
    readonly store: ExperimentStore,
    options: LeaseOptions = {},
  ) {
    this.owner = options.owner ?? randomUUID();
    this.ttlMs = options.ttlMs ?? 15000;
    this.now = options.now ?? Date.now;
    if (
      !this.owner ||
      this.owner.length > 128 ||
      !Number.isSafeInteger(this.ttlMs) ||
      this.ttlMs < 100 ||
      this.ttlMs > 60000
    )
      throw new Error("optimization_lab: invalid lease options");
  }
  acquire(id: string): LeaseFence {
    return this.store.withLock(id, (directory) => {
      const now = this.now();
      const text = readBoundedFile(join(directory, "lease.json"));
      const previous = text === undefined ? null : LeaseRecordSchema.parse(JSON.parse(text));
      if (previous && previous.expiresAt > now)
        throw new Error("optimization_lab: experiment already has a live owner");
      const lease: LeaseRecord = {
        owner: this.owner,
        generation: (previous?.generation ?? 0) + 1,
        heartbeatAt: now,
        expiresAt: now + this.ttlMs,
      };
      LeaseRecordSchema.parse(lease);
      writeAtomicFile(join(directory, "lease.json"), canonicalJson(lease));
      return { owner: lease.owner, generation: lease.generation };
    });
  }
  heartbeat(id: string, fence: LeaseFence): LeaseRecord {
    return this.store.withLock(id, (directory) => {
      const now = this.now();
      const previous = this.store.assertFenceUnlocked(directory, fence, now);
      const lease = { ...previous, heartbeatAt: now, expiresAt: now + this.ttlMs };
      LeaseRecordSchema.parse(lease);
      writeAtomicFile(join(directory, "lease.json"), canonicalJson(lease));
      return lease;
    });
  }
  release(id: string, fence: LeaseFence): void {
    this.store.withLock(id, (directory) => {
      const now = this.now();
      const previous = this.store.assertFenceUnlocked(directory, fence, now);
      // Keep the generation forever, including after clean release.
      writeAtomicFile(
        join(directory, "lease.json"),
        canonicalJson({ ...previous, expiresAt: now }),
      );
    });
  }
}
