import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: number;
}

const FILE = path.join(os.homedir(), ".code-shell", "desktop", "recents.json");
const MAX = 10;

export async function loadRecents(): Promise<RecentProject[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as RecentProject[];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX);
  } catch {
    return [];
  }
}

export async function pushRecent(p: RecentProject): Promise<RecentProject[]> {
  const cur = await loadRecents();
  const next = [p, ...cur.filter((r) => r.path !== p.path)].slice(0, MAX);
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(next, null, 2), "utf8");
  } catch {
    // best effort
  }
  return next;
}
