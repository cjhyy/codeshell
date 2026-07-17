import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, stat } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { PluginInstallError } from "./types.js";

export const MAX_NPM_TARBALL_BYTES = 64 * 1024 * 1024;
export const MAX_NPM_TAR_EXTRACTED_BYTES = 256 * 1024 * 1024;
export const MAX_NPM_TAR_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_NPM_TAR_ENTRIES = 10_000;
export const MAX_NPM_TAR_PATH_BYTES = 1_024;
export const MAX_NPM_TAR_DEPTH = 32;

const TAR_BLOCK = 512;
const MAX_PAX_BYTES = 64 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function installError(message: string, cause?: unknown): PluginInstallError {
  const suffix = cause instanceof Error ? `: ${cause.message}` : "";
  return new PluginInstallError(`${message}${suffix}`);
}

/** Inflate the npm .tgz into a bounded private tar file. */
export async function gunzipNpmTarball(tgzPath: string, tarPath: string): Promise<void> {
  const compressed = await stat(tgzPath);
  if (!compressed.isFile() || compressed.size > MAX_NPM_TARBALL_BYTES) {
    throw new PluginInstallError(
      `npm plugin tarball must be a regular file no larger than ${MAX_NPM_TARBALL_BYTES} bytes`,
    );
  }
  let expanded = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      expanded += chunk.length;
      if (expanded > MAX_NPM_TAR_EXTRACTED_BYTES) {
        callback(
          new PluginInstallError(
            `npm plugin tarball expands beyond ${MAX_NPM_TAR_EXTRACTED_BYTES} bytes`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(tgzPath),
      createGunzip(),
      limiter,
      createWriteStream(tarPath, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    if (error instanceof PluginInstallError) throw error;
    throw installError("cannot decompress npm plugin tarball", error);
  }
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function decodeField(block: Buffer, start: number, length: number, label: string): string {
  const field = block.subarray(start, start + length);
  const nul = field.indexOf(0);
  const value = nul < 0 ? field : field.subarray(0, nul);
  try {
    return utf8.decode(value);
  } catch (error) {
    throw installError(`npm tar has invalid UTF-8 in ${label}`, error);
  }
}

function parseOctal(block: Buffer, start: number, length: number, label: string): number {
  const field = block.subarray(start, start + length);
  if ((field[0] ?? 0) & 0x80) {
    throw new PluginInstallError(`npm tar uses unsupported base-256 ${label}`);
  }
  const raw = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(raw)) {
    throw new PluginInstallError(`npm tar has invalid ${label}`);
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PluginInstallError(`npm tar ${label} is out of range`);
  }
  return value;
}

function assertHeaderChecksum(block: Buffer): void {
  const expected = parseOctal(block, 148, 8, "header checksum");
  let actual = 0;
  for (let i = 0; i < block.length; i += 1) {
    actual += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
  }
  if (actual !== expected) {
    throw new PluginInstallError("npm tar header checksum mismatch");
  }
}

function safeTarPath(destDir: string, rawName: string): { target: string; portableKey: string } {
  if (
    rawName.length === 0 ||
    Buffer.byteLength(rawName, "utf8") > MAX_NPM_TAR_PATH_BYTES ||
    rawName.includes("\0") ||
    rawName.includes("\\") ||
    rawName.startsWith("/") ||
    /^[A-Za-z]:/.test(rawName)
  ) {
    throw new PluginInstallError(`refusing unsafe npm tar path: ${rawName}`);
  }
  const segments = rawName.replace(/\/+$/, "").split("/");
  if (
    segments.length === 0 ||
    segments.length > MAX_NPM_TAR_DEPTH ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new PluginInstallError(`refusing unsafe npm tar path: ${rawName}`);
  }
  const target = normalize(join(destDir, ...segments));
  const root = normalize(destDir.endsWith(sep) ? destDir : destDir + sep);
  if (target !== normalize(destDir) && !target.startsWith(root)) {
    throw new PluginInstallError(`npm tar path escapes extraction root: ${rawName}`);
  }
  // Reject names that collide on the default case-insensitive macOS/Windows
  // filesystems even when tests run on a case-sensitive volume.
  return { target, portableKey: segments.join("/").toLowerCase() };
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const value = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(value, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new PluginInstallError("npm tar is truncated");
    offset += bytesRead;
  }
  return value;
}

function parsePax(data: Buffer): { path?: string } {
  let cursor = 0;
  const result: { path?: string } = {};
  while (cursor < data.length) {
    const space = data.indexOf(0x20, cursor);
    if (space < 0) throw new PluginInstallError("npm tar has malformed PAX metadata");
    const lengthText = data.subarray(cursor, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) {
      throw new PluginInstallError("npm tar has malformed PAX record length");
    }
    const length = Number(lengthText);
    if (
      !Number.isSafeInteger(length) ||
      length <= space - cursor + 2 ||
      cursor + length > data.length
    ) {
      throw new PluginInstallError("npm tar has out-of-range PAX record length");
    }
    const record = data.subarray(space + 1, cursor + length);
    if (record[record.length - 1] !== 0x0a) {
      throw new PluginInstallError("npm tar PAX record is not newline terminated");
    }
    let text: string;
    try {
      text = utf8.decode(record.subarray(0, -1));
    } catch (error) {
      throw installError("npm tar has invalid UTF-8 in PAX metadata", error);
    }
    const equals = text.indexOf("=");
    if (equals <= 0) throw new PluginInstallError("npm tar has malformed PAX metadata");
    const key = text.slice(0, equals);
    const value = text.slice(equals + 1);
    if (key === "path") result.path = value;
    if (key === "linkpath") {
      throw new PluginInstallError("npm tar link metadata is forbidden");
    }
    if (key === "size") {
      throw new PluginInstallError("npm tar PAX size overrides are unsupported");
    }
    cursor += length;
  }
  return result;
}

async function copyFilePayload(
  source: Awaited<ReturnType<typeof open>>,
  sourceOffset: number,
  target: string,
  size: number,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const output = await open(target, "wx", 0o600);
  try {
    let copied = 0;
    while (copied < size) {
      const chunkSize = Math.min(64 * 1024, size - copied);
      const chunk = await readExactly(source, sourceOffset + copied, chunkSize);
      await output.write(chunk, 0, chunk.length, copied);
      copied += chunk.length;
    }
  } finally {
    await output.close();
  }
}

/**
 * Extract only regular files/directories from an already-bounded tar.
 * Links, devices, FIFOs, sparse files and every other special type fail closed.
 */
export async function extractNpmTar(tarPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true, mode: 0o700 });
  const destination = await lstat(destDir);
  if (!destination.isDirectory() || destination.isSymbolicLink()) {
    throw new PluginInstallError("npm tar extraction destination must be a real directory");
  }
  if ((await readdir(destDir)).length !== 0) {
    throw new PluginInstallError("npm tar extraction destination must be empty");
  }
  const archive = await stat(tarPath);
  if (!archive.isFile() || archive.size > MAX_NPM_TAR_EXTRACTED_BYTES) {
    throw new PluginInstallError("npm tar is not a bounded regular file");
  }

  const input = await open(tarPath, "r");
  const seen = new Set<string>();
  let entries = 0;
  let materializedBytes = 0;
  let position = 0;
  let zeroBlocks = 0;
  let nextPath: string | undefined;
  try {
    while (position < archive.size) {
      if (position + TAR_BLOCK > archive.size) {
        throw new PluginInstallError("npm tar has a partial header block");
      }
      const header = await readExactly(input, position, TAR_BLOCK);
      position += TAR_BLOCK;
      if (isZeroBlock(header)) {
        zeroBlocks += 1;
        if (zeroBlocks >= 2) break;
        continue;
      }
      if (zeroBlocks !== 0) {
        throw new PluginInstallError("npm tar has data after an end marker");
      }
      assertHeaderChecksum(header);
      entries += 1;
      if (entries > MAX_NPM_TAR_ENTRIES) {
        throw new PluginInstallError(`npm tar contains more than ${MAX_NPM_TAR_ENTRIES} entries`);
      }

      const name = decodeField(header, 0, 100, "entry name");
      const prefix = decodeField(header, 345, 155, "entry prefix");
      const headerPath = prefix ? `${prefix}/${name}` : name;
      const size = parseOctal(header, 124, 12, "entry size");
      const typeByte = header[156] ?? 0;
      const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
      const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
      if (position + padded > archive.size) {
        throw new PluginInstallError("npm tar entry payload is truncated");
      }

      if (type === "x") {
        if (size > MAX_PAX_BYTES) throw new PluginInstallError("npm tar PAX metadata is too large");
        const pax = parsePax(await readExactly(input, position, size));
        nextPath = pax.path;
        position += padded;
        continue;
      }
      if (type === "g") {
        if (size > MAX_PAX_BYTES) throw new PluginInstallError("npm tar PAX metadata is too large");
        parsePax(await readExactly(input, position, size));
        position += padded;
        continue;
      }
      if (type === "L") {
        if (size === 0 || size > MAX_NPM_TAR_PATH_BYTES + 1) {
          throw new PluginInstallError("npm tar GNU long path is out of bounds");
        }
        const longName = await readExactly(input, position, size);
        const nul = longName.indexOf(0);
        try {
          nextPath = utf8.decode(nul < 0 ? longName : longName.subarray(0, nul));
        } catch (error) {
          throw installError("npm tar has invalid UTF-8 in GNU long path", error);
        }
        position += padded;
        continue;
      }

      const effectivePath = nextPath ?? headerPath;
      nextPath = undefined;
      if (type !== "0" && type !== "5") {
        const labels: Record<string, string> = {
          "1": "hardlink",
          "2": "symlink",
          "3": "character device",
          "4": "block device",
          "6": "FIFO",
        };
        throw new PluginInstallError(
          `npm tar ${labels[type] ?? `special entry type ${JSON.stringify(type)}`} is forbidden: ${effectivePath}`,
        );
      }
      const safe = safeTarPath(destDir, effectivePath);
      if (seen.has(safe.portableKey)) {
        throw new PluginInstallError(`npm tar contains a duplicate path: ${effectivePath}`);
      }
      seen.add(safe.portableKey);

      if (type === "5") {
        if (size !== 0) throw new PluginInstallError("npm tar directory has a non-zero payload");
        await mkdir(safe.target, { recursive: true, mode: 0o700 });
      } else {
        if (size > MAX_NPM_TAR_FILE_BYTES) {
          throw new PluginInstallError(`npm tar file exceeds ${MAX_NPM_TAR_FILE_BYTES} bytes`);
        }
        materializedBytes += size;
        if (materializedBytes > MAX_NPM_TAR_EXTRACTED_BYTES) {
          throw new PluginInstallError(
            `npm tar files exceed ${MAX_NPM_TAR_EXTRACTED_BYTES} extracted bytes`,
          );
        }
        await copyFilePayload(input, position, safe.target, size);
      }
      position += padded;
    }

    if (zeroBlocks < 2) throw new PluginInstallError("npm tar is missing its end marker");
    while (position < archive.size) {
      const remaining = Math.min(TAR_BLOCK, archive.size - position);
      const trailing = await readExactly(input, position, remaining);
      if (!isZeroBlock(trailing)) {
        throw new PluginInstallError("npm tar has non-zero trailing data");
      }
      position += remaining;
    }
    if (nextPath !== undefined) {
      throw new PluginInstallError("npm tar ends with unapplied path metadata");
    }
  } finally {
    await input.close();
  }
}
