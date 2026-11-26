import type { PluginApprovalSummary } from "@cjhyy/code-shell-core";
import type { NativePluginRuntimeAction, NativePluginRuntimeView } from "../shared/native-plugins";

export interface NativePluginsApi {
  /** Approve or revoke a whole plugin: its native entry, hooks and MCP servers at once. */
  approvePlugin(installKey: string): Promise<PluginApprovalSummary[]>;
  revokePlugin(installKey: string): Promise<PluginApprovalSummary[]>;
  /** Native plugins in the running agent worker; never starts a worker. */
  nativePluginRuntime(
    action: NativePluginRuntimeAction,
    installKey?: string,
  ): Promise<NativePluginRuntimeView>;
  /** The end of a plugin's log, or "" when there is none to show. */
  nativePluginLog(installKey: string): Promise<string>;
}

/** Two channels: the approval decision, and the runtime state Main reads from the worker. */
export function createNativePluginsApi(ipc: {
  invoke: (channel: string, ...args: unknown[]) => Promise<any>;
}): NativePluginsApi {
  const approval = (action: "approve" | "revoke", installKey: string) =>
    ipc.invoke("plugins:approval", action, installKey);
  const native = (action: NativePluginRuntimeAction | "log", installKey?: string) =>
    ipc.invoke("plugins:native", action, installKey);
  return {
    approvePlugin: (installKey) => approval("approve", installKey),
    revokePlugin: (installKey) => approval("revoke", installKey),
    nativePluginRuntime: (action, installKey) => native(action, installKey),
    nativePluginLog: (installKey) => native("log", installKey),
  };
}
