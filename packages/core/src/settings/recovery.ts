/** Trusted local/admin recovery only. Never expose this through generic config RPC or a Panel. */
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { SettingsSchema } from "./schema.js";
import { acquireFileLock } from "../utils/file-mutex.js";

export type RecoveryScope = "project" | "local";
type Diagnosis = "missing" | "valid" | "invalid_syntax" | "invalid_settings";
type Entry = { name: string; bytes: Buffer | null };
type Snapshot = {
  root: string;
  directory: string;
  entries: Entry[];
  revision: string;
  directoryIdentity?: { dev: number; ino: number };
};
export interface SettingsRecoveryInspection {
  project: string;
  scope: RecoveryScope;
  revision: string;
  activeFile: string | null;
  status: Diagnosis;
  files: { name: string; size: number | null; sha256: string | null }[];
  candidate?: { sha256: string; size: number; status: Diagnosis };
}
export interface SettingsRecoveryResult extends SettingsRecoveryInspection {
  backupId: string;
}
const MAX_BYTES = 4 * 1024 * 1024;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const recoveryError = (message: string) => new Error(`Settings recovery: ${message}`);

function scopeNames(scope: RecoveryScope): string[] {
  if (scope !== "project" && scope !== "local") throw recoveryError("invalid scope");
  const stem = scope === "project" ? "settings" : "settings.local";
  return [`${stem}.json`, `${stem}.yaml`, `${stem}.yml`];
}
function realDirectory(path: string, missing = false): void {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw recoveryError("directory is unsafe");
  } catch (error) {
    if (!missing || !absent(error)) throw error;
  }
}
function readBytes(path: string, max = MAX_BYTES): Buffer | null {
  let fd: number | undefined;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > max)
      throw recoveryError("expected a bounded regular file");
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > max || info.ino !== entry.ino || info.dev !== entry.dev)
      throw recoveryError("file changed while opening");
    // Bound the read even if another writer grows the file after fstat.
    const bytes = Buffer.alloc(max + 1);
    let length = 0;
    // readFileSync(fd) is intentionally avoided: its allocation is not bounded.
    while (length <= max) {
      const count = readSync(fd, bytes, length, max + 1 - length, null);
      if (!count) break;
      length += count;
    }
    if (length > max) throw recoveryError("file exceeds recovery size limit");
    return bytes.subarray(0, length);
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function snapshot(cwd: string, scope: RecoveryScope): Snapshot {
  if (typeof cwd !== "string" || !cwd.trim())
    throw recoveryError("an explicit project directory is required");
  const root = realpathSync(resolve(cwd));
  realDirectory(root);
  const directory = join(root, ".code-shell");
  realDirectory(directory, true);
  const entries = scopeNames(scope).map((name) => ({
    name,
    bytes: readBytes(join(directory, name)),
  }));
  const revision = hash(
    JSON.stringify([
      root,
      scope,
      entries.map(({ name, bytes }) => [name, bytes === null ? null : hash(bytes)]),
    ]),
  );
  let directoryIdentity: { dev: number; ino: number } | undefined;
  try {
    const info = lstatSync(directory);
    directoryIdentity = { dev: info.dev, ino: info.ino };
  } catch (error) {
    if (!absent(error)) throw error;
  }
  return { root, directory, entries, revision, directoryIdentity };
}
function diagnose(bytes: Buffer | null, yaml = false): Diagnosis {
  if (bytes === null) return "missing";
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = yaml ? parseYaml(text, { maxAliasCount: 100 }) : JSON.parse(text);
  } catch {
    return "invalid_syntax";
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid_settings";
  // Preserve unknown extension fields, but reject prototype keys and unbounded nesting.
  const queue: { value: unknown; depth: number; exit?: boolean }[] = [{ value, depth: 0 }];
  const visiting = new WeakSet<object>();
  const visited = new WeakSet<object>();
  while (queue.length) {
    const next = queue.pop()!;
    if (!next.value || typeof next.value !== "object") continue;
    if (next.exit) {
      visiting.delete(next.value);
      visited.add(next.value);
      continue;
    }
    if (next.depth > 100 || visiting.has(next.value)) return "invalid_settings";
    if (visited.has(next.value)) continue;
    visiting.add(next.value);
    queue.push({ ...next, exit: true });
    for (const [key, child] of Object.entries(next.value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) return "invalid_settings";
      queue.push({ value: child, depth: next.depth + 1 });
    }
  }
  try {
    return SettingsSchema.safeParse(value).success ? "valid" : "invalid_settings";
  } catch {
    return "invalid_settings";
  }
}
function inspection(state: Snapshot, scope: RecoveryScope): SettingsRecoveryInspection {
  const active = state.entries.find((entry) => entry.bytes !== null);
  return {
    project: state.root,
    scope,
    revision: state.revision,
    activeFile: active?.name ?? null,
    status: diagnose(active?.bytes ?? null, Boolean(active && !active.name.endsWith(".json"))),
    files: state.entries.map(({ name, bytes }) => ({
      name,
      size: bytes?.length ?? null,
      sha256: bytes === null ? null : hash(bytes),
    })),
  };
}
export function inspectProjectSettingsRecovery(options: {
  cwd: string;
  scope?: RecoveryScope;
  candidatePath?: string;
}): SettingsRecoveryInspection {
  const scope = options.scope ?? "project";
  const result = inspection(snapshot(options.cwd, scope), scope);
  if (options.candidatePath !== undefined) {
    const bytes = readBytes(resolve(options.candidatePath));
    if (bytes === null) throw recoveryError("candidate does not exist");
    result.candidate = { sha256: hash(bytes), size: bytes.length, status: diagnose(bytes) };
  }
  return result;
}
function requireHash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw recoveryError("expected an exact SHA-256 revision");
}
function syncDirectory(path: string): void {
  // Windows does not support opening directories for fsync through Node.
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function writePrivate(path: string, bytes: Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let completed = false;
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    completed = true;
  } finally {
    closeSync(fd);
    if (!completed) rmSync(path, { force: true });
  }
}
function assertDirectoryIdentity(state: Snapshot): void {
  realDirectory(state.directory);
  const current = lstatSync(state.directory);
  if (
    !state.directoryIdentity ||
    current.dev !== state.directoryIdentity.dev ||
    current.ino !== state.directoryIdentity.ino
  )
    throw recoveryError("configuration directory changed; inspect again");
}
function backupDirectory(state: Snapshot): string {
  assertDirectoryIdentity(state);
  const directory = join(state.directory, "settings-recovery");
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  realDirectory(directory);
  if (process.platform !== "win32" && lstatSync(directory).mode & 0o077)
    throw recoveryError("backup directory must be private (mode 0700)");
  const ignore = join(directory, ".gitignore");
  const existing = readBytes(ignore);
  if (existing === null) writePrivate(ignore, Buffer.from("*\n"));
  else if (existing.toString("utf8") !== "*\n")
    throw recoveryError("backup directory ignore rule is not intact");
  return directory;
}
function backup(state: Snapshot, scope: RecoveryScope): string {
  const directory = backupDirectory(state);
  const id = randomUUID();
  const data = {
    version: 1,
    project: state.root,
    scope,
    createdAt: new Date().toISOString(),
    original: state.entries[0]!.bytes?.toString("base64") ?? null,
    originalSha256: state.entries[0]!.bytes === null ? null : hash(state.entries[0]!.bytes),
    siblings: state.entries
      .slice(1)
      .map(({ name, bytes }) => ({ name, sha256: bytes === null ? null : hash(bytes) })),
  };
  writePrivate(join(directory, `${id}.json`), Buffer.from(JSON.stringify(data)));
  syncDirectory(directory);
  syncDirectory(state.directory);
  return id;
}
function replace(state: Snapshot, bytes: Buffer | null, backupId: string): void {
  const target = join(state.directory, state.entries[0]!.name);
  const temporary = join(state.directory, `.settings-recovery-${randomUUID()}.tmp`);
  let committed = false;
  try {
    assertDirectoryIdentity(state);
    // Recheck every config input after creating the durable backup, before rename.
    const scope = state.entries[0]!.name === "settings.json" ? "project" : "local";
    if (snapshot(state.root, scope).revision !== state.revision)
      throw recoveryError("configuration changed; inspect again before retrying");
    if (bytes === null) rmSync(target, { force: true });
    else {
      writePrivate(temporary, bytes);
      renameSync(temporary, target);
    }
    committed = true;
    syncDirectory(state.directory);
  } catch {
    throw recoveryError(
      `${committed ? "replacement occurred but durability is uncertain" : "replacement failed"}; inspect before retrying; original backup ${backupId}`,
    );
  } finally {
    rmSync(temporary, { force: true });
  }
}
function mutation<T>(
  cwd: string,
  scope: RecoveryScope,
  expected: string,
  run: (state: Snapshot) => T,
): T {
  requireHash(expected);
  const initial = snapshot(cwd, scope);
  if (initial.revision !== expected) throw recoveryError("configuration changed; inspect again");
  try {
    mkdirSync(initial.directory, { mode: 0o700 });
    syncDirectory(initial.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  realDirectory(initial.directory);
  const identity = lstatSync(initial.directory);
  const release = acquireFileLock(join(initial.directory, initial.entries[0]!.name));
  try {
    const current = snapshot(initial.root, scope);
    const latest = lstatSync(current.directory);
    if (current.revision !== expected || latest.ino !== identity.ino || latest.dev !== identity.dev)
      throw recoveryError("configuration changed; inspect again");
    return run(current);
  } finally {
    release();
  }
}
export function repairProjectSettings(options: {
  cwd: string;
  scope?: RecoveryScope;
  candidatePath: string;
  expectedRevision: string;
  candidateSha256: string;
}): SettingsRecoveryResult {
  const scope = options.scope ?? "project";
  requireHash(options.candidateSha256);
  const bytes = readBytes(resolve(options.candidatePath));
  if (bytes === null || hash(bytes) !== options.candidateSha256)
    throw recoveryError("candidate changed or is missing; inspect again");
  if (diagnose(bytes) !== "valid") throw recoveryError("candidate is not valid settings JSON");
  return mutation(options.cwd, scope, options.expectedRevision, (state) => {
    const backupId = backup(state, scope);
    replace(state, bytes, backupId);
    return { ...inspection(snapshot(state.root, scope), scope), backupId };
  });
}
export function restoreProjectSettings(options: {
  cwd: string;
  scope?: RecoveryScope;
  backupId: string;
  expectedRevision: string;
}): SettingsRecoveryResult {
  const scope = options.scope ?? "project";
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(options.backupId))
    throw recoveryError("invalid backup id");
  return mutation(options.cwd, scope, options.expectedRevision, (state) => {
    const directory = join(state.directory, "settings-recovery");
    realDirectory(directory);
    const bytes = readBytes(join(directory, `${options.backupId}.json`), 6 * 1024 * 1024);
    let archive: any;
    try {
      archive = JSON.parse(bytes!.toString("utf8"));
    } catch {
      throw recoveryError("backup is missing or invalid");
    }
    if (
      archive?.version !== 1 ||
      archive.project !== state.root ||
      archive.scope !== scope ||
      (archive.original !== null && typeof archive.original !== "string")
    )
      throw recoveryError("backup does not belong to this project and scope");
    const original = archive.original === null ? null : Buffer.from(archive.original, "base64");
    if (
      (original &&
        (original.length > MAX_BYTES || original.toString("base64") !== archive.original)) ||
      (original === null ? null : hash(original)) !== archive.originalSha256
    )
      throw recoveryError("backup content is damaged");
    const siblings = state.entries
      .slice(1)
      .map(({ name, bytes }) => ({ name, sha256: bytes === null ? null : hash(bytes) }));
    if (JSON.stringify(archive.siblings) !== JSON.stringify(siblings))
      throw recoveryError(
        "YAML alternatives changed since backup; repair using reviewed JSON instead",
      );
    const backupId = backup(state, scope);
    replace(state, original, backupId);
    return { ...inspection(snapshot(state.root, scope), scope), backupId };
  });
}
