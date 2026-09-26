import { createHash } from "node:crypto";
import { legacyPanelAppPackageSelection } from "./legacy-packages.js";
import { SettingsManager } from "../settings/manager.js";
import {
  parsePanelAppPackagePins,
  resolvePanelAppBindingPolicy,
  type PanelAppPackagePin,
} from "./bindings.js";
import {
  listInstalledPanelApps,
  retainInstalledPanelApp,
  resolvePanelAppPackage,
  type InstalledPanelApp,
} from "./installer.js";
import { PanelAppInstallError, assertSafePanelAppId } from "./paths.js";
import { readInstalledPanelAppsRegistry } from "./registry.js";

/** Effective selection includes the first captured package of unversioned legacy bindings.
 * This synchronous read also keeps Skill scanning safe before async project migration.
 * Caller supplies its Host-verified binding project, not an arbitrary guest directory.
 */
export function projectPanelAppPackagePins(
  projectPath: string,
  appId?: string,
): Record<string, PanelAppPackagePin> {
  if (!projectPath) return {};
  const settings = new SettingsManager(projectPath, "full");
  const raw = settings.getRawForScope("project", projectPath, { strict: true });
  const pins = parsePanelAppPackagePins(raw);
  for (const id of legacyBoundApps(raw).filter((id) => !appId || id === appId)) {
    if (pins[id]) continue;
    const baseline = legacyPanelAppPackageSelection(id);
    if (baseline === null)
      throw new PanelAppInstallError(
        `Panel App '${id}' legacy package is unavailable; explicitly review a project version`,
      );
    if (baseline) pins[id] = baseline;
  }
  return appId ? (pins[appId] ? { [appId]: pins[appId]! } : {}) : pins;
}

/** Synchronous diagnostic selection for Skill scanning. A null entry denies that app only. */
export function inspectProjectPanelAppPackagePins(
  projectPath: string,
): Record<string, PanelAppPackagePin | null> {
  const raw = new SettingsManager(projectPath, "full").getRawForScope("project", projectPath, {
    strict: true,
  });
  const pins: Record<string, PanelAppPackagePin | null> = parsePanelAppPackagePins(raw);
  for (const id of legacyBoundApps(raw)) {
    if (pins[id]) continue;
    try {
      const selected = legacyPanelAppPackageSelection(id);
      if (selected !== undefined) pins[id] = selected;
    } catch {
      pins[id] = null;
    }
  }
  return pins;
}

function legacyBoundApps(raw: Record<string, unknown>): string[] {
  const bound = resolvePanelAppBindingPolicy({}, raw, true).boundApps;
  if (bound.size > 1024) throw new PanelAppInstallError("Too many legacy Panel bindings");
  return [...bound].filter((id) => /^[a-z][a-z0-9-]{0,63}$/.test(id));
}

/** Materialize only existing explicit bindings, preserving concurrent pins and unbinds.
 * The caller authorizes the binding project. No new app or permission is enabled.
 */
export async function migrateProjectPanelAppPackagePins(
  projectPath: string,
  appId?: string,
): Promise<string[]> {
  if (!projectPath) return [];
  const manager = new SettingsManager(projectPath, "full");
  const raw = manager.getRawForScope("project", projectPath, { strict: true });
  const originalPins = parsePanelAppPackagePins(raw);
  const pending = legacyBoundApps(raw).filter(
    (id) => !originalPins[id] && (!appId || id === appId),
  );
  if (!pending.length) return [];
  const installed = new Map((await listInstalledPanelApps(appId)).map((app) => [app.id, app]));
  const registry = new Set((await readInstalledPanelAppsRegistry()).map((app) => app.id));
  const prepared = new Map<string, PanelAppPackagePin>();
  for (const id of pending) {
    if (!registry.has(id)) continue; // Retained bytes never grant installation authority.
    let baseline = legacyPanelAppPackageSelection(id);
    if (baseline === undefined) {
      const app = installed.get(id);
      if (!app?.packageDigest)
        throw new PanelAppInstallError(`Panel App '${id}' legacy installation is unavailable`);
      try {
        await retainInstalledPanelApp(id, app.packageDigest);
      } catch (error) {
        // An updater may have captured the old bytes while we waited for its lock.
        if (legacyPanelAppPackageSelection(id) === undefined) throw error;
      }
      baseline = legacyPanelAppPackageSelection(id);
    }
    if (!baseline)
      throw new PanelAppInstallError(
        `Panel App '${id}' legacy package is unavailable; explicitly review a project version`,
      );
    const selected = await resolvePanelAppPackage(id, baseline.packageDigest);
    if (selected.version !== baseline.version)
      throw new PanelAppInstallError("Legacy Panel package version does not match");
    prepared.set(id, baseline);
  }
  if (!prepared.size) return [];
  const migrated: string[] = [];
  manager.mutateSettingsForScope("project", projectPath, (current) => {
    const pins = parsePanelAppPackagePins(current);
    const bound = new Set(legacyBoundApps(current));
    for (const [id, pin] of prepared) {
      if (pins[id] || !bound.has(id)) continue;
      pins[id] = pin;
      migrated.push(id);
    }
    if (!migrated.length) return false;
    current.panelAppPins = pins;
  });
  return migrated;
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

/** Separate failed selections from runnable apps. Never substitute catalog bytes for a failed pin.
 * Invalid project configuration still rejects the whole read; individual package failures do not.
 */
export async function inspectProjectPanelApps(
  projectPath: string,
  appId?: string,
): Promise<{
  apps: InstalledPanelApp[];
  issues: ProjectPanelAppIssue[];
  pins: Record<string, PanelAppPackagePin>;
}> {
  if (appId !== undefined) assertSafePanelAppId(appId);
  const settings = new SettingsManager(projectPath, "full");
  parsePanelAppPackagePins(settings.getRawForScope("project", projectPath, { strict: true }));
  const records = await readInstalledPanelAppsRegistry();
  const catalog = new Map((await listInstalledPanelApps(appId)).map((app) => [app.id, app]));
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
      const app = pin
        ? await resolvePanelAppPackage(record.id, pin.packageDigest)
        : catalog.get(record.id);
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
