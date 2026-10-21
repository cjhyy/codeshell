/**
 * Where a project's persistent memory lives (OM5).
 *
 * Older versions stored it at `<base>/projects/<legacy key>/memory`, where the
 * legacy key replaced every path separator with "-". That is lossy:
 * `/w/team/api` and `/w/team-api` shared one store, so one project's facts were
 * injected as the other's. New roots are `<base>/project-memory/<slug>-<hash>`:
 * the hash covers the full resolved path, the slug only keeps it readable, and
 * the separate parent directory means a new root can never be a legacy one.
 *
 * A legacy store is copied (never moved) into the new root on first use, but
 * only when no other known project maps to the same legacy key. Otherwise its
 * owner cannot be proven, so it is left untouched and unread and the project
 * starts empty.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { logger } from "../logging/logger.js";

const PROJECT_MEMORY_DIR = "project-memory";
const SLUG_MAX_CHARS = 48;
const HASH_HEX_CHARS = 16;
/** Matches the session list's state.json cap; larger registries are skipped. */
const MAX_REGISTRY_BYTES = 1024 * 1024;

/** Collision-free directory name for a project: readable slug plus path hash. */
export function projectMemoryKey(projectDir: string): string {
  const normalized = resolve(projectDir);
  // Leading dots are dropped so a key is never hidden and never matches the
  // dot-prefixed staging directories used during migration.
  const slug = Array.from(
    basename(normalized)
      .replace(/[^\p{L}\p{N}._-]+/gu, "_")
      .replace(/^\.+/, ""),
  )
    .slice(0, SLUG_MAX_CHARS)
    .join("");
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, HASH_HEX_CHARS);
  return `${slug || "root"}-${hash}`;
}

export function projectMemoryRoot(baseDir: string, projectDir: string): string {
  return join(baseDir, PROJECT_MEMORY_DIR, projectMemoryKey(projectDir));
}

/** The pre-OM5 key, kept only to find stores written by older versions. */
function legacyProjectMemoryKey(projectDir: string): string {
  return projectDir.replace(/[/\\:]/g, "-").replace(/^-/, "");
}

function realDirectory(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function readBoundedJson(path: string): unknown {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > MAX_REGISTRY_BYTES) return undefined;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * Every project path the shared state root records: Desktop's project registry
 * and its legacy recents, plus the cwd/workspace root of every stored session
 * (CLI, TUI and Desktop sessions alike). Unreadable entries are skipped.
 */
function* knownProjectPaths(baseDir: string): Generator<unknown> {
  const registry = record(readBoundedJson(join(baseDir, "desktop", "projects.json")));
  for (const project of Array.isArray(registry?.projects) ? registry.projects : []) {
    const roots = record(project)?.roots;
    for (const root of Array.isArray(roots) ? roots : []) yield record(root)?.path;
  }
  const recents = readBoundedJson(join(baseDir, "desktop", "recents.json"));
  for (const recent of Array.isArray(recents) ? recents : []) yield record(recent)?.path;

  const sessions = join(baseDir, "sessions");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(sessions, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No session store yet.
  }
  for (const dir of dirs) {
    const state = record(readBoundedJson(join(sessions, dir, "state.json")));
    yield state?.cwd;
    yield record(state?.workspace)?.root;
  }
}

/** Another known project sharing `projectDir`'s legacy key, if any. */
function otherLegacyClaimant(baseDir: string, projectDir: string): string | undefined {
  const key = legacyProjectMemoryKey(projectDir);
  const self = resolve(projectDir);
  for (const path of knownProjectPaths(baseDir)) {
    if (typeof path !== "string" || path.length === 0) continue;
    if (legacyProjectMemoryKey(path) === key && resolve(path) !== self) return path;
  }
  return undefined;
}

/**
 * Copy a legacy store into `root` through a private staging directory and one
 * rename, so a concurrent process either sees no root or a complete one. When
 * two processes race, the first rename wins and the loser discards its copy.
 */
function copyIntoPlace(legacy: string, root: string): void {
  const parent = dirname(root);
  mkdirSync(parent, { recursive: true });
  const staging = join(parent, `.${basename(root)}.migrating-${randomUUID()}`);
  try {
    cpSync(legacy, staging, {
      recursive: true,
      errorOnExist: true,
      force: false,
      // Lock directories belong to the legacy writers; links could point the
      // new store back into a shared location.
      filter: (source) => {
        const info = lstatSync(source);
        return !info.isSymbolicLink() && !(info.isDirectory() && source.endsWith(".lock"));
      },
    });
    try {
      renameSync(staging, root);
    } catch (error) {
      if (!existsSync(root)) throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Resolve the memory root for `projectDir`, adopting an unambiguous legacy
 * store on first use. A failed copy throws without creating the root, so the
 * next open retries; the legacy store is never modified.
 */
export function prepareProjectMemoryRoot(baseDir: string, projectDir: string): string {
  const root = projectMemoryRoot(baseDir, projectDir);
  if (existsSync(root)) return root;
  const legacy = join(baseDir, "projects", legacyProjectMemoryKey(projectDir), "memory");
  if (!realDirectory(legacy)) return root;
  const claimant = otherLegacyClaimant(baseDir, projectDir);
  if (claimant !== undefined) {
    logger.warn("memory.legacy_project_root_ambiguous", { projectDir, legacy, claimant });
    return root;
  }
  copyIntoPlace(legacy, root);
  logger.info("memory.legacy_project_root_migrated", { projectDir, legacy, root });
  return root;
}
