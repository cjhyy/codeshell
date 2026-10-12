/** Evidence-preserving repair of an exclusively locked, proved unpublished tail. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** Any pending receipt is a barrier, including malformed files and symlinks. */
export function isOutputJournalRepairPending(directory: string): boolean {
  try {
    lstatSync(join(directory, "output-journal-repair-pending.json"));
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

function stamp(fd: number): string {
  const at = fstatSync(fd, { bigint: true });
  return `${at.dev}:${at.ino}:${at.size}:${at.mtimeNs}:${at.ctimeNs}`;
}
function writeAll(fd: number, data: Buffer, position: number): void {
  let offset = 0;
  while (offset < data.length) {
    const count = writeSync(fd, data, offset, data.length - offset, position + offset);
    if (!count) throw new Error("Output repair evidence write made no progress");
    offset += count;
  }
}
function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Caller holds state.json.lock and has verified head against the original inode. */
export function repairUncommittedOutputTail(
  journal: number,
  file: string,
  directory: string,
  published: {
    identity: string;
    sequence: number;
    offset: number;
    hash: string;
    logicalOffset?: number;
  },
): void {
  const before = fstatSync(journal);
  const originalStamp = stamp(journal);
  if (before.size <= published.offset || before.size > 128 * 1024 * 1024)
    throw new Error("Invalid output repair boundary");
  let evidenceBytes = before.size + 4096;
  const existing = readdirSync(directory).filter((name) => /^\.output-repair-/.test(name));
  if (existing.length > 1024) throw new Error("Output repair evidence budget exhausted");
  for (const name of existing) {
    const at = lstatSync(join(directory, name));
    if (!at.isFile() || at.isSymbolicLink()) throw new Error("Invalid output repair evidence");
    evidenceBytes += at.size;
  }
  if (evidenceBytes > 128 * 1024 * 1024) throw new Error("Output repair evidence budget exhausted");
  const id = randomUUID();
  const evidence = `.output-repair-${id}.evidence.jsonl`;
  const receipt = `.output-repair-${id}.json`;
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const digest = createHash("sha256");
  let target: number | undefined;
  try {
    target = openSync(join(directory, evidence), flags, 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(
        journal,
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      if (!count) throw new Error("Output repair source changed");
      const chunk = buffer.subarray(0, count);
      digest.update(chunk);
      writeAll(target, chunk, offset);
      offset += count;
    }
    fsyncSync(target);
    closeSync(target);
    target = undefined;
    if (stamp(journal) !== originalStamp) throw new Error("Output repair source changed");
    target = openSync(join(directory, receipt), flags, 0o600);
    writeAll(
      target,
      Buffer.from(
        JSON.stringify({
          version: 1,
          reason: "unpublished-final-tail",
          evidence,
          bytes: before.size,
          sha256: digest.digest("hex"),
          originalInode: { dev: before.dev, ino: before.ino },
          published,
        }) + "\n",
      ),
      0,
    );
    fsyncSync(target);
    closeSync(target);
    target = undefined;
    // Both the entire original file and its receipt must be durable first.
    syncDirectory(directory);
    const named = lstatSync(file);
    if (
      stamp(journal) !== originalStamp ||
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    )
      throw new Error("Output repair source was replaced");
    ftruncateSync(journal, published.offset);
    fsyncSync(journal);
  } finally {
    if (target !== undefined) closeSync(target);
    // Failed evidence remains private beside the intact source for diagnosis.
    // No failure before the final truncate can discard original bytes.
  }
}
