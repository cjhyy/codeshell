/** Non-activated async custody/I/O experiment. Only private opt-in fixture readers use it; no package export. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fsp from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { setImmediate as yieldTask, setTimeout as delay } from "node:timers/promises";
import { types as utilTypes } from "node:util";
import { lock } from "../../utils/lockfile.js";
import {
  decodeStateBytes,
  canonical,
  canonicalSteps,
  encodeState,
  EVENT_ID,
  HEX,
  fail,
  parseUnique,
  STATE_LIMIT,
  StorageFailure,
  type DecodedState,
  type Position,
  type RawObject,
} from "./codec.js";
import {
  encodeRecord,
  eventPayloadIterator,
  validateScope,
  verifyState,
  type Binding,
  type VerifiedJournal,
} from "./journal.js";
import {
  CHUNK_SIZE,
  EVENT_LIMIT,
  JOURNAL_LIMIT,
  LOCK_RETRY_MS,
  LOCK_STALE_MS,
  RECORD_LIMIT,
} from "./io.js";
import {
  assertPath,
  combineFailures,
  LeaseFs,
  poisonPath,
  releasePath,
  reservePath,
  type FixtureIOHooks,
} from "./lease-fs.js";

const MARKER = ".codeshell-output-storage-fixture";
const MAGIC = "non-activated-producer-output-storage-prototype-v1\n";
type Identity = { dev: number; ino: number };
type Context = {
  custody: AsyncFixtureCustody;
  admission: boolean;
  signal?: AbortSignal;
  pending: Set<Promise<unknown>>;
  files: Set<AsyncFile>;
  busy: boolean;
  ioFailures: unknown[];
  writerBinding?: { proof: VerifiedJournal; state: string; stateStamp: string };
};
const leases = new WeakMap<AsyncLease, Context>();
const snapshots = new WeakMap<AsyncJournalSnapshot, { context: Context; file: AsyncFile }>();
const files = new WeakMap<AsyncFile, { handle: FileHandle; owner: Context; closed: boolean }>();
export type AsyncLease = Readonly<{ root: string; directory: string; sessionId: string }>;
export type AsyncFile = Readonly<{ kind: "fixture-journal" }>;
export type AsyncLeaseOptions = { signal?: AbortSignal };
export type LeaseSettlement<T> = Readonly<{
  value?: T;
  failures: readonly unknown[];
  cleanupFailures: readonly unknown[];
  cleanupOk: boolean;
}>;

/** Capture before validating caller fields. This copies JSON; it does not grant producer authority. */
const ownedJSONLengths = new WeakMap<object, number>();
function assertCaptureArrays(value: unknown, depth = 0): void {
  if (depth > 128) fail("Canonical depth bound");
  if (utilTypes.isProxy(value)) fail("Proxy is not strict JSON");
  if (value === null || typeof value !== "object") return;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor)))
    fail("Accessor is not strict JSON");
  if (Array.isArray(value)) {
    const length = descriptors.length.value as number;
    if (
      Object.keys(descriptors).length !== length + 1 ||
      Object.keys(descriptors).some(
        (key) =>
          key !== "length" &&
          (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length || !descriptors[key].enumerable),
      )
    )
      fail("Sparse or decorated JSON array");
  }
  for (const descriptor of Object.values(descriptors))
    if (descriptor.enumerable) assertCaptureArrays(descriptor.value, depth + 1);
}
export function captureOwnedJSON<T>(value: T, limit = EVENT_LIMIT): T {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVENT_LIMIT)
    throw new StorageFailure("capacity", "Strict capture byte bound cannot exceed the event limit");
  if (typeof value === "object" && value !== null && ownedJSONLengths.has(value)) {
    if (ownedJSONLengths.get(value)! > limit)
      throw new StorageFailure("capacity", "Owned JSON byte bound");
    return value; // Only our recursively frozen copies carry this certificate.
  }
  // Caller arrays may hide own decoration from Object.keys; parsed disk JSON cannot have it.
  assertCaptureArrays(value);
  const text = canonical(value);
  const owned = parseUnique(text, limit);
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(owned);
  if (typeof owned === "object" && owned !== null)
    ownedJSONLengths.set(owned, Buffer.byteLength(text));
  return owned as T;
}

/** State permits optional undefined object fields, while every input read must be own data. */
function captureStateData(value: unknown, depth = 0): unknown {
  if (depth > 128) fail("State capture depth bound");
  if (utilTypes.isProxy(value)) fail("Proxy state input refused");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null) return fail("Non-JSON state capture value");
  if (Object.getOwnPropertySymbols(value).length) fail("Symbol state input refused");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor)))
    fail("Accessor state input refused");
  if (Array.isArray(value)) {
    const length = descriptors.length.value as number;
    if (
      Object.keys(descriptors).length !== length + 1 ||
      Object.keys(descriptors).some(
        (key) =>
          key !== "length" &&
          (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length || !descriptors[key].enumerable),
      )
    )
      fail("Sparse or decorated state array refused");
    return Array.from({ length }, (_, index) =>
      captureStateData(descriptors[String(index)].value, depth + 1),
    );
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    fail("Plain state data required");
  return Object.fromEntries(
    Object.entries(descriptors)
      .filter(([, descriptor]) => descriptor.enumerable && descriptor.value !== undefined)
      .map(([key, descriptor]) => [key, captureStateData(descriptor.value, depth + 1)]),
  );
}
export function captureOwnedGoal(value: unknown): unknown {
  if (value === undefined) return undefined;
  const owned = captureStateData(value);
  if (Buffer.byteLength(JSON.stringify(owned)) > STATE_LIMIT)
    throw new StorageFailure("capacity", "Goal state byte bound");
  return owned;
}

function captureStateWrapper(value: DecodedState): DecodedState {
  if (utilTypes.isProxy(value)) fail("Proxy state wrapper refused");
  if (
    value === null ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  )
    fail("Owned decoded state wrapper required");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor)))
    fail("Accessor state wrapper refused");
  if (
    !Object.hasOwn(descriptors, "state") ||
    Object.keys(descriptors).some((key) => !["state", "format", "control"].includes(key))
  )
    fail("Owned decoded state wrapper required");
  // Wrapper fields are API arguments, so an own data field keeps its value regardless of
  // enumerability. Nested Session metadata retains the codec's enumerable JSON semantics.
  return Object.fromEntries(
    Object.entries(descriptors)
      .filter(([, descriptor]) => descriptor.value !== undefined)
      .map(([key, descriptor]) => [key, captureStateData(descriptor.value)]),
  ) as DecodedState;
}

function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Fixture operation cancelled", "AbortError");
}
function identity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
type Resources = { hooks?: FixtureIOHooks; cleanup?: (cause: unknown) => void };
function resources(context: Context): Resources {
  return { hooks: context.custody.hooks, cleanup: (cause) => context.custody.recordCleanup(cause) };
}
async function closeHandle(handle: FileHandle, resource: Resources = {}): Promise<void> {
  const failures: unknown[] = [];
  try {
    const fault = resource.hooks?.faultBefore?.("file.close");
    if (fault) throw fault;
    await handle.close();
  } catch (cause) {
    failures.push(cause);
    resource.cleanup?.(cause);
    // Settle a real fallback close even when the injected/native close result was unknown.
    try {
      resource.hooks?.observe?.({ operation: "file.close.fallback", stage: "submit" });
      await handle.close();
      resource.hooks?.observe?.({ operation: "file.close.fallback", stage: "settle" });
    } catch (secondary) {
      failures.push(secondary);
      resource.cleanup?.(secondary);
    }
  }
  if (failures.length) throw combineFailures(failures);
}
async function regular(path: string, flags: number, resource: Resources = {}): Promise<FileHandle> {
  const handle = await fsp.open(
    path,
    flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    0o600,
  );
  try {
    if (!(await handle.stat()).isFile()) fail("Expected regular fixture file");
    return handle;
  } catch (cause) {
    const failures = [cause];
    try {
      await closeHandle(handle, resource);
    } catch (secondary) {
      failures.push(secondary);
    }
    throw combineFailures(failures);
  }
}
async function namedFile(path: string, handle: FileHandle): Promise<void> {
  // A failed sibling in Promise.all must not leave actual native I/O behind during unlock.
  const opened = await handle.stat();
  const named = await fsp.lstat(path);
  if (!named.isFile() || named.isSymbolicLink() || !identity(opened, named))
    fail("Fixture file incarnation changed");
}
async function stamp(handle: FileHandle): Promise<string> {
  const stat = await handle.stat({ bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
async function namedWriterStamp(path: string): Promise<string> {
  const stat = await fsp.lstat(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) fail("Final writer binding requires a regular file");
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
async function readBounded(path: string, limit: number, resource: Resources = {}): Promise<Buffer> {
  const handle = await regular(path, constants.O_RDONLY, resource);
  const failures: unknown[] = [];
  let bytes: Buffer | undefined;
  try {
    await namedFile(path, handle);
    const before = await stamp(handle);
    const size = (await handle.stat()).size;
    if (size > limit) throw new StorageFailure("capacity", "File byte bound");
    bytes = Buffer.alloc(size);
    for (let at = 0; at < size; ) {
      const { bytesRead } = await handle.read(bytes, at, Math.min(CHUNK_SIZE, size - at), at);
      if (!bytesRead) fail("Fixture read made no progress");
      at += bytesRead;
    }
    if (
      (await stamp(handle)) !== before ||
      (await handle.read(Buffer.alloc(1), 0, 1, size)).bytesRead !== 0
    )
      fail("Fixture file changed during read");
    await namedFile(path, handle);
  } catch (cause) {
    failures.push(cause);
  }
  try {
    await closeHandle(handle, resource);
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length) throw combineFailures(failures);
  return bytes!;
}
async function fixtureRoot(root: string): Promise<string> {
  const home = process.env.CODE_SHELL_TEST_HOME;
  if (process.env.NODE_ENV !== "test" || !home || !isAbsolute(home))
    fail("Guarded private fixture environment required");
  const canonical = await fsp.realpath(root);
  const privateHome = await fsp.realpath(home);
  const path = relative(privateHome, canonical);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    fail("Fixture root is outside private HOME");
  if (
    !(await readBounded(join(canonical, MARKER), Buffer.byteLength(MAGIC))).equals(
      Buffer.from(MAGIC),
    )
  )
    fail("Invalid opt-in fixture marker");
  return canonical;
}
export function assertAsyncLease(lease: AsyncLease, allowCancelled = false): Context {
  const context = leases.get(lease);
  if (!context?.admission) fail("Current native async fixture lease required");
  context.custody.assertHealthy();
  if (!allowCancelled) abort(context.signal);
  return context;
}
function fileFor(context: Context, file: AsyncFile): FileHandle {
  const stored = files.get(file);
  if (!stored || stored.owner !== context || stored.closed) fail("Owned async journal required");
  return stored.handle;
}
function submit<T>(
  lease: AsyncLease,
  operation: () => Promise<T>,
  allowCancelled = false,
): Promise<T> {
  const context = assertAsyncLease(lease, allowCancelled);
  if (context.busy) fail("Overlapping fixture I/O refused");
  context.busy = true;
  // Register before the microtask that can submit the first native operation.
  const work = Promise.resolve().then(() => {
    context.custody.assertHealthy();
    if (!allowCancelled) abort(context.signal);
    return operation();
  });
  context.pending.add(work);
  const result = work.then(
    (value) => {
      context.pending.delete(work);
      context.busy = false;
      context.custody.assertHealthy();
      if (!allowCancelled) abort(context.signal); // Wait for the actual durability group.
      return value;
    },
    (cause) => {
      context.pending.delete(work);
      context.busy = false;
      context.ioFailures.push(cause);
      if (!(cause instanceof DOMException && cause.name === "AbortError"))
        poisonPath(context.custody.target, cause as Error);
      throw cause;
    },
  );
  // A caller that forgets to await cannot make rejection unobserved or release custody early.
  void result.catch(() => {});
  return result;
}

async function completeIO<T>(
  context: Context,
  name: string,
  operation: () => Promise<T>,
  beforeSubmit?: () => void,
  completed?: () => void,
): Promise<T> {
  await context.custody.assertDirectory();
  const failures: unknown[] = [];
  let value: T | undefined;
  let submitted = false;
  try {
    context.custody.hooks.observe?.({ operation: name, stage: "submit" });
    const fault = context.custody.hooks.faultBefore?.(name);
    if (fault) throw fault;
    beforeSubmit?.();
    submitted = true;
    value = await operation();
    completed?.(); // Actual native facts survive an instrumentation/authority error afterwards.
    await context.custody.hooks.afterNative?.(name);
    await context.custody.assertDirectory();
  } catch (cause) {
    failures.push(cause);
  }
  try {
    context.custody.hooks.observe?.({ operation: name, stage: "settle" });
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length) {
    if (
      submitted ||
      failures.length !== 1 ||
      !(failures[0] instanceof DOMException && failures[0].name === "AbortError")
    )
      poisonPath(context.custody.target, failures[0]);
    throw combineFailures(failures);
  }
  return value as T;
}
async function writeAll(
  context: Context,
  handle: FileHandle,
  bytes: Buffer,
  position: number,
  alreadyStarted = false,
): Promise<void> {
  // Once a byte write starts, complete the already submitted durability group before cancellation.
  if (!alreadyStarted) abort(context.signal);
  for (let at = 0; at < bytes.length; ) {
    const { bytesWritten } = await completeIO(
      context,
      "file.write",
      () => handle.write(bytes, at, Math.min(CHUNK_SIZE, bytes.length - at), position + at),
      () => {
        if (at === 0 && !alreadyStarted) abort(context.signal);
      },
    );
    if (!bytesWritten) fail("Fixture write made no progress");
    at += bytesWritten;
  }
}

export function readAsyncStateUnderLease(lease: AsyncLease): Promise<DecodedState> {
  const context = assertAsyncLease(lease);
  return submit(lease, () => context.custody.assertCurrent());
}

/** Captures a strict owned representation synchronously, before any async handoff. */
export function writeAsyncStateUnderLease(
  lease: AsyncLease,
  state: DecodedState,
  platform = process.platform,
): Promise<void> {
  return writePreparedAsyncStateUnderLease(lease, prepareAsyncState(lease, state, platform));
}
export type PreparedState = Readonly<{ kind: "prepared-state" }>;
const preparedStates = new WeakMap<PreparedState, { lease: AsyncLease; bytes: Buffer }>();
export function prepareAsyncState(
  lease: AsyncLease,
  state: DecodedState,
  platform = process.platform,
): PreparedState {
  const context = assertAsyncLease(lease);
  if (platform === "win32")
    throw new StorageFailure("unsupported", "Prototype requires directory fsync support");
  const bytes = Buffer.from(encodeState(captureStateWrapper(state)));
  context.custody.assertCapturedState(decodeStateBytes(bytes));
  const token = Object.freeze({ kind: "prepared-state" as const });
  preparedStates.set(token, { lease, bytes });
  return token;
}
export function writePreparedAsyncStateUnderLease(
  lease: AsyncLease,
  prepared: PreparedState,
  facts?: WriterFacts,
  stage = "state",
): Promise<void> {
  const context = assertAsyncLease(lease);
  const owned = preparedStates.get(prepared);
  if (!owned || owned.lease !== lease) fail("Prepared state for this current lease required");
  const bytes = owned.bytes;
  context.custody.assertCapturedState(decodeStateBytes(bytes));
  const ledger = facts ? claimWriterFacts(facts, lease) : undefined;
  return submit(lease, async () => {
    const temporary = join(lease.directory, `.prototype-async-state-${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    const failures: unknown[] = [];
    const resource = resources(context);
    try {
      await context.custody.assertCurrent();
      abort(context.signal);
      if (ledger) ledger.tempSubmitted = true;
      handle = await regular(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        resource,
      );
      if (ledger) await context.custody.hooks.afterNative?.("writer.temp.open");
      await writeAll(context, handle, bytes, 0, !!ledger);
      await completeIO(context, "file.sync", () => handle!.sync());
      await closeHandle(handle, resource);
      handle = undefined;
      await context.custody.assertDirectory();
      await completeIO(
        context,
        "state.rename",
        () => fsp.rename(temporary, join(lease.directory, "state.json")),
        undefined,
        () => {
          ledger?.native.push("state.rename:" + stage);
        },
      );
      const directory = await fsp.open(
        lease.directory,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const directoryFailures: unknown[] = [];
      try {
        await completeIO(
          context,
          "directory.sync",
          () => directory.sync(),
          undefined,
          () => {
            ledger?.native.push("directory.sync:" + stage);
          },
        );
      } catch (cause) {
        directoryFailures.push(cause);
      }
      try {
        await closeHandle(directory, resource);
      } catch (cause) {
        directoryFailures.push(cause);
      }
      if (directoryFailures.length) throw combineFailures(directoryFailures);
      await context.custody.assertDirectory();
      if (ledger) ledger.completed.push(stage);
      await context.custody.hooks.afterNative?.("writer.stage." + stage);
    } catch (cause) {
      failures.push(cause);
    }
    if (handle) {
      try {
        await closeHandle(handle, resource);
      } catch (cause) {
        failures.push(cause);
      }
    }
    try {
      const fault = context.custody.hooks.faultBefore?.("temp.unlink");
      if (fault) throw fault;
      await fsp.unlink(temporary);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") {
        failures.push(cause);
        context.custody.recordCleanup(cause);
      }
    }
    if (failures.length) throw combineFailures(failures);
  });
}
export function openAsyncJournal(lease: AsyncLease, writable = false): Promise<AsyncFile> {
  const context = assertAsyncLease(lease);
  return submit(lease, async () => {
    const handle = await regular(
      join(lease.directory, "output-journal.jsonl"),
      writable ? constants.O_RDWR : constants.O_RDONLY,
      resources(context),
    );
    try {
      await namedFile(join(lease.directory, "output-journal.jsonl"), handle);
      if ((await handle.stat()).size > JOURNAL_LIMIT)
        throw new StorageFailure("capacity", "Journal storage bound");
      const file: AsyncFile = Object.freeze({ kind: "fixture-journal" });
      files.set(file, { handle, owner: context, closed: false });
      context.files.add(file);
      return file;
    } catch (cause) {
      const failures = [cause];
      try {
        await closeHandle(handle, resources(context));
      } catch (secondary) {
        failures.push(secondary);
      }
      throw combineFailures(failures);
    }
  });
}
export function readAsyncAt(
  lease: AsyncLease,
  file: AsyncFile,
  length: number,
  position: number,
): Promise<Buffer> {
  const context = assertAsyncLease(lease);
  const handle = fileFor(context, file);
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > RECORD_LIMIT ||
    !Number.isSafeInteger(position) ||
    position < 0 ||
    position + length > JOURNAL_LIMIT
  )
    fail("Bounded async read required");
  return submit(lease, async () => {
    await namedFile(join(lease.directory, "output-journal.jsonl"), handle);
    const bytes = Buffer.alloc(length);
    let at = 0;
    while (at < length) {
      const { bytesRead } = await completeIO(context, "journal.read", () =>
        handle.read(bytes, at, Math.min(CHUNK_SIZE, length - at), position + at),
      );
      if (!bytesRead) break;
      at += bytesRead;
    }
    await namedFile(join(lease.directory, "output-journal.jsonl"), handle);
    return bytes.subarray(0, at);
  });
}
export type AsyncJournalSnapshot = Readonly<{
  size: number;
  stamp: string;
  dev: string;
  ino: string;
  directoryDev: string;
  directoryIno: string;
}>;

/** No descriptor escapes: the snapshot belongs to a current opaque lease/file pair. */
export function snapshotAsyncJournal(
  lease: AsyncLease,
  file: AsyncFile,
): Promise<AsyncJournalSnapshot> {
  const context = assertAsyncLease(lease);
  const handle = fileFor(context, file);
  return submit(lease, async () => {
    await context.custody.assertCurrent();
    await namedFile(join(lease.directory, "output-journal.jsonl"), handle);
    const stat = await handle.stat({ bigint: true });
    if (stat.size > BigInt(JOURNAL_LIMIT))
      throw new StorageFailure("capacity", "Journal byte bound");
    const directory = await fsp.lstat(lease.directory, { bigint: true });
    await context.custody.assertCurrent();
    await namedFile(join(lease.directory, "output-journal.jsonl"), handle);
    const after = await handle.stat({ bigint: true });
    const stamp = (value: typeof stat) =>
      `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
    if (stamp(stat) !== stamp(after)) fail("Journal changed while capturing descriptor snapshot");
    const snapshot = Object.freeze({
      size: Number(stat.size),
      stamp: stamp(stat),
      dev: String(stat.dev),
      ino: String(stat.ino),
      directoryDev: String(directory.dev),
      directoryIno: String(directory.ino),
    });
    snapshots.set(snapshot, { context, file });
    return snapshot;
  });
}
export function assertAsyncJournalSnapshot(
  lease: AsyncLease,
  file: AsyncFile,
  expected: AsyncJournalSnapshot,
): Promise<void> {
  const context = assertAsyncLease(lease);
  const owner = snapshots.get(expected);
  if (!owner || owner.context !== context || owner.file !== file)
    fail("Native snapshot for this current lease/file required");
  const handle = fileFor(context, file);
  return submit(lease, async () => {
    await context.custody.assertDirectory();
    await namedFile(join(lease.directory, "output-journal.jsonl"), handle);
    if ((await stamp(handle)) !== expected.stamp) fail("Journal changed during verification");
    await context.custody.assertDirectory();
  });
}

/** A real macrotask permits the native heartbeat to progress, followed by current custody checks. */
export function yieldAsyncLease(lease: AsyncLease): Promise<void> {
  const context = assertAsyncLease(lease);
  return submit(lease, async () => {
    await yieldTask();
    assertAsyncLease(lease);
    await context.custody.assertDirectory();
    assertAsyncLease(lease);
    context.custody.hooks.observe?.({ operation: "scanner.cpu_yield", stage: "settle" });
  });
}

export function appendAsyncUnderLease(
  lease: AsyncLease,
  file: AsyncFile,
  input: Buffer,
  offset: number,
): Promise<void> {
  const context = assertAsyncLease(lease);
  const handle = fileFor(context, file);
  if (
    utilTypes.isProxy(input) ||
    !Buffer.isBuffer(input) ||
    Object.getPrototypeOf(input) !== Buffer.prototype ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    fail("Owned bytes and append offset required");
  const byteLength = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    "byteLength",
  )!.get!.call(input) as number;
  if (byteLength > RECORD_LIMIT || offset + byteLength > JOURNAL_LIMIT)
    throw new StorageFailure("capacity", "Journal storage bound");
  if (Object.getOwnPropertySymbols(input).length) fail("Decorated fixture Buffer refused");
  for (const key of Object.getOwnPropertyNames(input))
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= byteLength)
      fail("Decorated fixture Buffer refused");
  const bytes = Buffer.alloc(byteLength);
  // Internal typed-array copy does not consult caller property accessors or species constructors.
  Uint8Array.prototype.set.call(bytes, input);
  return submit(lease, async () => {
    await context.custody.assertCurrent();
    await namedFile(join(lease.directory, "output-journal.jsonl"), handle);
    if ((await handle.stat()).size !== offset) fail("Journal head changed before append");
    await writeAll(context, handle, bytes, offset);
    await completeIO(context, "file.sync", () => handle.sync());
    await namedFile(join(lease.directory, "output-journal.jsonl"), handle);
    await context.custody.assertCurrent();
  });
}
export function closeAsyncFile(lease: AsyncLease, file: AsyncFile): Promise<void> {
  const context = assertAsyncLease(lease);
  const handle = fileFor(context, file);
  return submit(lease, async () => {
    files.get(file)!.closed = true;
    await closeHandle(handle, resources(context));
    context.files.delete(file);
  });
}

export type WriterFacts = Readonly<{ kind: "writer-facts" }>;
type Facts = {
  journalSubmitted: boolean;
  tempSubmitted: boolean;
  completed: string[];
  native: string[];
  bound?: VerifiedJournal;
};
const writerLedgers = new WeakMap<WriterFacts, Facts>();
const writerOwners = new WeakMap<WriterFacts, AsyncLease>();
export function createWriterFacts(): WriterFacts {
  const token = Object.freeze({ kind: "writer-facts" as const });
  writerLedgers.set(token, {
    journalSubmitted: false,
    tempSubmitted: false,
    completed: [],
    native: [],
  });
  return token;
}
function factsFor(token: WriterFacts): Facts {
  const facts = writerLedgers.get(token);
  if (!facts) fail("Owned writer facts required");
  return facts;
}
function claimWriterFacts(token: WriterFacts, lease: AsyncLease): Facts {
  const facts = factsFor(token),
    owner = writerOwners.get(token);
  if (owner && owner !== lease) fail("Writer facts for this current lease required");
  writerOwners.set(token, lease);
  return facts;
}
export function readWriterFacts(token: WriterFacts): Readonly<Facts> {
  return structuredClone(factsFor(token));
}

export type PreparedEventSource = Readonly<{ kind: "prepared-event-source" }>;
type EventSource = {
  lease: AsyncLease;
  binding: Binding;
  event?: RawObject;
  bytes: Buffer;
  id: string;
  digest: string;
};
const eventSources = new WeakMap<PreparedEventSource, EventSource>();
export async function prepareAsyncEventSource(
  lease: AsyncLease,
  binding: Binding,
  event: RawObject,
): Promise<PreparedEventSource> {
  // Each parameter has its own bound; an exact 16MiB event is not an oversized envelope.
  const ownedBinding = captureOwnedJSON(binding);
  const ownedEvent = captureOwnedJSON(event);
  assertAsyncLease(lease);
  validateScope(ownedBinding.scope);
  if (
    typeof ownedBinding.eventId !== "string" ||
    !EVENT_ID.test(ownedBinding.eventId) ||
    typeof ownedBinding.projectionDigest !== "string" ||
    !HEX.test(ownedBinding.projectionDigest)
  )
    fail("Invalid prepared event binding");
  if (typeof ownedEvent.type !== "string" || !ownedEvent.type.length) fail("Invalid display event");
  const bytes = Buffer.alloc(ownedJSONLengths.get(ownedEvent)!);
  let offset = 0;
  let pending = 0;
  for (const chunk of canonicalSteps(ownedEvent)) {
    const length = Buffer.byteLength(chunk);
    if (bytes.write(chunk, offset) !== length) fail("Owned canonical event changed");
    offset += length;
    pending += length;
    if (pending >= CHUNK_SIZE) {
      await yieldAsyncLease(lease);
      pending = 0;
    }
  }
  if (offset !== bytes.length) fail("Owned canonical event length changed");
  if (bytes.length > EVENT_LIMIT) throw new StorageFailure("capacity", "Whole event byte bound");
  const hash = createHash("sha256");
  for (let at = 0; at < bytes.length; at += CHUNK_SIZE) {
    hash.update(bytes.subarray(at, at + CHUNK_SIZE));
    await yieldAsyncLease(lease);
  }
  const token = Object.freeze({ kind: "prepared-event-source" as const });
  eventSources.set(token, {
    lease,
    binding: ownedBinding,
    event: bytes.length <= CHUNK_SIZE ? ownedEvent : undefined,
    bytes,
    id: randomUUID(),
    digest: hash.digest("hex"),
  });
  return token;
}
export function preparedEventCount(source: PreparedEventSource): number {
  const value = eventSources.get(source);
  if (!value) fail("Owned prepared event source required");
  return Math.max(1, Math.ceil(value.bytes.length / CHUNK_SIZE));
}
export type PreparedRecordGroup = Readonly<{ kind: "prepared-record-group" }>;
type Group = {
  lease: AsyncLease;
  head: Position;
  positions: Position[];
  lengths: number[];
  source?: EventSource;
  payload?: RawObject;
};
const recordGroups = new WeakMap<PreparedRecordGroup, Group>();
function* groupPayloads(group: Group): Generator<RawObject> {
  if (group.source) {
    const s = group.source;
    yield* eventPayloadIterator(s.binding, s.event ?? {}, s.bytes, s.id, s.digest);
  } else if (group.payload) yield group.payload;
}
export async function prepareAsyncRecordGroup(
  lease: AsyncLease,
  head: Position,
  payload?: RawObject,
  source?: PreparedEventSource,
): Promise<PreparedRecordGroup> {
  assertAsyncLease(lease);
  const ownedHead = captureOwnedJSON(head);
  // Cursor tokens retain the original Position field order even for an empty prepared group.
  const group: Group = {
    lease,
    head: { sequence: ownedHead.sequence, offset: ownedHead.offset, hash: ownedHead.hash },
    positions: [],
    lengths: [],
  };
  if (
    !Number.isSafeInteger(group.head.sequence) ||
    group.head.sequence < 0 ||
    !Number.isSafeInteger(group.head.offset) ||
    group.head.offset < 0 ||
    typeof group.head.hash !== "string" ||
    !HEX.test(group.head.hash)
  )
    fail("Valid prepared head required");
  if (payload && source) fail("One prepared record source required");
  if (source) {
    group.source = eventSources.get(source);
    if (!group.source || group.source.lease !== lease) fail("Owned event source required");
  }
  if (payload) group.payload = captureOwnedJSON(payload);
  let position = group.head;
  for (const value of groupPayloads(group)) {
    const encoded = encodeRecord(position, value);
    position = encoded.position;
    if (position.offset > JOURNAL_LIMIT)
      throw new StorageFailure("capacity", "Journal storage bound");
    group.positions.push(position);
    group.lengths.push(encoded.bytes.length);
    await yieldAsyncLease(lease);
  }
  const token = Object.freeze({ kind: "prepared-record-group" as const });
  recordGroups.set(token, group);
  return token;
}
export function preparedGroupHead(token: PreparedRecordGroup): Position {
  const group = recordGroups.get(token);
  if (!group) fail("Owned prepared record group required");
  return { ...(group.positions.at(-1) ?? group.head) };
}
export function appendPreparedRecordGroup(
  lease: AsyncLease,
  file: AsyncFile,
  token: PreparedRecordGroup,
  facts: WriterFacts,
  stage: string,
): Promise<void> {
  const context = assertAsyncLease(lease),
    handle = fileFor(context, file);
  const group = recordGroups.get(token),
    ledger = claimWriterFacts(facts, lease);
  if (!group || group.lease !== lease)
    fail("Prepared record group for this current lease required");
  return submit(lease, async () => {
    await context.custody.assertCurrent();
    await namedFile(join(lease.directory, "output-journal.jsonl"), handle);
    if ((await handle.stat()).size !== group.head.offset) fail("Journal head changed before group");
    let position = group.head,
      index = 0,
      groupStarted = false;
    for (const payload of groupPayloads(group)) {
      const encoded = encodeRecord(position, payload);
      const expected = group.positions[index];
      if (
        encoded.bytes.length !== group.lengths[index] ||
        encoded.position.hash !== expected.hash ||
        encoded.position.offset !== expected.offset
      )
        fail("Prepared record recipe changed");
      for (let at = 0; at < encoded.bytes.length; ) {
        await namedFile(join(lease.directory, "output-journal.jsonl"), handle);
        const { bytesWritten } = await completeIO(
          context,
          "file.write",
          () =>
            handle.write(
              encoded.bytes,
              at,
              Math.min(CHUNK_SIZE, encoded.bytes.length - at),
              position.offset + at,
            ),
          () => {
            if (!groupStarted) abort(context.signal);
            groupStarted = true;
            ledger.journalSubmitted = true;
          },
        );
        if (
          !Number.isInteger(bytesWritten) ||
          bytesWritten < 1 ||
          bytesWritten > Math.min(CHUNK_SIZE, encoded.bytes.length - at)
        )
          fail("Invalid short write");
        at += bytesWritten;
      }
      position = encoded.position;
      index++;
    }
    if (groupStarted)
      await completeIO(
        context,
        "file.sync",
        () => handle.sync(),
        undefined,
        () => {
          ledger.native.push("journal.sync:" + stage);
        },
      );
    await namedFile(join(lease.directory, "output-journal.jsonl"), handle);
    if ((await handle.stat()).size !== position.offset) fail("Journal size changed after group");
    await context.custody.assertCurrent();
    ledger.completed.push(stage);
    await context.custody.hooks.afterNative?.("writer.stage." + stage);
  });
}
/** Final bindings may be proved after cancellation, but never after revoked native custody. */
export function finalizeAsyncWriter(
  lease: AsyncLease,
  file: AsyncFile,
  proof: VerifiedJournal,
  facts: WriterFacts,
): Promise<VerifiedJournal> {
  const context = assertAsyncLease(lease, true),
    handle = fileFor(context, file),
    ledger = claimWriterFacts(facts, lease);
  return submit(
    lease,
    async () => {
      const current = await context.custody.assertCurrent();
      if (current.state.outputJournalIdentity !== proof.pin)
        fail("Journal pin changed during write");
      verifyState(current, proof);
      const stateStamp = await namedWriterStamp(context.custody.target);
      await namedFile(join(lease.directory, "output-journal.jsonl"), handle);
      if ((await handle.stat()).size !== proof.head.offset) fail("Final journal head mismatch");
      const next = { ...proof, fileStamp: await stamp(handle) };
      if (encodeState(await context.custody.assertCurrent()) !== encodeState(current))
        fail("Final writer state changed while binding");
      if ((await namedWriterStamp(context.custody.target)) !== stateStamp)
        fail("Final writer state stamp changed while binding");
      await namedFile(join(lease.directory, "output-journal.jsonl"), handle);
      if ((await stamp(handle)) !== next.fileStamp) fail("Final journal stamp changed");
      ledger.bound = next;
      context.writerBinding = { proof: next, state: encodeState(current), stateStamp };
      await context.custody.hooks.afterNative?.("writer.final_binding");
      return next;
    },
    true,
  );
}

export class AsyncFixtureCustody {
  readonly target: string;
  private current?: Promise<unknown>;
  private disposal?: Promise<void>;
  private closing = false;
  private adapter?: LeaseFs;
  private cleanupFailures: unknown[] = [];

  private constructor(
    readonly root: string,
    readonly sessionId: string,
    readonly directory: string,
    private readonly incarnation: Identity,
    private readonly startedAt: number,
    readonly hooks: FixtureIOHooks,
  ) {
    this.target = join(directory, "state.json");
  }

  static async create(
    root: string,
    sessionId: string,
    hooks: FixtureIOHooks = {},
  ): Promise<AsyncFixtureCustody> {
    if (
      typeof sessionId !== "string" ||
      !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(sessionId) ||
      sessionId.includes("..")
    )
      fail("Invalid fixture Session id");
    const canonical = await fixtureRoot(root);
    const directory = join(canonical, sessionId);
    assertPath(join(directory, "state.json"));
    const incarnation = await fsp.lstat(directory);
    if (!incarnation.isDirectory() || incarnation.isSymbolicLink())
      fail("Existing fixture directory required");
    const state = decodeStateBytes(
      await readBounded(join(directory, "state.json"), STATE_LIMIT, { hooks }),
    );
    if (state.state.sessionId !== sessionId || state.state.ephemeral)
      fail("Persistent fixture Session required");
    const result = new AsyncFixtureCustody(
      canonical,
      sessionId,
      directory,
      incarnation,
      state.state.startedAt,
      hooks,
    );
    await result.assertDirectory();
    return result;
  }

  assertHealthy(): void {
    assertPath(this.target);
  }
  recordCleanup(cause: unknown): void {
    this.cleanupFailures.push(cause);
    poisonPath(this.target, cause);
  }
  async assertOwned(): Promise<void> {
    this.assertHealthy();
    if (!this.adapter) fail("Current native async custody required");
    await this.adapter.assertOwned();
    this.assertHealthy();
  }
  assertCapturedState(state: DecodedState): void {
    if (
      state.state.sessionId !== this.sessionId ||
      state.state.startedAt !== this.startedAt ||
      state.state.ephemeral
    )
      fail("Captured Session identity cannot change under this lease");
  }
  async assertDirectory(): Promise<void> {
    this.assertHealthy();
    try {
      const current = await fsp.lstat(this.directory);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        !identity(current, this.incarnation)
      )
        fail("Fixture Session replaced/deleted");
      if (this.adapter) await this.assertOwned();
      this.assertHealthy();
    } catch (cause) {
      poisonPath(this.target, cause);
      throw cause;
    }
  }
  async assertCurrent(): Promise<DecodedState> {
    try {
      await this.assertDirectory();
      const current = decodeStateBytes(
        await readBounded(this.target, STATE_LIMIT, {
          hooks: this.hooks,
          cleanup: (cause) => this.recordCleanup(cause),
        }),
      );
      if (
        current.state.sessionId !== this.sessionId ||
        current.state.startedAt !== this.startedAt ||
        current.state.ephemeral ||
        current.state.outputRecoveryIncomplete
      )
        fail("Fixture authority revoked/incomplete");
      if (this.adapter) await this.assertOwned();
      this.assertHealthy();
      return current;
    } catch (cause) {
      poisonPath(this.target, cause);
      throw cause;
    }
  }

  withLease<T>(
    operation: (lease: AsyncLease) => T | Promise<T>,
    options: AsyncLeaseOptions = {},
  ): Promise<T> {
    return this.admit(operation, options).then((settlement) => {
      if (settlement.failures.length) throw combineFailures(settlement.failures);
      return settlement.value as T;
    });
  }
  withLeaseSettled<T>(
    operation: (lease: AsyncLease) => T | Promise<T>,
    options: AsyncLeaseOptions = {},
  ): Promise<LeaseSettlement<T>> {
    return this.admit(operation, options);
  }
  private admit<T>(
    operation: (lease: AsyncLease) => T | Promise<T>,
    options: AsyncLeaseOptions,
  ): Promise<LeaseSettlement<T>> {
    if (this.closing) return Promise.reject(new Error("Async custody disposed"));
    if (this.current) return Promise.reject(new Error("Nested async custody acquisition refused"));
    const signal = options.signal; // Own this reference before the first async handoff.
    const cleanupStart = this.cleanupFailures.length;
    const work = this.run(operation, { signal }, cleanupStart).catch((cause) => {
      const cleanupFailures = this.cleanupFailures.slice(cleanupStart);
      try {
        this.assertHealthy();
      } catch (health) {
        cleanupFailures.push(health);
      }
      return { failures: [cause], cleanupFailures, cleanupOk: !cleanupFailures.length };
    });
    this.current = work;
    void work
      .finally(() => {
        this.current = undefined;
      })
      .catch(() => {});
    return work;
  }

  private async run<T>(
    operation: (lease: AsyncLease) => T | Promise<T>,
    options: AsyncLeaseOptions,
    cleanupStart: number,
  ): Promise<LeaseSettlement<T>> {
    abort(options.signal);
    this.assertHealthy();
    let adapter: LeaseFs | undefined;
    let release: (() => Promise<void>) | undefined;
    for (let attempt = 0; attempt <= LOCK_RETRY_MS.length; attempt++) {
      abort(options.signal);
      if (reservePath(this.target)) {
        adapter = new LeaseFs(this.target, (cause) => poisonPath(this.target, cause), this.hooks);
        try {
          release = await lock(this.target, {
            realpath: false,
            retries: 0,
            stale: LOCK_STALE_MS,
            update: LOCK_STALE_MS / 2,
            fs: adapter.api,
            onCompromised: (cause) => poisonPath(this.target, cause),
          });
          adapter.activate();
          this.adapter = adapter;
          break;
        } catch (cause) {
          const failures = [cause];
          try {
            await adapter.close(release);
          } catch (cleanup) {
            failures.push(cleanup);
            this.recordCleanup(cleanup);
          } finally {
            releasePath(this.target);
          }
          adapter = undefined;
          if (
            failures.length > 1 ||
            !["ELOCKED", "EEXIST"].includes((cause as NodeJS.ErrnoException)?.code ?? "")
          )
            throw combineFailures(failures);
        }
      }
      const wait = LOCK_RETRY_MS[attempt];
      if (wait === undefined)
        throw new StorageFailure("busy", "Original 75ms async lock retry budget exhausted");
      await delay(wait);
    }
    if (!adapter || !release) throw new StorageFailure("busy", "Async fixture lock unavailable");
    const lease: AsyncLease = Object.freeze({
      root: this.root,
      sessionId: this.sessionId,
      directory: this.directory,
    });
    const context: Context = {
      custody: this,
      admission: true,
      signal: options.signal,
      pending: new Set(),
      files: new Set(),
      busy: false,
      ioFailures: [],
    };
    leases.set(lease, context);
    let result: T | undefined;
    const failures: unknown[] = [];
    try {
      abort(options.signal);
      await fixtureRoot(this.root);
      await this.assertCurrent();
      result = await operation(lease);
    } catch (cause) {
      failures.push(cause);
    }
    context.admission = false;
    while (context.pending.size) await Promise.allSettled([...context.pending]);
    failures.push(...context.ioFailures);
    for (const file of context.files) {
      const stored = files.get(file)!;
      stored.closed = true;
      try {
        await closeHandle(stored.handle, resources(context));
      } catch (cause) {
        failures.push(cause);
        this.recordCleanup(cause);
      }
    }
    context.files.clear();
    const bindingFailures: unknown[] = [];
    try {
      const current = await this.assertCurrent();
      const witness = context.writerBinding;
      if (witness) {
        if (
          current.state.outputJournalIdentity !== witness.proof.pin ||
          encodeState(current) !== witness.state ||
          (await namedWriterStamp(this.target)) !== witness.stateStamp
        )
          fail("Final writer state binding changed during descriptor cleanup");
        verifyState(current, witness.proof);
        if (
          (await namedWriterStamp(join(this.directory, "output-journal.jsonl"))) !==
          witness.proof.fileStamp
        )
          fail("Final writer journal binding changed during descriptor cleanup");
        await this.assertDirectory();
      }
    } catch (cause) {
      poisonPath(this.target, cause);
      failures.push(cause);
      bindingFailures.push(cause);
    }
    if (!bindingFailures.length) {
      try {
        abort(options.signal);
      } catch (cause) {
        failures.push(cause);
      }
    }
    leases.delete(lease);
    try {
      await adapter.close(release);
    } catch (cause) {
      failures.push(cause);
      this.recordCleanup(cause);
    } finally {
      this.adapter = undefined;
      releasePath(this.target);
    }
    try {
      this.assertHealthy();
    } catch (cause) {
      failures.push(cause);
    }
    const cleanupFailures = [...this.cleanupFailures.slice(cleanupStart), ...bindingFailures];
    try {
      this.assertHealthy();
    } catch (cause) {
      cleanupFailures.push(cause);
    }
    return { value: result, failures, cleanupFailures, cleanupOk: !cleanupFailures.length };
  }

  /** No early release: waits for the callback, submitted I/O, descriptors, heartbeat and unlock. */
  dispose(): Promise<void> {
    this.closing = true;
    this.disposal ??= (async () => {
      if (this.current) await this.current.catch(() => {});
      if (this.cleanupFailures.length) throw combineFailures(this.cleanupFailures);
    })();
    return this.disposal;
  }
}
