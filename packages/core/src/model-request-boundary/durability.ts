import { closeSync, constants, fsyncSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** FlushFileBuffers requires a writable handle on Windows. The file must
 * already exist; O_RDWR neither creates, truncates nor appends to it. */
export function openForDurableRead(file: string, flags = 0): number {
  return openSync(
    file,
    (process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY) | flags,
  );
}

/** Commit every ancestor entry too: fsync(leaf) alone cannot preserve a newly-created parent. */
export function syncDirectoryAncestors(directory: string): void {
  if (process.platform === "win32") return;
  let current = resolve(directory);
  for (;;) {
    const fd = openSync(current, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
