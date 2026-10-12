/** Fixed offline repair format. Hash-chain proof never grants a new cursor authority. */
import { createHash } from "node:crypto";
import type { OutputHeadPin, PublishedOutputHead } from "./output-journal-head.js";
import type { OutputPosition, OutputStoragePin } from "./output-journal-storage.js";

export const OUTPUT_REPAIR_PENDING = "output-journal-repair-pending.json";
export const OUTPUT_BACKUP_MANIFEST = "output-journal-backup.json";
export const OUTPUT_ANCHOR = "output-journal.jsonl";
export const OUTPUT_HEAD = "output-journal-head.json";
export const OUTPUT_SEGMENTS = "output-journal-segments.json";
export const MAX_OUTPUT_REPAIR_BYTES = 512 * 1024 * 1024;
export const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
export const samePosition = (a: OutputPosition, b: OutputPosition): boolean =>
  a.sequence === b.sequence && a.offset === b.offset && a.hash === b.hash;
export interface FileIdentity {
  dev: number;
  ino: number;
}
export interface RepairAuthority {
  root: string;
  rootFile: FileIdentity;
  sessionId: string;
  sessionFile: FileIdentity;
  startedAt: number;
  anchor: FileIdentity;
  identityPin: string;
  headPin: OutputHeadPin;
  head: PublishedOutputHead;
  storagePin?: OutputStoragePin;
}
export interface BackupFile extends FileIdentity {
  name: string;
  bytes: number;
  sha256: string;
}
export interface OutputJournalBackupManifest {
  format: "codeshell-output-journal-backup";
  version: 1;
  authority: RepairAuthority;
  floor: OutputPosition;
  files: BackupFile[];
}
export interface RepairSegment extends FileIdentity {
  name: string;
  start: OutputPosition;
  end?: OutputPosition;
}
export interface RepairStorageManifest {
  version: 1;
  identity: string;
  origin: OutputPosition;
  floor: OutputPosition;
  anchor: { end: OutputPosition; retained: boolean };
  segments: RepairSegment[];
}
export class OutputJournalRepairError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OutputJournalRepairError";
  }
}
export function requireRepair(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new OutputJournalRepairError(code, message);
}
export function validIdentity(value: FileIdentity): boolean {
  return Boolean(
    value &&
    Number.isSafeInteger(value.dev) &&
    value.dev >= 0 &&
    Number.isSafeInteger(value.ino) &&
    value.ino >= 0,
  );
}
export function validPosition(value: OutputPosition): boolean {
  return Boolean(
    value &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0 &&
    Number.isSafeInteger(value.offset) &&
    value.offset >= 0 &&
    /^[a-f0-9]{64}$/.test(value.hash),
  );
}
export function decodeJson(data: Buffer): any {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
}
export function segmentBarrier(identity: string): Buffer {
  return Buffer.from(
    JSON.stringify({ storage: "codeshell-output-segments", version: 1, identity }) + "\n",
  );
}
export function parseRepairStorage(
  data: Buffer,
  authority: RepairAuthority,
): RepairStorageManifest {
  requireRepair(
    data.length === 32768,
    "manifest_unproved",
    "Segment manifest has the wrong length",
  );
  const value = decodeJson(data),
    manifest = value?.manifest as RepairStorageManifest;
  const pin = authority.storagePin;
  requireRepair(
    pin &&
      pin.version === 1 &&
      pin.identity === authority.head.identity &&
      validIdentity(pin.file) &&
      validPosition(pin.origin) &&
      manifest &&
      manifest.version === 1 &&
      manifest.identity === pin.identity &&
      validPosition(manifest.origin) &&
      samePosition(manifest.origin, pin.origin) &&
      validPosition(manifest.floor) &&
      validPosition(manifest.anchor?.end) &&
      typeof manifest.anchor.retained === "boolean" &&
      Array.isArray(manifest.segments) &&
      manifest.segments.length > 0 &&
      manifest.segments.length <= 16 &&
      value.sha256 === sha256(JSON.stringify(manifest)),
    "manifest_unproved",
    "Segment manifest proof is damaged",
  );
  let expected = manifest.anchor.retained ? manifest.anchor.end : manifest.floor;
  const seen = new Set<string>();
  for (let index = 0; index < manifest.segments.length; index++) {
    const segment = manifest.segments[index]!;
    requireRepair(
      /^output-segment-[a-f0-9-]{36}\.jsonl$/.test(segment.name) &&
        !seen.has(segment.name) &&
        validIdentity(segment) &&
        validPosition(segment.start) &&
        samePosition(segment.start, expected) &&
        (index === manifest.segments.length - 1
          ? segment.end === undefined
          : validPosition(segment.end!) &&
            segment.end!.sequence >= segment.start.sequence &&
            segment.end!.offset >= segment.start.offset),
      "manifest_unproved",
      "Segment manifest continuity is damaged",
    );
    seen.add(segment.name);
    if (segment.end) expected = segment.end;
  }
  requireRepair(
    manifest.anchor.retained ||
      (manifest.floor.sequence >= manifest.anchor.end.sequence &&
        manifest.floor.offset >= manifest.anchor.end.offset),
    "retention_mismatch",
    "Retention floor moved behind the retired anchor",
  );
  return manifest;
}
export function encodeRepairStorage(manifest: RepairStorageManifest): Buffer {
  const data = Buffer.from(JSON.stringify({ manifest, sha256: sha256(JSON.stringify(manifest)) }));
  requireRepair(data.length <= 32768, "manifest_unproved", "Segment manifest exceeds its bound");
  const result = Buffer.alloc(32768, 0x20);
  data.copy(result);
  return result;
}
export function logicalStorage(manifest: RepairStorageManifest): string {
  return JSON.stringify({
    ...manifest,
    segments: manifest.segments.map(({ dev: _dev, ino: _ino, ...s }) => s),
  });
}
export function outputRepairCursor(authority: RepairAuthority, position: OutputPosition): string {
  return Buffer.from(
    JSON.stringify({
      identity: authority.head.identity,
      sequence: position.sequence,
      offset: position.offset,
      hash: position.hash,
    }),
  ).toString("base64url");
}

/** Read one complete newline record at a time, without retaining output bodies. */
export function verifyBackupChain(
  manifest: OutputJournalBackupManifest,
  read: (name: string, start: number, end: number, consume: (chunk: Buffer) => void) => void,
): { headerEnd: number; storage?: RepairStorageManifest } {
  const authority = manifest.authority;
  requireRepair(
    authority &&
      typeof authority.root === "string" &&
      validIdentity(authority.rootFile) &&
      validIdentity(authority.sessionFile) &&
      validIdentity(authority.anchor) &&
      /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(authority.sessionId) &&
      !authority.sessionId.includes("..") &&
      Number.isFinite(authority.startedAt) &&
      /^[a-f0-9]{64}$/.test(authority.identityPin) &&
      authority.headPin?.version === 2 &&
      validIdentity(authority.headPin.file!) &&
      validPosition(authority.headPin) &&
      authority.head?.version === 1 &&
      validPosition(authority.head) &&
      authority.head.identity === authority.headPin.identity &&
      authority.head.sequence >= authority.headPin.sequence &&
      authority.head.offset >= authority.headPin.offset &&
      validPosition(manifest.floor),
    "authority_mismatch",
    "Backup has no original durable-head authority",
  );
  const entries = new Map(manifest.files.map((file) => [file.name, file]));
  requireRepair(entries.size === manifest.files.length, "bundle_invalid", "Duplicate backup file");
  const anchor = entries.get(OUTPUT_ANCHOR);
  requireRepair(
    anchor && anchor.dev === authority.anchor.dev && anchor.ino === authority.anchor.ino,
    "authority_mismatch",
    "Backup anchor identity is different",
  );
  let first = Buffer.alloc(0);
  read(OUTPUT_ANCHOR, 0, Math.min(anchor.bytes, 256 * 1024), (chunk) => {
    if (first.indexOf(10) < 0) first = Buffer.concat([first, chunk]);
  });
  const newline = first.indexOf(10);
  requireRepair(newline >= 0, "bundle_invalid", "Backup header is missing");
  const headerBytes = first.subarray(0, newline + 1),
    header = decodeJson(first.subarray(0, newline));
  requireRepair(
    header.version === 1 &&
      header.durableHead === 1 &&
      header.sessionId === authority.sessionId &&
      header.startedAt === authority.startedAt &&
      typeof header.sessionIncarnation === "string" &&
      typeof header.journalId === "string" &&
      /^[a-f0-9]{64}$/.test(header.storageScope) &&
      sha256(headerBytes) === authority.identityPin,
    "authority_mismatch",
    "Backup header does not identify the admitted journal",
  );
  const identity = sha256(
    `${sha256(authority.root)}\n${headerBytes.subarray(0, -1).toString("utf8")}\n${authority.sessionFile.dev}:${authority.sessionFile.ino}\n${authority.anchor.dev}:${authority.anchor.ino}`,
  );
  requireRepair(
    identity === authority.head.identity,
    "authority_mismatch",
    "Backup cursor authority changed",
  );
  const start = { sequence: 0, offset: newline + 1, hash: authority.identityPin };
  const regions: { name: string; base: number; from: number; to: number; end?: OutputPosition }[] =
    [];
  let storage: RepairStorageManifest | undefined;
  const headEntry = entries.get(OUTPUT_HEAD);
  requireRepair(
    headEntry &&
      headEntry.dev === authority.headPin.file!.dev &&
      headEntry.ino === authority.headPin.file!.ino &&
      headEntry.bytes === 4096,
    "authority_mismatch",
    "Backup durable-head file is different",
  );
  let headBytes = Buffer.alloc(0);
  read(OUTPUT_HEAD, 0, 4096, (chunk) => {
    headBytes = Buffer.concat([headBytes, chunk]);
  });
  const headValue = decodeJson(headBytes);
  requireRepair(
    JSON.stringify(headValue.head) === JSON.stringify(authority.head) &&
      headValue.sha256 === sha256(JSON.stringify(headValue.head)),
    "head_unproved",
    "Backup durable head is damaged",
  );
  if (authority.storagePin) {
    const item = entries.get(OUTPUT_SEGMENTS);
    requireRepair(
      item &&
        item.dev === authority.storagePin.file.dev &&
        item.ino === authority.storagePin.file.ino,
      "manifest_unproved",
      "Backup segment manifest inode changed",
    );
    let bytes = Buffer.alloc(0);
    read(OUTPUT_SEGMENTS, 0, item.bytes, (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
    });
    storage = parseRepairStorage(bytes, authority);
    requireRepair(
      samePosition(storage.floor, manifest.floor),
      "retention_mismatch",
      "Backup retention floor changed",
    );
    const barrier = segmentBarrier(identity);
    const at = storage.anchor.retained ? storage.anchor.end.offset : start.offset;
    let marker = Buffer.alloc(0);
    read(OUTPUT_ANCHOR, at, at + barrier.length, (chunk) => {
      marker = Buffer.concat([marker, chunk]);
    });
    requireRepair(
      marker.equals(barrier),
      "bundle_invalid",
      "Backup legacy-reader barrier is missing",
    );
    if (storage.anchor.retained) {
      requireRepair(
        samePosition(storage.floor, start) && anchor.bytes === at + barrier.length,
        "retention_mismatch",
        "Backup retained anchor is inconsistent",
      );
      regions.push({
        name: OUTPUT_ANCHOR,
        base: 0,
        from: start.offset,
        to: storage.anchor.end.offset,
        end: storage.anchor.end,
      });
    }
    for (const segment of storage.segments) {
      const item = entries.get(segment.name);
      requireRepair(
        item &&
          item.dev === segment.dev &&
          item.ino === segment.ino &&
          item.bytes <= 32 * 1024 * 1024 &&
          (!segment.end || item.bytes === segment.end.offset - segment.start.offset),
        "bundle_invalid",
        "Backup segment is missing or incomplete",
      );
      regions.push({
        name: segment.name,
        base: segment.start.offset,
        from: 0,
        to: item.bytes,
        end: segment.end,
      });
    }
  } else {
    requireRepair(
      samePosition(manifest.floor, start) && anchor.bytes === authority.head.offset,
      "bundle_invalid",
      "Single-file backup includes an unpublished tail or a gap",
    );
    regions.push({ name: OUTPUT_ANCHOR, base: 0, from: start.offset, to: anchor.bytes });
  }
  const expectedNames = [
    "state.json",
    OUTPUT_ANCHOR,
    OUTPUT_HEAD,
    ...(storage ? [OUTPUT_SEGMENTS, ...storage.segments.map((s) => s.name)] : []),
  ].sort();
  requireRepair(
    [...entries.keys()].sort().join() === expectedNames.join(),
    "bundle_invalid",
    "Backup inventory is incomplete or ambiguous",
  );
  let current: OutputPosition = manifest.floor;
  let fragment: { id: string; index: number; total: number } | undefined;
  for (const region of regions) {
    let pending = Buffer.alloc(0),
      physical = region.from;
    read(region.name, region.from, region.to, (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const end = pending.indexOf(10);
        if (end < 0) break;
        requireRepair(end <= 256 * 1024, "chain_invalid", "Backup record exceeds its bound");
        const stored = decodeJson(pending.subarray(0, end)),
          { hash, ...value } = stored;
        const producer = value.producer;
        const validProducer =
          producer &&
          ["protocol", "host"].includes(producer.kind) &&
          typeof producer.id === "string" &&
          /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(producer.id);
        requireRepair(
          value.sequence === current.sequence + 1 &&
            value.previousHash === current.hash &&
            hash === sha256(JSON.stringify(value)) &&
            !!value.event !== !!value.fragment &&
            ((value.version === undefined &&
              !value.run &&
              ((typeof value.runId === "string" && !producer) ||
                (value.runId === undefined && validProducer))) ||
              (value.version === 2 &&
                value.runId === undefined &&
                ((typeof value.run?.id === "string" && !!value.run.id && !producer) ||
                  (!value.run && validProducer)))),
          "chain_invalid",
          "Backup record continuity failed",
        );
        if (value.event)
          requireRepair(
            typeof value.event === "object" && typeof value.event.type === "string" && !fragment,
            "chain_invalid",
            "Backup whole event interrupted a fragment group",
          );
        const part = value.fragment;
        if (part) {
          requireRepair(
            typeof part.id === "string" &&
              Number.isSafeInteger(part.index) &&
              Number.isSafeInteger(part.total) &&
              part.total >= 2 &&
              part.total <= 256 &&
              part.index >= 0 &&
              part.index < part.total &&
              typeof part.data === "string" &&
              part.data.length <= Math.ceil(65536 / 3) * 4 &&
              (fragment
                ? part.id === fragment.id &&
                  part.total === fragment.total &&
                  part.index === fragment.index + 1
                : part.index === 0),
            "chain_invalid",
            "Backup fragment continuity failed",
          );
          fragment = part.index === part.total - 1 ? undefined : part;
        }
        physical += end + 1;
        current = { sequence: value.sequence, offset: region.base + physical, hash };
        pending = pending.subarray(end + 1);
      }
      requireRepair(
        pending.length <= 256 * 1024,
        "chain_invalid",
        "Backup record exceeds its bound",
      );
    });
    requireRepair(
      pending.length === 0 && !fragment && (!region.end || samePosition(current, region.end)),
      "chain_invalid",
      "Backup segment is not a complete event boundary",
    );
  }
  requireRepair(
    samePosition(current, authority.head),
    "head_mismatch",
    "Backup does not cover the exact published head",
  );
  return { headerEnd: start.offset, storage };
}
