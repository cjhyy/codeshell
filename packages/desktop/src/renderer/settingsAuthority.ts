import { requireProjectConfigurationTarget } from "./configurationTarget";

export function readScopedSettings(
  scope: "user" | "project",
  projectPath?: string,
): Promise<Record<string, unknown> | null> {
  return scope === "user"
    ? window.codeshell.getSettings("user")
    : window.codeshell.getConfigurationSettings(
        requireProjectConfigurationTarget(projectPath ?? ""),
      );
}

export function updateScopedSettings(
  scope: "user" | "project",
  patch: Record<string, unknown>,
  projectPath?: string,
): Promise<void> {
  return scope === "user"
    ? window.codeshell.updateSettings("user", patch)
    : window.codeshell.updateConfigurationSettings(
        requireProjectConfigurationTarget(projectPath ?? ""),
        patch,
      );
}
