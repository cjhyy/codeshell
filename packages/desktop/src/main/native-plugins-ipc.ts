/**
 * Native plugin runtime state for the plugin detail page. Plugins live in the
 * agent worker, so this asks the worker that is running; it never starts one
 * just to look.
 */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  NATIVE_PLUGINS_LOG_QUERY,
  NATIVE_PLUGINS_RESTART_QUERY,
  NATIVE_PLUGINS_STATUS_QUERY,
  type NativePluginsLogReply,
  type NativePluginsStatusReply,
} from "@cjhyy/code-shell-core";
import { isFeatureEnabled } from "@cjhyy/code-shell-core/extension";
import type {
  NativePluginRuntimeAction,
  NativePluginRuntimeView,
} from "../shared/native-plugins.js";
import type { AgentBridge } from "./agent-bridge.js";
import { readUserFeatureFlags } from "./capability-modules-env.js";

type WorkerReply = { ok: true; result: unknown } | { ok: false; message: string; code?: number };

export interface NativePluginRuntimeDeps {
  /** The user-level `native_plugins` flag. */
  enabled(): boolean;
  hasLiveWorker(): boolean;
  query(type: string, params: Record<string, unknown>): Promise<WorkerReply>;
}

/** JSON-RPC "invalid params": a worker without the native plugin module does not know the query. */
const UNKNOWN_QUERY = -32602;
const QUERY_TIMEOUT_MS = 10_000;
const MAX_INSTALL_KEY = 512;

function data<T>(reply: Extract<WorkerReply, { ok: true }>): T | undefined {
  return (reply.result as { data?: T } | null)?.data;
}

export async function nativePluginRuntime(
  deps: NativePluginRuntimeDeps,
  action: NativePluginRuntimeAction,
  installKey?: string,
): Promise<NativePluginRuntimeView> {
  if (!deps.enabled()) return { kind: "off" };
  if (!deps.hasLiveWorker()) return { kind: "no-worker" };
  const reply = await deps.query(
    action === "restart" ? NATIVE_PLUGINS_RESTART_QUERY : NATIVE_PLUGINS_STATUS_QUERY,
    action === "restart" ? { installKey } : {},
  );
  if (!reply.ok) {
    if (reply.code === UNKNOWN_QUERY) return { kind: "not-loaded" };
    throw new Error(reply.message);
  }
  return { kind: "loaded", plugins: data<NativePluginsStatusReply>(reply)?.plugins ?? [] };
}

/** The end of a plugin's log, or "" when there is nothing to show. */
export async function nativePluginLog(
  deps: NativePluginRuntimeDeps,
  installKey: string,
): Promise<string> {
  if (!deps.enabled() || !deps.hasLiveWorker()) return "";
  const reply = await deps.query(NATIVE_PLUGINS_LOG_QUERY, { installKey });
  return reply.ok ? (data<NativePluginsLogReply>(reply)?.text ?? "") : "";
}

export function registerNativePluginIpc(
  ipcMain: Pick<IpcMain, "handle">,
  windows: Iterable<BrowserWindow>,
  bridge: () => Pick<AgentBridge, "hasLiveWorker" | "requestWorker"> | null,
  settingsCwd: () => string,
): void {
  const deps: NativePluginRuntimeDeps = {
    enabled: () => isFeatureEnabled(readUserFeatureFlags(settingsCwd()), "native_plugins"),
    hasLiveWorker: () => bridge()?.hasLiveWorker() === true,
    query: async (type, params) => {
      const current = bridge();
      if (!current) return { ok: false, message: "The agent worker is not running" };
      return current.requestWorker("agent/query", { ...params, type }, QUERY_TIMEOUT_MS, {
        settleOnExit: true,
        failFast: true,
        meta: { origin: "host", producer: "native-plugins" },
      });
    },
  };
  const requireWindow = (event: IpcMainInvokeEvent) => {
    if (
      ![...windows].some(
        (window) => !window.isDestroyed() && window.webContents === event.sender,
      ) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error("Native plugin state requires an application window");
  };
  const requireKey = (value: unknown): string => {
    if (typeof value !== "string" || !value || value.length > MAX_INSTALL_KEY)
      throw new Error("A plugin install key is required");
    return value;
  };
  ipcMain.handle("plugins:native", (event, action: unknown, installKey?: unknown) => {
    requireWindow(event);
    if (action === "status") return nativePluginRuntime(deps, "status");
    if (action === "restart") return nativePluginRuntime(deps, "restart", requireKey(installKey));
    if (action === "log") return nativePluginLog(deps, requireKey(installKey));
    throw new Error("Unknown native plugin action");
  });
}
