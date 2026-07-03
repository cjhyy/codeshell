import type { PermissionMode } from "@cjhyy/code-shell-core";

export type TuiPermissionMode = "plan" | "normal" | "bypass";

export function nextPermissionMode(current: TuiPermissionMode): TuiPermissionMode {
  const modes: TuiPermissionMode[] = ["plan", "normal", "bypass"];
  return modes[(modes.indexOf(current) + 1) % modes.length] ?? "normal";
}

export function permissionConfigurePayload(mode: TuiPermissionMode): {
  planMode: boolean;
  permissionMode: PermissionMode;
} {
  return {
    planMode: mode === "plan",
    permissionMode: mode === "bypass" ? "bypassPermissions" : mode === "normal" ? "acceptEdits" : "default",
  };
}
