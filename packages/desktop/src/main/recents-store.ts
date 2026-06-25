import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: number;
  /** Pinned projects render first and are exempt from the MAX recents cap. */
  pinned?: boolean;
  /** Set when the user removes the project; persists so it doesn't reappear. */
  deletedAt?: number;
}

function defaultFile(): string {
  return path.join(os.homedir(), ".code-shell", "desktop", "recents.json");
}
let FILE = defaultFile();
/** Test-only: redirect the store file so tests never touch real ~/.code-shell. */
export function __setRecentsFileForTest(p: string | null): void {
  FILE = p ?? defaultFile();
}
const MAX = 10;

async function readAll(): Promise<RecentProject[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as RecentProject[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

async function writeAll(list: RecentProject[]): Promise<void> {
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(list, null, 2), "utf8");
  } catch {
    // best effort
  }
}

/** Live = not soft-deleted and directory still exists on disk. */
function isLive(r: RecentProject): boolean {
  return Boolean(r.path) && !r.deletedAt && fsSync.existsSync(r.path);
}

/** Recent-projects menu list: live, capped at MAX, newest-first as stored. */
export async function loadRecents(): Promise<RecentProject[]> {
  const all = await readAll();
  return all.filter(isLive).slice(0, MAX);
}

/** Full project list for UI (source of truth for the sidebar / mobile): live
 *  projects, pinned first. Pinned items are exempt from the MAX cap; only the
 *  unpinned tail is capped (recents semantics). */
export async function loadProjects(): Promise<RecentProject[]> {
  const all = await readAll();
  const live = all.filter(isLive);
  const pinned = live.filter((r) => r.pinned);
  const rest = live.filter((r) => !r.pinned).slice(0, MAX);
  return [...pinned, ...rest];
}

export async function setPinned(projectPath: string, pinned: boolean): Promise<void> {
  const all = await readAll();
  await writeAll(all.map((r) => (r.path === projectPath ? { ...r, pinned } : r)));
}

export async function softDelete(projectPath: string): Promise<void> {
  const all = await readAll();
  await writeAll(all.map((r) => (r.path === projectPath ? { ...r, deletedAt: Date.now() } : r)));
}

export async function pushRecent(p: RecentProject): Promise<RecentProject[]> {
  const all = await readAll();
  const prior = all.find((r) => r.path === p.path);
  // Re-opening a project un-deletes it and preserves its pin state.
  const merged: RecentProject = { ...prior, ...p, deletedAt: undefined };
  const next = [merged, ...all.filter((r) => r.path !== p.path)];
  await writeAll(next);
  return loadRecents();
}
