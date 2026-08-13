import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { codeShellHome } from "@cjhyy/code-shell-core";
import { acquireFileLock } from "@cjhyy/code-shell-core/internal";

export type TrustLevel = "trusted" | "untrusted";

interface TrustMap {
  [path: string]: TrustLevel;
}

const MAX_TRUST_ENTRIES = 20_000;
const MAX_PATH_LENGTH = 32_768;
const MAX_TRUST_FILE_BYTES = 4 * 1024 * 1024;

function defaultFile(): string {
  return path.join(codeShellHome(), "desktop", "trust.json");
}

let file = defaultFile();
let cache: TrustMap = {};
let mutationQueue: Promise<void> = Promise.resolve();

/** Test-only isolation hook. */
export function __setTrustFileForTest(next: string | null): void {
  file = next ?? defaultFile();
  cache = {};
  mutationQueue = Promise.resolve();
}

function validTrustPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !value.includes("\0") &&
    path.isAbsolute(value)
  );
}

function canonicalTrustPath(projectPath: string): string {
  try {
    return path.resolve(realpathSync(projectPath));
  } catch {
    return path.resolve(projectPath);
  }
}

function parseTrustMap(value: unknown): TrustMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("trust registry root must be an object");
  }
  const result: TrustMap = {};
  const entries = Object.entries(value);
  if (entries.length > MAX_TRUST_ENTRIES) throw new Error("trust registry is too large");
  for (const [projectPath, level] of entries) {
    if (!validTrustPath(projectPath) || (level !== "trusted" && level !== "untrusted")) {
      throw new Error("trust registry contains an invalid entry");
    }
    const canonical = canonicalTrustPath(projectPath);
    // Conflicting legacy aliases fail closed: an explicit untrusted record wins.
    result[canonical] = result[canonical] === "untrusted" ? "untrusted" : level;
  }
  return result;
}

/** Every read refreshes the sync cache; any failure clears it (fail closed). */
async function load(target = file): Promise<TrustMap> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const entry = await fs.lstat(target);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_TRUST_FILE_BYTES) {
      throw new Error("trust registry must be a bounded regular file");
    }
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_TRUST_FILE_BYTES) {
      throw new Error("trust registry must be a bounded regular file");
    }
    const next = parseTrustMap(JSON.parse(await handle.readFile("utf8")) as unknown);
    cache = next;
    return next;
  } catch {
    cache = {};
    return {};
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertSafeTrustParent(target: string): Promise<void> {
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await fs.lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error("trust registry directory must be a real directory");
  }
}

async function save(target: string, map: TrustMap): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await assertSafeTrustParent(target);
    try {
      const targetInfo = await fs.lstat(target);
      if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
        throw new Error("trust registry target must be a regular file");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const serialized = `${JSON.stringify(map, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_TRUST_FILE_BYTES) {
      throw new Error("trust registry is too large");
    }
    await fs.writeFile(temporary, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function serializeMutation(mutation: (target: string) => Promise<void>): Promise<void> {
  const target = file;
  const result = mutationQueue.then(() => mutation(target));
  mutationQueue = result.catch(() => undefined);
  return result;
}

export async function getTrust(projectPath: string): Promise<TrustLevel | "unknown"> {
  if (!validTrustPath(projectPath)) return "unknown";
  await mutationQueue.catch(() => undefined);
  const map = await load();
  return map[canonicalTrustPath(projectPath)] ?? "unknown";
}

export function setTrust(projectPath: string, level: TrustLevel): Promise<void> {
  if (!validTrustPath(projectPath)) throw new Error("invalid trust path");
  if (level !== "trusted" && level !== "untrusted") throw new Error("invalid trust level");
  const canonical = canonicalTrustPath(projectPath);
  return serializeMutation(async (target) => {
    await assertSafeTrustParent(target);
    const release = acquireFileLock(target);
    try {
      // Re-read while holding the cross-process lock. Atomic rename alone does
      // not stop two desktop instances from both writing a stale snapshot.
      const map = { ...(await load(target)) };
      if (!(canonical in map) && Object.keys(map).length >= MAX_TRUST_ENTRIES) {
        throw new Error("trust registry is full");
      }
      map[canonical] = level;
      // Only publish trusted state to the sync path after durable persistence.
      await save(target, map);
      cache = map;
    } finally {
      release();
    }
  });
}

/** Synchronous, fail-closed lookup used by the agent bridge's ordered IPC path. */
export function getTrustCachedSync(projectPath: string): TrustLevel | "unknown" {
  return validTrustPath(projectPath)
    ? (cache[canonicalTrustPath(projectPath)] ?? "unknown")
    : "unknown";
}

/** Prime the cache from disk before accepting renderer run requests. */
export async function warmTrustCache(): Promise<void> {
  await mutationQueue.catch(() => undefined);
  await load();
}

/**
 * Summary of dangerous config a project would apply if trusted. This reads raw
 * project files deliberately so malformed configuration is still surfaced.
 */
export interface ProjectTrustRisks {
  permissionRules: number;
  envKeys: string[];
  hooks: number;
  mcpServers: string[];
  setupScripts: boolean;
}

function readJsonObject(target: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

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
    permissionRules: Array.isArray(perms?.rules) ? perms.rules.length : 0,
    envKeys: env && typeof env === "object" ? Object.keys(env) : [],
    hooks: Array.isArray(hooks) ? hooks.length : 0,
    mcpServers: mcp && typeof mcp === "object" ? Object.keys(mcp) : [],
    setupScripts: Boolean(localEnv && typeof localEnv === "object" && localEnv.setupScripts),
  };
}
