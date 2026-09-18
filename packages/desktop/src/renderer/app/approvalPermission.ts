import { fromSettingsPermissionMode, type PermissionMode } from "../chat/PermissionPill";

function configuredPermission(settings: Record<string, unknown> | null): unknown {
  const permissions = settings?.permissions;
  return (
    settings?.permissionMode ??
    (permissions && typeof permissions === "object"
      ? (permissions as Record<string, unknown>).defaultMode
      : undefined)
  );
}

/** Read the requesting Session's defaults, independently of the foreground page. */
export async function readApprovalPermission(sessionId: string): Promise<PermissionMode> {
  // Main resolves the persisted Session's configuration authority. A missing or
  // unusable Session must reject here rather than inherit global full access.
  const [project, user] = await Promise.all([
    window.codeshell.getConfigurationSettings({ sessionId }),
    window.codeshell.getSettings("user"),
  ]);
  // Resolve aliases within each scope before applying project-over-user
  // precedence, so a legacy user permissionMode cannot mask a project defaultMode.
  return fromSettingsPermissionMode(configuredPermission(project) ?? configuredPermission(user));
}
