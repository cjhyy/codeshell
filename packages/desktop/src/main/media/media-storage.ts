import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { MediaScope } from "./media-types.js";

export const MAX_MEDIA_JSON_BYTES = 4 * 1024 * 1024;

export function normalizeMediaScope(scope: MediaScope): MediaScope {
  if (!scope || !/^[a-z][a-z0-9-]{0,63}$/.test(scope.appId)) {
    throw new Error("Media operations require a valid Host-bound app ID");
  }
  if (
    typeof scope.projectPath !== "string" ||
    !isAbsolute(scope.projectPath) ||
    scope.projectPath.length > 4096 ||
    scope.projectPath.includes("\0")
  ) {
    throw new Error("Media operations require an absolute Host-bound project path");
  }
  return { appId: scope.appId, projectPath: resolve(scope.projectPath) };
}

export function mediaScopeKey(scope: MediaScope): string {
  const normalized = normalizeMediaScope(scope);
  return createHash("sha256")
    .update("codeshell-media-v1\0")
    .update(normalized.appId)
    .update("\0")
    .update(normalized.projectPath)
    .digest("hex");
}

export async function prepareMediaRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new Error("Media storage root must be absolute");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Media root must be a real directory");
  return realpath(root);
}

/** Validate each managed descendant instead of following a replaced symlink. */
export async function mediaDirectory(
  root: string,
  segments: string[],
  create = true,
): Promise<string> {
  let directory = await prepareMediaRoot(root);
  for (const segment of segments) {
    if (!/^[a-zA-Z0-9._-]+$/.test(segment) || segment === "." || segment === "..") {
      throw new Error("Invalid managed media directory");
    }
    directory = join(directory, segment);
    if (create)
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Media directory must not be a symlink");
  }
  return directory;
}

export function cloneMediaJson<T>(value: T, maxBytes = MAX_MEDIA_JSON_BYTES): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Media data must be serializable JSON");
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > maxBytes) {
    throw new Error("Media JSON exceeds its storage budget");
  }
  return JSON.parse(serialized) as T;
}

export async function readMediaJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_MEDIA_JSON_BYTES)
      throw new Error("Invalid media metadata file");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

export async function writeMediaJson(file: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(cloneMediaJson(value))}\n`;
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    // Sync the rename on platforms that permit directory file descriptors.
    const directory = await open(dirname(file), "r").catch(() => null);
    if (directory) {
      await directory.sync().catch(() => {});
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}
