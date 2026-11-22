import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";

import { MAX_LAB_JSON_BYTES } from "../../shared/optimization-lab.js";

/** Open the selected inode without following links and detect replacement or mutation. */
export async function readBoundedUtf8File(source: string): Promise<string> {
  if (!isAbsolute(source)) throw new Error("Lab JSON file path must be absolute");
  const prior = await fs.lstat(source, { bigint: true });
  if (!prior.isFile() || prior.isSymbolicLink() || prior.size > BigInt(MAX_LAB_JSON_BYTES))
    throw new Error("Lab JSON file must be a bounded regular file");
  const file = await fs.open(
    source,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await file.stat({ bigint: true });
    const same = (other: typeof info) =>
      other.isFile() &&
      !other.isSymbolicLink() &&
      other.dev === info.dev &&
      other.ino === info.ino &&
      other.size === info.size &&
      other.mtimeNs === info.mtimeNs &&
      other.ctimeNs === info.ctimeNs;
    if (!same(prior) || info.size > BigInt(MAX_LAB_JSON_BYTES))
      throw new Error("Lab JSON file changed or is too large");
    const buffer = Buffer.alloc(Number(info.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (
      BigInt(length) !== info.size ||
      !same(await file.stat({ bigint: true })) ||
      !same(await fs.lstat(source, { bigint: true }))
    )
      throw new Error("Lab JSON file changed or is too large");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, length),
    );
  } finally {
    await file.close();
  }
}

async function optionalEntry(
  path: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function containsPath(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === "" ||
    (!child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      child !== ".." &&
      !isAbsolute(child))
  );
}

/** Replace only the selected regular file, never a symlink target or the immutable Lab store. */
export async function writeDatasetFile(
  destination: string,
  text: string,
  artifactRoot: string,
  revalidate: () => Promise<void>,
  claim?: () => void,
): Promise<void> {
  if (!isAbsolute(destination)) throw new Error("Dataset export path must be absolute");
  const parent = await fs.realpath(dirname(destination));
  const directory = await fs.lstat(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("Dataset export parent must be a regular directory");
  const target = join(parent, basename(destination));
  const protectedRoot = await fs.realpath(artifactRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return resolvePath(artifactRoot);
    throw error;
  });
  if (containsPath(protectedRoot, target))
    throw new Error("Cannot export into frozen Lab artifacts");
  const existing = await optionalEntry(target);
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error("Dataset export destination must be a regular file");
  const verifyPaths = async () => {
    if ((await fs.realpath(dirname(destination))) !== parent)
      throw new Error("Dataset export parent changed");
    const currentDirectory = await fs.lstat(parent);
    if (
      !currentDirectory.isDirectory() ||
      currentDirectory.isSymbolicLink() ||
      currentDirectory.dev !== directory.dev ||
      currentDirectory.ino !== directory.ino
    )
      throw new Error("Dataset export parent changed");
    const current = await optionalEntry(target);
    if (
      existing
        ? !current ||
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.dev !== existing.dev ||
          current.ino !== existing.ino ||
          current.size !== existing.size ||
          current.mtimeMs !== existing.mtimeMs ||
          current.ctimeMs !== existing.ctimeMs
        : current !== undefined
    )
      throw new Error("Dataset export destination changed");
  };
  const temporary = join(parent, `.optimization-lab-${randomUUID()}.tmp`);
  try {
    await revalidate();
    await verifyPaths();
    await fs.writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await revalidate();
    await verifyPaths();
    // Rename replaces the directory entry itself; it never follows a destination symlink.
    claim?.();
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
