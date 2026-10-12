/** Explicit, offline, evidence-first restore. Never resets a published cursor or a coverage gap. */
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { lockSync } from "../utils/lockfile.js";
import { readPublishedOutputHead, type OutputHeadPin } from "./output-journal-head.js";
import { readOutputJournal } from "./output-journal.js";
import { isOutputJournalRepairPending } from "./output-journal-repair.js";
import {
  OUTPUT_ANCHOR,
  OUTPUT_BACKUP_MANIFEST,
  OUTPUT_HEAD,
  OUTPUT_REPAIR_PENDING,
  OUTPUT_SEGMENTS,
  MAX_OUTPUT_REPAIR_BYTES,
  OutputJournalRepairError,
  decodeJson,
  encodeRepairStorage,
  logicalStorage,
  outputRepairCursor,
  parseRepairStorage,
  requireRepair,
  sha256,
  validIdentity,
  verifyBackupChain,
  type BackupFile,
  type FileIdentity,
  type OutputJournalBackupManifest,
  type RepairAuthority,
  type RepairStorageManifest,
} from "./output-journal-backup-format.js";

const MAX_FILE = 128 * 1024 * 1024;
const flags = (mode: number) =>
  mode | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
const named = (path: string) => fs.lstatSync(path, { throwIfNoEntry: false });
const sameInode = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino;
function directory(path: string): fs.Stats {
  const stat = named(path);
  requireRepair(
    stat?.isDirectory() && !stat.isSymbolicLink(),
    "path_replaced",
    "Expected a real private directory",
  );
  return stat!;
}
function stamp(fd: number): string {
  const stat = fs.fstatSync(fd, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function openFile(
  path: string,
  mode = fs.constants.O_RDONLY,
  expected?: FileIdentity,
  aliases = false,
): number {
  const fd = fs.openSync(path, flags(mode), 0o600);
  try {
    const stat = fs.fstatSync(fd),
      at = named(path);
    requireRepair(
      stat.isFile() &&
        (aliases ? stat.nlink <= 2 : stat.nlink === 1) &&
        at?.isFile() &&
        !at.isSymbolicLink() &&
        sameInode(stat, at) &&
        (!expected || sameInode(stat, expected)),
      "path_replaced",
      "An output file was linked or replaced",
    );
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
function readRange(fd: number, start: number, end: number, consume: (data: Buffer) => void): void {
  requireRepair(
    start >= 0 && end >= start && end <= MAX_FILE,
    "file_budget",
    "Output file exceeds its repair bound",
  );
  const buffer = Buffer.allocUnsafe(65536);
  for (let offset = start; offset < end; ) {
    const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
    requireRepair(count > 0, "source_changed", "Output file changed while reading");
    consume(buffer.subarray(0, count));
    offset += count;
  }
}
function readBytes(path: string, limit: number, aliases = false, expected?: FileIdentity): Buffer {
  const fd = openFile(path, fs.constants.O_RDONLY, expected, aliases);
  try {
    const before = stamp(fd),
      size = fs.fstatSync(fd).size;
    requireRepair(size > 0 && size <= limit, "file_budget", "Invalid bounded metadata file");
    const chunks: Buffer[] = [];
    readRange(fd, 0, size, (chunk) => chunks.push(Buffer.from(chunk)));
    requireRepair(
      stamp(fd) === before && sameInode(named(path)!, fs.fstatSync(fd)),
      "source_changed",
      "Metadata changed while reading",
    );
    return Buffer.concat(chunks);
  } finally {
    fs.closeSync(fd);
  }
}
function writeAll(fd: number, data: Buffer, position: number): void {
  for (let offset = 0; offset < data.length; ) {
    const count = fs.writeSync(fd, data, offset, data.length - offset, position + offset);
    requireRepair(count > 0, "write_failed", "Repair write made no progress");
    offset += count;
  }
}
function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(path, flags(fs.constants.O_RDONLY));
  try {
    requireRepair(fs.fstatSync(fd).isDirectory(), "path_replaced", "Directory was replaced");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function writePrivate(path: string, data: Buffer): void {
  const fd = fs.openSync(
    path,
    flags(fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL),
    0o600,
  );
  try {
    writeAll(fd, data, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function sealed(value: unknown, alias: string): Buffer {
  return Buffer.from(
    JSON.stringify({ value, sha256: sha256(JSON.stringify(value)), alias }) + "\n",
  );
}
function unseal(path: string, limit = 128 * 1024): any {
  const wrapper = decodeJson(readBytes(path, limit, true));
  requireRepair(
    wrapper?.sha256 === sha256(JSON.stringify(wrapper.value)),
    "evidence_invalid",
    "Repair receipt checksum failed",
  );
  // Exclusive receipt publication can be interrupted between link and unlink.
  // Only its encoded, same-inode private alias may be removed on retry.
  const stat = named(path)!;
  if (stat.nlink === 2) {
    requireRepair(
      /^\.receipt-[a-f0-9-]{36}\.tmp$/.test(wrapper.alias),
      "evidence_invalid",
      "Receipt has an unknown hard-link alias",
    );
    const alias = join(dirname(path), wrapper.alias),
      other = named(alias);
    requireRepair(
      other?.isFile() && !other.isSymbolicLink() && sameInode(other, stat),
      "evidence_invalid",
      "Receipt alias was replaced",
    );
    fs.unlinkSync(alias);
    syncDirectory(dirname(path));
  }
  return wrapper.value;
}
/** Complete receipts appear only after their file fsync. The source evidence is never replaced. */
function atomicReceipt(path: string, value: unknown): void {
  if (named(path)) {
    requireRepair(
      JSON.stringify(unseal(path)) === JSON.stringify(value),
      "evidence_invalid",
      "Existing repair receipt differs",
    );
    const fd = openFile(path);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    syncDirectory(dirname(path));
    return;
  }
  const temp = join(dirname(path), `.receipt-${randomUUID()}.tmp`);
  writePrivate(temp, sealed(value, basename(temp)));
  fs.linkSync(temp, path); // Exclusive publication: never overwrite a concurrent path.
  fs.unlinkSync(temp);
  syncDirectory(dirname(path));
}
/** Pure containment check; the optional path flavor also exercises Windows semantics on POSIX. */
export function outputRepairPathsOverlap(
  first: string,
  second: string,
  paths: Pick<typeof import("node:path"), "relative" | "isAbsolute" | "sep"> = {
    relative,
    isAbsolute,
    sep,
  },
): boolean {
  const contains = (parent: string, child: string) => {
    const rel = paths.relative(parent, child);
    return (
      rel === "" || (!paths.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + paths.sep))
    );
  };
  return contains(first, second) || contains(second, first);
}
function canonicalTarget(path: string): string {
  requireRepair(isAbsolute(path), "invalid_path", "An absolute destination path is required");
  return join(fs.realpathSync(dirname(path)), basename(path));
}
interface Location {
  root: string;
  directory: string;
  statePath: string;
  state: any;
  authority: RepairAuthority;
}
function locate(root: string, sessionId: string, anchorIdentity?: FileIdentity): Location {
  requireRepair(
    /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(sessionId) && !sessionId.includes(".."),
    "invalid_session",
    "Invalid Session id",
  );
  requireRepair(isAbsolute(root), "invalid_path", "An explicit absolute Sessions root is required");
  const canonicalRoot = fs.realpathSync(root),
    rootFile = directory(canonicalRoot);
  const dir = join(canonicalRoot, sessionId),
    sessionFile = directory(dir),
    statePath = join(dir, "state.json");
  const state = decodeJson(readBytes(statePath, 1024 * 1024));
  requireRepair(
    state?.sessionId === sessionId &&
      Number.isFinite(state.startedAt) &&
      !state.ephemeral &&
      !sessionId.startsWith("qchat-") &&
      /^[a-f0-9]{64}$/.test(state.outputJournalIdentity),
    "authority_mismatch",
    "Session has no admitted output authority",
  );
  const pin = state.outputJournalHead as OutputHeadPin;
  requireRepair(
    pin?.version === 2 && validIdentity(pin.file!),
    "head_unproved",
    "Original durable-head file proof is required",
  );
  let head;
  try {
    head = readPublishedOutputHead(dir, pin);
  } catch (cause) {
    throw new OutputJournalRepairError(
      "head_unproved",
      "Original durable-head proof was lost, replaced or damaged",
      { cause },
    );
  }
  const anchor = openFile(join(dir, OUTPUT_ANCHOR), fs.constants.O_RDONLY, anchorIdentity);
  try {
    const file = fs.fstatSync(anchor);
    const authority: RepairAuthority = {
      root: canonicalRoot,
      rootFile: { dev: rootFile.dev, ino: rootFile.ino },
      sessionId,
      sessionFile: { dev: sessionFile.dev, ino: sessionFile.ino },
      startedAt: state.startedAt,
      anchor: { dev: file.dev, ino: file.ino },
      identityPin: state.outputJournalIdentity,
      headPin: pin,
      head,
      ...(state.outputJournalStorage ? { storagePin: state.outputJournalStorage } : {}),
    };
    return { root: canonicalRoot, directory: dir, statePath, state, authority };
  } finally {
    fs.closeSync(anchor);
  }
}
function assertAuthority(at: Location, expected = at.authority): Location {
  const now = locate(at.root, expected.sessionId, expected.anchor);
  requireRepair(
    JSON.stringify(now.authority) === JSON.stringify(expected),
    "authority_mismatch",
    "Current Session, published head or storage authority changed",
  );
  return now;
}
function locked<T>(
  root: string,
  sessionId: string,
  work: (at: Location, assertLock: () => void) => T,
): T {
  const before = locate(root, sessionId);
  const release = lockSync(before.statePath, {
    realpath: false,
    retries: 0,
    stale: 120000,
    update: 60000,
  });
  const lockPath = before.statePath + ".lock",
    pin = directory(lockPath);
  const assertLock = () => {
    requireRepair(
      sameInode(directory(lockPath), pin),
      "lock_lost",
      "Output repair state lease was replaced",
    );
    // A synchronous copy cannot run the async lease timer. Refresh explicitly
    // so other supported writers never mistake this bounded operation for stale.
    const now = new Date();
    fs.utimesSync(lockPath, now, now);
  };
  let result: T, primary: unknown;
  try {
    assertLock();
    const at = assertAuthority(before);
    result = work(at, assertLock);
    assertLock();
  } catch (error) {
    primary = error;
  }
  try {
    assertLock();
    release();
  } catch (error) {
    if (primary)
      throw new AggregateError([primary, error], "Output repair and lease release failed", {
        cause: error,
      });
    throw error;
  }
  if (primary) throw primary;
  return result!;
}
function currentStorage(at: Location): RepairStorageManifest | undefined {
  if (!at.authority.storagePin) return undefined;
  return parseRepairStorage(
    readBytes(join(at.directory, OUTPUT_SEGMENTS), 32768, false, at.authority.storagePin.file),
    at.authority,
  );
}
function inventory(storage?: RepairStorageManifest): string[] {
  return [
    "state.json",
    OUTPUT_ANCHOR,
    OUTPUT_HEAD,
    ...(storage ? [OUTPUT_SEGMENTS, ...storage.segments.map((s) => s.name)] : []),
  ];
}
function copyFile(from: number, destination: string, name: string): BackupFile {
  const before = stamp(from),
    original = fs.fstatSync(from);
  requireRepair(
    original.size <= MAX_FILE,
    "file_budget",
    "Output evidence exceeds its per-file bound",
  );
  const target = fs.openSync(
    destination,
    flags(fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL),
    0o600,
  );
  const hash = createHash("sha256");
  let offset = 0;
  try {
    readRange(from, 0, original.size, (chunk) => {
      hash.update(chunk);
      writeAll(target, chunk, offset);
      offset += chunk.length;
    });
    fs.fsyncSync(target);
    requireRepair(
      before === stamp(from),
      "source_changed",
      "Output source changed during evidence copy",
    );
    return {
      name,
      dev: original.dev,
      ino: original.ino,
      bytes: original.size,
      sha256: hash.digest("hex"),
    };
  } finally {
    fs.closeSync(target);
  }
}
interface Bundle {
  directory: string;
  manifest: OutputJournalBackupManifest;
  digest: string;
  fds: Map<string, number>;
  storage?: RepairStorageManifest;
}
function openBundle(path: string): Bundle {
  const dir = canonicalTarget(path);
  directory(dir);
  const text = readBytes(join(dir, OUTPUT_BACKUP_MANIFEST), 128 * 1024),
    manifest = decodeJson(text) as OutputJournalBackupManifest;
  requireRepair(
    manifest?.format === "codeshell-output-journal-backup" &&
      manifest.version === 1 &&
      Array.isArray(manifest.files) &&
      manifest.files.length >= 3 &&
      manifest.files.length <= 20,
    "bundle_invalid",
    "Unsupported or incomplete output backup",
  );
  requireRepair(
    fs.readdirSync(dir).sort().join() ===
      [OUTPUT_BACKUP_MANIFEST, ...manifest.files.map((f) => f.name)].sort().join(),
    "bundle_invalid",
    "Backup contains unexpected or missing files",
  );
  const fds = new Map<string, number>();
  let total = 0;
  try {
    for (const file of manifest.files) {
      requireRepair(
        ["state.json", OUTPUT_ANCHOR, OUTPUT_HEAD, OUTPUT_SEGMENTS].includes(file.name) ||
          /^output-segment-[a-f0-9-]{36}\.jsonl$/.test(file.name),
        "bundle_invalid",
        "Unsafe backup file name",
      );
      requireRepair(
        validIdentity(file) &&
          Number.isSafeInteger(file.bytes) &&
          file.bytes >= 0 &&
          file.bytes <= MAX_FILE &&
          /^[a-f0-9]{64}$/.test(file.sha256) &&
          !fds.has(file.name),
        "bundle_invalid",
        "Invalid backup descriptor",
      );
      total += file.bytes;
      requireRepair(
        total <= MAX_OUTPUT_REPAIR_BYTES,
        "file_budget",
        "Backup exceeds its total bound",
      );
      const fd = openFile(join(dir, file.name));
      fds.set(file.name, fd);
      const before = stamp(fd),
        hash = createHash("sha256");
      requireRepair(
        fs.fstatSync(fd).size === file.bytes,
        "bundle_invalid",
        "Backup file length differs",
      );
      readRange(fd, 0, file.bytes, (chunk) => {
        hash.update(chunk);
      });
      requireRepair(
        hash.digest("hex") === file.sha256 && stamp(fd) === before,
        "bundle_invalid",
        "Backup checksum failed",
      );
    }
    const checked = verifyBackupChain(manifest, (name, start, end, consume) =>
      readRange(fds.get(name)!, start, end, consume),
    );
    return { directory: dir, manifest, digest: sha256(text), fds, storage: checked.storage };
  } catch (error) {
    for (const fd of fds.values()) fs.closeSync(fd);
    throw error;
  }
}
function closeBundle(bundle: Bundle): void {
  for (const fd of bundle.fds.values()) fs.closeSync(fd);
}
function verifyConsumer(at: Location, floor: OutputJournalBackupManifest["floor"]): void {
  const through = outputRepairCursor(at.authority, at.authority.head);
  let after = outputRepairCursor(at.authority, floor),
    loops = 0;
  for (;;) {
    const page = readOutputJournal(at.root, at.authority.sessionId, { after, through });
    requireRepair(
      page.status === "ok" && page.through === through && page.next && !page.uncommittedTail,
      "consumer_incomplete",
      "The actual output consumer cannot verify the complete published prefix",
    );
    if (page.complete) return;
    requireRepair(
      page.next !== after && ++loops <= 1000000,
      "consumer_incomplete",
      "Output consumer pagination stalled",
    );
    after = page.next;
  }
}
/** An explicit complete snapshot; never copies a live, unproved or sticky-gap prefix. */
export function backupOutputJournal(
  root: string,
  sessionId: string,
  destination: string,
): { directory: string; through: string; files: number } {
  return locked(root, sessionId, (at, assertLock) => {
    requireRepair(
      !isOutputJournalRepairPending(at.directory),
      "repair_pending",
      "Finish or diagnose the pending repair first",
    );
    const storage = currentStorage(at);
    const anchor = readBytes(join(at.directory, OUTPUT_ANCHOR), MAX_FILE),
      end = anchor.indexOf(10);
    requireRepair(end >= 0, "chain_invalid", "Output header is missing");
    const floor = storage?.floor ?? {
      sequence: 0,
      offset: end + 1,
      hash: at.authority.identityPin,
    };
    verifyConsumer(at, floor);
    const target = canonicalTarget(destination);
    requireRepair(
      !outputRepairPathsOverlap(target, at.directory) && !named(target),
      "invalid_path",
      "Backup must be a new directory separate from this Session",
    );
    fs.mkdirSync(target, { mode: 0o700 });
    const targetPin = directory(target),
      files: BackupFile[] = [];
    let total = 0;
    for (const name of inventory(storage)) {
      const source = openFile(join(at.directory, name));
      try {
        const item = copyFile(source, join(target, name), name);
        total += item.bytes;
        files.push(item);
      } finally {
        fs.closeSync(source);
      }
      requireRepair(
        total <= MAX_OUTPUT_REPAIR_BYTES,
        "file_budget",
        "Backup exceeds its total bound",
      );
      assertLock();
      assertAuthority(at);
      requireRepair(
        sameInode(directory(target), targetPin),
        "path_replaced",
        "Backup destination was replaced",
      );
    }
    const manifest: OutputJournalBackupManifest = {
      format: "codeshell-output-journal-backup",
      version: 1,
      authority: at.authority,
      floor,
      files,
    };
    writePrivate(
      join(target, OUTPUT_BACKUP_MANIFEST),
      Buffer.from(JSON.stringify(manifest) + "\n"),
    );
    syncDirectory(target);
    syncDirectory(dirname(target));
    const bundle = openBundle(target);
    try {
      verifyConsumer(at, floor);
      assertAuthority(at);
      assertLock();
    } finally {
      closeBundle(bundle);
    }
    return {
      directory: target,
      through: outputRepairCursor(at.authority, at.authority.head),
      files: files.length,
    };
  });
}

interface Evidence {
  version: 1;
  authority: RepairAuthority;
  bundleDigest: string;
  files: (BackupFile | { name: string; missing: true })[];
}
interface Pending {
  version: 1;
  attempt: string;
  evidence: string;
  receiptSha256: string;
  bundleDigest: string;
  authority: RepairAuthority;
}
interface Created extends FileIdentity {
  version: 1;
  name: string;
  temp: string;
  bytes: number;
  sha256: string;
}
function assertFreshEvidence(at: Location, evidence: Evidence): void {
  for (const file of evidence.files) {
    if (file.name === "state.json") continue; // Independent sticky flags are retained, never rewritten.
    const path = join(at.directory, file.name);
    if ("missing" in file) {
      requireRepair(
        !named(path),
        "source_changed",
        "A missing segment appeared after evidence capture",
      );
      continue;
    }
    const fd = openFile(path, fs.constants.O_RDONLY, file);
    try {
      const before = stamp(fd),
        hash = createHash("sha256");
      requireRepair(
        fs.fstatSync(fd).size === file.bytes,
        "source_changed",
        "Source length changed after evidence capture",
      );
      readRange(fd, 0, file.bytes, (chunk) => {
        hash.update(chunk);
      });
      requireRepair(
        before === stamp(fd) && hash.digest("hex") === file.sha256,
        "source_changed",
        "Source changed after complete evidence capture",
      );
    } finally {
      fs.closeSync(fd);
    }
  }
}
function captureEvidence(
  at: Location,
  bundle: Bundle,
  missing: Set<string>,
): { pending: Pending; evidence: Evidence; directory: string } {
  const attempt = randomUUID(),
    evidenceName = `.output-manual-repair-${attempt}`,
    dir = join(at.directory, evidenceName);
  fs.mkdirSync(dir, { mode: 0o700 });
  const data = join(dir, "source");
  fs.mkdirSync(data, { mode: 0o700 });
  const evidence: Evidence = {
    version: 1,
    authority: at.authority,
    bundleDigest: bundle.digest,
    files: [],
  };
  let total = 0;
  for (const name of inventory(bundle.storage)) {
    if (missing.has(name)) {
      evidence.files.push({ name, missing: true });
      continue;
    }
    const expected =
      name === "state.json" ? undefined : bundle.manifest.files.find((file) => file.name === name);
    const fd = openFile(join(at.directory, name), fs.constants.O_RDONLY, expected);
    try {
      const file = copyFile(fd, join(data, name), name);
      evidence.files.push(file);
      total += file.bytes;
    } finally {
      fs.closeSync(fd);
    }
    requireRepair(
      total <= MAX_OUTPUT_REPAIR_BYTES,
      "file_budget",
      "Damaged-source evidence exceeds its complete-copy bound",
    );
  }
  atomicReceipt(join(dir, "receipt.json"), evidence);
  syncDirectory(data);
  syncDirectory(dir);
  syncDirectory(at.directory);
  assertAuthority(at);
  const receiptSha256 = sha256(readBytes(join(dir, "receipt.json"), 128 * 1024));
  return {
    pending: {
      version: 1,
      attempt,
      evidence: evidenceName,
      receiptSha256,
      bundleDigest: bundle.digest,
      authority: at.authority,
    },
    evidence,
    directory: dir,
  };
}
function loadEvidence(
  at: Location,
  bundle: Bundle,
): { pending: Pending; evidence: Evidence; directory: string } {
  const pending = unseal(join(at.directory, OUTPUT_REPAIR_PENDING)) as Pending;
  requireRepair(
    pending?.version === 1 &&
      /^[a-f0-9-]{36}$/.test(pending.attempt) &&
      pending.evidence === `.output-manual-repair-${pending.attempt}` &&
      pending.bundleDigest === bundle.digest &&
      JSON.stringify(pending.authority) === JSON.stringify(at.authority),
    "pending_mismatch",
    "Pending repair belongs to a different backup or published authority",
  );
  const dir = join(at.directory, pending.evidence);
  directory(dir);
  directory(join(dir, "source"));
  const receipt = readBytes(join(dir, "receipt.json"), 128 * 1024);
  requireRepair(
    sha256(receipt) === pending.receiptSha256,
    "evidence_invalid",
    "Original evidence receipt changed",
  );
  const evidence = unseal(join(dir, "receipt.json")) as Evidence;
  requireRepair(
    evidence.version === 1 &&
      JSON.stringify(evidence.authority) === JSON.stringify(at.authority) &&
      evidence.bundleDigest === bundle.digest &&
      Array.isArray(evidence.files) &&
      evidence.files
        .map((x) => x.name)
        .sort()
        .join() === inventory(bundle.storage).sort().join(),
    "evidence_invalid",
    "Original damaged-source inventory is incomplete",
  );
  for (const file of evidence.files) {
    if ("missing" in file) {
      requireRepair(
        bundle.storage?.segments.some((x) => x.name === file.name),
        "evidence_invalid",
        "Only a proved segment may have been missing",
      );
      continue;
    }
    const fd = openFile(join(dir, "source", file.name));
    try {
      const hash = createHash("sha256");
      requireRepair(
        fs.fstatSync(fd).size === file.bytes,
        "evidence_invalid",
        "Original evidence length changed",
      );
      readRange(fd, 0, file.bytes, (chunk) => {
        hash.update(chunk);
      });
      requireRepair(
        hash.digest("hex") === file.sha256,
        "evidence_invalid",
        "Original damaged-source evidence changed",
      );
    } finally {
      fs.closeSync(fd);
    }
  }
  return { pending, evidence, directory: dir };
}
function createdSegment(dir: string, segment: BackupFile, source: number): Created {
  const receiptPath = join(dir, `created-${segment.name}.json`);
  if (named(receiptPath)) {
    const created = unseal(receiptPath) as Created;
    requireRepair(
      created.version === 1 &&
        created.name === segment.name &&
        validIdentity(created) &&
        /^\.segment-[a-f0-9-]{36}\.tmp$/.test(created.temp) &&
        created.bytes === segment.bytes &&
        created.sha256 === segment.sha256,
      "evidence_invalid",
      "Created segment receipt is invalid",
    );
    // Reflush before exclusive publication after any interrupted receipt fsync.
    atomicReceipt(receiptPath, created);
    return created;
  }
  const temp = `.segment-${randomUUID()}.tmp`,
    file = copyFile(source, join(dir, temp), segment.name);
  requireRepair(
    file.bytes === segment.bytes && file.sha256 === segment.sha256,
    "bundle_invalid",
    "Backup segment changed while preparing its replacement",
  );
  const actual = named(join(dir, temp))!;
  const created: Created = {
    version: 1,
    name: segment.name,
    temp,
    dev: actual.dev,
    ino: actual.ino,
    bytes: file.bytes,
    sha256: file.sha256,
  };
  atomicReceipt(receiptPath, created);
  return created;
}
function restoreFile(source: number, destination: number, bytes: number, from = 0): void {
  let offset = from;
  readRange(source, from, bytes, (chunk) => {
    writeAll(destination, chunk, offset);
    offset += chunk.length;
  });
  fs.ftruncateSync(destination, bytes);
  fs.fsyncSync(destination);
}

/** Repairs only the exact current head, on the original anchor/manifest inodes. */
export function restoreOutputJournalBackup(
  root: string,
  sessionId: string,
  backup: string,
): {
  status: "repaired";
  through: string;
  evidenceDirectory: string;
  coverage: "ok" | "incomplete";
} {
  const bundle = openBundle(backup);
  try {
    return locked(root, sessionId, (at, assertLock) => {
      requireRepair(
        JSON.stringify(at.authority) === JSON.stringify(bundle.manifest.authority),
        "head_mismatch",
        "Backup is stale or belongs to another root, inode, head or authority",
      );
      let attempt: ReturnType<typeof captureEvidence>;
      const pendingPath = join(at.directory, OUTPUT_REPAIR_PENDING),
        pendingExists = !!named(pendingPath);
      let current: RepairStorageManifest | undefined;
      if (pendingExists) {
        attempt = loadEvidence(at, bundle);
        const original = attempt.evidence.files.find((file) => file.name === OUTPUT_SEGMENTS);
        if (bundle.storage) {
          requireRepair(
            original && !("missing" in original),
            "manifest_unproved",
            "Pending repair has no original manifest proof",
          );
          current = parseRepairStorage(
            readBytes(join(attempt.directory, "source", OUTPUT_SEGMENTS), 32768),
            at.authority,
          );
          requireRepair(
            JSON.stringify(current) === JSON.stringify(bundle.storage),
            "retention_mismatch",
            "Pending retention floor differs from the backup",
          );
          // A valid, newer floor is never rolled back, even by an interrupted repair.
          let live: RepairStorageManifest | undefined;
          try {
            live = currentStorage(at);
          } catch {
            /* The pending receipt proves our pre-write manifest. */
          }
          requireRepair(
            !live || logicalStorage(live) === logicalStorage(current),
            "retention_mismatch",
            "Current retention floor advanced during the interrupted repair",
          );
        }
      } else {
        current = currentStorage(at);
        requireRepair(
          !bundle.storage ||
            (current && JSON.stringify(current) === JSON.stringify(bundle.storage)),
          "retention_mismatch",
          "Current manifest, retained floor or segment chain differs from the backup",
        );
        const missing = new Set<string>();
        for (const file of bundle.manifest.files) {
          if (file.name === "state.json") continue;
          const path = join(at.directory, file.name),
            stat = named(path);
          if (!stat && current?.segments.some((s) => s.name === file.name)) {
            missing.add(file.name);
            continue;
          }
          const fd = openFile(path, fs.constants.O_RDONLY, file);
          fs.closeSync(fd);
        }
        attempt = captureEvidence(at, bundle, missing);
        atomicReceipt(pendingPath, attempt.pending);
      }
      // Valid pending evidence can be retried; never erase a malformed pending marker.
      const marker = openFile(pendingPath),
        markerIdentity = fs.fstatSync(marker),
        markerHash = sha256(readBytes(pendingPath, 128 * 1024));
      try {
        fs.fsyncSync(marker);
      } finally {
        fs.closeSync(marker);
      }
      syncDirectory(at.directory);
      const assertMarker = () => {
        const fd = openFile(pendingPath, fs.constants.O_RDONLY, markerIdentity);
        try {
          requireRepair(
            sha256(readBytes(pendingPath, 128 * 1024)) === markerHash,
            "pending_mismatch",
            "Pending repair marker changed during restore",
          );
        } finally {
          fs.closeSync(fd);
        }
      };
      assertLock();
      assertAuthority(at);
      assertMarker();
      const readyPath = join(attempt.directory, "source-verified.json"),
        readyProof = {
          bundleDigest: bundle.digest,
          receiptSha256: attempt.pending.receiptSha256,
        };
      // Pending alone grants no overwrite permission: a refusal between capture
      // and this durable checkpoint must continue to preserve a changed source.
      if (!named(readyPath)) assertFreshEvidence(at, attempt.evidence);
      atomicReceipt(readyPath, readyProof);
      assertLock();
      assertAuthority(at);
      assertMarker();
      const targets = new Map<string, number>();
      try {
        const anchor = openFile(
          join(at.directory, OUTPUT_ANCHOR),
          fs.constants.O_RDWR,
          at.authority.anchor,
        );
        targets.set(OUTPUT_ANCHOR, anchor);
        writeAll(anchor, Buffer.from("!"), 0);
        fs.fsyncSync(anchor);
        const updated = current ? structuredClone(current) : undefined;
        for (const file of bundle.manifest.files) {
          if (["state.json", OUTPUT_HEAD, OUTPUT_ANCHOR, OUTPUT_SEGMENTS].includes(file.name))
            continue;
          const originalEvidence = attempt.evidence.files.find((x) => x.name === file.name)!;
          const path = join(at.directory, file.name);
          let identity: FileIdentity = file;
          if ("missing" in originalEvidence) {
            const created = createdSegment(attempt.directory, file, bundle.fds.get(file.name)!);
            const temp = join(attempt.directory, created.temp),
              live = named(path);
            if (!live) {
              const tempFd = openFile(temp, fs.constants.O_RDONLY, created, true);
              try {
                requireRepair(
                  fs.fstatSync(tempFd).size === file.bytes,
                  "evidence_invalid",
                  "Prepared segment length changed",
                );
              } finally {
                fs.closeSync(tempFd);
              }
              fs.linkSync(temp, path); // A concurrent writer can only make this fail, never be overwritten.
              syncDirectory(at.directory);
            }
            requireRepair(
              sameInode(named(path)!, created),
              "path_replaced",
              "Missing segment was replaced during repair",
            );
            if (named(temp)) {
              requireRepair(
                sameInode(named(temp)!, created),
                "path_replaced",
                "Private prepared segment was replaced",
              );
              fs.unlinkSync(temp);
              syncDirectory(attempt.directory);
            }
            identity = created;
            const entry = updated!.segments.find((x) => x.name === file.name)!;
            entry.dev = created.dev;
            entry.ino = created.ino;
          }
          const fd = openFile(path, fs.constants.O_RDWR, identity);
          targets.set(file.name, fd);
          restoreFile(bundle.fds.get(file.name)!, fd, file.bytes);
          assertLock();
          assertAuthority(at);
        }
        if (updated) {
          const fd = openFile(
            join(at.directory, OUTPUT_SEGMENTS),
            fs.constants.O_RDWR,
            at.authority.storagePin!.file,
          );
          targets.set(OUTPUT_SEGMENTS, fd);
          const data = encodeRepairStorage(updated);
          writeAll(fd, data, 0);
          fs.ftruncateSync(fd, data.length);
          fs.fsyncSync(fd);
        }
        const anchorFile = bundle.manifest.files.find((f) => f.name === OUTPUT_ANCHOR)!;
        restoreFile(bundle.fds.get(OUTPUT_ANCHOR)!, anchor, anchorFile.bytes, 1);
        for (const [name, fd] of targets) {
          const file = bundle.manifest.files.find((f) => f.name === name)!;
          const hash = createHash("sha256");
          let firstChunk = true;
          const originalFirstByte = Buffer.alloc(1);
          fs.readSync(bundle.fds.get(OUTPUT_ANCHOR)!, originalFirstByte, 0, 1, 0);
          readRange(fd, 0, fs.fstatSync(fd).size, (chunk) => {
            if (name === OUTPUT_ANCHOR && firstChunk) {
              const data = Buffer.from(chunk);
              data[0] = originalFirstByte[0]!;
              hash.update(data);
            } else hash.update(chunk);
            firstChunk = false;
          });
          const expected =
            name === OUTPUT_SEGMENTS ? sha256(encodeRepairStorage(updated!)) : file.sha256;
          requireRepair(
            hash.digest("hex") === expected &&
              sameInode(named(join(at.directory, name))!, fs.fstatSync(fd)),
            "restore_changed",
            "Restored file is not the complete proved backup",
          );
        }
        assertLock();
        assertAuthority(at);
        assertMarker();
        // All body/segment/manifest bytes are durable before the historical-parser barrier clears.
        const first = Buffer.alloc(1);
        fs.readSync(bundle.fds.get(OUTPUT_ANCHOR)!, first, 0, 1, 0);
        writeAll(anchor, first, 0);
        fs.fsyncSync(anchor);
        atomicReceipt(join(attempt.directory, "result.json"), {
          version: 1,
          status: "restored",
          head: at.authority.head,
          floor: bundle.manifest.floor,
        });
        assertLock();
        assertAuthority(at);
        assertMarker();
        fs.unlinkSync(pendingPath);
        try {
          syncDirectory(at.directory);
        } catch (error) {
          try {
            atomicReceipt(pendingPath, attempt.pending);
            syncDirectory(at.directory);
          } catch (barrierError) {
            throw new AggregateError(
              [error, barrierError],
              "Restored output is proved, but pending-marker publication failed",
              { cause: barrierError },
            );
          }
          throw error;
        }
        const final = assertAuthority(at),
          sticky =
            !!final.state.outputRecoveryIncomplete ||
            !!final.state.outputCoverage?.unpaired ||
            !!final.state.outputCoverage?.inputIds?.length;
        if (!final.state.outputRecoveryIncomplete) verifyConsumer(final, bundle.manifest.floor);
        return {
          status: "repaired",
          through: outputRepairCursor(at.authority, at.authority.head),
          evidenceDirectory: attempt.directory,
          coverage: sticky ? "incomplete" : "ok",
        };
      } finally {
        for (const fd of targets.values()) fs.closeSync(fd);
      }
    });
  } finally {
    closeBundle(bundle);
  }
}

/** Diagnosis never changes the journal or clears sticky coverage evidence. */
export function inspectOutputJournalRepair(
  root: string,
  sessionId: string,
): {
  status: "ok" | "incomplete";
  pending: boolean;
  published?: { sequence: number; offset: number; hash: string };
  stickyGap: boolean;
  reason?: string;
} {
  let pending = false;
  try {
    if (
      isAbsolute(root) &&
      /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(sessionId) &&
      !sessionId.includes("..")
    ) {
      pending = isOutputJournalRepairPending(join(fs.realpathSync(root), sessionId));
    }
    const at = locate(root, sessionId);
    const stickyGap =
      !!at.state.outputRecoveryIncomplete ||
      !!at.state.outputCoverage?.unpaired ||
      !!at.state.outputCoverage?.inputIds?.length;
    let reason: string | undefined;
    try {
      const storage = currentStorage(at);
      if (!pending && !at.state.outputRecoveryIncomplete) {
        const first = readBytes(join(at.directory, OUTPUT_ANCHOR), MAX_FILE),
          newline = first.indexOf(10);
        verifyConsumer(
          at,
          storage?.floor ?? { sequence: 0, offset: newline + 1, hash: at.authority.identityPin },
        );
      } else reason = pending ? "repair_pending" : "sticky_gap";
    } catch (error) {
      reason = error instanceof Error ? error.message : "unproved_output";
    }
    return {
      status: reason || stickyGap ? "incomplete" : "ok",
      pending,
      published: {
        sequence: at.authority.head.sequence,
        offset: at.authority.head.offset,
        hash: at.authority.head.hash,
      },
      stickyGap,
      ...(reason ? { reason } : {}),
    };
  } catch (error) {
    return {
      status: "incomplete",
      pending,
      stickyGap: true,
      reason: error instanceof Error ? error.message : "authority_unproved",
    };
  }
}
