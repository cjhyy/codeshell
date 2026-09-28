import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface ProjectSeccompProfile {
  readonly json: string;
  readonly sha256: string;
}

/** Administrator configuration only. Snapshot bytes once; never read project files or HTTP input. */
export function readProjectSeccompProfile(path: string): ProjectSeccompProfile {
  let fd: number | undefined;
  try {
    if (!path || /[\0\r\n]/.test(path)) throw new Error();
    if (!lstatSync(resolve(path)).isFile()) throw new Error();
    fd = openSync(resolve(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    const limit = 1024 * 1024;
    if (!stat.isFile() || stat.size < 2 || stat.size > limit) throw new Error();
    const buffer = Buffer.alloc(limit + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > limit) throw new Error();
    const value = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
    // Docker validates individual rules. Reject disabling the default filter here.
    if (
      !value ||
      Array.isArray(value) ||
      value.defaultAction !== "SCMP_ACT_ERRNO" ||
      !Array.isArray(value.syscalls)
    )
      throw new Error();
    const json = JSON.stringify(value);
    return Object.freeze({ json, sha256: createHash("sha256").update(json).digest("hex") });
  } catch {
    // A mistaken path may name a private configuration file: never echo its contents.
    throw new Error(
      "Project seccomp profile must be a regular JSON file (max 1 MiB) with a deny-by-default policy.",
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Docker CLI reads its own private copy; editing the source cannot race container creation. */
export async function materializeProjectSeccompProfile(
  dataDir: string,
  profile: ProjectSeccompProfile,
): Promise<string> {
  const directory = join(dataDir, "project-runtime-security");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Unsafe project runtime security directory.");
  await chmod(directory, 0o700);
  const destination = join(directory, `${profile.sha256}.json`);
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(profile.json, "utf8");
      await handle.chmod(0o400);
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    return destination;
  } finally {
    await rm(temporary, { force: true });
  }
}
