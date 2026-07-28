import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

export type InstalledPanelAppRecord = z.infer<typeof RegistryEntry>;

async function readRegistryUnlocked(): Promise<InstalledPanelAppRecord[]> {
  const path = panelAppsRegistryPath();
  if (!existsSync(path)) return [];
  try {
    return Registry.parse(JSON.parse(await readFile(path, "utf-8"))).apps;
  } catch {
    return [];
  }
}

async function writeRegistryUnlocked(apps: InstalledPanelAppRecord[]): Promise<void> {
  const path = panelAppsRegistryPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const registry = Registry.parse({
      version: 1,
      apps: [...apps].sort((left, right) => left.id.localeCompare(right.id)),
    });
    await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(tmp, path);
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
  const directory = dirname(panelAppsRegistryPath());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await lock(directory, {
    realpath: true,
    stale: 10_000,
    retries: { retries: 8, minTimeout: 10, maxTimeout: 120, factor: 1.5 },
  });
  try {
    const next = mutation(await readRegistryUnlocked());
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
