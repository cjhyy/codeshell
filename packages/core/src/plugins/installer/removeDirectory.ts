import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, basename } from "node:path";

/** Constant-time namespace change; recursive deletion runs off the event loop. */
export function detachPluginDirectory(dir: string): string {
  const detached = join(dirname(dir), `.${basename(dir)}.removed-${randomUUID()}`);
  renameSync(dir, detached);
  return detached;
}

export async function removeDetachedPluginDirectories(dirs: readonly string[]): Promise<void> {
  // Always attempt every detached tree, including after a preceding error.
  const results = await Promise.allSettled(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}
