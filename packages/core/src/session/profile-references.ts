import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";

const MAX_STATE_BYTES = 1024 * 1024;

/** Single-pass async scan for destructive operations that must visit every reference. */
export async function* iterateProfileReferences(
  storageDir: string,
  profileName: string,
  options: { includeArchived?: boolean },
  validateSessionId: (id: string) => void,
): AsyncGenerator<string> {
  const target = typeof profileName === "string" ? profileName.trim() : "";
  if (!target || target.length > 64) return;
  let directory;
  try {
    directory = await opendir(storageDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for await (const entry of directory) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith(".pending-") ||
      entry.name.startsWith("qchat-")
    ) {
      continue;
    }
    try {
      validateSessionId(entry.name);
    } catch {
      continue;
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let matches = false;
    try {
      const file = join(storageDir, entry.name, "state.json");
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) continue;
      handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== info.dev ||
        opened.ino !== info.ino ||
        opened.size > MAX_STATE_BYTES
      ) {
        continue;
      }
      // Bound the read even if another process grows or replaces the file.
      const bytes = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length !== opened.size) continue;
      let state: { workspaceProfile?: unknown; archivedAt?: unknown };
      try {
        state = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      } catch {
        // Match the existing reference query's treatment of corrupt states.
        continue;
      }
      if (!state || typeof state !== "object" || Array.isArray(state)) continue;
      matches =
        state.workspaceProfile === target &&
        (options.includeArchived !== false || typeof state.archivedAt !== "number");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") throw error;
    } finally {
      await handle?.close();
    }
    if (matches) yield entry.name;
  }
}
