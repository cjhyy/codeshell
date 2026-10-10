/** Explicit local references: no copies, directory traversal or automatic refresh. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { CollectionLocalEntrySchema, type LocalCollectionEntry } from "./collection.js";
import { MAX_DOCUMENT_BYTES } from "./documents/types.js";

export interface CollectionReadOptions {
  signal?: AbortSignal;
  assertAuthorized?: () => void;
}

function assertAllowed(options: CollectionReadOptions): void {
  options.signal?.throwIfAborted();
  options.assertAuthorized?.();
}

function snapshot(
  path: string,
  options: CollectionReadOptions,
  expected?: Pick<LocalCollectionEntry, "dev" | "ino" | "sizeBytes" | "mtimeMs">,
) {
  assertAllowed(options);
  if (realpathSync(path) !== path)
    throw new Error("Collection file path changed; update the collection");
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("Collection entry must be a regular file");
  if (before.size > BigInt(MAX_DOCUMENT_BYTES))
    throw new Error("Collection file exceeds the 20 MiB parsing limit");
  const assertSelected = (info: typeof before) => {
    if (
      expected &&
      (info.dev.toString() !== expected.dev ||
        info.ino.toString() !== expected.ino ||
        Number(info.size) !== expected.sizeBytes ||
        Number(info.mtimeNs) / 1_000_000 !== expected.mtimeMs)
    )
      throw new Error(
        "Collection file changed since selection; update the collection before reading",
      );
  };
  assertSelected(before);
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fstatSync(fd, { bigint: true });
    assertSelected(opened);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs
    )
      throw new Error("Collection file changed before reading; update the collection");
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      assertAllowed(options);
      const count = readSync(fd, bytes, length, Math.min(64 * 1024, bytes.length - length), null);
      if (!count) break;
      length += count;
    }
    assertAllowed(options);
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (
      length !== Number(opened.size) ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      named.size !== opened.size ||
      named.mtimeNs !== opened.mtimeNs ||
      named.ctimeNs !== opened.ctimeNs ||
      realpathSync(path) !== path
    )
      throw new Error("Collection file changed during reading; update the collection");
    const content = bytes.subarray(0, length);
    return {
      bytes: content,
      sizeBytes: length,
      sha256: createHash("sha256").update(content).digest("hex"),
      dev: opened.dev.toString(),
      ino: opened.ino.toString(),
      mtimeMs: Number(opened.mtimeNs) / 1_000_000,
    };
  } finally {
    closeSync(fd);
  }
}

/** Native selection supplies the path; callers retain their owner/revision checks. */
export function captureCollectionLocalFile(
  path: string,
  id: string,
  name?: string,
  options: CollectionReadOptions = {},
): LocalCollectionEntry {
  assertAllowed(options);
  CollectionLocalEntrySchema.shape.id.parse(id);
  const selected = resolve(path);
  const info = lstatSync(selected, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error("Collection selection must be a regular file, not a symbolic link");
  const canonical = realpathSync(selected);
  assertAllowed(options);
  const label = CollectionLocalEntrySchema.shape.name.parse(name ?? basename(canonical));
  const { bytes: _bytes, ...proof } = snapshot(canonical, options, {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    sizeBytes: Number(info.size),
    mtimeMs: Number(info.mtimeNs) / 1_000_000,
  });
  return CollectionLocalEntrySchema.parse({
    id,
    name: label,
    kind: "local",
    path: canonical,
    checkedAt: new Date().toISOString(),
    ...proof,
  });
}

/** Every read validates the selected version, including reads satisfied by a parsed cache. */
export function readCollectionLocalFile(
  entry: LocalCollectionEntry,
  options: CollectionReadOptions = {},
): Uint8Array {
  const expected = CollectionLocalEntrySchema.parse(entry);
  const current = snapshot(expected.path, options, expected);
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.sizeBytes !== expected.sizeBytes ||
    current.mtimeMs !== expected.mtimeMs ||
    current.sha256 !== expected.sha256
  )
    throw new Error(
      "Collection file changed since selection; update the collection before reading",
    );
  return current.bytes;
}
