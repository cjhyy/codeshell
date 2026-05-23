/**
 * Tail recent log lines from ~/.code-shell/logs/<bucket>-*.log.
 *
 * We don't tail in real time — the renderer asks for the most recent
 * N lines and re-polls as needed. Live streaming is a Phase 6 nicety.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type LogBucket = "ui-ink" | "engine" | "desktop";

const LOGS_DIR = path.join(os.homedir(), ".code-shell", "logs");

export async function tailLog(bucket: LogBucket, lines = 200): Promise<string[]> {
  let entries: { name: string; mtime: number }[];
  try {
    const dir = await fs.readdir(LOGS_DIR, { withFileTypes: true });
    entries = await Promise.all(
      dir
        .filter((e) => e.isFile() && e.name.startsWith(`${bucket}-`) && e.name.endsWith(".log"))
        .map(async (e) => {
          const st = await fs.stat(path.join(LOGS_DIR, e.name));
          return { name: e.name, mtime: st.mtimeMs };
        }),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  if (entries.length === 0) return [];
  entries.sort((a, b) => b.mtime - a.mtime);
  const newest = path.join(LOGS_DIR, entries[0].name);
  const raw = await fs.readFile(newest, "utf8");
  const all = raw.split("\n").filter(Boolean);
  return all.slice(-lines);
}
