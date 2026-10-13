/** Bounded segmented storage retaining the original journal cursor domain. */
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
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export interface OutputPosition {
  sequence: number;
  offset: number;
  hash: string;
}
export interface OutputStoragePin {
  version: 1;
  identity: string;
  file: { dev: number; ino: number };
  origin: OutputPosition;
}
interface Segment {
  name: string;
  dev: number;
  ino: number;
  start: OutputPosition;
  end?: OutputPosition;
}
interface Manifest {
  version: 1;
  identity: string;
  origin: OutputPosition;
  floor: OutputPosition;
  anchor: { end: OutputPosition; retained: boolean };
  segments: Segment[];
}
const NAME = "output-journal-segments.json";
const MANIFEST_BYTES = 32 * 1024;
const SEGMENT_BYTES = 16 * 1024 * 1024; // Soft threshold; never split a whole event.
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;
const RETAINED_BYTES = 256 * 1024 * 1024;
// Reserve the bounded header/physical marker, manifest and publication block.
const PAYLOAD_BYTES = RETAINED_BYTES - 256 * 1024 - MANIFEST_BYTES - 4096;
const MAX_SEGMENTS = 16;
const hash = (data: string) => createHash("sha256").update(data).digest("hex");
const same = (a: OutputPosition, b: OutputPosition) =>
  a.sequence === b.sequence && a.offset === b.offset && a.hash === b.hash;
function valid(position: OutputPosition): boolean {
  return (
    !!position &&
    Number.isSafeInteger(position.sequence) &&
    position.sequence >= 0 &&
    Number.isSafeInteger(position.offset) &&
    position.offset >= 0 &&
    /^[a-f0-9]{64}$/.test(position.hash)
  );
}
function stamp(fd: number): string {
  const at = fstatSync(fd, { bigint: true });
  return `${at.dev}:${at.ino}:${at.size}:${at.mtimeNs}:${at.ctimeNs}`;
}
function open(path: string, flags: number): number {
  const fd = openSync(
    path,
    flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    0o600,
  );
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new Error("Output segment is not a regular file");
  }
  return fd;
}
function write(fd: number, data: Buffer, position = 0): void {
  let offset = 0;
  while (offset < data.length) {
    const count = writeSync(fd, data, offset, data.length - offset, position + offset);
    if (!count) throw new Error("Output storage write made no progress");
    offset += count;
  }
}
function directorySync(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function marker(identity: string): Buffer {
  // Actual historical parsers require sequence/runId/event/previousHash here.
  // This physical format barrier is never a logical output record or cursor.
  return Buffer.from(
    JSON.stringify({ storage: "codeshell-output-segments", version: 1, identity }) + "\n",
  );
}
/** A prepared, not-yet-admitted migration may still expose its earlier proved prefix. */
export function isOutputStorageBarrier(fd: number, position: number, identity: string): boolean {
  const barrier = marker(identity);
  if (fstatSync(fd).size !== position + barrier.length) return false;
  const data = Buffer.alloc(barrier.length);
  return readSync(fd, data, 0, data.length, position) === data.length && data.equals(barrier);
}
function writeManifest(fd: number, manifest: Manifest): void {
  const text = JSON.stringify(manifest);
  const value = Buffer.from(JSON.stringify({ manifest, sha256: hash(text) }));
  if (value.length > MANIFEST_BYTES) throw new Error("Output storage manifest exceeds its bound");
  const block = Buffer.alloc(MANIFEST_BYTES, 0x20);
  value.copy(block);
  // A torn update is a damaged manifest, never a fallback to an older floor.
  write(fd, block);
  fsyncSync(fd);
}
function readManifest(fd: number, identity: string, pin: OutputStoragePin): Manifest {
  if (fstatSync(fd).size !== MANIFEST_BYTES)
    throw new Error("Output storage manifest was truncated");
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = stamp(fd);
    const block = Buffer.alloc(MANIFEST_BYTES);
    let offset = 0;
    while (offset < block.length) {
      const count = readSync(fd, block, offset, block.length - offset, offset);
      if (!count) throw new Error("Output storage manifest changed");
      offset += count;
    }
    if (before !== stamp(fd)) continue;
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(block));
    const manifest = value?.manifest as Manifest;
    if (
      !manifest ||
      manifest.version !== 1 ||
      manifest.identity !== identity ||
      !valid(manifest.origin) ||
      !same(manifest.origin, pin.origin) ||
      !valid(manifest.floor) ||
      !valid(manifest.anchor?.end) ||
      typeof manifest.anchor.retained !== "boolean" ||
      !Array.isArray(manifest.segments) ||
      !manifest.segments.length ||
      manifest.segments.length > MAX_SEGMENTS ||
      value.sha256 !== hash(JSON.stringify(manifest))
    )
      throw new Error("Output storage manifest proof is damaged");
    return manifest;
  }
  throw new Error("Output storage manifest changed");
}
interface Region {
  fd: number;
  name: string;
  start: number;
  end: number;
  base: number;
}

/** Anchor fd remains caller-owned. Every segment descriptor belongs to this view. */
export class SegmentedOutputFile {
  private readonly manifestFd: number;
  private readonly regions: Region[] = [];
  readonly manifest: Manifest;
  readonly floor: OutputPosition;
  readonly size: number;
  constructor(
    readonly anchorFd: number,
    private readonly directory: string,
    private readonly anchorPath: string,
    private readonly headerEnd: number,
    readonly pin: OutputStoragePin,
    identity: string,
  ) {
    if (
      pin.version !== 1 ||
      pin.identity !== identity ||
      !valid(pin.origin) ||
      !pin.file ||
      !Number.isSafeInteger(pin.file.dev) ||
      !Number.isSafeInteger(pin.file.ino)
    )
      throw new Error("Invalid output storage admission pin");
    this.manifestFd = open(join(directory, NAME), constants.O_RDONLY);
    try {
      const at = fstatSync(this.manifestFd);
      if (at.dev !== pin.file.dev || at.ino !== pin.file.ino)
        throw new Error("Output storage manifest was replaced");
      this.manifest = readManifest(this.manifestFd, identity, pin);
      this.floor = this.manifest.floor;
      const barrier = marker(identity);
      const matches = (position: number) => {
        const data = Buffer.alloc(barrier.length);
        return (
          readSync(anchorFd, data, 0, data.length, position) === data.length && data.equals(barrier)
        );
      };
      if (
        this.manifest.anchor.retained
          ? !matches(this.manifest.anchor.end.offset)
          : !matches(headerEnd) && !matches(this.manifest.anchor.end.offset)
      )
        throw new Error("Output storage legacy format barrier was lost");
      if (
        !this.manifest.anchor.retained &&
        (this.floor.sequence < this.manifest.anchor.end.sequence ||
          this.floor.offset < this.manifest.anchor.end.offset)
      )
        throw new Error("Output storage retention floor moved backwards");
      if (this.manifest.anchor.retained) {
        if (this.floor.sequence !== 0 || this.floor.offset !== headerEnd)
          throw new Error("Invalid retained anchor floor");
        this.regions.push({
          fd: anchorFd,
          name: anchorPath,
          start: headerEnd,
          end: this.manifest.anchor.end.offset,
          base: 0,
        });
      }
      let expected = this.manifest.anchor.retained ? this.manifest.anchor.end : this.floor;
      for (let index = 0; index < this.manifest.segments.length; index++) {
        const segment = this.manifest.segments[index]!;
        if (
          !/^output-segment-[a-f0-9-]{36}\.jsonl$/.test(segment.name) ||
          !valid(segment.start) ||
          !same(segment.start, expected) ||
          !Number.isSafeInteger(segment.dev) ||
          !Number.isSafeInteger(segment.ino) ||
          (index === this.manifest.segments.length - 1
            ? segment.end !== undefined
            : !valid(segment.end!))
        )
          throw new Error("Output segment chain is damaged");
        const path = join(directory, segment.name);
        const fd = open(path, constants.O_RDONLY);
        const stat = fstatSync(fd);
        this.regions.push({
          fd,
          name: path,
          start: segment.start.offset,
          end: segment.start.offset + stat.size,
          base: segment.start.offset,
        });
        if (
          stat.dev !== segment.dev ||
          stat.ino !== segment.ino ||
          stat.size > MAX_SEGMENT_BYTES ||
          (segment.end &&
            (segment.end.offset !== segment.start.offset + stat.size ||
              segment.end.sequence < segment.start.sequence))
        )
          throw new Error("Output segment was lost, truncated or replaced");
        if (segment.end) expected = segment.end;
      }
      this.size = this.regions.at(-1)!.end;
      if (this.size - this.floor.offset > PAYLOAD_BYTES)
        throw new Error("Output retained storage exceeds its bound");
      this.assertNamed();
    } catch (cause) {
      this.close();
      throw cause;
    }
  }
  read(buffer: Buffer, offset: number, length: number, position: number): number {
    if (position < this.floor.offset)
      throw Object.assign(new Error("Output cursor retention expired"), {
        code: "CODESHELL_OUTPUT_RETENTION_EXPIRED",
      });
    let region = this.regions.find((item) => position >= item.start && position < item.end);
    let end = region?.end;
    if (!region) {
      // currentSize() can observe a durable append after this view opened its
      // descriptors. Closed regions keep their manifest bounds; only the last
      // active descriptor can extend, and only by bytes really present there.
      // Otherwise the newer scan bound would hit an artificial EOF at the
      // constructor's older active size and invalidate an intact frozen cursor.
      const active = this.regions.at(-1)!;
      const currentEnd = this.currentSize();
      if (position >= active.end && position < currentEnd) {
        region = active;
        end = currentEnd;
      }
    }
    if (!region) return 0;
    return readSync(
      region.fd,
      buffer,
      offset,
      Math.min(length, end! - position),
      position - region.base,
    );
  }
  stamp(): string {
    return [
      stamp(this.anchorFd),
      stamp(this.manifestFd),
      ...this.regions.map((item) => stamp(item.fd)),
    ].join("|");
  }
  currentSize(): number {
    const last = this.regions.at(-1)!;
    return last.base + fstatSync(last.fd).size;
  }
  assertNamed(): void {
    for (const [path, fd] of [
      [join(this.directory, NAME), this.manifestFd],
      [this.anchorPath, this.anchorFd],
      ...this.regions.map((item) => [item.name, item.fd]),
    ] as [string, number][]) {
      const named = lstatSync(path),
        current = fstatSync(fd);
      if (
        named.isSymbolicLink() ||
        !named.isFile() ||
        named.dev !== current.dev ||
        named.ino !== current.ino
      )
        throw new Error("Output storage file was replaced during recovery");
    }
  }
  /** Last segment is always active and is opened separately under state.lock. */
  active(): { fd: number; start: OutputPosition } {
    const segment = this.manifest.segments.at(-1)!;
    const fd = open(join(this.directory, segment.name), constants.O_RDWR);
    const at = fstatSync(fd);
    if (at.dev !== segment.dev || at.ino !== segment.ino) {
      closeSync(fd);
      throw new Error("Active output segment was replaced");
    }
    return { fd, start: segment.start };
  }
  close(): void {
    for (const region of this.regions) if (region.fd !== this.anchorFd) closeSync(region.fd);
    this.regions.length = 0;
    closeSync(this.manifestFd);
  }
}

function createSegment(directory: string, start: OutputPosition): Segment {
  const name = `output-segment-${randomUUID()}.jsonl`;
  const fd = open(join(directory, name), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL);
  try {
    fsyncSync(fd);
    const at = fstatSync(fd);
    directorySync(directory);
    return { name, dev: at.dev, ino: at.ino, start: { ...start } };
  } finally {
    closeSync(fd);
  }
}
/** Caller owns state.lock and has verified the complete published anchor. */
export function initializeOutputStorage(
  anchorFd: number,
  directory: string,
  identity: string,
  header: OutputPosition,
  head: OutputPosition,
  origin: OutputPosition,
  admit: (pin: OutputStoragePin) => void,
): OutputStoragePin {
  const segment = createSegment(directory, head);
  const manifest: Manifest = {
    version: 1,
    identity,
    origin: { ...origin },
    floor: { ...header },
    anchor: { end: { ...head }, retained: true },
    segments: [segment],
  };
  const fd = open(join(directory, NAME), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL);
  try {
    writeManifest(fd, manifest);
    directorySync(directory);
    const barrier = marker(identity);
    write(anchorFd, barrier, head.offset);
    fsyncSync(anchorFd);
    const at = fstatSync(fd);
    const pin: OutputStoragePin = {
      version: 1,
      identity,
      origin: { ...origin },
      file: { dev: at.dev, ino: at.ino },
    };
    admit(pin);
    return pin;
  } finally {
    closeSync(fd);
  }
}
/** Whole-event rotation. Durable floor precedes deletion; original anchor inode survives. */
export function rotateOutputStorage(
  view: SegmentedOutputFile,
  directory: string,
  headerEnd: number,
  head: OutputPosition,
  nextBytes: number,
): boolean {
  const manifest = structuredClone(view.manifest);
  const active = manifest.segments.at(-1)!;
  if (
    head.offset - active.start.offset + nextBytes <= SEGMENT_BYTES ||
    head.offset === active.start.offset
  )
    return false;
  active.end = { ...head };
  manifest.segments.push(createSegment(directory, head));
  const removed: Segment[] = [];
  let retireAnchor = false;
  while (
    manifest.segments.length > MAX_SEGMENTS ||
    head.offset - manifest.floor.offset + nextBytes > PAYLOAD_BYTES
  ) {
    if (manifest.anchor.retained) {
      manifest.anchor.retained = false;
      manifest.floor = { ...manifest.anchor.end };
      retireAnchor = true;
    } else {
      const first = manifest.segments[0]!;
      if (!first.end) throw new Error("Output event exceeds retained storage bound");
      removed.push(manifest.segments.shift()!);
      manifest.floor = { ...first.end };
    }
  }
  const fd = open(join(directory, NAME), constants.O_RDWR);
  try {
    const at = fstatSync(fd);
    if (at.dev !== view.pin.file.dev || at.ino !== view.pin.file.ino)
      throw new Error("Output storage manifest was replaced");
    writeManifest(fd, manifest);
    if (retireAnchor) {
      const barrier = marker(view.pin.identity);
      // Never expose a header-only anchor to a real historical parser, even
      // across kill/fault: durable rejecting bytes precede the first truncate.
      write(view.anchorFd, barrier, headerEnd);
      fsyncSync(view.anchorFd);
      ftruncateSync(view.anchorFd, headerEnd + barrier.length);
      fsyncSync(view.anchorFd);
    }
    for (const segment of removed) {
      const path = join(directory, segment.name),
        at = lstatSync(path);
      if (at.isSymbolicLink() || at.dev !== segment.dev || at.ino !== segment.ino)
        throw new Error("Retired output segment was replaced");
      unlinkSync(path);
    }
    directorySync(directory);
    return true;
  } finally {
    closeSync(fd);
  }
}
export function shouldSegmentOutput(size: number, nextBytes: number): boolean {
  return size + nextBytes > SEGMENT_BYTES;
}
