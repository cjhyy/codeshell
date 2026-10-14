/**
 * Remove only persisted kind="mock" data sources and their exact-ID references.
 * Usage: bun scripts/cleanup-legacy-source-mocks.ts [--home <CodeShell home>]
 *        [--project <root> ...] [--registered-projects] [--apply]
 * Defaults to a read-only plan. Close CodeShell before applying a nonempty plan.
 * Exact original bytes are backed up beside every changed file; references are written before
 * the catalog, so interrupted cleanup can be retried using the retained IDs.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { acquireLockOnPath, writeFileAtomic } from "../packages/core/src/utils/file-mutex.js";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 5_000;
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
type JsonObject = Record<string, unknown>;
type Target = { path: string; field: "sources" | "sourceAccess"; catalog?: true };
type Change = Target & { original: Buffer; next: string; records: number; references: number };
export interface CleanupOptions {
  home?: string;
  projects?: string[];
  registeredProjects?: boolean;
  apply?: boolean;
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Check every existing path component; a symlinked ancestor is unsafe too. */
function checkedPath(path: string): ReturnType<typeof lstatSync> | undefined {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Cannot inspect path: ${current}`);
    }
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${current}`);
    if (current === absolute) return info;
    if (!info.isDirectory()) throw new Error(`Not a directory: ${current}`);
  }
  return lstatSync(current);
}

function readJson(
  path: string,
  maxBytes = MAX_BYTES,
): { original: Buffer; value: unknown } | undefined {
  const info = checkedPath(path);
  if (!info) return undefined;
  if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes)
    throw new Error(`Not a bounded regular file: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let original: Buffer;
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > maxBytes ||
      opened.ino !== info.ino ||
      opened.dev !== info.dev
    )
      throw new Error(`File changed while opening: ${path}`);
    const buffer = Buffer.alloc(opened.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (!count) break;
      size += count;
    }
    if (size > opened.size) throw new Error(`File grew while reading: ${path}`);
    original = Buffer.from(buffer.subarray(0, size));
  } finally {
    closeSync(fd);
  }
  try {
    return {
      original,
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(original)),
    };
  } catch {
    // JSON parser messages can include secret-bearing input excerpts.
    throw new Error(`Invalid JSON; left unchanged: ${path}`);
  }
}

function boundedArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES)
    throw new Error(`Invalid or oversized metadata array: ${path}`);
  return value;
}

function registeredRoots(home: string): string[] {
  const registryPath = join(home, "desktop", "projects.json");
  const registry = readJson(registryPath);
  let paths: unknown[];
  if (registry) {
    if (!object(registry.value) || registry.value.version !== 2)
      throw new Error(`Invalid project registry: ${registryPath}`);
    paths = boundedArray(registry.value.projects, registryPath).flatMap((project) => {
      if (!object(project)) throw new Error(`Invalid project registry: ${registryPath}`);
      const roots = boundedArray(project.roots, registryPath);
      if (roots.length > 256) throw new Error(`Too many project roots: ${registryPath}`);
      return roots.map((root) => (object(root) ? root.path : undefined));
    });
  } else {
    const recentsPath = join(home, "desktop", "recents.json");
    const recents = readJson(recentsPath);
    paths = recents
      ? boundedArray(recents.value, recentsPath).map((entry) =>
          object(entry) ? entry.path : undefined,
        )
      : [];
  }
  if (paths.length > MAX_ENTRIES) throw new Error(`Too many registered project roots: ${home}`);
  if (
    paths.some(
      (path) =>
        typeof path !== "string" ||
        !isAbsolute(path) ||
        !path ||
        path.length > 32_768 ||
        path.includes("\0"),
    )
  )
    throw new Error(`Invalid registered project path: ${home}`);
  return paths as string[];
}

function targets(
  home: string,
  options: CleanupOptions,
): { candidates: Target[]; projectRoots: number } {
  const out: Target[] = [{ path: join(home, "sources.json"), field: "sources", catalog: true }];
  const roots = new Set((options.projects ?? []).map((path) => resolve(path)));
  if (options.registeredProjects)
    for (const path of registeredRoots(home)) roots.add(resolve(path));
  if (roots.size > MAX_ENTRIES) throw new Error("Too many project roots");
  for (const root of roots) {
    for (const name of ["settings.json", "settings.local.json"])
      out.push({ path: join(root, ".code-shell", name), field: "sources" });
  }
  const profiles = join(home, "profiles");
  const info = checkedPath(profiles);
  if (info) {
    if (!info.isDirectory()) throw new Error(`Invalid profiles directory: ${profiles}`);
    const dir = opendirSync(profiles);
    let seen = 0;
    try {
      for (;;) {
        const entry = dir.readSync();
        if (!entry) break;
        if (++seen > MAX_ENTRIES) throw new Error(`Too many profile entries: ${profiles}`);
        if (!PROFILE_NAME.test(entry.name)) continue;
        if (entry.isSymbolicLink())
          throw new Error(`Symbolic profile directory: ${join(profiles, entry.name)}`);
        if (entry.isDirectory())
          out.push({ path: join(profiles, entry.name, "profile.json"), field: "sourceAccess" });
      }
    } finally {
      dir.closeSync();
    }
  }
  return { candidates: out, projectRoots: roots.size };
}

function plan(home: string, options: CleanupOptions) {
  const { candidates, projectRoots } = targets(home, options);
  const catalog = readJson(candidates[0]!.path);
  if (
    catalog &&
    (!object(catalog.value) || catalog.value.version !== 1 || !Array.isArray(catalog.value.sources))
  )
    throw new Error(`Invalid source catalog: ${candidates[0]!.path}`);
  const entries = catalog
    ? boundedArray((catalog.value as JsonObject).sources, candidates[0]!.path)
    : [];
  const mocks = entries.filter((entry) => object(entry) && entry.kind === "mock");
  const ids = new Set(
    mocks.flatMap((entry) =>
      typeof (entry as JsonObject).id === "string" ? [(entry as JsonObject).id as string] : [],
    ),
  );
  // A real record sharing an ID still owns its bindings, regardless of order.
  for (const entry of entries)
    if (object(entry) && entry.kind !== "mock" && typeof entry.id === "string")
      ids.delete(entry.id);
  const changes: Change[] = [];
  const inspected = { projectRoots, catalogFiles: 0, projectSettingsFiles: 0, profileFiles: 0 };
  for (const target of candidates) {
    const current = target.catalog
      ? catalog
      : readJson(target.path, target.field === "sourceAccess" ? 256 * 1024 : MAX_BYTES);
    if (!current) continue;
    if (target.catalog) inspected.catalogFiles++;
    else if (target.field === "sourceAccess") inspected.profileFiles++;
    else inspected.projectSettingsFiles++;
    if (!object(current.value)) throw new Error(`Invalid JSON object: ${target.path}`);
    const before = current.value[target.field];
    if (before === undefined) continue;
    const items = boundedArray(before, target.path);
    const after = items.filter((item) =>
      target.catalog
        ? !(object(item) && item.kind === "mock")
        : !(object(item) && typeof item.sourceId === "string" && ids.has(item.sourceId)),
    );
    if (after.length === items.length) continue;
    // Keep [] explicitly: sourceAccess omission would broaden profile access.
    const next = `${JSON.stringify({ ...current.value, [target.field]: after }, null, 2)}\n`;
    if (Buffer.byteLength(next) > MAX_BYTES)
      throw new Error(`Result exceeds size limit: ${target.path}`);
    changes.push({
      ...target,
      original: current.original,
      next,
      records: target.catalog ? items.length - after.length : 0,
      references: target.catalog ? 0 : items.length - after.length,
    });
  }
  const directories = [...new Set(candidates.map((target) => dirname(target.path)))]
    .filter((dir) => {
      const info = checkedPath(dir);
      if (info && !info.isDirectory()) throw new Error(`Invalid state directory: ${dir}`);
      return Boolean(info);
    })
    .sort();
  return { changes, directories, inspected };
}

export function cleanupLegacySourceMocks(options: CleanupOptions = {}) {
  // Same default and override as core's codeShellHome(), without loading runtime services.
  const home = resolve(
    options.home ?? process.env.CODE_SHELL_HOME ?? join(homedir(), ".code-shell"),
  );
  let pending = plan(home, options);
  const backups = new Map<string, string>();
  if (options.apply && pending.changes.length) {
    const releases: Array<() => void> = [];
    try {
      // Unique existing directories, one lock per directory, fixed order. No awaits.
      for (const directory of pending.directories) releases.push(acquireLockOnPath(directory));
      const current = plan(home, options);
      if (JSON.stringify(current.directories) !== JSON.stringify(pending.directories))
        throw new Error("Cleanup targets changed; rerun the command");
      pending = current;
      // Back up every exact original before making the first replacement.
      for (const change of pending.changes) {
        const backup = `${change.path}.legacy-mocks.${randomUUID()}.bak`;
        writeFileSync(backup, change.original, { flag: "wx", mode: 0o600 });
        backups.set(change.path, backup);
      }
      // On a reference write failure the global mock records remain available
      // for recovery/retry. Never nest mutateJsonFile under these same locks.
      for (const change of [...pending.changes].sort(
        (a, b) => Number(Boolean(a.catalog)) - Number(Boolean(b.catalog)),
      )) {
        const latest = readJson(change.path);
        if (!latest || !latest.original.equals(change.original))
          throw new Error(
            `File changed during cleanup; recover from backup or rerun: ${change.path}`,
          );
        writeFileAtomic(change.path, change.next, 0o600);
      }
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
  return {
    mode: options.apply ? "apply" : "dry-run",
    inspected: pending.inspected,
    sourceRecords: pending.changes.reduce((sum, change) => sum + change.records, 0),
    sourceReferences: pending.changes.reduce((sum, change) => sum + change.references, 0),
    files: pending.changes.map((change) => ({
      path: change.path,
      sourceRecords: change.records,
      sourceReferences: change.references,
      ...(backups.has(change.path) ? { backup: backups.get(change.path) } : {}),
    })),
  };
}

if (import.meta.main) {
  try {
    const options: CleanupOptions = { projects: [] };
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--apply") options.apply = true;
      else if (arg === "--registered-projects") options.registeredProjects = true;
      else if (arg === "--home" || arg === "--project") {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error(`Missing path for ${arg}`);
        if (arg === "--home") options.home = value;
        else options.projects!.push(value);
      } else throw new Error(`Unknown argument at position ${index + 1}`);
    }
    console.log(JSON.stringify(cleanupLegacySourceMocks(options), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Cleanup failed");
    process.exitCode = 1;
  }
}
