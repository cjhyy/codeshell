import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readBoundedJson(
  path: string,
  maxBytes: number,
): Promise<unknown | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > maxBytes) {
      throw new Error(`state is not a bounded regular file: ${path}`);
    }
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) {
      throw new Error(`state is not a bounded regular file: ${path}`);
    }
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Move unreadable owner state aside before starting from a clean store.
 *
 * A corrupt receipt must not disable every future delivery, but silently
 * overwriting it would destroy the only forensic copy. Rename keeps the bad
 * bytes for diagnosis and makes the original path available for an atomic
 * replacement. A failed quarantine is deliberately surfaced so callers never
 * overwrite a target they could not isolate.
 */
export async function quarantineCorruptJson(path: string): Promise<string | undefined> {
  const quarantinePath = `${path}.${Date.now()}.${randomUUID()}.corrupt`;
  try {
    await rename(path, quarantinePath);
    return quarantinePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeOwnerJsonAtomic(
  path: string,
  value: unknown,
  maxBytes: number,
): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new Error("state is too large");
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error(`state parent must be a real directory: ${parent}`);
  }
  try {
    const targetInfo = await lstat(path);
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
      throw new Error(`state target must be a regular file: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
