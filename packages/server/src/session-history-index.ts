import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { StorageDatabase } from "@cjhyy/code-shell-core/internal/storage";
import { isHistorySessionId, readHistorySummary } from "./session-history-summary.js";
import type { DesktopSessionSummary } from "./sessions-service.js";

type Candidate = { name: string; isDirectory(): boolean; isFile(): boolean };
function info(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
}
function stamp(stat?: Stats) {
  return stat && [stat.dev, stat.ino, stat.mode, stat.size, stat.ctimeMs, stat.mtimeMs];
}

function sources(root: string, id: string) {
  const candidates: Candidate[] = [];
  const stamps: Array<ReturnType<typeof stamp>> = [];
  const add = (name: string, stat: Stats) =>
    candidates.push({
      name,
      isDirectory: () => stat.isDirectory(),
      isFile: () => stat.isFile(),
    });
  const dir = info(join(root, id));
  if (dir?.isDirectory()) {
    stamps.push(
      stamp(dir),
      stamp(info(join(root, id, "state.json"))),
      stamp(info(join(root, id, "transcript.jsonl"))),
    );
    add(id, dir);
  }
  for (const suffix of [".json", ".jsonl"]) {
    const name = id + suffix;
    const flat = info(join(root, name));
    stamps.push(stamp(flat));
    if (flat?.isFile()) add(name, flat);
  }
  return { candidates, stamp: JSON.stringify(stamps) };
}

/** Update the Sessions page's file summaries in the storage worker. Only files
 * with a changed identity, size or timestamp are reopened to read titles. */
export async function reconcileSessionHistory(
  db: StorageDatabase,
  root: string,
  dirty?: readonly string[],
) {
  const present = info(root)?.isDirectory();
  const previous = dirty
    ? undefined
    : new Map(
        db
          .all<{ id: string; stamp: string }>("SELECT id, stamp FROM session_history")
          .map((row) => [row.id, row.stamp]),
      );
  const ids = new Set<string>();
  if (!dirty) {
    for (const entry of present ? readdirSync(root, { withFileTypes: true }) : []) {
      if (entry.isDirectory()) ids.add(entry.name);
      else if (entry.isFile() && /\.jsonl?$/.test(entry.name))
        ids.add(entry.name.replace(/\.jsonl?$/, ""));
    }
    for (const id of previous!.keys()) ids.add(id);
  } else {
    for (const id of dirty) {
      ids.add(id);
      if (/\.jsonl?$/.test(id)) ids.add(id.replace(/\.jsonl?$/, ""));
    }
  }
  for (const id of ids) {
    if (!isHistorySessionId(id)) continue;
    const before = present ? sources(root, id) : { candidates: [], stamp: "" };
    const old = previous
      ? previous.get(id)
      : db.get<{ stamp: string }>("SELECT stamp FROM session_history WHERE id=?", [id])?.stamp;
    if (!before.candidates.length) {
      if (old !== undefined) db.run("DELETE FROM session_history WHERE id=?", [id]);
      continue;
    }
    if (before.stamp === old) continue;
    let summary: DesktopSessionSummary | null = null;
    for (const entry of before.candidates) {
      summary = await readHistorySummary(entry, root);
      if (summary) break;
    }
    if (before.stamp !== sources(root, id).stamp) continue;
    db.run(
      `INSERT INTO session_history (id, stamp, file, title, size, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET stamp=excluded.stamp, file=excluded.file, title=excluded.title,
       size=excluded.size, created_at=excluded.created_at, updated_at=excluded.updated_at`,
      [
        id,
        before.stamp,
        summary?.file ?? null,
        summary?.title ?? null,
        summary?.size ?? null,
        summary?.createdAt ?? null,
        summary?.updatedAt ?? null,
      ],
    );
  }
}
