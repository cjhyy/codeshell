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
import { PanelAppInstallError } from "./paths.js";
import { readInstalledPanelAppsRegistry } from "./registry.js";

/** Effective selection includes the first captured package of unversioned legacy bindings.
 * This synchronous read also keeps Skill scanning safe before async project migration.
 * Caller supplies its Host-verified binding project, not an arbitrary guest directory.
 */
export function projectPanelAppPackagePins(
  projectPath: string,
): Record<string, PanelAppPackagePin> {
  if (!projectPath) return {};
  const settings = new SettingsManager(projectPath, "full");
  const raw = settings.getRawForScope("project", projectPath, { strict: true });
  const pins = parsePanelAppPackagePins(raw);
  for (const id of legacyBoundApps(raw)) {
    if (pins[id]) continue;
    const baseline = legacyPanelAppPackageSelection(id);
    if (baseline === null)
      throw new PanelAppInstallError(
        `Panel App '${id}' legacy package is unavailable; explicitly review a project version`,
      );
    if (baseline) pins[id] = baseline;
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
export async function migrateProjectPanelAppPackagePins(projectPath: string): Promise<string[]> {
  if (!projectPath) return [];
  const manager = new SettingsManager(projectPath, "full");
  const raw = manager.getRawForScope("project", projectPath, { strict: true });
  const originalPins = parsePanelAppPackagePins(raw);
  const pending = legacyBoundApps(raw).filter((id) => !originalPins[id]);
  if (!pending.length) return [];
  const installed = new Map((await listInstalledPanelApps()).map((app) => [app.id, app]));
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

export async function listProjectPanelApps(projectPath: string): Promise<InstalledPanelApp[]> {
  await migrateProjectPanelAppPackagePins(projectPath);
  const pins = projectPanelAppPackagePins(projectPath);
  // A removed global catalog entry stays unavailable; a retained file is not a grant.
  const records = await readInstalledPanelAppsRegistry();
  const catalog = new Map((await listInstalledPanelApps()).map((app) => [app.id, app]));
  const selected: InstalledPanelApp[] = [];
  for (const record of records) {
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
