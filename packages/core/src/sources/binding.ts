/** WorkspaceSourceBinding 的项目 settings 读写（原子，经 SettingsManager）。 */
import type { SettingsManager } from "../settings/manager.js";
import { WorkspaceSourceBindingSchema, type WorkspaceSourceBinding } from "./types.js";

function parseBindings(raw: unknown): WorkspaceSourceBinding[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((binding) => WorkspaceSourceBindingSchema.safeParse(binding))
    .filter((result): result is { success: true; data: WorkspaceSourceBinding } => result.success)
    .map((result) => result.data);
}

export function listBindings(sm: SettingsManager, cwd: string): WorkspaceSourceBinding[] {
  try {
    return parseBindings(sm.getForScope("project", cwd).sources);
  } catch {
    return [];
  }
}

export function bindSource(
  sm: SettingsManager,
  cwd: string,
  binding: WorkspaceSourceBinding,
  beforeCommit?: () => void,
): void {
  const parsed = WorkspaceSourceBindingSchema.parse(binding);
  sm.updateProjectSettings(
    cwd,
    (current) => {
      current.sources = [
        ...parseBindings(current.sources).filter((b) => b.sourceId !== parsed.sourceId),
        parsed,
      ];
    },
    beforeCommit,
  );
}

export function unbindSource(
  sm: SettingsManager,
  cwd: string,
  sourceId: string,
  beforeCommit?: () => void,
): void {
  sm.updateProjectSettings(
    cwd,
    (current) => {
      current.sources = parseBindings(current.sources).filter((b) => b.sourceId !== sourceId);
    },
    beforeCommit,
  );
}
