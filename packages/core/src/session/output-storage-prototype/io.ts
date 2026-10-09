/** Explicit private-fixture custody. No production caller or package export uses this module. */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { lockSync } from "../../utils/lockfile.js";
import { decodeStateBytes, encodeState, fail, StorageFailure, type DecodedState } from "./codec.js";

export const LOCK_STALE_MS = 10_000;
export const LOCK_RETRY_MS = [5, 10, 20, 40] as const;
export const JOURNAL_LIMIT = 128 * 1024 * 1024;
export const RECORD_LIMIT = 256 * 1024;
export const EVENT_LIMIT = 16 * 1024 * 1024;
export const CHUNK_SIZE = 64 * 1024;
const MARKER = ".codeshell-output-storage-fixture";
const MAGIC = "non-activated-producer-output-storage-prototype-v1\n";
const activeTokens = new WeakSet<object>();

export type Lease = Readonly<{ root: string; sessionId: string; directory: string }>;
function regular(path: string, flags: number): number {
  const fd = openSync(
    path,
    flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    0o600,
  );
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    fail("Expected regular fixture file");
  }
  return fd;
}
function privateTestHome(): string {
  const home = process.env.CODE_SHELL_TEST_HOME;
  if (process.env.NODE_ENV !== "test" || !home || !isAbsolute(home))
    fail("Guarded private fixture environment required");
  return realpathSync(home);
}
export function createFixtureRoot(): string {
  const root = mkdtempSync(join(privateTestHome(), "producer-output-prototype-"));
  writeFileSync(join(root, MARKER), MAGIC, { mode: 0o600, flag: "wx" });
  return root;
}
function fixtureRoot(root: string): string {
  const canonical = realpathSync(root);
  const path = relative(privateTestHome(), canonical);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    fail("Fixture root is outside private HOME");
  const fd = regular(join(canonical, MARKER), constants.O_RDONLY);
  try {
    if (fstatSync(fd).size !== Buffer.byteLength(MAGIC)) fail("Invalid opt-in fixture marker");
    const bytes = Buffer.alloc(Buffer.byteLength(MAGIC));
    if (
      readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length ||
      bytes.toString("utf8") !== MAGIC
    )
      fail("Invalid opt-in fixture marker");
  } finally {
    closeSync(fd);
  }
  return canonical;
}
export function stamp(fd: number): string {
  const stat = fstatSync(fd, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
export function openJournal(lease: Lease, writable = false): number {
  assertLease(lease);
  return regular(
    join(lease.directory, "output-journal.jsonl"),
    writable ? constants.O_RDWR : constants.O_RDONLY,
  );
}
export function assertJournalFile(lease: Lease, fd: number): void {
  const opened = fstatSync(fd);
  const named = lstatSync(join(lease.directory, "output-journal.jsonl"));
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.dev !== opened.dev ||
    named.ino !== opened.ino
  )
    fail("Journal file incarnation changed");
}
export function assertLease(lease: Lease): void {
  if (!activeTokens.has(lease))
    fail("Native fixture lease required; nested/outlived token refused");
}
export function readStateUnderLease(lease: Lease): DecodedState {
  assertLease(lease);
  const state = readStateFile(join(lease.directory, "state.json"));
  if (state.state.sessionId !== lease.sessionId) fail("Wrong fixture Session identity");
  return state;
}
function readStateFile(path: string): DecodedState {
  const fd = regular(path, constants.O_RDONLY);
  try {
    const opened = fstatSync(fd);
    const named = lstatSync(path);
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    )
      fail("State file incarnation changed");
    const before = stamp(fd);
    const size = fstatSync(fd).size;
    if (size > 1024 * 1024) throw new StorageFailure("capacity", "State byte bound");
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, bytes, offset, size - offset, offset);
      if (!n) fail("State read made no progress");
      offset += n;
    }
    const after = lstatSync(path);
    if (
      stamp(fd) !== before ||
      readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0 ||
      !after.isFile() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    )
      fail("State changed during read");
    return decodeStateBytes(bytes);
  } finally {
    closeSync(fd);
  }
}
export function writeAll(fd: number, bytes: Buffer, offset: number): void {
  let done = 0;
  while (done < bytes.length) {
    const n = writeSync(fd, bytes, done, bytes.length - done, offset + done);
    if (!n) fail("Storage write made no progress");
    done += n;
  }
}
export function writeStateUnderLease(
  lease: Lease,
  state: DecodedState,
  platform = process.platform,
): void {
  assertLease(lease);
  // Known unsupported platforms fail before even creating the exclusive temp file.
  if (platform === "win32")
    throw new StorageFailure("unsupported", "Prototype requires directory fsync support");
  const bytes = Buffer.from(encodeState(state));
  const temporary = join(lease.directory, `.prototype-state-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = regular(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    writeAll(fd, bytes, 0);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, join(lease.directory, "state.json"));
    const directory = openSync(lease.directory, constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* Preserve write/rename failure. */
    }
  }
}
export function appendUnderLease(lease: Lease, fd: number, bytes: Buffer, offset: number): void {
  assertLease(lease);
  assertJournalFile(lease, fd);
  if (fstatSync(fd).size !== offset) fail("Journal head changed before append");
  if (offset + bytes.length > JOURNAL_LIMIT)
    throw new StorageFailure("capacity", "Journal storage bound");
  writeAll(fd, bytes, offset);
  fsyncSync(fd);
  assertJournalFile(lease, fd);
}

/** Real existing state lock; callback cannot await or recursively acquire this custody. */
export class FixtureCustody {
  readonly root: string;
  readonly directory: string;
  private readonly dev: number;
  private readonly ino: number;
  private held = false;
  private readonly startedAt: number;

  constructor(
    root: string,
    readonly sessionId: string,
  ) {
    this.root = fixtureRoot(root);
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(sessionId) || sessionId.includes(".."))
      fail("Invalid fixture Session id");
    this.directory = join(this.root, sessionId);
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Existing fixture directory required");
    this.dev = stat.dev;
    this.ino = stat.ino;
    const state = readStateFile(join(this.directory, "state.json"));
    if (state.state.sessionId !== sessionId || state.state.ephemeral)
      fail("Persistent fixture Session required");
    this.startedAt = state.state.startedAt;
  }

  withLease<T>(operation: (lease: Lease) => T): T {
    if (this.held) fail("Nested storage lock acquisition refused");
    fixtureRoot(this.root);
    const target = join(this.directory, "state.json");
    let release: (() => void) | undefined;
    for (let attempt = 0; attempt <= LOCK_RETRY_MS.length; attempt++) {
      try {
        release = lockSync(target, {
          realpath: false,
          retries: 0,
          stale: LOCK_STALE_MS,
          update: LOCK_STALE_MS / 2,
        });
        break;
      } catch (error) {
        if (!["ELOCKED", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
        const delay = LOCK_RETRY_MS[attempt];
        if (delay === undefined)
          throw new StorageFailure("busy", "Original 75ms lock retry budget exhausted");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      }
    }
    if (!release) throw new StorageFailure("busy", "Fixture lock unavailable");
    const lease = Object.freeze({
      root: this.root,
      sessionId: this.sessionId,
      directory: this.directory,
    });
    activeTokens.add(lease);
    this.held = true;
    try {
      this.assertCurrent(lease);
      const result = operation(lease);
      if (result && typeof (result as { then?: unknown }).then === "function")
        fail("Async lock holder refused");
      this.assertCurrent(lease);
      return result;
    } finally {
      activeTokens.delete(lease);
      this.held = false;
      release(); // Compromised/reaped leases must not be swallowed.
    }
  }

  private assertCurrent(lease: Lease): void {
    const stat = lstatSync(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== this.dev ||
      stat.ino !== this.ino
    )
      fail("Fixture Session replaced/deleted");
    const current = readStateUnderLease(lease);
    if (current.state.startedAt !== this.startedAt || current.state.outputRecoveryIncomplete)
      fail("Fixture authority revoked/incomplete");
  }
}
