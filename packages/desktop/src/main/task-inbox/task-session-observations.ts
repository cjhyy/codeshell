import { lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TaskRows } from "./task-projection-rows.js";
import { changeTaskIntent } from "./task-projection.js";
import { checkedTaskObject } from "./task-inbox-types.js";

export interface DiskTaskSession {
  id: string;
  archivedAt?: number;
}
export function isDiskTaskId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "." &&
    value !== ".." &&
    /^[a-zA-Z0-9_.-]{1,512}$/.test(value)
  );
}
export function parseDiskTaskSessions(raw: unknown): DiskTaskSession[] {
  const p = checkedTaskObject(raw, new Set(["sessions"]));
  if (!Array.isArray(p.sessions)) throw new Error("Invalid disk session observations");
  return p.sessions.map((item) => {
    const s = checkedTaskObject(item, new Set(["id", "archivedAt"]));
    if (
      !isDiskTaskId(s.id) ||
      (s.archivedAt !== undefined &&
        !(typeof s.archivedAt === "number" && Number.isFinite(s.archivedAt) && s.archivedAt >= 0))
    )
      throw new Error("Invalid disk session");
    return { id: s.id, archivedAt: s.archivedAt };
  });
}

function directoryGone(root: string, id: string): boolean {
  // A filtered catalog, corrupt state.json or unavailable volume cannot prove
  // a user deleted a session. The directory itself must have disappeared.
  try {
    if (!statSync(root).isDirectory()) return false;
    lstatSync(join(root, id));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    try {
      return statSync(root).isDirectory();
    } catch {
      return false;
    }
  }
}
export function observeDiskTaskSessions(
  rows: TaskRows,
  root: string,
  previous: string[],
  sessions: DiskTaskSession[],
) {
  const next = new Set(previous);
  const now = Date.now();
  let changed = false;
  const present = new Set<string>();
  for (const { id, archivedAt } of sessions) {
    present.add(id);
    next.add(id);
    if (
      changeTaskIntent(
        rows,
        {
          type: archivedAt === undefined ? "sessionUnarchived" : "sessionArchived",
          sessionId: id,
        },
        archivedAt ?? now,
      )
    )
      changed = true;
  }
  for (const id of previous) {
    if (present.has(id) || !directoryGone(root, id)) continue;
    if (changeTaskIntent(rows, { type: "sessionDeleted", sessionId: id }, now)) changed = true;
    next.delete(id);
  }
  const observed = [...next].sort();
  return {
    changed,
    observed,
    membershipChanged:
      observed.length !== previous.length || observed.some((id, i) => id !== previous[i]),
  };
}
