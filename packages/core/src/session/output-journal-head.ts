/** A fixed, checksummed durable publication watermark, pinned by Session state. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  capturePersistentFileIdentity,
  isValidPersistentFileIdentity,
  matchesPersistentFileIdentity,
  type PersistentFileIdentity,
} from "./persistent-file-identity.js";

export interface PublishedOutputHead {
  version: 1;
  identity: string;
  sequence: number;
  offset: number;
  hash: string;
}
export interface OutputHeadPin extends Omit<PublishedOutputHead, "version"> {
  version: 1 | 2 | 3;
  file?: { dev: number; ino: number; stable?: PersistentFileIdentity };
  name?: string;
}
const BYTES = 4096;
const NAME = "output-journal-head.json";
export function outputJournalHeadName(pin?: Pick<OutputHeadPin, "name">): string {
  if (pin?.name === undefined) return NAME;
  if (!/^output-journal-head-[a-f0-9-]{36}\.json$/.test(pin.name))
    throw new Error("Invalid output epoch watermark name");
  return pin.name;
}
const hash = (data: string) => createHash("sha256").update(data).digest("hex");
function validHead(head: PublishedOutputHead | OutputHeadPin): boolean {
  return Boolean(
    head &&
    /^[a-f0-9]{64}$/.test(head.identity) &&
    Number.isSafeInteger(head.sequence) &&
    head.sequence >= 0 &&
    Number.isSafeInteger(head.offset) &&
    head.offset >= 0 &&
    /^[a-f0-9]{64}$/.test(head.hash),
  );
}
function stamp(fd: number): string {
  const at = fstatSync(fd, { bigint: true });
  return `${at.dev}:${at.ino}:${at.size}:${at.mtimeNs}:${at.ctimeNs}`;
}
function open(directory: string, flags: number, pin?: OutputHeadPin, name?: string): number {
  const path = join(directory, outputJournalHeadName(pin ?? { name }));
  const fd = openSync(
    path,
    flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    0o600,
  );
  try {
    const at = fstatSync(fd);
    if (
      pin?.version === 2 &&
      pin.file &&
      at.isFile() &&
      at.size === BYTES &&
      at.ino === pin.file.ino &&
      at.dev !== pin.file.dev
    )
      throw Object.assign(
        new Error("Output journal device number changed; identity migration is required"),
        { code: "CODESHELL_OUTPUT_IDENTITY_REVALIDATION_REQUIRED" },
      );
    if (
      !at.isFile() ||
      (pin &&
        (!pin.file ||
          at.size !== BYTES ||
          (pin.version === 3
            ? !isValidPersistentFileIdentity(pin.file.stable) ||
              !matchesPersistentFileIdentity(path, pin.file.stable, at)
            : at.dev !== pin.file.dev || at.ino !== pin.file.ino)))
    )
      throw new Error("Output watermark file was lost or replaced");
    return fd;
  } catch (cause) {
    closeSync(fd);
    throw cause;
  }
}
function encoded(head: PublishedOutputHead): Buffer {
  const value = JSON.stringify(head);
  const data = Buffer.from(JSON.stringify({ head, sha256: hash(value) }));
  if (data.length > BYTES) throw new Error("Output watermark exceeds its bound");
  const block = Buffer.alloc(BYTES, 0x20);
  data.copy(block);
  return block;
}
function write(fd: number, data: Buffer): void {
  let offset = 0;
  try {
    while (offset < data.length) {
      const count = writeSync(fd, data, offset, data.length - offset, offset);
      if (!count) throw new Error("Output watermark write made no progress");
      offset += count;
    }
    fsyncSync(fd);
  } catch (cause) {
    if (offset > 0) {
      // Never fall back to an older valid slot after a torn head write: that
      // could discard a cursor already published before this attempt. Retain
      // the journal and make this watermark explicitly unreadable instead.
      try {
        writeSync(fd, Buffer.from("!"), 0, 1, 0);
        fsyncSync(fd);
      } catch {
        // Preserve the I/O failure. Readers independently check shape/checksum.
      }
    }
    throw cause;
  }
}
export function readPublishedOutputHead(
  directory: string,
  pin: OutputHeadPin,
): PublishedOutputHead {
  if (!validHead(pin)) throw new Error("Invalid output watermark admission pin");
  if (pin.version === 1) return { ...pin, version: 1 };
  if (
    ![2, 3].includes(pin.version) ||
    !pin.file ||
    (pin.version === 2 &&
      (!Number.isSafeInteger(pin.file.dev) ||
        !Number.isSafeInteger(pin.file.ino) ||
        pin.file.dev < 0 ||
        pin.file.ino < 0)) ||
    (pin.version === 3 && !isValidPersistentFileIdentity(pin.file.stable))
  )
    throw new Error("Invalid output watermark admission pin");
  const fd = open(directory, constants.O_RDONLY, pin);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = stamp(fd);
      const data = Buffer.alloc(BYTES);
      let offset = 0;
      while (offset < data.length) {
        const count = readSync(fd, data, offset, data.length - offset, offset);
        if (!count) throw new Error("Output watermark changed while reading");
        offset += count;
      }
      if (stamp(fd) !== before) continue;
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
      const head = value?.head as PublishedOutputHead;
      const named = lstatSync(join(directory, outputJournalHeadName(pin)));
      const opened = fstatSync(fd);
      if (
        !validHead(head) ||
        head.version !== 1 ||
        head.identity !== pin.identity ||
        head.sequence < pin.sequence ||
        head.offset < pin.offset ||
        (head.sequence === pin.sequence && head.hash !== pin.hash) ||
        value.sha256 !== hash(JSON.stringify(head)) ||
        named.isSymbolicLink() ||
        named.dev !== opened.dev ||
        named.ino !== opened.ino
      )
        throw new Error("Output watermark proof was damaged or replaced");
      return head;
    }
    throw new Error("Output watermark changed while reading");
  } finally {
    closeSync(fd);
  }
}
/** Caller owns state.json.lock. State admission follows file and directory fsync. */
export function initializePublishedOutputHead(
  directory: string,
  head: PublishedOutputHead,
  name?: string,
): OutputHeadPin {
  const fd = open(
    directory,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
    undefined,
    name,
  );
  try {
    write(fd, encoded(head));
    const at = fstatSync(fd);
    if (process.platform !== "win32") {
      const dir = openSync(directory, constants.O_RDONLY);
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    }
    return {
      ...head,
      version: 3,
      file: {
        dev: at.dev,
        ino: at.ino,
        stable: capturePersistentFileIdentity(join(directory, outputJournalHeadName({ name })), at),
      },
      ...(name ? { name } : {}),
    };
  } finally {
    closeSync(fd);
  }
}
/** No rename or directory mutation per frame; a failed/torn block never falls back. */
export function updatePublishedOutputHead(
  directory: string,
  pin: OutputHeadPin,
  head: PublishedOutputHead,
): void {
  const fd = open(directory, constants.O_RDWR, pin);
  try {
    write(fd, encoded(head));
  } finally {
    closeSync(fd);
  }
}

/** Upgrade only the exact head admitted by the old proof; never recapture a replacement. */
export function admitPersistentPublishedOutputHead(
  directory: string,
  pin: OutputHeadPin,
): OutputHeadPin {
  readPublishedOutputHead(directory, pin);
  if (pin.version === 3) return pin;
  if (pin.version !== 2)
    throw new Error("Inline output head must be materialized before admission");
  const fd = open(directory, constants.O_RDONLY, pin);
  try {
    const stable = capturePersistentFileIdentity(
      join(directory, NAME),
      fstatSync(fd, { bigint: true }),
    );
    readPublishedOutputHead(directory, pin);
    return { ...pin, version: 3, file: { ...pin.file!, stable } };
  } finally {
    closeSync(fd);
  }
}
