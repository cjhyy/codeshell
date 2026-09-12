import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { processLimits } from "./process-state.js";

function identity(info: Stats): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode].join(":");
}

/** The callback supplies an installed, reviewed entry, never a Guest-provided path. */
export async function verifyProcessEntry(path: string, sha256: string): Promise<string> {
  if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(sha256))
    throw new Error("invalid reviewed package entry");
  if ((await realpath(path)) !== path)
    throw new Error("package entry path contains a symbolic link");
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new Error("package entry must be an unlinked regular file");
  if (before.size > processLimits.maxEntryBytes)
    throw new Error("package entry exceeds size limit");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (identity(opened) !== identity(before))
      throw new Error("package entry changed while opening");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > processLimits.maxEntryBytes) throw new Error("package entry exceeds size limit");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    const current = await lstat(path);
    if (
      identity(opened) !== identity(after) ||
      identity(opened) !== identity(current) ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      (await realpath(path)) !== path ||
      total !== opened.size ||
      hash.digest("hex") !== sha256
    )
      throw new Error("reviewed package entry changed or failed its hash check");
    return identity(opened);
  } finally {
    await file.close();
  }
}
