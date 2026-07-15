/** WorkspaceSourceBinding 的项目 settings 读写（原子，经 SettingsManager）。 */
import type { SettingsManager } from "../settings/manager.js";
import { WorkspaceSourceBindingSchema, type WorkspaceSourceBinding } from "./types.js";

export function listBindings(sm: SettingsManager, cwd: string): WorkspaceSourceBinding[] {
  try {
    const raw = sm.getForScope("project", cwd).sources as unknown[] | undefined;
    if (!Array.isArray(raw)) return [];

    return raw
      .map((binding) => WorkspaceSourceBindingSchema.safeParse(binding))
      .filter((result): result is { success: true; data: WorkspaceSourceBinding } => result.success)
      .map((result) => result.data);
  } catch {
    return [];
  }
}

export function bindSource(
  sm: SettingsManager,
  cwd: string,
  binding: WorkspaceSourceBinding,
): void {
  const parsed = WorkspaceSourceBindingSchema.parse(binding);
  const rest = listBindings(sm, cwd).filter((item) => item.sourceId !== parsed.sourceId);
  sm.saveProjectSetting("sources", [...rest, parsed], cwd);
}

export function unbindSource(sm: SettingsManager, cwd: string, sourceId: string): void {
  const bindings = listBindings(sm, cwd).filter((binding) => binding.sourceId !== sourceId);
  sm.saveProjectSetting("sources", bindings, cwd);
}
