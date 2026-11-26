/**
 * The worker queries a host uses to see and steer native plugins, and their
 * replies. Names only: a host that asks needs none of the runtime itself.
 */

import type { NativePluginStatus } from "./runtime.js";

export type { NativePluginRuntimeState, NativePluginStatus } from "./runtime.js";

export const NATIVE_PLUGINS_MODULE_ID = "native-plugins";
/** Every plugin this worker knows about and how it is doing. */
export const NATIVE_PLUGINS_STATUS_QUERY = "native_plugins_status";
/** `{ installKey }`: forget past failures and start the plugin's process afresh. */
export const NATIVE_PLUGINS_RESTART_QUERY = "native_plugins_restart";
/** `{ installKey }`: the end of the plugin's log. */
export const NATIVE_PLUGINS_LOG_QUERY = "native_plugins_log";

export interface NativePluginsStatusReply {
  plugins: NativePluginStatus[];
}

export interface NativePluginsRestartReply extends NativePluginsStatusReply {
  /** False when the plugin is not loaded in this worker. */
  restarted: boolean;
}

export interface NativePluginsLogReply {
  /** The end of the plugin's log; empty when it has not written one. */
  text: string;
}
