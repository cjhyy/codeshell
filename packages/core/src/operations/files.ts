import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";

/** All operation sidecars are used under the original ledger directory lock. */
export function operationDirectory(path: string, create = false): Stats {
  if (create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const info = lstatSync(path);
  // Windows mode bits do not describe owner/group/other ACL permissions. As for
  // the existing ledger/credential store, Windows relies on Host storage ACLs;
  // these helpers neither validate nor repair that ACL boundary.
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new Error("Invalid private operation directory");
  return info;
}

export function operationFile(path: string, maxBytes: number): Stats {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > maxBytes ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new Error("Invalid private operation file or bounds exceeded");
  return info;
}

/** Fixed allocation/read ceiling also rejects a file that grows after fstat. */
export function readOperationFile(path: string, maxBytes: number): string {
  const before = operationFile(path, maxBytes);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1)
      throw new Error("Operation file changed");
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    for (;;) {
      const read = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      bytes += read;
      if (bytes > maxBytes) throw new Error("Operation file exceeds bounds");
      if (read === 0) break;
    }
    const after = fstatSync(fd);
    const current = operationFile(path, maxBytes);
    if (
      after.size !== bytes ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.dev !== after.dev ||
      current.ino !== after.ino
    )
      throw new Error("Operation file changed while reading");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
  } finally {
    closeSync(fd);
  }
}
