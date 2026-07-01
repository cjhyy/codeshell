import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type TrustLevel = "trusted" | "untrusted";

interface TrustMap {
  [path: string]: TrustLevel;
}

const FILE = path.join(os.homedir(), ".code-shell", "desktop", "trust.json");

/**
 * In-memory mirror of the trust map, kept in sync by every load()/setTrust().
 * Exists so the agent-bridge's synchronous `agent:msg` IPC handler can resolve
 * a project's trust without awaiting a disk read (it can't await — reordering
 * run vs approve/cancel would break). Warmed on startup via {@link warmTrustCache}.
 */
let cache: TrustMap = {};

async function load(): Promise<TrustMap> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    cache = JSON.parse(raw) as TrustMap;
    return cache;
  } catch {
    return {};
  }
}

async function save(map: TrustMap): Promise<void> {
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(map, null, 2), "utf8");
  } catch {
    // best effort
  }
}

export async function getTrust(p: string): Promise<TrustLevel | "unknown"> {
  const map = await load();
  return map[p] ?? "unknown";
}

export async function setTrust(p: string, level: TrustLevel): Promise<void> {
  const map = await load();
  map[p] = level;
  cache = map;
  await save(map);
}

/**
 * Synchronous trust lookup from the in-memory cache. Returns "unknown" if the
 * path was never trusted OR the cache hasn't been warmed yet — both map to
 * fail-closed (untrusted) at the call site. Use this only where you can't await
 * (the agent-bridge sync IPC handler); prefer {@link getTrust} otherwise.
 */
export function getTrustCachedSync(p: string): TrustLevel | "unknown" {
  return cache[p] ?? "unknown";
}

/** Prime the in-memory cache from disk. Call once during main startup. */
export async function warmTrustCache(): Promise<void> {
  await load();
}
