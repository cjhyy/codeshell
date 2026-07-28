import type { PanelAppDescriptor, PanelAppExtensionSummary } from "../shared/panel-apps.js";

export interface PanelAppPolicy {
  disabledApps: ReadonlySet<string>;
  globalDisabledApps: ReadonlySet<string>;
  projectOverrides: Readonly<Record<string, "on" | "off">>;
}

export function isPanelAppAvailable(app: PanelAppDescriptor, policy: PanelAppPolicy): boolean {
  return !policy.disabledApps.has(app.appId);
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
  const disabledByPolicy = policy.disabledApps.has(app.appId);
  return {
    ...app,
    kind: "panel-app",
    enabled: !disabledByPolicy,
    globalEnabled: !policy.globalDisabledApps.has(app.appId),
    ...(policy.projectOverrides[app.appId]
      ? { projectOverride: policy.projectOverrides[app.appId] }
      : {}),
    disabledByPolicy,
    updateSource,
  };
}
