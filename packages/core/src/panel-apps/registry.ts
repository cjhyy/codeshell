import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { panelAppsRegistryPath } from "./paths.js";
import { lock } from "../utils/lockfile.js";

const GitSource = z
  .object({
    kind: z.literal("git"),
    url: z.string().url().max(4_096),
    ref: z.string().min(1).max(255).optional(),
    subdir: z.string().min(1).max(1_024).optional(),
  })
  .strict();

const RegistryEntry = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    version: z.string().min(1).max(80),
    source: z.union([z.string().min(1).max(4_096), GitSource]),
    installedAt: z.string().min(1).max(128),
    lastUpdated: z.string().min(1).max(128),
  })
  .strict();

const Registry = z
  .object({
    version: z.literal(1),
    apps: z.array(RegistryEntry).max(1_024),
  })
  .strict();

const MAX_PANEL_APP_REGISTRY_BYTES = 4 * 1024 * 1024;

export type InstalledPanelAppRecord = z.infer<typeof RegistryEntry>;

async function registryEntry(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function checkedRegistryDirectory(): Promise<string> {
  const directory = dirname(panelAppsRegistryPath());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Panel App registry directory must be a real directory");
  }
  return directory;
}

async function readRegistryUnlocked(strict = false): Promise<InstalledPanelAppRecord[]> {
  const path = panelAppsRegistryPath();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const metadata = await registryEntry(path);
    if (!metadata) return [];
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > MAX_PANEL_APP_REGISTRY_BYTES
    ) {
      throw new Error("Panel App registry must be a bounded regular file");
    }
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_PANEL_APP_REGISTRY_BYTES) {
      throw new Error("Panel App registry must be a bounded regular file");
    }
    return Registry.parse(JSON.parse(await handle.readFile("utf8"))).apps;
  } catch (error) {
    if (strict) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new Error(`Panel App registry is corrupt${detail}`, { cause: error });
    }
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeRegistryUnlocked(apps: InstalledPanelAppRecord[]): Promise<void> {
  const path = panelAppsRegistryPath();
  await checkedRegistryDirectory();
  const target = await registryEntry(path);
  if (target && (target.isSymbolicLink() || !target.isFile())) {
    throw new Error("Panel App registry target must be a regular file");
  }
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const registry = Registry.parse({
      version: 1,
      apps: [...apps].sort((left, right) => left.id.localeCompare(right.id)),
    });
    const serialized = `${JSON.stringify(registry, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_PANEL_APP_REGISTRY_BYTES) {
      throw new Error("Panel App registry is too large");
    }
    await writeFile(tmp, serialized, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(tmp, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function mutateRegistry<T>(
  mutation: (current: InstalledPanelAppRecord[]) => {
    apps: InstalledPanelAppRecord[];
    result: T;
  },
): Promise<T> {
  const directory = await checkedRegistryDirectory();
  const release = await lock(directory, {
    realpath: true,
    stale: 10_000,
    retries: { retries: 8, minTimeout: 10, maxTimeout: 120, factor: 1.5 },
  });
  try {
    const next = mutation(await readRegistryUnlocked(true));
    await writeRegistryUnlocked(next.apps);
    return next.result;
  } finally {
    await release();
  }
}

export async function readInstalledPanelAppsRegistry(): Promise<InstalledPanelAppRecord[]> {
  return readRegistryUnlocked();
}

export async function writeInstalledPanelAppsRegistry(
  apps: InstalledPanelAppRecord[],
): Promise<void> {
  await mutateRegistry(() => ({ apps, result: undefined }));
}

export async function upsertInstalledPanelAppRecord(
  record: InstalledPanelAppRecord,
): Promise<void> {
  await mutateRegistry((current) => ({
    apps: [
      ...current.filter((candidate) => candidate.id !== record.id),
      RegistryEntry.parse(record),
    ],
    result: undefined,
  }));
}

export async function removeInstalledPanelAppRecord(id: string): Promise<void> {
  await mutateRegistry((current) => ({
    apps: current.filter((candidate) => candidate.id !== id),
    result: undefined,
  }));
}
