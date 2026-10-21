/** Explicit offline re-admission of legacy device-number bindings. Never rewrites chat bytes. */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { lockSync } from "../utils/lockfile.js";
import { STATE_LEASE_LOCK_OPTIONS } from "./output-journal-state-lease.js";
import {
  capturePersistentFileIdentity,
  matchesPersistentFileIdentity,
  type PersistentFileIdentity,
} from "./persistent-file-identity.js";
import {
  validateOutputJournalBinding,
  type OutputJournalBinding,
} from "./output-journal-binding.js";
import { readOutputJournal } from "./output-journal.js";
import { SessionOutputCoverageStore } from "./output-coverage-state.js";
import {
  decodeJson,
  OUTPUT_ANCHOR,
  OUTPUT_HEAD,
  OUTPUT_REPAIR_PENDING,
  requireRepair,
  sha256,
  validPosition,
  verifyBackupChain,
  type BackupFile,
  type OutputJournalBackupManifest,
} from "./output-journal-backup-format.js";

const FORMAT = "codeshell-output-identity-migration";
const MAX_FILE = 128 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const MAX_FILES = 4096;
const MAX_RECEIPT = 8 * 1024 * 1024;
const RECEIPT = "receipt.json";
const RESULT = "result.json";
const SOURCE = "source";
const hex = /^[a-f0-9]{64}$/;
const operationId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const validInputId = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= 512;
type AssertLease = () => void;
const noLease: AssertLease = () => {};
const flags = (mode: number) =>
  mode | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

export interface OutputIdentityMigrationOptions {
  acceptLegacyIdentity: boolean;
  resumeWithRecordedGap?: boolean;
  /** Durable progress notifications; a thrown callback leaves a retryable checkpoint. */
  onCheckpoint?: (
    phase: "evidence-durable" | "barrier-durable" | "state-durable" | "consumer-verified",
  ) => void;
}
export interface OutputIdentityMigrationResult {
  version: 1;
  status: "migrated" | "already_migrated";
  sessionId: string;
  evidenceDirectory: string;
  journalIdentity: string;
  coverageIdentity: string;
  historicalGap: boolean;
  transcriptSha256: string;
}
interface SourceFile {
  name: string;
  bytes: number;
  sha256: string;
  dev: number;
  ino: number;
  stamp: string;
  stable: PersistentFileIdentity;
}
interface Receipt {
  format: typeof FORMAT;
  version: 1;
  id: string;
  root: string;
  sessionId: string;
  evidenceDirectory: string;
  createdAt: string;
  resumeWithRecordedGap: boolean;
  files: SourceFile[];
  binding: OutputJournalBinding;
  state: Record<string, any>;
  transcriptSha256: string;
  historicalGap: boolean;
}

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function stamp(fd: number): string {
  const at = fs.fstatSync(fd, { bigint: true });
  return `${at.dev}:${at.ino}:${at.size}:${at.mtimeNs}:${at.ctimeNs}`;
}
function openFile(path: string, mode = fs.constants.O_RDONLY, receiptAlias = false): number {
  const fd = fs.openSync(path, flags(mode), 0o600);
  try {
    const at = fs.fstatSync(fd),
      named = fs.lstatSync(path);
    requireRepair(
      at.isFile() &&
        (receiptAlias ? at.nlink <= 2 : at.nlink === 1) &&
        named.isFile() &&
        !named.isSymbolicLink() &&
        sameFile(at, named),
      "path_replaced",
      "Identity migration requires private regular files without aliases",
    );
    return fd;
  } catch (cause) {
    fs.closeSync(fd);
    throw cause;
  }
}
function bytes(
  path: string,
  limit = MAX_FILE,
  receiptAlias = false,
  flush = false,
  assertLease = noLease,
): Buffer {
  assertLease();
  const fd = openFile(path, fs.constants.O_RDONLY, receiptAlias);
  try {
    const before = stamp(fd),
      size = fs.fstatSync(fd).size;
    requireRepair(
      size >= 0 && size <= limit,
      "file_budget",
      "Identity migration file exceeds its bound",
    );
    const result = Buffer.alloc(size);
    for (let offset = 0; offset < size; ) {
      assertLease();
      const count = fs.readSync(fd, result, offset, Math.min(65536, size - offset), offset);
      requireRepair(count > 0, "source_changed", "Identity migration source changed");
      offset += count;
    }
    requireRepair(
      stamp(fd) === before && sameFile(fs.lstatSync(path), fs.fstatSync(fd)),
      "source_changed",
      "Identity migration source changed",
    );
    if (flush) {
      assertLease();
      fs.fsyncSync(fd);
    }
    return result;
  } finally {
    fs.closeSync(fd);
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
function writeAll(fd: number, data: Buffer, start = 0, assertLease = noLease): void {
  for (let offset = start; offset < data.length; ) {
    assertLease();
    const count = fs.writeSync(fd, data, offset, Math.min(65536, data.length - offset), offset);
    requireRepair(count > 0, "write_failed", "Identity migration write made no progress");
    offset += count;
  }
  assertLease();
  fs.fsyncSync(fd);
}
function exists(path: string): boolean {
  try {
    fs.lstatSync(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}
function privateDirectory(path: string): void {
  if (!exists(path)) fs.mkdirSync(path, { mode: 0o700 });
  const at = fs.lstatSync(path);
  requireRepair(
    at.isDirectory() && !at.isSymbolicLink(),
    "path_replaced",
    "Expected an ordinary private directory",
  );
}
function evidenceParents(evidence: string, name: string, create: boolean): void {
  let parent = join(evidence, SOURCE);
  for (const part of name.split("/").slice(0, -1)) {
    parent = join(parent, part);
    if (create) privateDirectory(parent);
    else {
      const at = fs.lstatSync(parent);
      requireRepair(
        at.isDirectory() && !at.isSymbolicLink(),
        "path_replaced",
        "Evidence parent directory was replaced",
      );
    }
  }
}
function sealed(value: unknown): Buffer {
  return Buffer.from(JSON.stringify({ value, sha256: sha256(JSON.stringify(value)) }) + "\n");
}
function unseal(path: string): any {
  const wrapper = decodeJson(bytes(path, MAX_RECEIPT, true));
  requireRepair(
    wrapper && wrapper.sha256 === sha256(JSON.stringify(wrapper.value)),
    "evidence_invalid",
    "Identity migration receipt checksum failed",
  );
  const at = fs.lstatSync(path);
  if (at.nlink === 2) {
    requireRepair(
      typeof wrapper.alias === "string" &&
        /^\.identity-receipt-[a-f0-9-]{36}\.tmp$/.test(wrapper.alias),
      "evidence_invalid",
      "Migration receipt has an unknown alias",
    );
    const alias = join(dirname(path), wrapper.alias),
      other = fs.lstatSync(alias);
    requireRepair(
      other.isFile() && !other.isSymbolicLink() && sameFile(at, other),
      "evidence_invalid",
      "Migration receipt alias was replaced",
    );
    fs.unlinkSync(alias);
    syncDirectory(dirname(path));
  }
  return wrapper.value;
}
/** A receipt is visible only after the full file and its directory entry are durable. */
function publishReceipt(path: string, value: unknown, id: string, assertLease = noLease): void {
  assertLease();
  if (exists(path)) {
    requireRepair(
      JSON.stringify(unseal(path)) === JSON.stringify(value),
      "evidence_invalid",
      "Existing migration receipt differs",
    );
    return;
  }
  const temp = join(dirname(path), `.identity-receipt-${id}.tmp`);
  const data = Buffer.from(
    JSON.stringify({ value, sha256: sha256(JSON.stringify(value)), alias: basename(temp) }) + "\n",
  );
  requireRepair(data.length <= MAX_RECEIPT, "file_budget", "Migration receipt exceeds its bound");
  writeExclusive(temp, data, assertLease);
  assertLease();
  fs.linkSync(temp, path);
  fs.unlinkSync(temp);
  syncDirectory(dirname(path));
}
/** Exclusive, retryable publication. A partial private file is completed only from its exact prefix. */
function writeExclusive(path: string, data: Buffer, assertLease = noLease): void {
  assertLease();
  if (!exists(path)) {
    const fd = fs.openSync(
      path,
      flags(fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL),
      0o600,
    );
    try {
      writeAll(fd, data, 0, assertLease);
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  const fd = openFile(path, fs.constants.O_RDWR);
  try {
    const current = bytes(path, data.length, false, false, assertLease);
    requireRepair(
      current.equals(data.subarray(0, current.length)),
      "evidence_invalid",
      "Existing migration evidence differs",
    );
    writeAll(fd, data, current.length, assertLease);
  } finally {
    fs.closeSync(fd);
  }
}
function contains(parent: string, child: string): boolean {
  const at = relative(parent, child);
  return at === "" || (!isAbsolute(at) && at !== ".." && !at.startsWith(".." + sep));
}
function inventory(
  directory: string,
  ignored = new Set<string>(),
  assertLease = noLease,
): SourceFile[] {
  const files: SourceFile[] = [];
  let total = 0,
    directories = 0;
  const visit = (base: string, prefix = "") => {
    requireRepair(++directories <= MAX_FILES, "file_budget", "Too many session directories");
    for (const entry of fs
      .readdirSync(base, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      assertLease();
      if (!prefix && (entry.name === "state.json.lock" || ignored.has(entry.name))) continue;
      const name = prefix ? prefix + "/" + entry.name : entry.name;
      const path = join(base, entry.name),
        at = fs.lstatSync(path);
      requireRepair(
        !at.isSymbolicLink(),
        "path_replaced",
        "Session inventory contains a symbolic link",
      );
      if (at.isDirectory()) {
        visit(path, name);
        continue;
      }
      requireRepair(
        at.isFile() && at.nlink === 1 && at.size <= MAX_FILE,
        "file_budget",
        "Session inventory contains an unsupported file",
      );
      total += at.size;
      requireRepair(
        files.length < MAX_FILES && total <= MAX_TOTAL,
        "file_budget",
        "Session inventory exceeds its evidence budget",
      );
      const fd = openFile(path);
      try {
        files.push({
          name,
          bytes: at.size,
          sha256: sha256(bytes(path, MAX_FILE, false, false, assertLease)),
          dev: at.dev,
          ino: at.ino,
          stamp: stamp(fd).split(":").slice(1).join(":"),
          stable: capturePersistentFileIdentity(path),
        });
      } finally {
        fs.closeSync(fd);
      }
    }
  };
  visit(directory);
  return files;
}
function assertInventory(
  directory: string,
  expected: SourceFile[],
  migratedState?: Buffer,
  migrationId?: string,
  assertLease = noLease,
): void {
  const current = inventory(
    directory,
    new Set([
      OUTPUT_REPAIR_PENDING,
      ...(migrationId ? [`.output-identity-state-${migrationId}.tmp`] : []),
    ]),
    assertLease,
  );
  requireRepair(
    current.length === expected.length,
    "source_changed",
    "Session inventory changed during migration",
  );
  for (let index = 0; index < expected.length; index++) {
    const at = current[index]!,
      before = expected[index]!;
    requireRepair(
      at.name === before.name,
      "source_changed",
      "Session inventory changed during migration",
    );
    if (at.name === "state.json" && migratedState) {
      requireRepair(
        at.bytes === migratedState.length && at.sha256 === sha256(migratedState),
        "source_changed",
        "Migrated state changed",
      );
    } else {
      requireRepair(
        at.bytes === before.bytes &&
          at.sha256 === before.sha256 &&
          matchesPersistentFileIdentity(join(directory, at.name), before.stable) &&
          at.stamp === before.stamp,
        "source_changed",
        "Session bytes or identity changed during migration",
      );
    }
  }
}
function verifySourceEvidence(evidence: string, files: SourceFile[], assertLease = noLease): void {
  const directories = new Set<string>([join(evidence, SOURCE)]);
  for (const file of files) {
    assertLease();
    requireRepair(
      typeof file.name === "string" &&
        file.name
          .split("/")
          .every((part) => part && part !== "." && part !== ".." && !part.includes("\\")),
      "evidence_invalid",
      "Unsafe evidence name",
    );
    evidenceParents(evidence, file.name, false);
    const path = join(evidence, SOURCE, file.name);
    const data = bytes(path, MAX_FILE, false, true, assertLease);
    requireRepair(
      data.length === file.bytes && sha256(data) === file.sha256,
      "evidence_invalid",
      "Session evidence is incomplete or changed",
    );
    for (
      let parent = dirname(path);
      contains(join(evidence, SOURCE), parent);
      parent = dirname(parent)
    ) {
      directories.add(parent);
      if (parent === join(evidence, SOURCE)) break;
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    assertLease();
    syncDirectory(directory);
  }
}
function validateBinding(root: string, directory: string, binding: OutputJournalBinding): void {
  const fd = openFile(join(directory, OUTPUT_ANCHOR));
  try {
    validateOutputJournalBinding(root, directory, fd, binding);
  } finally {
    fs.closeSync(fd);
  }
}
function makePlan(
  root: string,
  sessionId: string,
  directory: string,
  evidenceDirectory: string,
  files: SourceFile[],
  resume: boolean,
  originalState?: Buffer,
  assertLease = noLease,
): Receipt {
  assertLease();
  const stateBytes = originalState ?? bytes(join(directory, "state.json"), 1024 * 1024),
    state = decodeJson(stateBytes);
  requireRepair(
    state &&
      state.sessionId === sessionId &&
      Number.isFinite(state.startedAt) &&
      !state.ephemeral &&
      !sessionId.startsWith("qchat-"),
    "authority_mismatch",
    "Invalid persistent Session identity",
  );
  requireRepair(
    !state.outputJournalBinding && !state.outputIdentityRecovery,
    "authority_mismatch",
    "Session already has an unrelated identity migration",
  );
  requireRepair(
    !state.outputJournalStorage,
    "segmented_legacy_identity",
    "Legacy segmented identity migration requires a separate reviewed migration",
  );
  requireRepair(
    !state.outputRecoveryIncomplete || resume,
    "resume_required",
    "A failed Session requires --resume-with-recorded-gap",
  );
  const pin = state.outputJournalHead;
  requireRepair(
    pin?.version === 2 &&
      Number.isSafeInteger(pin.file?.dev) &&
      Number.isSafeInteger(pin.file?.ino) &&
      validPosition(pin) &&
      hex.test(pin.identity) &&
      hex.test(state.outputJournalIdentity),
    "authority_mismatch",
    "Session has no version-2 legacy identity authority",
  );
  const anchor = files.find((f) => f.name === OUTPUT_ANCHOR),
    headFile = files.find((f) => f.name === OUTPUT_HEAD),
    transcript = files.find((f) => f.name === "transcript.jsonl");
  requireRepair(
    anchor && headFile && transcript && headFile.ino === pin.file.ino && headFile.bytes === 4096,
    "authority_mismatch",
    "Published files are missing or replaced",
  );
  const data = bytes(join(directory, OUTPUT_ANCHOR), MAX_FILE, false, false, assertLease);
  const newline = data.indexOf(10);
  requireRepair(newline >= 0 && newline < 256 * 1024, "chain_invalid", "Journal header is missing");
  const head = decodeJson(bytes(join(directory, OUTPUT_HEAD), 4096)).head;
  requireRepair(
    head && (head.sequence !== pin.sequence || head.hash === pin.hash),
    "head_unproved",
    "Published head disagrees with its admission pin",
  );
  const oldDev = pin.file.dev,
    directoryStat = fs.lstatSync(directory);
  const oldCoverage = sha256(
    `${root}\n${sessionId}\n${oldDev}:${directoryStat.ino}\n${state.startedAt}`,
  );
  if (state.outputCoverageIdentity !== undefined || state.outputCoverage !== undefined) {
    const proof = state.outputCoverage;
    requireRepair(
      state.outputCoverageIdentity === oldCoverage &&
        proof?.version === 1 &&
        proof.incarnation === oldCoverage &&
        typeof proof.unpaired === "boolean" &&
        Array.isArray(proof.inputIds) &&
        proof.inputIds.length <= 128 &&
        proof.inputIds.every(validInputId) &&
        new Set(proof.inputIds).size === proof.inputIds.length &&
        proof.inputIds.reduce((sum: number, id: string) => sum + Buffer.byteLength(id), 0) <=
          32 * 1024 &&
        (proof.lastInputId === undefined || validInputId(proof.lastInputId)) &&
        (proof.journalIdentity === undefined ||
          proof.journalIdentity === state.outputJournalIdentity),
      "coverage_mismatch",
      "Legacy coverage identity cannot be reconstructed",
    );
  }
  // This verifies all record hashes and whole fragment groups against the ORIGINAL cursor domain.
  const selected = ["state.json", OUTPUT_ANCHOR, OUTPUT_HEAD];
  const manifest: OutputJournalBackupManifest = {
    format: "codeshell-output-journal-backup",
    version: 1,
    authority: {
      root,
      rootFile: { dev: oldDev, ino: fs.lstatSync(root).ino },
      sessionId,
      sessionFile: { dev: oldDev, ino: directoryStat.ino },
      startedAt: state.startedAt,
      anchor: { dev: oldDev, ino: anchor.ino },
      identityPin: state.outputJournalIdentity,
      headPin: pin,
      head,
    },
    floor: { sequence: 0, offset: newline + 1, hash: state.outputJournalIdentity },
    files: selected.map((name) => {
      const file = files.find((item) => item.name === name)!;
      return { ...file, dev: oldDev } as BackupFile;
    }),
  };
  verifyBackupChain(manifest, (name, start, end, consume) => {
    const source = bytes(join(directory, name), MAX_FILE, false, false, assertLease);
    requireRepair(
      start >= 0 && end >= start && end <= source.length,
      "chain_invalid",
      "Invalid migration verification range",
    );
    for (let offset = start; offset < end; offset += 65536) {
      assertLease();
      consume(source.subarray(offset, Math.min(end, offset + 65536)));
    }
  });
  const binding: OutputJournalBinding = {
    version: 1,
    root,
    directory: capturePersistentFileIdentity(directory),
    anchor: capturePersistentFileIdentity(join(directory, OUTPUT_ANCHOR)),
    journalIdentity: head.identity,
    coverageIdentity: oldCoverage,
  };
  validateBinding(root, directory, binding);
  const historicalGap = !!state.outputRecoveryIncomplete || !!state.outputCoverage?.unpaired;
  return {
    format: FORMAT,
    version: 1,
    id: randomUUID(),
    root,
    sessionId,
    evidenceDirectory,
    createdAt: new Date().toISOString(),
    resumeWithRecordedGap: resume,
    files,
    binding,
    state,
    transcriptSha256: transcript.sha256,
    historicalGap,
  };
}
function migratedState(receipt: Receipt, receiptHash: string): Buffer {
  const state = structuredClone(receipt.state);
  const head = receipt.files.find((file) => file.name === OUTPUT_HEAD)!;
  state.outputJournalBinding = receipt.binding;
  state.outputJournalHead = {
    ...state.outputJournalHead,
    version: 3,
    file: {
      dev: head.dev,
      ino: head.ino,
      stable: capturePersistentFileIdentity(join(receipt.root, receipt.sessionId, OUTPUT_HEAD)),
    },
  };
  if (state.outputRecoveryIncomplete) {
    state.outputRecoveryIncomplete = false;
    state.outputCoverageIdentity = receipt.binding.coverageIdentity;
    state.outputCoverage = {
      ...(state.outputCoverage ?? {
        version: 1,
        incarnation: receipt.binding.coverageIdentity,
        inputIds: [],
        journalIdentity: state.outputJournalIdentity,
      }),
      unpaired: true,
    };
  }
  state.outputIdentityRecovery = {
    version: 1,
    id: receipt.id,
    evidenceDirectory: receipt.evidenceDirectory,
    receiptSha256: receiptHash,
    migratedAt: receipt.createdAt,
    previousOutputRecoveryIncomplete: !!receipt.state.outputRecoveryIncomplete,
    historicalGap: receipt.historicalGap,
  };
  const result = Buffer.from(JSON.stringify(state, null, 2) + "\n");
  requireRepair(result.length <= 1024 * 1024, "file_budget", "Migrated state exceeds its bound");
  return result;
}
function publishState(path: string, data: Buffer, id: string, assertLease = noLease): void {
  const temp = join(dirname(path), `.output-identity-state-${id}.tmp`);
  writeExclusive(temp, data, assertLease);
  assertLease();
  fs.renameSync(temp, path);
  syncDirectory(dirname(path));
}
function verifyConsumer(
  root: string,
  sessionId: string,
  identity: string,
  expected: Record<string, any>,
  assertLease = noLease,
): void {
  let after: string | undefined, through: string | undefined;
  for (let page = 0; page < 1_000_000; page++) {
    assertLease();
    const result = readOutputJournal(root, sessionId, { after, through });
    requireRepair(
      result.status === "ok" && result.through && result.next,
      "consumer_incomplete",
      "Migrated output consumer cannot verify the retained history",
    );
    requireRepair(
      JSON.parse(Buffer.from(result.through, "base64url").toString("utf8")).identity === identity,
      "authority_mismatch",
      "Migration changed the logical cursor domain",
    );
    if (result.complete) {
      const coverage = new SessionOutputCoverageStore(() => root).read(sessionId);
      const persisted = decodeJson(bytes(join(root, sessionId, "state.json"), 1024 * 1024));
      requireRepair(
        coverage.status === "ok" &&
          coverage.incarnation === expected.outputJournalBinding.coverageIdentity &&
          coverage.journalIdentity === expected.outputJournalIdentity &&
          coverage.unpaired === (expected.outputCoverage?.unpaired ?? false) &&
          JSON.stringify(coverage.inputIds) ===
            JSON.stringify(expected.outputCoverage?.inputIds ?? []) &&
          persisted.outputCoverage?.lastInputId === expected.outputCoverage?.lastInputId,
        "coverage_mismatch",
        "Migrated display coverage does not preserve the admitted input history",
      );
      return;
    }
    requireRepair(
      result.next !== after,
      "consumer_incomplete",
      "Migrated output consumer made no progress",
    );
    through = result.through;
    after = result.next;
  }
  throw new Error("Migrated output consumer exceeded its bounded page budget");
}

export function migrateOutputJournalIdentity(
  root: string,
  sessionId: string,
  evidenceDirectory: string,
  options: OutputIdentityMigrationOptions,
): OutputIdentityMigrationResult {
  requireRepair(
    options.acceptLegacyIdentity === true,
    "acceptance_required",
    "Legacy identity re-admission requires --accept-legacy-identity",
  );
  requireRepair(
    isAbsolute(root) &&
      isAbsolute(evidenceDirectory) &&
      /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(sessionId) &&
      !sessionId.includes(".."),
    "invalid_path",
    "Explicit absolute root, evidence directory and safe Session id are required",
  );
  root = fs.realpathSync(root);
  evidenceDirectory = join(
    fs.realpathSync(dirname(evidenceDirectory)),
    basename(evidenceDirectory),
  );
  requireRepair(
    !contains(root, evidenceDirectory) && !contains(evidenceDirectory, root),
    "invalid_path",
    "Evidence must be outside the Session store",
  );
  if (exists(evidenceDirectory)) {
    const evidenceStat = fs.lstatSync(evidenceDirectory);
    requireRepair(
      evidenceStat.isDirectory() && !evidenceStat.isSymbolicLink(),
      "path_replaced",
      "Evidence directory was replaced",
    );
  }
  const directory = join(root, sessionId),
    statePath = join(directory, "state.json"),
    pendingPath = join(directory, OUTPUT_REPAIR_PENDING);
  const at = fs.lstatSync(directory);
  requireRepair(
    at.isDirectory() && !at.isSymbolicLink(),
    "path_replaced",
    "Session directory was replaced",
  );
  const release = lockSync(statePath, STATE_LEASE_LOCK_OPTIONS);
  const lockPath = statePath + ".lock",
    lease = fs.lstatSync(lockPath);
  let refreshedAt = 0;
  const assertLease = () => {
    const current = fs.lstatSync(lockPath);
    requireRepair(
      current.isDirectory() && !current.isSymbolicLink() && sameFile(current, lease),
      "lock_lost",
      "Output identity migration state lease was replaced",
    );
    const now = Date.now();
    if (now - refreshedAt >= 1000) {
      fs.utimesSync(lockPath, new Date(now), new Date(now));
      refreshedAt = now;
    }
  };
  const work = (): OutputIdentityMigrationResult => {
    assertLease();
    const receiptPath = join(evidenceDirectory, RECEIPT);
    let receipt: Receipt;
    if (exists(receiptPath)) {
      const sourceDirectory = fs.lstatSync(join(evidenceDirectory, SOURCE));
      requireRepair(
        sourceDirectory.isDirectory() && !sourceDirectory.isSymbolicLink(),
        "path_replaced",
        "Evidence source directory was replaced",
      );
      receipt = unseal(receiptPath);
      requireRepair(
        typeof receipt?.id === "string" && operationId.test(receipt.id),
        "evidence_invalid",
        "Migration receipt has an invalid operation ID",
      );
      requireRepair(
        receipt?.format === FORMAT &&
          receipt.version === 1 &&
          receipt.root === root &&
          receipt.sessionId === sessionId &&
          receipt.evidenceDirectory === evidenceDirectory &&
          receipt.resumeWithRecordedGap === !!options.resumeWithRecordedGap &&
          Array.isArray(receipt.files) &&
          receipt.files.length <= MAX_FILES,
        "evidence_invalid",
        "Identity migration receipt belongs to a different operation",
      );
      verifySourceEvidence(evidenceDirectory, receipt.files, assertLease);
      const verified = makePlan(
        root,
        sessionId,
        directory,
        evidenceDirectory,
        receipt.files,
        receipt.resumeWithRecordedGap,
        bytes(join(evidenceDirectory, SOURCE, "state.json"), 1024 * 1024),
        assertLease,
      );
      requireRepair(
        JSON.stringify(verified.state) === JSON.stringify(receipt.state) &&
          JSON.stringify(verified.binding) === JSON.stringify(receipt.binding) &&
          verified.historicalGap === receipt.historicalGap &&
          verified.transcriptSha256 === receipt.transcriptSha256,
        "evidence_invalid",
        "Migration authority no longer matches its source evidence",
      );
    } else {
      requireRepair(!exists(pendingPath), "repair_pending", "A different repair is pending");
      const files = inventory(directory, undefined, assertLease);
      receipt = makePlan(
        root,
        sessionId,
        directory,
        evidenceDirectory,
        files,
        !!options.resumeWithRecordedGap,
        undefined,
        assertLease,
      );
      privateDirectory(evidenceDirectory);
      privateDirectory(join(evidenceDirectory, SOURCE));
      for (const file of files) {
        assertLease();
        const target = join(evidenceDirectory, SOURCE, file.name);
        evidenceParents(evidenceDirectory, file.name, true);
        writeExclusive(
          target,
          bytes(join(directory, file.name), MAX_FILE, false, false, assertLease),
          assertLease,
        );
        syncDirectory(dirname(target));
      }
      assertInventory(directory, files, undefined, undefined, assertLease);
      verifySourceEvidence(evidenceDirectory, files, assertLease);
      publishReceipt(receiptPath, receipt, receipt.id, assertLease);
      syncDirectory(evidenceDirectory);
      syncDirectory(dirname(evidenceDirectory));
    }
    // A preceding invocation may have failed after linking a complete receipt
    // but before its directory flush. Re-flush the already verified proof and
    // directory entries before allowing the source state to change on retry.
    assertLease();
    const receiptHash = sha256(bytes(receiptPath, MAX_RECEIPT, false, true, assertLease));
    syncDirectory(evidenceDirectory);
    syncDirectory(dirname(evidenceDirectory));
    const nextState = migratedState(receipt, receiptHash);
    const pending = {
      format: FORMAT,
      version: 1,
      id: receipt.id,
      evidenceDirectory,
      receiptSha256: receiptHash,
    };
    const currentState = bytes(statePath, 1024 * 1024);
    const alreadyCommitted = currentState.equals(nextState);
    if (!alreadyCommitted)
      assertInventory(directory, receipt.files, undefined, receipt.id, assertLease);
    else assertInventory(directory, receipt.files, nextState, receipt.id, assertLease);
    options.onCheckpoint?.("evidence-durable");
    assertLease();
    validateBinding(root, directory, receipt.binding);
    writeExclusive(pendingPath, sealed(pending), assertLease);
    syncDirectory(directory);
    options.onCheckpoint?.("barrier-durable");
    assertLease();
    assertInventory(
      directory,
      receipt.files,
      alreadyCommitted ? nextState : undefined,
      receipt.id,
      assertLease,
    );
    if (!alreadyCommitted) publishState(statePath, nextState, receipt.id, assertLease);
    options.onCheckpoint?.("state-durable");
    assertLease();
    assertInventory(directory, receipt.files, nextState, receipt.id, assertLease);
    validateBinding(root, directory, receipt.binding);
    const result: OutputIdentityMigrationResult = {
      version: 1,
      status: alreadyCommitted ? "already_migrated" : "migrated",
      sessionId,
      evidenceDirectory,
      journalIdentity: receipt.binding.journalIdentity,
      coverageIdentity: receipt.binding.coverageIdentity,
      historicalGap: receipt.historicalGap,
      transcriptSha256: receipt.transcriptSha256,
    };
    try {
      assertLease();
      fs.unlinkSync(pendingPath);
      syncDirectory(directory);
      verifyConsumer(
        root,
        sessionId,
        receipt.binding.journalIdentity,
        decodeJson(nextState),
        assertLease,
      );
      options.onCheckpoint?.("consumer-verified");
      assertLease();
      const durableResult = { ...result, status: "migrated" };
      publishReceipt(join(evidenceDirectory, RESULT), durableResult, receipt.id, assertLease);
      syncDirectory(evidenceDirectory);
      return result;
    } catch (cause) {
      assertLease();
      writeExclusive(pendingPath, sealed(pending), assertLease);
      syncDirectory(directory);
      throw cause;
    }
  };
  let result: OutputIdentityMigrationResult | undefined, primary: unknown;
  try {
    result = work();
  } catch (cause) {
    primary = cause;
  }
  try {
    assertLease();
    release();
  } catch (cause) {
    if (primary)
      throw new AggregateError(
        [primary, cause],
        "Output identity migration and lease release failed",
        { cause },
      );
    throw cause;
  }
  if (primary) throw primary;
  return result!;
}
