import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SettingsManager } from "../settings/manager.js";
import { parsePanelAppPackagePins, type PanelAppPackagePin } from "./bindings.js";
import {
  listInstalledPanelApps,
  resolvePanelAppPackage,
  type InstalledPanelApp,
} from "./installer.js";
import { PanelAppInstallError, assertSafePanelAppId, panelAppInstallDir } from "./paths.js";
import { PANEL_APP_META_FILE } from "./package-content.js";
import { readInstalledPanelAppsRegistry } from "./registry.js";

const MAX_META_BYTES = 64 * 1024;

/** When the installed catalog bytes were last replaced, from the metadata swapped with them. */
export function installedPanelAppUpdatedAt(id: string): number | undefined {
  let fd: number | undefined;
  try {
    const path = join(panelAppInstallDir(id), PANEL_APP_META_FILE);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_META_BYTES) return undefined;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isFile()) return undefined;
    const meta = z
      .object({ lastUpdated: z.string() })
      .passthrough()
      .parse(JSON.parse(readFileSync(fd, "utf8")));
    const time = Date.parse(meta.lastUpdated);
    return Number.isFinite(time) ? time : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A pin holds its project only if it was chosen after the app's latest global install or
 * update; every install or update therefore moves all projects to the installed version.
 * A tie goes to the install. Pins without a time predate this rule and are superseded.
 * While the catalog directory is mid-swap its time is unknown, and a timed pin keeps
 * selecting its immutable package.
 */
export function currentPanelAppPackagePins(
  raw: Record<string, unknown>,
): Record<string, PanelAppPackagePin> {
  const pins = parsePanelAppPackagePins(raw);
  for (const [id, pin] of Object.entries(pins)) {
    const pinnedAt = pin.pinnedAt === undefined ? NaN : Date.parse(pin.pinnedAt);
    const updatedAt = installedPanelAppUpdatedAt(id) ?? -Infinity;
    if (!(pinnedAt > updatedAt)) delete pins[id];
  }
  return pins;
}

/** Effective package selection for a project: only pins newer than the latest install.
 * This synchronous read also serves Skill scanning.
 * Caller supplies its Host-verified binding project, not an arbitrary guest directory.
 */
export function projectPanelAppPackagePins(
  projectPath: string,
  appId?: string,
): Record<string, PanelAppPackagePin> {
  if (!projectPath) return {};
  const settings = new SettingsManager(projectPath, "full");
  const pins = currentPanelAppPackagePins(
    settings.getRawForScope("project", projectPath, { strict: true }),
  );
  return appId ? (pins[appId] ? { [appId]: pins[appId]! } : {}) : pins;
}

/** Synchronous diagnostic selection for Skill scanning. */
export function inspectProjectPanelAppPackagePins(
  projectPath: string,
): Record<string, PanelAppPackagePin | null> {
  return currentPanelAppPackagePins(
    new SettingsManager(projectPath, "full").getRawForScope("project", projectPath, {
      strict: true,
    }),
  );
}

/** Bindings no longer capture a legacy baseline: an unpinned project uses the installed app. */
export async function migrateProjectPanelAppPackagePins(
  _projectPath: string,
  _appId?: string,
): Promise<string[]> {
  return [];
}

/** A pin selects package bytes; project binding and global disable remain separate authority. */
export async function selectProjectPanelAppPackage(
  app: InstalledPanelApp,
  pin: PanelAppPackagePin | undefined,
): Promise<InstalledPanelApp> {
  if (!pin) return app;
  const selected = await resolvePanelAppPackage(app.id, pin.packageDigest);
  if (selected.version !== pin.version)
    throw new PanelAppInstallError(
      `Panel App '${app.id}' pinned version does not match its package`,
    );
  return selected;
}

export async function listProjectPanelApps(
  projectPath: string,
  appId?: string,
): Promise<InstalledPanelApp[]> {
  if (appId !== undefined) assertSafePanelAppId(appId);
  await migrateProjectPanelAppPackagePins(projectPath, appId);
  const pins = projectPanelAppPackagePins(projectPath);
  // A removed global catalog entry stays unavailable; a retained file is not a grant.
  const records = await readInstalledPanelAppsRegistry();
  const catalog = new Map((await listInstalledPanelApps(appId)).map((app) => [app.id, app]));
  const selected: InstalledPanelApp[] = [];
  for (const record of records) {
    if (appId !== undefined && record.id !== appId) continue;
    const pin = pins[record.id];
    if (pin) {
      // The mutable catalog directory may be swapping during another project's
      // update. Registry membership authorizes discovery; pinned bytes are independent.
      const retained = await resolvePanelAppPackage(record.id, pin.packageDigest);
      if (retained.version !== pin.version)
        throw new PanelAppInstallError(
          `Panel App '${record.id}' pinned version does not match its package`,
        );
      selected.push(retained);
    } else if (catalog.has(record.id)) selected.push(catalog.get(record.id)!);
  }
  return selected.sort((a, b) => a.id.localeCompare(b.id));
}

export interface ProjectPanelAppIssue {
  id: string;
  pin?: PanelAppPackagePin;
  code: "package_unavailable";
  /** Opaque identity of the registered installation and failed selection. */
  selectionKey: string;
}

/**
 * Verified package reads shared by one multi-project pass. Each read hashes
 * every package byte, so N projects would otherwise re-hash the same catalog
 * N times. Create a fresh object per pass; never keep one across passes.
 */
export interface PanelAppInspectionReads {
  installed?: Promise<InstalledPanelApp[]>;
  packages: Map<string, Promise<InstalledPanelApp>>;
}

/** Separate failed selections from runnable apps. Never substitute catalog bytes for a failed pin.
 * Invalid project configuration still rejects the whole read; individual package failures do not.
 */
export async function inspectProjectPanelApps(
  projectPath: string,
  appId?: string,
  reads?: PanelAppInspectionReads,
): Promise<{
  apps: InstalledPanelApp[];
  issues: ProjectPanelAppIssue[];
  pins: Record<string, PanelAppPackagePin>;
}> {
  if (appId !== undefined) assertSafePanelAppId(appId);
  const settings = new SettingsManager(projectPath, "full");
  parsePanelAppPackagePins(settings.getRawForScope("project", projectPath, { strict: true }));
  const records = await readInstalledPanelAppsRegistry();
  const installed = reads
    ? (await (reads.installed ??= listInstalledPanelApps())).filter(
        (app) => appId === undefined || app.id === appId,
      )
    : await listInstalledPanelApps(appId);
  const catalog = new Map(installed.map((app) => [app.id, app]));
  const resolvePackage = (id: string, packageDigest: string) => {
    if (!reads) return resolvePanelAppPackage(id, packageDigest);
    const key = `${id}\0${packageDigest}`;
    let read = reads.packages.get(key);
    if (!read) reads.packages.set(key, (read = resolvePanelAppPackage(id, packageDigest)));
    return read;
  };
  const apps: InstalledPanelApp[] = [];
  const issues: ProjectPanelAppIssue[] = [];
  const pins: Record<string, PanelAppPackagePin> = {};
  for (const record of records) {
    if (appId !== undefined && record.id !== appId) continue;
    let pin: PanelAppPackagePin | undefined;
    try {
      pin = projectPanelAppPackagePins(projectPath, record.id)[record.id];
      await migrateProjectPanelAppPackagePins(projectPath, record.id);
      pin = projectPanelAppPackagePins(projectPath, record.id)[record.id];
      const app = pin ? await resolvePackage(record.id, pin.packageDigest) : catalog.get(record.id);
      if (!app || (pin && pin.version !== app.version))
        throw new PanelAppInstallError("Selected project package is unavailable");
      if (
        JSON.stringify(pin) !==
        JSON.stringify(projectPanelAppPackagePins(projectPath, record.id)[record.id])
      )
        throw new PanelAppInstallError("Project package changed during inspection");
      if (pin) pins[record.id] = pin;
      apps.push(app);
    } catch {
      issues.push({
        id: record.id,
        ...(pin ? { pin } : {}),
        code: "package_unavailable",
        selectionKey: createHash("sha256").update(JSON.stringify({ record, pin })).digest("hex"),
      });
    }
  }
  // Do not turn a concurrent configuration corruption into an apparently healthy catalog.
  parsePanelAppPackagePins(settings.getRawForScope("project", projectPath, { strict: true }));
  return { apps: apps.sort((a, b) => a.id.localeCompare(b.id)), issues, pins };
}
