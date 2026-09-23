import {
  listProjectPanelApps,
  panelAppInstallDir,
  panelAppPackageDir,
  panelAppsRegistryPath,
  projectPanelAppPackagePins,
} from "@cjhyy/code-shell-core";
import type { PanelAppDescriptor } from "../shared/panel-apps.js";
import { PanelAppInspectionCache } from "./panel-app-inspection-cache.js";

/** The caller has already resolved and authorized the main binding project. */
export function projectPanelAppInspectionCache(projectPath: string): PanelAppInspectionCache {
  const pin = (id: string) => projectPanelAppPackagePins(projectPath)[id];
  return new PanelAppInspectionCache({
    installPath(id) {
      const selected = pin(id);
      return selected ? panelAppPackageDir(id, selected.packageDigest) : panelAppInstallDir(id);
    },
    selectionKey: (id) => JSON.stringify(pin(id) ?? null),
    registryPath: panelAppsRegistryPath,
    listInstalled: () => listProjectPanelApps(projectPath),
  });
}

/** Reject old guests immediately when the project changes its package selection. */
export function isPanelAppDescriptorSelected(
  descriptor: PanelAppDescriptor,
  projectPath: string,
): boolean {
  try {
    const pin = projectPanelAppPackagePins(projectPath)[descriptor.appId];
    return pin
      ? descriptor.packagePinned === true &&
          descriptor.packageDigest === pin.packageDigest &&
          descriptor.version === pin.version
      : descriptor.packagePinned !== true;
  } catch {
    return false;
  }
}
