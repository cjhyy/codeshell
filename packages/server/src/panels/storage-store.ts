import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Matches the existing Desktop namespace, so its remote Web shares saved panel state. */
export function panelAppStoragePath(dataDir: string, appId: string, projectPath: string): string {
  const namespace = createHash("sha256")
    .update("codeshell-panel-app-storage-v2")
    .update("\0")
    .update(appId)
    .update("\0")
    .update(projectPath)
    .digest("hex");
  return join(dataDir, "panel-app-storage", `${namespace}.json`);
}

export const DEFAULT_PANEL_APP_STORAGE_QUOTA_BYTES = 256 * 1024;
const MAX_PANEL_APP_STORAGE_QUOTA_BYTES = 16 * 1024 * 1024;
const MAX_PANEL_APP_STORAGE_KEYS = 10_000;
const STORAGE_KEY_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;

export type PanelAppStorage = Record<string, unknown>;

export function panelAppStorageQuotaBytes(requested?: number): number {
  if (requested === undefined) return DEFAULT_PANEL_APP_STORAGE_QUOTA_BYTES;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new Error("Panel App storage quota must be a positive safe integer");
  }
  return Math.min(requested, MAX_PANEL_APP_STORAGE_QUOTA_BYTES);
}

export function panelAppStorageKey(params: unknown): string {
  const key = (params as { key?: unknown } | null)?.key;
  if (typeof key !== "string" || !STORAGE_KEY_PATTERN.test(key)) {
    throw new Error("storage key must match [a-zA-Z0-9._-]{1,80}");
  }
  return key;
}

export interface PanelAppStorageSnapshot {
  exists: boolean;
  value: unknown;
  /** Content revision, not an edit counter. null means the key is absent. */
  revision: string | null;
}

export interface PanelAppStorageChange {
  key: string;
  expectedRevision: string | null;
  remove: boolean;
  value?: unknown;
}

/** Snapshot hashes include the key; legacy JSON files require no migration. */
export function panelAppStorageSnapshot(
  storage: PanelAppStorage,
  key: string,
): PanelAppStorageSnapshot {
  const exists = Object.hasOwn(storage, key);
  const value = exists ? storage[key] : null;
  return {
    exists,
    value,
    revision: exists
      ? `sha256:${createHash("sha256")
          .update(JSON.stringify([key, value]))
          .digest("hex")}`
      : null,
  };
}

/** Validate and copy before any async work, so a caller cannot change a pending write. */
export function panelAppStorageChange(params: unknown): PanelAppStorageChange {
  const key = panelAppStorageKey(params);
  const input = params as Record<string, unknown>;
  const expectedRevision = input.expectedRevision;
  if (
    expectedRevision !== null &&
    (typeof expectedRevision !== "string" || !/^sha256:[0-9a-f]{64}$/.test(expectedRevision))
  )
    throw new Error("storage.compareAndSet requires expectedRevision (sha256 or null)");
  if (input.remove !== undefined && typeof input.remove !== "boolean")
    throw new Error("storage remove must be a boolean");
  const remove = input.remove === true;
  if (remove && Object.hasOwn(input, "value"))
    throw new Error("storage removal cannot also include a value");
  const encoded = remove ? undefined : JSON.stringify(input.value);
  if (!remove && encoded === undefined)
    throw new Error("Panel App storage only accepts JSON values");
  return { key, expectedRevision, remove, ...(remove ? {} : { value: JSON.parse(encoded!) }) };
}

/** Call only under the shared per-file lock; conflict never changes the store. */
export function applyPanelAppStorageChange(
  storage: PanelAppStorage,
  change: PanelAppStorageChange,
) {
  const current = panelAppStorageSnapshot(storage, change.key);
  if (current.revision !== change.expectedRevision) return { updated: false, snapshot: current };
  if (change.remove) delete storage[change.key];
  else storage[change.key] = change.value;
  return { updated: true, snapshot: panelAppStorageSnapshot(storage, change.key) };
}

function emptyStorage(): PanelAppStorage {
  // A null prototype is important here: valid app keys include names such as
  // `__proto__`, `constructor`, and `toString`. They must remain data keys and
  // never read or mutate JavaScript's object prototype.
  return Object.create(null) as PanelAppStorage;
}

async function assertRealStorageParent(file: string, create: boolean): Promise<void> {
  const parent = dirname(file);
  if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
  const metadata = await lstat(parent);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Panel App storage parent must be a real directory");
  }
}

async function storageFileMetadata(
  file: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function preparePanelAppStorage(file: string): Promise<void> {
  await assertRealStorageParent(file, true);
  const metadata = await storageFileMetadata(file);
  if (metadata && (metadata.isSymbolicLink() || !metadata.isFile())) {
    throw new Error("Panel App storage target must be a regular file");
  }
  if (!metadata) {
    // Materialize an empty store so the caller can take a PER-FILE lock on it.
    // Locking this path (rather than the shared parent directory) is what keeps
    // one panel app's storage write from stalling every other app; the lock
    // library needs the target to exist. `wx` keeps this a no-op under a race.
    try {
      await writeFile(file, "{}\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export async function readPanelAppStorage(
  file: string,
  quotaBytes: number,
): Promise<PanelAppStorage> {
  const quota = panelAppStorageQuotaBytes(quotaBytes);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertRealStorageParent(file, false);
    const metadata = await storageFileMetadata(file);
    if (!metadata) return emptyStorage();
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > quota) {
      throw new Error("Panel App storage must be a bounded regular file");
    }
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > quota) {
      throw new Error("Panel App storage must be a bounded regular file");
    }
    const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Panel App storage root must be an object");
    }
    const entries = Object.entries(parsed);
    if (entries.length > MAX_PANEL_APP_STORAGE_KEYS) {
      throw new Error("Panel App storage contains too many keys");
    }
    const storage = emptyStorage();
    for (const [key, value] of entries) {
      if (!STORAGE_KEY_PATTERN.test(key))
        throw new Error("Panel App storage contains an invalid key");
      storage[key] = value;
    }
    return storage;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStorage();
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writePanelAppStorage(
  file: string,
  storage: PanelAppStorage,
  quotaBytes: number,
  beforeCommit?: () => Promise<void>,
): Promise<void> {
  const quota = panelAppStorageQuotaBytes(quotaBytes);
  const entries = Object.entries(storage);
  if (entries.length > MAX_PANEL_APP_STORAGE_KEYS) {
    throw new Error("Panel App storage contains too many keys");
  }
  for (const [key] of entries) {
    if (!STORAGE_KEY_PATTERN.test(key))
      throw new Error("Panel App storage contains an invalid key");
  }
  const serialized = `${JSON.stringify(storage)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > quota) {
    throw new Error("Panel App storage quota exceeded");
  }
  await preparePanelAppStorage(file);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    // A remote owner can disconnect or lose its binding while staging bytes.
    // Recheck both authorization and the target after staging, before publishing.
    await beforeCommit?.();
    await preparePanelAppStorage(file);
    await rename(temporary, file);
    if (process.platform !== "win32") await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
