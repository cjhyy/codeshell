import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { sameResourceIdentity } from "./directories.js";
import { mediaSourceIdentity } from "./library.js";

/** Host-only optimization. Both paths are managed storage, never guest paths. */
export async function stageResourceClone(options: {
  sourcePath: string;
  stagingDirectory: string;
  targetDevice: number;
  verify(): Promise<void>;
  signal?: AbortSignal;
}) {
  const { sourcePath, stagingDirectory, signal } = options;
  signal?.throwIfAborted();
  await options.verify();
  signal?.throwIfAborted();
  const source = await lstat(sourcePath);
  if (!source.isFile() || source.isSymbolicLink()) throw new Error("Invalid resource clone source");
  if (source.dev !== options.targetDevice || !["darwin", "linux"].includes(process.platform))
    return undefined;
  const staging = await lstat(stagingDirectory);
  if (!staging.isDirectory() || staging.isSymbolicLink())
    throw new Error("Invalid resource clone staging directory");
  if (staging.dev !== source.dev) return undefined;
  const directory = await mkdtemp(join(stagingDirectory, "clone-"));
  const identity = await lstat(directory);
  const path = join(directory, "content");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const verify = async () => {
    signal?.throwIfAborted();
    await options.verify();
    const currentStaging = await lstat(stagingDirectory);
    const currentDirectory = await lstat(directory);
    const currentSource = await lstat(sourcePath);
    if (
      !currentStaging.isDirectory() ||
      currentStaging.isSymbolicLink() ||
      !sameResourceIdentity(currentStaging, staging) ||
      !currentDirectory.isDirectory() ||
      currentDirectory.isSymbolicLink() ||
      !sameResourceIdentity(currentDirectory, identity) ||
      !currentSource.isFile() ||
      currentSource.isSymbolicLink() ||
      Object.entries(mediaSourceIdentity(source)).some(
        ([key, value]) => currentSource[key as keyof typeof source] !== value,
      )
    )
      throw new Error("Resource changed during clone");
    signal?.throwIfAborted();
  };
  const close = async () => {
    await handle?.close().catch(() => {});
    handle = undefined;
    const current = await lstat(directory).catch(() => undefined);
    if (current?.isDirectory() && sameResourceIdentity(current, identity))
      await rm(directory, { recursive: true, force: true }).catch(() => {});
  };
  try {
    await verify();
    try {
      if (process.platform === "darwin") {
        // Electron's Node/libuv does not implement FICLONE on macOS. The OS
        // utility uses clonefile, with ordinary copy fallback on other volumes.
        // Its target is fresh Host-private storage, outside the tool grant.
        await new Promise<void>((resolve, reject) => {
          const child = spawn("/bin/cp", ["-c", "-n", sourcePath, path], {
            stdio: "ignore",
            signal,
          });
          child.once("error", reject);
          child.once("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error("Native resource clone failed"));
          });
        });
      } else {
        // FORCE prevents a failed Linux reflink from silently doing another
        // full copy before the existing streaming fallback is used.
        await copyFile(
          sourcePath,
          path,
          constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE,
        );
      }
    } catch (error) {
      await verify();
      if (
        process.platform !== "darwin" &&
        !["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EINVAL"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
      await close();
      return undefined;
    }
    await verify();
    handle = await open(
      path,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const cloned = await handle.stat();
    if (!cloned.isFile() || cloned.size !== source.size || sameResourceIdentity(cloned, source))
      throw new Error("Invalid cloned resource");
    await handle.chmod(0o600);
    return { path, handle, verify, close };
  } catch (error) {
    await close();
    throw error;
  }
}
