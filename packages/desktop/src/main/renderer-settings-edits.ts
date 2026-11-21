import { touchesExternalSessionVisibility } from "./pet/external-session-visibility.js";
import type { SettingsScope } from "./settings-service.js";
import type { SettingsChange } from "../shared/settings-change.js";

export function validateRendererSettingsPatch(
  patch: unknown,
): asserts patch is Record<string, unknown> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("patch must be object");
  if (["panelAppBindings", "panelAppPins", "panelAppOverrides"].some((key) => key in patch))
    throw new Error("Panel project bindings must use the reviewed project binding API");
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(patch));
  } catch (error) {
    throw new Error("settings patch must be JSON-serializable", { cause: error });
  }
  if (bytes > 2 * 1024 * 1024) throw new Error("settings patch is too large");
}

export function settingsChange(
  scope: SettingsScope,
  patch: Record<string, unknown>,
): SettingsChange {
  return {
    panelApps:
      "disabledPanelApps" in patch || "panelAppBindings" in patch || "panelAppOverrides" in patch,
    git: "git" in patch,
    pet: scope === "user" && "pet" in patch,
    externalVisibility: touchesExternalSessionVisibility(scope, patch),
    pluginCommands: "disabledPlugins" in patch || "capabilityOverrides" in patch,
  };
}
