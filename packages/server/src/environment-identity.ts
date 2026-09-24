import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EnvironmentDescriptor } from "@cjhyy/code-shell-web";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Publish once, atomically. Never silently replace a corrupt identity or adopt a symlink. */
export async function environmentIdentity(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "environment.json");
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temporary = join(dataDir, `.environment-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, id: randomUUID() }));
      await file.sync();
      await file.close();
      try {
        await link(temporary, path);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      }
    } finally {
      await file.close().catch(() => {});
      await rm(temporary, { force: true });
    }
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 256)
    throw new Error("Invalid environment identity file");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await file.stat();
    if (
      !actual.isFile() ||
      actual.size > 256 ||
      actual.ino !== metadata.ino ||
      actual.dev !== metadata.dev
    )
      throw new Error("Environment identity changed while opening");
    const bytes = Buffer.alloc(257);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 256) throw new Error("Environment identity exceeds size limit");
    const value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (value?.version !== 1 || typeof value.id !== "string" || !UUID.test(value.id))
      throw new Error("Invalid environment identity");
    return value.id;
  } finally {
    await file.close();
  }
}

export function describeEnvironment(
  id: string,
  kind: EnvironmentDescriptor["kind"],
): EnvironmentDescriptor {
  return {
    version: 1,
    id,
    name: kind === "desktop" ? "我的电脑" : kind === "project-host" ? "云端项目" : "Hub 工作台",
    kind,
    entryPath: kind === "desktop" ? "/mobile" : "/",
  };
}
