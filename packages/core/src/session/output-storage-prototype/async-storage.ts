/** Non-activated marker-only async storage. No production producer authority is granted. */
import {
  AsyncFixtureCustody,
  assertAsyncJournalSnapshot,
  closeAsyncFile,
  openAsyncJournal,
  readAsyncStateUnderLease,
  snapshotAsyncJournal,
  createWriterFacts,
  readWriterFacts,
  type AsyncLeaseOptions,
} from "./async-io.js";
import { AsyncJournalReader } from "./async-journal.js";
import { encodeState, EVENT_ID, HEX, StorageFailure, type RawObject } from "./codec.js";
import { AsyncIdentityIndex, IdentityPool } from "./id-index.js";
import type { Scope, VerifiedJournal } from "./journal.js";
import {
  captureWriterRequest,
  executeWriterMutation,
  onlyCancellation,
  prepareWriterMutation,
  WriterCancellation,
  WriterFailure,
  type PreparedMutation,
  type WriterRequest,
} from "./async-writer.js";
import type { Receipt } from "./storage.js";
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
  transition(options: AsyncLeaseOptions = {}): Promise<string> {
    return this.write({ kind: "transition" }, options) as Promise<string>;
  }
  append(
    eventId: string,
    scope: Scope,
    event: RawObject,
    options: AsyncLeaseOptions = {},
  ): Promise<Receipt> {
    try {
      return this.write(
        captureWriterRequest("append", eventId, scope, event),
        options,
      ) as Promise<Receipt>;
    } catch (cause) {
      return Promise.reject(cause);
    }
  }
  control(
    eventId: string,
    scope: Scope,
    goal: unknown,
    event: RawObject | null,
    expectedRevision: number,
    options: AsyncLeaseOptions = {},
  ): Promise<Receipt> {
    try {
      return this.write(
        captureWriterRequest("control", eventId, scope, event, goal, expectedRevision),
        options,
      ) as Promise<Receipt>;
    } catch (cause) {
      return Promise.reject(cause);
    }
  }
  private write(request: WriterRequest, options: AsyncLeaseOptions): Promise<string | Receipt> {
    if (this.closing) return Promise.reject(new Error("Async fixture storage disposed"));
    if (this.current)
      return Promise.reject(
        new StorageFailure("busy", "Async fixture storage operation in progress"),
      );
    const signal = options.signal;
    const facts = createWriterFacts();
    let prepared: PreparedMutation | undefined;
    const work = Promise.resolve().then(async () => {
      try {
        const settlement = await this.custody.withLeaseSettled(
          async (lease) => {
            const file = await openAsyncJournal(lease, true);
            const snapshot = await snapshotAsyncJournal(lease, file);
            const reader = new AsyncJournalReader(lease, file, snapshot);
            const state = await readAsyncStateUnderLease(lease);
            let proof: VerifiedJournal;
            if (this.verified && this.index.isAuthenticated(snapshot.stamp)) {
              await reader.state(state, this.verified);
              proof = this.verified;
            } else {
              this.index.reset();
              proof = await reader.verify(state, this.index);
              this.index.authenticate(snapshot.stamp);
            }
            prepared = await prepareWriterMutation(
              lease,
              reader,
              state,
              proof,
              this.index,
              request,
            );
            if (encodeState(await readAsyncStateUnderLease(lease)) !== encodeState(state))
              throw new StorageFailure("incomplete", "State changed during writer preparation");
            await assertAsyncJournalSnapshot(lease, file, snapshot);
            await executeWriterMutation(lease, file, prepared, facts);
            // Native custody owns and closes this descriptor, also when cancellation interrupted a stage.
            return prepared.receipt;
          },
          { signal },
        );
        const actual = readWriterFacts(facts);
        const causes = [...settlement.failures, ...settlement.cleanupFailures];
        if (signal?.aborted && !causes.length)
          causes.push(new DOMException("Writer cancelled after cleanup", "AbortError"));
        if (causes.length) {
          if (onlyCancellation(causes) && settlement.cleanupOk) {
            const committed =
              !!actual.bound &&
              !!prepared?.finalStage &&
              actual.completed.includes(prepared.finalStage);
            throw new WriterCancellation(
              committed
                ? "committed"
                : !actual.journalSubmitted && !actual.tempSubmitted
                  ? "zero_effects"
                  : "incomplete_or_unknown",
              combineFailures(causes),
              committed ? prepared!.receipt : undefined,
            );
          }
          if (
            settlement.cleanupOk &&
            !actual.journalSubmitted &&
            !actual.tempSubmitted &&
            settlement.failures.length === 1 &&
            settlement.failures[0] instanceof StorageFailure
          )
            throw settlement.failures[0];
          throw new WriterFailure(causes);
        }
        if (!settlement.cleanupOk || !prepared) throw new WriterFailure(settlement.cleanupFailures);
        const proof = prepared.finalStage ? actual.bound : prepared.proof;
        if (!proof) throw new WriterFailure([new Error("Final writer bindings not proven")]);
        if (prepared.delta) this.index.publishPrepared(prepared.delta, proof.fileStamp);
        else this.index.authenticate(proof.fileStamp);
        this.verified = proof;
        return prepared.receipt;
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
