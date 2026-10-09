/** Complete verified-history index. No LRU miss is ever treated as proof of absence. */
import { createHash } from "node:crypto";
import { HEX, StorageFailure } from "./codec.js";

export const MAX_IDENTITIES = 262_144;
export const INDEX_SLOTS = 524_288;
export const INDEX_BYTES = INDEX_SLOTS * (32 + 32 + 8 + 8 + 8 + 1);
export const POOL_BYTES = 96 * 1024 * 1024;
const MAX_PROBES = 64;
const MAX_HASH_MATCHES = 4;
export type IndexReceipt = { sequence: number; offset: number; bindingOffset: number };
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

export class CompleteIdentityIndex {
  private keys: Uint8Array;
  private projections: Uint8Array;
  private sequences: Float64Array;
  private offsets: Float64Array;
  private bindingOffsets: Float64Array;
  private occupied: Uint8Array;
  private readonly release: () => void;
  private disposed = false;
  private size = 0;
  private authenticatedStamp?: string;

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
  private assertOpen() {
    if (this.disposed) throw new StorageFailure("incomplete", "Disposed identity proof");
  }
  private locate(eventId: string, readBinding: (offset: number) => string) {
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
      if (readBinding(this.bindingOffsets[slot]) === eventId) return { slot, hash, found: true };
    }
    throw new StorageFailure("capacity", "Identity probe bound");
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
    if (typeof projection !== "string" || !HEX.test(projection))
      throw new StorageFailure("incomplete", "Invalid projection digest");
    const { slot, hash, found } = this.locate(eventId, readBinding);
    if (found) throw new StorageFailure("incomplete", "Duplicate committed event id in history");
    if (this.size >= MAX_IDENTITIES)
      throw new StorageFailure("capacity", "Complete identity capacity exhausted");
    this.keys.set(hash, slot * 32);
    this.projections.set(Buffer.from(projection, "hex"), slot * 32);
    this.sequences[slot] = receipt.sequence;
    this.offsets[slot] = receipt.offset;
    this.bindingOffsets[slot] = receipt.bindingOffset;
    this.occupied[slot] = 1;
    this.size++;
  }
}
