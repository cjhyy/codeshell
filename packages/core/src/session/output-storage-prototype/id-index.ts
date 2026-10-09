/** Complete verified-history index. No LRU miss is ever treated as proof of absence. */
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { EVENT_ID, HEX, StorageFailure } from "./codec.js";

export const MAX_IDENTITIES = 262_144;
export const INDEX_SLOTS = 524_288;
export const INDEX_BYTES = INDEX_SLOTS * (32 + 32 + 8 + 8 + 8 + 1);
export const POOL_BYTES = 96 * 1024 * 1024;
const MAX_PROBES = 64;
const MAX_HASH_MATCHES = 4;
export type IndexReceipt = { sequence: number; offset: number; bindingOffset: number };
export type PreparedIndexInsert = Readonly<{ kind: "prepared-index-insert" }>;
type Arena = {
  keys: Uint8Array;
  projections: Uint8Array;
  sequences: Float64Array;
  offsets: Float64Array;
  bindingOffsets: Float64Array;
  occupied: Uint8Array;
  busy: boolean;
};

const processArenas: Arena[] = [];
export class IdentityPool {
  // Own the two backing arenas permanently; eviction cannot allocate a third
  // array set while detached indexes await the garbage collector.
  private readonly arenas = processArenas;
  acquire(): { arena: Arena; release: () => void } {
    let arena = this.arenas.find((candidate) => !candidate.busy);
    if (!arena) {
      if ((this.arenas.length + 1) * INDEX_BYTES > POOL_BYTES)
        throw new StorageFailure("capacity", "Identity pool exhausted");
      arena = {
        keys: new Uint8Array(INDEX_SLOTS * 32),
        projections: new Uint8Array(INDEX_SLOTS * 32),
        sequences: new Float64Array(INDEX_SLOTS),
        offsets: new Float64Array(INDEX_SLOTS),
        bindingOffsets: new Float64Array(INDEX_SLOTS),
        occupied: new Uint8Array(INDEX_SLOTS),
        busy: false,
      };
      this.arenas.push(arena);
    }
    arena.occupied.fill(0);
    arena.busy = true;
    let released = false;
    return {
      arena,
      release: () => {
        if (!released) {
          released = true;
          arena.busy = false;
        }
      },
    };
  }
  get bytes(): number {
    return this.arenas.filter((arena) => arena.busy).length * INDEX_BYTES;
  }
  get backingBytes(): number {
    return this.arenas.length * INDEX_BYTES;
  }
  get arenaCount(): number {
    return this.arenas.length;
  }
}

class IdentityTable {
  protected keys: Uint8Array;
  protected projections: Uint8Array;
  protected sequences: Float64Array;
  protected offsets: Float64Array;
  protected bindingOffsets: Float64Array;
  protected occupied: Uint8Array;
  private readonly release: () => void;
  protected disposed = false;
  protected size = 0;
  protected authenticatedStamp?: string;

  constructor(pool: IdentityPool) {
    const { arena, release } = pool.acquire();
    this.release = release;
    this.keys = arena.keys;
    this.projections = arena.projections;
    this.sequences = arena.sequences;
    this.offsets = arena.offsets;
    this.bindingOffsets = arena.bindingOffsets;
    this.occupied = arena.occupied;
  }
  authenticate(stamp: string) {
    this.assertOpen();
    this.authenticatedStamp = stamp;
  }
  reset() {
    this.assertOpen();
    this.occupied.fill(0);
    this.size = 0;
    this.invalidate();
  }
  invalidate() {
    this.authenticatedStamp = undefined;
  }
  isAuthenticated(stamp: string): boolean {
    return !this.disposed && this.authenticatedStamp === stamp;
  }
  get count(): number {
    return this.size;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
    this.keys = new Uint8Array(0);
    this.projections = new Uint8Array(0);
    this.sequences = new Float64Array(0);
    this.offsets = new Float64Array(0);
    this.bindingOffsets = new Float64Array(0);
    this.occupied = new Uint8Array(0);
    this.release();
  }
  protected assertOpen() {
    if (this.disposed) throw new StorageFailure("incomplete", "Disposed identity proof");
  }
  protected *locateSteps(
    eventId: string,
  ): Generator<number, { slot: number; hash: Buffer; found: boolean }, string> {
    this.assertOpen();
    const hash = createHash("sha256").update(eventId).digest();
    const start = hash.readUInt32LE(0) & (INDEX_SLOTS - 1);
    let matches = 0;
    for (let probe = 0; probe < MAX_PROBES; probe++) {
      const slot = (start + probe) & (INDEX_SLOTS - 1);
      if (!this.occupied[slot]) return { slot, hash, found: false };
      let equal = true;
      for (let i = 0; i < 32; i++)
        if (this.keys[slot * 32 + i] !== hash[i]) {
          equal = false;
          break;
        }
      if (!equal) continue;
      if (++matches > MAX_HASH_MATCHES)
        throw new StorageFailure("capacity", "Identity hash collision bound");
      if ((yield this.bindingOffsets[slot]) === eventId) return { slot, hash, found: true };
    }
    throw new StorageFailure("capacity", "Identity probe bound");
  }
  protected insert(
    _eventId: string,
    projection: string,
    receipt: IndexReceipt,
    located: { slot: number; hash: Buffer; found: boolean },
  ) {
    if (typeof projection !== "string" || !HEX.test(projection))
      throw new StorageFailure("incomplete", "Invalid projection digest");
    if (located.found)
      throw new StorageFailure("incomplete", "Duplicate committed event id in history");
    if (this.size >= MAX_IDENTITIES)
      throw new StorageFailure("capacity", "Complete identity capacity exhausted");
    const { slot, hash } = located;
    this.keys.set(hash, slot * 32);
    this.projections.set(Buffer.from(projection, "hex"), slot * 32);
    this.sequences[slot] = receipt.sequence;
    this.offsets[slot] = receipt.offset;
    this.bindingOffsets[slot] = receipt.bindingOffset;
    this.occupied[slot] = 1;
    this.size++;
  }
  protected receipt(slot: number, projection: string): IndexReceipt {
    const expected = Buffer.from(this.projections.subarray(slot * 32, slot * 32 + 32)).toString(
      "hex",
    );
    if (expected !== projection)
      throw new StorageFailure("conflict", "Same event id has different projection");
    return {
      sequence: this.sequences[slot],
      offset: this.offsets[slot],
      bindingOffset: this.bindingOffsets[slot],
    };
  }
}

export class CompleteIdentityIndex extends IdentityTable {
  private locate(eventId: string, readBinding: (offset: number) => string) {
    const steps = this.locateSteps(eventId);
    let next = steps.next();
    while (!next.done) next = steps.next(readBinding(next.value));
    return next.value;
  }
  lookup(
    eventId: string,
    projection: string,
    stamp: string,
    readBinding: (offset: number) => string,
  ): IndexReceipt | undefined {
    if (!this.isAuthenticated(stamp))
      throw new StorageFailure("incomplete", "Whole-history identity proof requires rebuild");
    const { slot, found } = this.locate(eventId, readBinding);
    if (!found) return undefined;
    return this.receipt(slot, projection);
  }

  assertInsertable(eventId: string, readBinding: (offset: number) => string) {
    const { found } = this.locate(eventId, readBinding);
    if (found) throw new StorageFailure("incomplete", "Duplicate committed event id in history");
    if (this.size >= MAX_IDENTITIES)
      throw new StorageFailure("capacity", "Complete identity capacity exhausted");
  }
  addVerified(
    eventId: string,
    projection: string,
    receipt: IndexReceipt,
    readBinding: (offset: number) => string,
  ) {
    this.insert(eventId, projection, receipt, this.locate(eventId, readBinding));
  }
}

/** One awaited binding lookup owns its arena until every actual read and cleanup has settled. */
export class AsyncIdentityIndex extends IdentityTable {
  private current?: Promise<unknown>;
  private closing = false;
  private disposal?: Promise<void>;
  private generation = 0;
  private readonly prepared = new WeakMap<
    PreparedIndexInsert,
    {
      generation: number;
      size: number;
      eventId: string;
      projection: string;
      projectionBytes: Buffer;
      receipt: IndexReceipt;
      located: { slot: number; hash: Buffer; found: boolean };
    }
  >();

  prepareInsert(
    eventId: string,
    projection: string,
    receipt: IndexReceipt,
    reader: (offset: number) => Promise<string>,
  ): Promise<PreparedIndexInsert> {
    if (typeof projection !== "string" || !HEX.test(projection))
      return Promise.reject(new StorageFailure("incomplete", "Invalid projection digest"));
    // Use the same descriptor-only capture as addVerified, without inserting into the arena.
    let owned: IndexReceipt;
    try {
      owned = this.captureReceipt(receipt);
    } catch (cause) {
      return Promise.reject(cause);
    }
    return this.operation(eventId, reader, (located) => {
      if (located.found) throw new StorageFailure("incomplete", "Duplicate committed event id");
      if (this.size >= MAX_IDENTITIES)
        throw new StorageFailure("capacity", "Complete identity capacity exhausted");
      const token = Object.freeze({ kind: "prepared-index-insert" as const });
      this.prepared.set(token, {
        generation: this.generation,
        size: this.size,
        eventId,
        projection,
        projectionBytes: Buffer.from(projection, "hex"),
        receipt: owned,
        located: { ...located, hash: Buffer.from(located.hash) },
      });
      return token;
    });
  }
  /** No allocation, capacity search or binding read remains after custody cleanup. */
  publishPrepared(token: PreparedIndexInsert, stamp: string): void {
    const delta = this.prepared.get(token);
    if (
      !delta ||
      this.current ||
      this.closing ||
      this.disposed ||
      delta.generation !== this.generation ||
      delta.size !== this.size ||
      this.occupied[delta.located.slot]
    )
      throw new StorageFailure("incomplete", "Prepared identity lifetime changed");
    this.prepared.delete(token);
    // Every deterministic input/capacity validation was completed by prepareInsert.
    const { slot, hash } = delta.located;
    this.keys.set(hash, slot * 32);
    this.projections.set(delta.projectionBytes, slot * 32);
    this.sequences[slot] = delta.receipt.sequence;
    this.offsets[slot] = delta.receipt.offset;
    this.bindingOffsets[slot] = delta.receipt.bindingOffset;
    this.occupied[slot] = 1;
    this.size++;
    super.authenticate(stamp);
    this.generation++;
  }

  override reset(): void {
    if (this.current || this.closing)
      throw new StorageFailure("busy", "Index operation in progress/closing");
    super.reset();
    this.generation++;
  }
  override authenticate(stamp: string): void {
    if (this.current || this.closing)
      throw new StorageFailure("busy", "Index operation in progress/closing");
    super.authenticate(stamp);
    this.generation++;
  }
  override invalidate(): void {
    super.invalidate();
    this.generation++;
  }
  override dispose(): Promise<void> {
    this.closing = true;
    this.disposal ??= (async () => {
      if (this.current) await this.current.catch(() => {});
      super.dispose();
    })();
    return this.disposal;
  }
  private operation<T>(
    eventId: string,
    reader: (offset: number) => Promise<string>,
    action: (located: { slot: number; hash: Buffer; found: boolean }) => T,
  ): Promise<T> {
    if (this.closing || this.disposed)
      return Promise.reject(new StorageFailure("incomplete", "Disposed identity proof"));
    if (this.current)
      return Promise.reject(new StorageFailure("busy", "Index operation in progress"));
    if (typeof eventId !== "string" || !EVENT_ID.test(eventId) || typeof reader !== "function")
      return Promise.reject(new StorageFailure("incomplete", "Invalid identity lookup"));
    const generation = this.generation;
    const work = Promise.resolve().then(async () => {
      const steps = this.locateSteps(eventId);
      try {
        let next = steps.next();
        while (!next.done) {
          const binding = await reader(next.value);
          this.assertOpen();
          if (this.closing || generation !== this.generation)
            throw new StorageFailure("incomplete", "Index lifetime changed during binding read");
          if (typeof binding !== "string" || !EVENT_ID.test(binding))
            throw new StorageFailure("incomplete", "Invalid indexed identity binding");
          next = steps.next(binding);
        }
        this.assertOpen();
        if (this.closing || generation !== this.generation)
          throw new StorageFailure("incomplete", "Index lifetime changed before result");
        return action(next.value);
      } catch (cause) {
        this.invalidate();
        throw cause;
      } finally {
        steps.return(undefined as never);
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
  lookup(
    eventId: string,
    projection: string,
    stamp: string,
    reader: (offset: number) => Promise<string>,
  ): Promise<IndexReceipt | undefined> {
    if (!this.isAuthenticated(stamp))
      return Promise.reject(
        new StorageFailure("incomplete", "Whole-history identity proof requires rebuild"),
      );
    if (typeof projection !== "string" || !HEX.test(projection))
      return Promise.reject(new StorageFailure("incomplete", "Invalid projection digest"));
    return this.operation(eventId, reader, ({ slot, found }) =>
      found ? this.receipt(slot, projection) : undefined,
    );
  }
  addVerified(
    eventId: string,
    projection: string,
    receipt: IndexReceipt,
    reader: (offset: number) => Promise<string>,
  ): Promise<void> {
    let owned: IndexReceipt;
    try {
      owned = this.captureReceipt(receipt);
    } catch (cause) {
      return Promise.reject(cause);
    }
    return this.operation(eventId, reader, (located) => {
      this.insert(eventId, projection, owned, located);
    });
  }
  private captureReceipt(receipt: IndexReceipt): IndexReceipt {
    // Own the receipt before any reader can await or mutate caller data.
    if (
      utilTypes.isProxy(receipt) ||
      receipt === null ||
      typeof receipt !== "object" ||
      Object.getOwnPropertySymbols(receipt).length
    )
      throw new StorageFailure("incomplete", "Owned identity receipt required");
    const descriptors = Object.getOwnPropertyDescriptors(receipt);
    if (
      Object.keys(descriptors).length !== 3 ||
      ["sequence", "offset", "bindingOffset"].some(
        (key) =>
          !descriptors[key] ||
          !("value" in descriptors[key]) ||
          !Number.isSafeInteger(descriptors[key].value) ||
          descriptors[key].value < 0,
      )
    )
      throw new StorageFailure("incomplete", "Owned identity receipt required");
    return {
      sequence: descriptors.sequence.value as number,
      offset: descriptors.offset.value as number,
      bindingOffset: descriptors.bindingOffset.value as number,
    };
  }
}
