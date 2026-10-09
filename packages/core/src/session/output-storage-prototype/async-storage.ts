/** Non-activated marker-only async read storage. No write or producer activation entry exists. */
import {
  AsyncFixtureCustody,
  assertAsyncJournalSnapshot,
  closeAsyncFile,
  openAsyncJournal,
  readAsyncStateUnderLease,
  snapshotAsyncJournal,
  type AsyncLeaseOptions,
} from "./async-io.js";
import { AsyncJournalReader } from "./async-journal.js";
import { EVENT_ID, HEX, StorageFailure } from "./codec.js";
import { AsyncIdentityIndex, IdentityPool } from "./id-index.js";
import type { VerifiedJournal } from "./journal.js";
import { combineFailures, type FixtureIOHooks } from "./lease-fs.js";
import { claimAsyncFixtureReader } from "./path-mode.js";

export class AsyncFixtureStorage {
  private verified?: VerifiedJournal;
  private current?: Promise<unknown>;
  private closing = false;
  private disposal?: Promise<void>;
  private constructor(
    private readonly custody: AsyncFixtureCustody,
    private readonly index: AsyncIdentityIndex,
    private readonly releaseMode: () => void,
  ) {}

  static async create(
    root: string,
    sessionId: string,
    pool: IdentityPool,
    hooks: FixtureIOHooks = {},
  ): Promise<AsyncFixtureStorage> {
    const custody = await AsyncFixtureCustody.create(root, sessionId, hooks);
    const releaseMode = claimAsyncFixtureReader(custody.target);
    try {
      return new AsyncFixtureStorage(custody, new AsyncIdentityIndex(pool), releaseMode);
    } catch (cause) {
      const failures = [cause];
      try {
        await custody.dispose();
      } catch (cleanup) {
        failures.push(cleanup);
      }
      if (failures.length === 1) {
        try {
          custody.assertHealthy();
          releaseMode();
        } catch {
          /* Retain the path fence after compromise. */
        }
      }
      throw combineFailures(failures);
    }
  }
  private run<T>(
    options: AsyncLeaseOptions,
    operation: (reader: AsyncJournalReader, proof: VerifiedJournal) => Promise<T>,
  ): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Async fixture storage disposed"));
    if (this.current)
      return Promise.reject(
        new StorageFailure("busy", "Async fixture storage operation in progress"),
      );
    const signal = options.signal;
    // Defer every hook/operation until the admission slot is installed.
    const work = Promise.resolve().then(async () => {
      let candidate: VerifiedJournal | undefined;
      try {
        const result = await this.custody.withLease(
          async (lease) => {
            const file = await openAsyncJournal(lease);
            const snapshot = await snapshotAsyncJournal(lease, file);
            const reader = new AsyncJournalReader(lease, file, snapshot);
            const state = await readAsyncStateUnderLease(lease);
            if (this.verified && this.index.isAuthenticated(snapshot.stamp)) {
              await reader.state(state, this.verified); // Includes the legacy current pin, too.
              candidate = this.verified;
            } else {
              this.index.reset();
              candidate = await reader.verify(state, this.index);
              // This private candidate is usable only by this still-admitted operation. Any outer
              // close/heartbeat/release failure invalidates it; public proof is published below.
              this.index.authenticate(snapshot.stamp);
            }
            const value = await operation(reader, candidate);
            await reader.state(await readAsyncStateUnderLease(lease), candidate);
            await assertAsyncJournalSnapshot(lease, file, snapshot);
            await closeAsyncFile(lease, file);
            return value;
          },
          { signal },
        );
        // Includes actual descriptor close, heartbeat descendant drain and release settlement.
        this.verified = candidate;
        return result;
      } catch (cause) {
        this.verified = undefined;
        this.index.invalidate();
        throw cause;
      }
    });
    this.current = work;
    void work
      .finally(() => {
        if (this.current === work) this.current = undefined;
      })
      .catch(() => {});
    return work;
  }
  inspect(options: AsyncLeaseOptions = {}): Promise<VerifiedJournal> {
    return this.run(options, async (_reader, proof) => structuredClone(proof));
  }
  /** Exact full-history identity lookup, including a fresh authenticated receipt boundary read. */
  lookup(
    eventId: string,
    projection: string,
    options: AsyncLeaseOptions = {},
  ): Promise<{ cursor: string; replayed: true } | undefined> {
    if (
      typeof eventId !== "string" ||
      !EVENT_ID.test(eventId) ||
      typeof projection !== "string" ||
      !HEX.test(projection)
    )
      return Promise.reject(new StorageFailure("incomplete", "Invalid identity lookup"));
    return this.run(options, async (reader, proof) => {
      const receipt = await this.index.lookup(eventId, projection, proof.fileStamp, (offset) =>
        reader.binding(offset),
      );
      return receipt
        ? { cursor: await reader.receipt(proof.identity, receipt), replayed: true as const }
        : undefined;
    });
  }
  dispose(): Promise<void> {
    this.closing = true;
    this.disposal ??= (async () => {
      if (this.current) await this.current.catch(() => {});
      this.verified = undefined;
      this.index.invalidate();
      const failures: unknown[] = [];
      try {
        await this.custody.dispose();
      } catch (cause) {
        failures.push(cause);
      }
      // Never return arena backing while a binding read or custody cleanup remains in flight.
      try {
        await this.index.dispose();
      } catch (cause) {
        failures.push(cause);
      }
      if (!failures.length) {
        try {
          this.custody.assertHealthy();
          this.releaseMode();
        } catch {
          /* Settled cleanup does not clear an observed path compromise. */
        }
      }
      if (failures.length) throw combineFailures(failures);
    })();
    return this.disposal;
  }
}
