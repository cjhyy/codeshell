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
          const st = await fs.stat(file);
          return { file, mtime: st.mtimeMs };
        }),
    );
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
  const raw = await fs.readFile(entries[0].file, "utf8");
  const all = raw.split("\n").filter(Boolean);
  return all.slice(-lines);
}
