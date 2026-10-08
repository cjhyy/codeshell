import { closeSync, fsyncSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
