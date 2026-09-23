import { SettingsManager } from "../settings/manager.js";
import { parsePanelAppPackagePins, type PanelAppPackagePin } from "./bindings.js";
import {
  listInstalledPanelApps,
  resolvePanelAppPackage,
  type InstalledPanelApp,
} from "./installer.js";
import { PanelAppInstallError } from "./paths.js";
import { readInstalledPanelAppsRegistry } from "./registry.js";

/** Caller supplies its Host-verified binding project, not an arbitrary guest directory. */
export function projectPanelAppPackagePins(
  projectPath: string,
): Record<string, PanelAppPackagePin> {
  if (!projectPath) return {};
  const settings = new SettingsManager(projectPath, "full");
  return parsePanelAppPackagePins(
    settings.getRawForScope("project", projectPath, { strict: true }),
  );
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
