import type { PanelAppDescriptor, PanelAppExtensionSummary } from "../shared/panel-apps.js";

export interface PanelAppPolicy {
  globalDisabledApps: ReadonlySet<string>;
  boundApps: ReadonlySet<string>;
  projectOverrides: Readonly<Record<string, "on" | "off">>;
}

export function isPanelAppAvailable(app: PanelAppDescriptor, policy: PanelAppPolicy): boolean {
  return policy.boundApps.has(app.appId) && !policy.globalDisabledApps.has(app.appId);
}

export function summarizePanelApp(
  app: PanelAppDescriptor,
  policy: PanelAppPolicy,
  updateSource: PanelAppExtensionSummary["updateSource"] = {
    kind: "dir",
    label: "",
    available: false,
  },
): PanelAppExtensionSummary {
  const projectBound = policy.boundApps.has(app.appId);
  return {
    ...app,
    kind: "panel-app",
    // The global denylist has no UI anymore, but it is still honored at
    // runtime (core `isPanelAppBound`) so pre-existing entries and manual
    // edits of ~/.code-shell/settings.json keep working.
    enabled: projectBound && !policy.globalDisabledApps.has(app.appId),
    projectBound,
    ...(policy.projectOverrides[app.appId]
      ? { projectOverride: policy.projectOverrides[app.appId] }
      : {}),
    updateSource,
  };
}
