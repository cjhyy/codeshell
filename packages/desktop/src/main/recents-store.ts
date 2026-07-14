import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveProjectRoot } from "@cjhyy/code-shell-capability-coding";

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
  canonicalPathCache.clear();
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

const canonicalPathCache = new Map<string, string>();

function canonicalPath(projectPath: string): string {
  const cached = canonicalPathCache.get(projectPath);
  if (cached) return cached;
  const root = resolveProjectRoot(projectPath);
  canonicalPathCache.set(projectPath, root);
  return root;
}

function canonicalizeProject(p: RecentProject): RecentProject {
  const root = p.path ? canonicalPath(p.path) : p.path;
  return { ...p, path: root, name: p.name || path.basename(root) };
}

function mergeCanonicalProjects(list: RecentProject[]): RecentProject[] {
  const byPath = new Map<string, RecentProject>();
  const order: string[] = [];
  for (const raw of list) {
    const p = canonicalizeProject(raw);
    const prior = byPath.get(p.path);
    if (!prior) {
      byPath.set(p.path, p);
      order.push(p.path);
      continue;
    }
    const merged: RecentProject = {
      ...prior,
      ...p,
      name: path.basename(p.path) || p.name || prior.name,
      lastOpenedAt: Math.max(prior.lastOpenedAt ?? 0, p.lastOpenedAt ?? 0),
      pinned: Boolean(prior.pinned || p.pinned) || undefined,
      deletedAt:
        prior.deletedAt && p.deletedAt ? Math.max(prior.deletedAt, p.deletedAt) : undefined,
    };
    byPath.set(p.path, merged);
  }
  return order.map((p) => byPath.get(p)!).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

async function readCanonicalAll(): Promise<RecentProject[]> {
  const raw = await readAll();
  const canonical = mergeCanonicalProjects(raw);
  if (JSON.stringify(raw) !== JSON.stringify(canonical)) await writeAll(canonical);
  return canonical;
}

/** Live = not soft-deleted and directory still exists on disk. */
function isLive(r: RecentProject): boolean {
  return Boolean(r.path) && !r.deletedAt && fsSync.existsSync(r.path);
}

/** Recent-projects menu list: live, capped at MAX, newest-first as stored. */
export async function loadRecents(): Promise<RecentProject[]> {
  const all = await readCanonicalAll();
  return all.filter(isLive).slice(0, MAX);
}

/** Full project list for UI (source of truth for the sidebar / mobile): ALL live
 *  projects, pinned first. Unlike loadRecents (a capped "recent menu"), this is
 *  the registry — it is NOT capped, so a user's full project set survives. */
export async function loadProjects(): Promise<RecentProject[]> {
  const all = await readCanonicalAll();
  const live = all.filter(isLive);
  const pinned = live.filter((r) => r.pinned);
  const rest = live.filter((r) => !r.pinned);
  return [...pinned, ...rest];
}

export async function setPinned(projectPath: string, pinned: boolean): Promise<void> {
  const target = canonicalPath(projectPath);
  const all = await readCanonicalAll();
  await writeAll(all.map((r) => (r.path === target ? { ...r, pinned } : r)));
}

export async function softDelete(projectPath: string): Promise<void> {
  const target = canonicalPath(projectPath);
  const all = await readCanonicalAll();
  await writeAll(all.map((r) => (r.path === target ? { ...r, deletedAt: Date.now() } : r)));
}

export async function pushRecent(p: RecentProject): Promise<RecentProject[]> {
  const project = canonicalizeProject(p);
  const all = await readCanonicalAll();
  const prior = all.find((r) => r.path === project.path);
  // Re-opening a project un-deletes it and preserves its pin state.
  const merged: RecentProject = { ...prior, ...project, deletedAt: undefined };
  const next = [merged, ...all.filter((r) => r.path !== project.path)];
  await writeAll(mergeCanonicalProjects(next));
  return loadRecents();
}
