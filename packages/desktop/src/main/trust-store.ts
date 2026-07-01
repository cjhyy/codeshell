import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
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

/**
 * Summary of the dangerous config a project would apply IF trusted — shown in
 * the trust dialog so the user sees the risk before granting trust (mirrors
 * Claude Code's TrustDialog, which lists Bash rules / env / hooks / MCP). These
 * are exactly the fields core strips from an untrusted project
 * (DANGEROUS_PROJECT_FIELDS): permissions.rules, env, hooks, mcpServers,
 * localEnvironment.setupScripts. All counts are 0 when the repo ships no
 * `.code-shell` settings — the common, low-risk case.
 */
export interface ProjectTrustRisks {
  permissionRules: number;
  envKeys: string[];
  hooks: number;
  mcpServers: string[];
  setupScripts: boolean;
}

function readJsonObject(p: string): Record<string, unknown> {
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Read a project's own `.code-shell/settings.{json,local.json}` (local over
 * project) and summarize its dangerous fields. Raw file read — deliberately no
 * schema validation, so we surface risk even from a malformed file. Never
 * throws; missing files → all-zero.
 */
export function summarizeProjectTrustRisks(cwd: string): ProjectTrustRisks {
  const dir = path.join(cwd, ".code-shell");
  const merged: Record<string, unknown> = {
    ...readJsonObject(path.join(dir, "settings.json")),
    ...readJsonObject(path.join(dir, "settings.local.json")),
  };
  const perms = merged.permissions as { rules?: unknown[] } | undefined;
  const env = merged.env as Record<string, unknown> | undefined;
  const hooks = merged.hooks as unknown[] | undefined;
  const mcp = merged.mcpServers as Record<string, unknown> | undefined;
  const localEnv = merged.localEnvironment as { setupScripts?: unknown } | undefined;
  return {
    permissionRules: Array.isArray(perms?.rules) ? perms!.rules!.length : 0,
    envKeys: env && typeof env === "object" ? Object.keys(env) : [],
    hooks: Array.isArray(hooks) ? hooks.length : 0,
    mcpServers: mcp && typeof mcp === "object" ? Object.keys(mcp) : [],
    setupScripts: !!(localEnv && typeof localEnv === "object" && localEnv.setupScripts),
  };
}
