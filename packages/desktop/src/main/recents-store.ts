import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveProjectRoot } from "@cjhyy/code-shell-capability-coding/git";
import { dlog } from "./desktop-logger.js";

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: number;
  /** Pinned projects render first in the full project registry. */
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
const RECENT_MENU_MAX = 10;
/** Safety bound only; loadProjects remains the complete registry below this generous limit. */
const REGISTRY_MAX = 5_000;
const REGISTRY_SCAN_MAX = 20_000;
const PROJECT_PATH_MAX = 32_768;
const PROJECT_NAME_MAX = 1_024;

let mutationQueue: Promise<void> = Promise.resolve();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function registryError(file: string, message: string): Error {
  return new Error(`Invalid recent-project registry at ${file}: ${message}`);
}

function validProjectPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    value.length <= PROJECT_PATH_MAX &&
    !value.includes("\0") &&
    path.isAbsolute(value)
  );
}

function checkedCanonicalPath(projectPath: unknown): string {
  if (!validProjectPath(projectPath)) throw new Error("Invalid recent project path");
  return canonicalPath(projectPath);
}

async function checkedRegistryText(file: string): Promise<string | undefined> {
  let info: fsSync.Stats;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw registryError(file, "registry file must not be a symbolic link");
  }
  if (!info.isFile()) throw registryError(file, "registry path is not a regular file");

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()) throw registryError(file, "registry path is not a regular file");
    return await handle.readFile("utf8");
  } finally {
    await handle?.close();
  }
}

function validTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0
  );
}

function parseRecentProject(value: unknown): RecentProject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!validProjectPath(item.path)) {
    return undefined;
  }
  if (
    typeof item.name !== "string" ||
    !item.name.trim() ||
    item.name.length > PROJECT_NAME_MAX ||
    /[\0\r\n]/u.test(item.name)
  ) {
    return undefined;
  }
  if (!validTimestamp(item.lastOpenedAt)) return undefined;
  if (item.pinned !== undefined && typeof item.pinned !== "boolean") return undefined;
  if (item.deletedAt !== undefined && !validTimestamp(item.deletedAt)) return undefined;

  return {
    path: item.path,
    name: item.name.trim(),
    lastOpenedAt: item.lastOpenedAt,
    ...(item.pinned === true ? { pinned: true } : {}),
    ...(item.deletedAt !== undefined ? { deletedAt: item.deletedAt } : {}),
  };
}

async function readAll(file: string): Promise<RecentProject[]> {
  try {
    const raw = await checkedRegistryText(file);
    if (raw === undefined) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw registryError(file, `JSON parse failed: ${errorMessage(error)}`);
    }
    if (!Array.isArray(parsed)) {
      throw registryError(file, "top-level value must be an array");
    }

    const scanned = parsed.slice(0, REGISTRY_SCAN_MAX);
    const valid = scanned
      .map((item) => parseRecentProject(item))
      .filter((item): item is RecentProject => item !== undefined);
    const invalidCount = scanned.length - valid.length;
    if (invalidCount > 0) {
      dlog("main", "recents_store.entries_isolated", {
        file,
        invalidCount,
        scannedCount: scanned.length,
      });
    }
    if (parsed.length > REGISTRY_SCAN_MAX) {
      dlog("main", "recents_store.scan_truncated", {
        file,
        entryCount: parsed.length,
        scanLimit: REGISTRY_SCAN_MAX,
      });
    }
    return valid;
  } catch (error) {
    dlog("main", "recents_store.read_failed", { file, error: errorMessage(error) });
    throw error;
  }
}

async function checkedWritableTarget(file: string): Promise<void> {
  try {
    const info = await fs.lstat(file);
    if (info.isSymbolicLink()) {
      throw registryError(file, "registry file must not be a symbolic link");
    }
    if (!info.isFile()) throw registryError(file, "registry path is not a regular file");
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw error;
  }
}

async function writeAll(file: string, list: RecentProject[]): Promise<void> {
  const normalized = boundRegistry(mergeCanonicalProjects(list));
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await checkedWritableTarget(file);
    await fs.writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(tmp, file);
  } catch (error) {
    dlog("main", "recents_store.write_failed", { file, error: errorMessage(error) });
    throw error;
  } finally {
    await fs.rm(tmp, { force: true }).catch((error) => {
      dlog("main", "recents_store.temp_cleanup_failed", {
        file,
        tmp,
        error: errorMessage(error),
      });
    });
  }
}

const canonicalPathCache = new Map<string, string>();

function canonicalPath(projectPath: string): string {
  const cached = canonicalPathCache.get(projectPath);
  if (cached) return cached;
  // resolveProjectRoot shells out to git. Missing historical/deleted paths
  // cannot resolve to a repository root, so retain them without spawning git.
  const root = fsSync.existsSync(projectPath) ? resolveProjectRoot(projectPath) : projectPath;
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

function boundRegistry(list: RecentProject[]): RecentProject[] {
  if (list.length <= REGISTRY_MAX) return list;
  const pinned = list.filter((project) => project.pinned);
  const rest = list.filter((project) => !project.pinned);
  const bounded = [...pinned, ...rest].slice(0, REGISTRY_MAX);
  dlog("main", "recents_store.registry_truncated", {
    entryCount: list.length,
    registryLimit: REGISTRY_MAX,
  });
  return bounded.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

async function readCanonicalAll(file: string): Promise<RecentProject[]> {
  return boundRegistry(mergeCanonicalProjects(boundRegistry(await readAll(file))));
}

async function loadCanonicalSafely(file: string): Promise<RecentProject[]> {
  try {
    return await readCanonicalAll(file);
  } catch {
    return [];
  }
}

function serializeMutation<T>(mutation: (file: string) => Promise<T>): Promise<T> {
  const file = FILE;
  const result = mutationQueue.then(() => mutation(file));
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Live = not soft-deleted and directory still exists on disk. */
function isLive(r: RecentProject): boolean {
  return Boolean(r.path) && !r.deletedAt && fsSync.existsSync(r.path);
}

/** Recent-projects menu list: live, capped at MAX, newest-first as stored. */
export async function loadRecents(): Promise<RecentProject[]> {
  const all = await loadCanonicalSafely(FILE);
  return all.filter(isLive).slice(0, RECENT_MENU_MAX);
}

/** Full project list for UI (source of truth for the sidebar / mobile): all live
 *  projects, pinned first. Unlike loadRecents, this is not subject to the
 *  ten-item menu cap; only the generous corruption-safety registry bound applies. */
export async function loadProjects(): Promise<RecentProject[]> {
  const all = await loadCanonicalSafely(FILE);
  const live = all.filter(isLive);
  const pinned = live.filter((r) => r.pinned);
  const rest = live.filter((r) => !r.pinned);
  return [...pinned, ...rest];
}

export async function setPinned(projectPath: string, pinned: boolean): Promise<void> {
  if (typeof pinned !== "boolean") throw new Error("Invalid pinned state");
  const target = checkedCanonicalPath(projectPath);
  return serializeMutation(async (file) => {
    const all = await readCanonicalAll(file);
    await writeAll(
      file,
      all.map((r) => (r.path === target ? { ...r, pinned } : r)),
    );
  });
}

export async function softDelete(projectPath: string): Promise<void> {
  const target = checkedCanonicalPath(projectPath);
  return serializeMutation(async (file) => {
    const all = await readCanonicalAll(file);
    const deletedAt = Date.now();
    await writeAll(
      file,
      all.map((r) => (r.path === target ? { ...r, deletedAt } : r)),
    );
  });
}

export async function pushRecent(p: RecentProject): Promise<RecentProject[]> {
  const inputPath =
    p && typeof (p as { path?: unknown }).path === "string" ? (p as { path: string }).path : "";
  const inputName =
    p && typeof (p as { name?: unknown }).name === "string"
      ? (p as { name: string }).name.trim()
      : "";
  const normalized = parseRecentProject({
    ...p,
    path: inputPath,
    name: inputName || path.basename(inputPath),
  });
  if (!normalized) throw new Error("Invalid recent project");
  const project = canonicalizeProject(normalized);
  return serializeMutation(async (file) => {
    const all = await readCanonicalAll(file);
    const prior = all.find((r) => r.path === project.path);
    // Re-opening a project un-deletes it and preserves its pin state.
    const merged: RecentProject = { ...prior, ...project, deletedAt: undefined };
    const next = boundRegistry(
      mergeCanonicalProjects([merged, ...all.filter((r) => r.path !== project.path)]),
    );
    await writeAll(file, next);
    return next.filter(isLive).slice(0, RECENT_MENU_MAX);
  });
}
