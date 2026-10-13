import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

/** Room-local history coordinates. These are never native Session/Run cursors. */
export interface RoomHistoryPage<T = unknown> {
  snapshotId: string;
  throughSeq: number;
  messages: T[];
  nextCursor?: string;
  complete: boolean;
}
export interface RoomHistoryRequest {
  sinceSeq?: number;
  cursor?: string;
  limit?: number;
}

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_LINE = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

function regular(path: string): Stats {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("room history must be a private regular file");
  }
  return stat;
}
function stamp(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
function openRegular(path: string): number {
  const before = regular(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  if (stamp(before) !== stamp(fstatSync(fd))) {
    closeSync(fd);
    throw new Error("room history changed while opening");
  }
  return fd;
}
function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Bounded memory, strict complete records, exact physical offsets. */
function* lines(
  fd: number,
  start: number,
  end: number,
  hashes?: string[],
): Generator<{ text: string; end: number }> {
  let offset = start;
  let carry = Buffer.alloc(0);
  while (offset < end) {
    const blockStart = hashes ? Math.floor(offset / 65536) * 65536 : offset;
    const data = Buffer.allocUnsafe(Math.min(65536, end - blockStart));
    let total = 0;
    while (total < data.length) {
      const count = readSync(fd, data, total, data.length - total, blockStart + total);
      if (!count) throw new Error("room history was truncated while reading");
      total += count;
    }
    if (hashes && createHash("sha256").update(data).digest("hex") !== hashes[blockStart / 65536]) {
      throw new Error("room history snapshot checksum mismatch");
    }
    const available = data.subarray(offset - blockStart);
    const count = available.length;
    offset += count;
    const chunk = Buffer.concat([carry, available]);
    let from = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, from);
      if (newline < 0) break;
      if (newline - from > MAX_LINE) throw new Error("room history record exceeds size limit");
      yield {
        text: decoder.decode(chunk.subarray(from, newline)),
        end: offset - chunk.length + newline + 1,
      };
      from = newline + 1;
    }
    carry = Buffer.from(chunk.subarray(from));
    if (carry.length > MAX_LINE) throw new Error("room history record exceeds size limit");
  }
  if (carry.length) throw new Error("room history has an incomplete final record");
}

export function scanRoomHistory<T extends { seq: number }>(
  file: string,
  parse: (value: unknown) => T | undefined,
  visit?: (message: T) => void,
): number {
  const fd = openRegular(file);
  try {
    const before = fstatSync(fd);
    if (before.size > MAX_BYTES)
      throw new Error("room history exceeds 256 MiB; archive it before continuing");
    let seq = 0;
    for (const line of lines(fd, 0, before.size)) {
      const msg = parse(JSON.parse(line.text));
      if (!msg || msg.seq !== seq + 1)
        throw new Error(`room history is corrupt at sequence ${seq + 1}`);
      seq = msg.seq;
      visit?.(msg);
    }
    if (stamp(before) !== stamp(fstatSync(fd)) || stamp(before) !== stamp(regular(file))) {
      throw new Error("room history changed while scanning");
    }
    return seq;
  } finally {
    closeSync(fd);
  }
}

interface Manifest {
  version: 1;
  roomId: string;
  snapshotId: string;
  bytes: number;
  throughSeq: number;
  sinceSeq: number;
  key: string;
  stamp: string;
  hashes: string[];
}
function validateManifest(value: Manifest, roomId: string, snapshotId: string): void {
  if (
    !value ||
    value.version !== 1 ||
    value.roomId !== roomId ||
    value.snapshotId !== snapshotId ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > MAX_BYTES ||
    !Number.isSafeInteger(value.throughSeq) ||
    value.throughSeq < 0 ||
    !Number.isSafeInteger(value.sinceSeq) ||
    value.sinceSeq < 0 ||
    value.sinceSeq > value.throughSeq ||
    typeof value.key !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.key) ||
    typeof value.stamp !== "string" ||
    !/^[0-9:.]+$/.test(value.stamp) ||
    !Array.isArray(value.hashes) ||
    value.hashes.length !== Math.ceil(value.bytes / 65536) ||
    value.hashes.some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
  )
    throw new Error("invalid history manifest");
}

interface Cursor {
  snapshotId: string;
  offset: number;
  afterSeq: number;
}

/** Durable immutable copies keep a frozen page boundary valid across Host restarts. */
export function readRoomHistoryPage<T extends { seq: number }>(
  roomDir: string,
  roomId: string,
  request: RoomHistoryRequest,
  parse: (value: unknown) => T | undefined,
): RoomHistoryPage<T> {
  const limit = request.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new Error("invalid history page limit");
  if (
    request.sinceSeq !== undefined &&
    (!Number.isSafeInteger(request.sinceSeq) || request.sinceSeq < 0)
  ) {
    throw new Error("invalid room sequence");
  }
  const directory = join(roomDir, "history-snapshots");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    throw new Error("invalid history snapshot directory");
  const assertDirectory = () => {
    const current = lstatSync(directory);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== directoryStat.dev ||
      current.ino !== directoryStat.ino
    )
      throw new Error("room history snapshot directory changed");
  };
  let manifest: Manifest;
  let cursor: Cursor;
  if (request.cursor !== undefined) {
    if (request.sinceSeq !== undefined || request.cursor.length > 2048)
      throw new Error("invalid history cursor");
    const [body, signature, extra] = request.cursor.split(".");
    if (!body || !signature || extra) throw new Error("invalid history cursor");
    cursor = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!UUID.test(cursor.snapshotId)) throw new Error("invalid history snapshot id");
    const path = join(directory, `${cursor.snapshotId}.json`);
    const metaFd = openRegular(path);
    try {
      const before = fstatSync(metaFd);
      if (before.size > 512 * 1024) throw new Error("invalid history manifest");
      manifest = JSON.parse(readFileSync(metaFd, "utf8"));
      if (stamp(before) !== stamp(fstatSync(metaFd)) || stamp(before) !== stamp(regular(path)))
        throw new Error("room history manifest changed while reading");
    } finally {
      closeSync(metaFd);
    }
    validateManifest(manifest, roomId, cursor.snapshotId);
    const expected = createHmac("sha256", manifest.key).update(body).digest();
    const received = Buffer.from(signature, "base64url");
    if (received.length !== expected.length || !timingSafeEqual(expected, received))
      throw new Error("invalid history cursor signature");
  } else {
    const snapshotId = randomUUID();
    const source = join(roomDir, "messages.jsonl");
    const file = join(directory, `${snapshotId}.jsonl`);
    const input = openRegular(source);
    let output: number | undefined;
    try {
      output = openSync(file, "wx", 0o600);
      const before = fstatSync(input);
      if (before.size > MAX_BYTES)
        throw new Error("room history exceeds 256 MiB; archive it before continuing");
      const hashes: string[] = [];
      let offset = 0;
      while (offset < before.size) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, before.size - offset));
        let count = 0;
        while (count < chunk.length) {
          const read = readSync(input, chunk, count, chunk.length - count, offset + count);
          if (!read) throw new Error("room history was truncated while freezing");
          count += read;
        }
        hashes.push(createHash("sha256").update(chunk).digest("hex"));
        let written = 0;
        while (written < count) {
          const progress = writeSync(output, chunk, written, count - written);
          if (!progress) throw new Error("room history freeze write made no progress");
          written += progress;
        }
        offset += count;
      }
      fsyncSync(output);
      if (stamp(before) !== stamp(fstatSync(input)) || stamp(before) !== stamp(regular(source))) {
        throw new Error("room history changed while freezing");
      }
      const throughSeq = scanRoomHistory(file, parse);
      manifest = {
        version: 1,
        roomId,
        snapshotId,
        bytes: before.size,
        throughSeq,
        sinceSeq: request.sinceSeq ?? 0,
        key: randomBytes(32).toString("hex"),
        stamp: stamp(fstatSync(output)),
        hashes,
      };
      const temporary = join(directory, `${snapshotId}.tmp`);
      writeFileSync(temporary, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
      const metaFd = openRegular(temporary);
      try {
        fsyncSync(metaFd);
      } finally {
        closeSync(metaFd);
      }
      assertDirectory();
      renameSync(temporary, join(directory, `${snapshotId}.json`));
      syncDirectory(directory);
      cursor = { snapshotId, offset: 0, afterSeq: 0 };
      // Old cursors fail explicitly when their retained copy expires. Never
      // remove another in-progress copy or an unknown directory entry.
      try {
        const old = readdirSync(directory)
          .filter((name) => UUID.test(name.replace(/\.json$/, "")) && name.endsWith(".json"))
          .map((name) => ({ name, time: regular(join(directory, name)).mtimeMs }))
          .sort((a, b) => b.time - a.time)
          .slice(8);
        for (const item of old) {
          if (item.name === `${snapshotId}.json`) continue;
          rmSync(join(directory, item.name));
          rmSync(join(directory, item.name.replace(/\.json$/, ".jsonl")), { force: true });
        }
      } catch {
        /* Retention failure must not invalidate the successfully published snapshot. */
      }
    } catch (error) {
      // Remove the publication marker before its data on an unpublished/failed
      // freeze. Retention failures are isolated after successful publication.
      rmSync(join(directory, `${snapshotId}.json`), { force: true });
      rmSync(join(directory, `${snapshotId}.tmp`), { force: true });
      rmSync(file, { force: true });
      throw error;
    } finally {
      closeSync(input);
      if (output !== undefined) closeSync(output);
    }
  }
  if (
    manifest.version !== 1 ||
    manifest.roomId !== roomId ||
    manifest.snapshotId !== cursor.snapshotId ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes < 0 ||
    manifest.bytes > MAX_BYTES ||
    !Number.isSafeInteger(manifest.throughSeq) ||
    manifest.throughSeq < 0 ||
    !Number.isSafeInteger(cursor.offset) ||
    cursor.offset < 0 ||
    cursor.offset > manifest.bytes ||
    !Number.isSafeInteger(cursor.afterSeq) ||
    cursor.afterSeq < 0 ||
    cursor.afterSeq > manifest.throughSeq
  ) {
    throw new Error("invalid room history snapshot");
  }
  assertDirectory();
  validateManifest(manifest, roomId, cursor.snapshotId);
  const file = join(directory, `${cursor.snapshotId}.jsonl`);
  const fd = openRegular(file);
  const messages: T[] = [];
  try {
    if (stamp(fstatSync(fd)) !== manifest.stamp)
      throw new Error("room history snapshot was modified");
    for (const line of lines(fd, cursor.offset, manifest.bytes, manifest.hashes)) {
      const msg = parse(JSON.parse(line.text));
      if (!msg || msg.seq !== cursor.afterSeq + 1)
        throw new Error("room history snapshot is corrupt");
      cursor.offset = line.end;
      cursor.afterSeq = msg.seq;
      if (msg.seq > manifest.sinceSeq) messages.push(msg);
      if (messages.length === limit) break;
    }
    if (stamp(fstatSync(fd)) !== manifest.stamp || stamp(regular(file)) !== manifest.stamp)
      throw new Error("room history snapshot changed while paging");
  } finally {
    closeSync(fd);
  }
  assertDirectory();
  const complete = cursor.offset === manifest.bytes;
  if (complete && cursor.afterSeq !== manifest.throughSeq)
    throw new Error("incomplete room history snapshot");
  const body = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return {
    snapshotId: manifest.snapshotId,
    throughSeq: manifest.throughSeq,
    messages,
    complete,
    ...(!complete
      ? {
          nextCursor: `${body}.${createHmac("sha256", manifest.key).update(body).digest("base64url")}`,
        }
      : {}),
  };
}
