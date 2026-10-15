/**
 * Tail recent log lines from ~/.code-shell/logs/. Desktop logs live in
 * desktop/; engine and terminal logs live directly in the logs directory.
 *
 * We don't tail in real time — the renderer asks for the most recent
 * N lines and re-polls as needed. Live streaming is a Phase 6 nicety.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type LogBucket = "ui-ink" | "engine" | "desktop";

const LOGS_DIR = path.join(os.homedir(), ".code-shell", "logs");

async function listLogFiles(
  dir: string,
  bucket: LogBucket,
): Promise<{ file: string; mtime: number }[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return await Promise.all(
      entries
        .filter((e) => e.isFile() && e.name.startsWith(`${bucket}-`) && e.name.endsWith(".log"))
        .map(async (e) => {
          const file = path.join(dir, e.name);
          try {
            const st = await fs.stat(file);
            return { file, mtime: st.mtimeMs };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        }),
    ).then((files) => files.filter((file) => file !== null));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export async function tailLog(
  bucket: LogBucket,
  lines = 200,
  baseDir: string = LOGS_DIR,
): Promise<string[]> {
  // Keep flat desktop logs readable during upgrades, while also reading the
  // dedicated directory used by desktop-logger's current writer.
  const dirs = bucket === "desktop" ? [path.join(baseDir, "desktop"), baseDir] : [baseDir];
  const entries = (await Promise.all(dirs.map((dir) => listLogFiles(dir, bucket)))).flat();
  if (entries.length === 0) return [];
  entries.sort((a, b) => b.mtime - a.mtime);
  const limit = Number.isSafeInteger(lines) && lines > 0 ? Math.min(lines, 10_000) : 200;
  // Read backwards in chunks. Reading the whole daily log made opening this
  // page allocate hundreds of MB even though the UI only needed a short tail.
  for (const entry of entries) {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(entry.file, "r");
    } catch (error) {
      // Rotation can remove a file between directory enumeration and open.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const { size } = await handle.stat();
      const chunks: Buffer[] = [];
      let offset = size;
      let readBytes = 0;
      let nonemptyLines = 0;
      let hasContent = false;
      const maxBytes = 8 * 1024 * 1024;
      while (offset > 0 && readBytes < maxBytes && nonemptyLines <= limit) {
        const length = Math.min(offset, 64 * 1024, maxBytes - readBytes);
        offset -= length;
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        const chunk = buffer.subarray(0, bytesRead);
        chunks.unshift(chunk);
        readBytes += length;
        // Count nonempty lines across chunk boundaries without decoding UTF-8
        // fragments. Decode once after all requested bytes have been collected.
        for (let index = chunk.length - 1; index >= 0; index -= 1) {
          if (chunk[index] === 10) {
            if (hasContent) nonemptyLines += 1;
            hasContent = false;
          } else if (chunk[index] !== 13) hasContent = true;
        }
      }
      const all = Buffer.concat(chunks).toString("utf8").split("\n");
      if (offset > 0 && all.length > 1) all.shift();
      return all
        .map((line) => line.replace(/\r$/, ""))
        .filter(Boolean)
        .slice(-limit);
    } finally {
      await handle.close();
    }
  }
  return [];
}
