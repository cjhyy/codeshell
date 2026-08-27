import { projectIdForPath } from "./projects";

function requireProjectId(projectPath: string | undefined): string {
  const projectId = projectIdForPath(projectPath);
  if (!projectId) throw new Error("project settings require a live V2 project id");
  return projectId;
}

export function readScopedSettings(
  scope: "user" | "project",
  projectPath?: string,
): Promise<Record<string, unknown> | null> {
  return scope === "user"
    ? window.codeshell.getSettings("user")
    : window.codeshell.getProjectSettings(requireProjectId(projectPath));
}

export function updateScopedSettings(
  scope: "user" | "project",
  patch: Record<string, unknown>,
  projectPath?: string,
): Promise<void> {
  return scope === "user"
    ? window.codeshell.updateSettings("user", patch)
    : window.codeshell.updateProjectSettings(requireProjectId(projectPath), patch);
}
