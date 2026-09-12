import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export function resourceRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    value.split("/").length > 16 ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.length > 240 ||
          /[\\\u0000-\u001f\u007f:]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error("Invalid relative resource path");
  return value;
}

export function sameResourceIdentity(
  a: Pick<Stats, "dev" | "ino">,
  b: Pick<Stats, "dev" | "ino">,
): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Hold every ancestor and verify its name still refers to that exact directory. */
export async function openResourceDirectory(
  root: string,
  path: string,
  create: boolean,
  authorize: () => Promise<void>,
) {
  if (!isAbsolute(root) || root.includes("\0")) throw new Error("Invalid resource directory grant");
  resourceRelativePath(path);
  const parts = path.split("/");
  const name = parts.pop()!;
  const held: { path: string; handle: FileHandle; identity: Stats }[] = [];
  const close = async () => {
    await Promise.all(held.map((entry) => entry.handle.close().catch(() => {})));
  };
  const verify = async () => {
    await authorize();
    for (const entry of held) {
      const current = await lstat(entry.path);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        !sameResourceIdentity(current, entry.identity)
      )
        throw new Error("Resource directory changed while it was in use");
    }
    await authorize();
  };
  try {
    await authorize();
    const original = await lstat(root);
    if (!original.isDirectory() || original.isSymbolicLink())
      throw new Error("Resource directory must not be a symlink");
    let current = await realpath(root);
    for (let i = -1; i < parts.length; i++) {
      if (i >= 0) {
        await verify();
        current = join(current, parts[i]!);
      }
      const parent = held.at(-1);
      const location =
        parent && process.platform === "linux"
          ? `/proc/self/fd/${parent.handle.fd}/${parts[i]}`
          : current;
      if (i >= 0 && create)
        await mkdir(location, { mode: 0o700 }).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
      const handle = await open(
        location,
        constants.O_RDONLY |
          (constants.O_DIRECTORY ?? 0) |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      const identity = await handle.stat().catch(async (error) => {
        await handle.close();
        throw error;
      });
      held.push({ path: current, handle, identity });
      if (!identity.isDirectory() || (i === -1 && !sameResourceIdentity(identity, original)))
        throw new Error("Resource directory changed while it was opened");
    }
    await verify();
    const parent = held.at(-1)!;
    const location = (file: string) =>
      process.platform === "linux"
        ? `/proc/self/fd/${parent.handle.fd}/${file}`
        : join(parent.path, file);
    return { name, path: location(name), location, rootIdentity: held[0]!.identity, verify, close };
  } catch (error) {
    await close();
    throw error;
  }
}
