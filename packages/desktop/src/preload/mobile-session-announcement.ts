import type { MobilePermissionMode } from "../shared/mobile-remote.js";

export interface MobileSessionAnnouncement {
  sessionId: string;
  cwd: string;
  title: string;
  prompt: string;
  clientMessageId?: string;
  permissionMode?: MobilePermissionMode;
}

/** Forward only the announcement fields consumed by the native renderer. */
export function normalizeMobileSessionAnnouncement(
  value: unknown,
): MobileSessionAnnouncement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const params = value as Record<string, unknown>;
  if (typeof params.sessionId !== "string" || !params.sessionId) return null;
  const permissionMode =
    params.permissionMode === "default" ||
    params.permissionMode === "acceptEdits" ||
    params.permissionMode === "bypassPermissions"
      ? params.permissionMode
      : undefined;
  return {
    sessionId: params.sessionId,
    cwd: typeof params.cwd === "string" ? params.cwd : "",
    title: typeof params.title === "string" ? params.title : "",
    prompt: typeof params.prompt === "string" ? params.prompt : "",
    ...(typeof params.clientMessageId === "string"
      ? { clientMessageId: params.clientMessageId }
      : {}),
    ...(permissionMode ? { permissionMode } : {}),
  };
}
