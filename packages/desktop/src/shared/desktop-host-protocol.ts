import { isDesktopSessionId } from "./disk-session-query.js";
import type { RpcMessage } from "@cjhyy/code-shell-core";

export const runtimePathFlag = "--codeshell-wait-for-runtime-path";

// The dedicated desktop port uses Core's JSON-RPC envelopes. The parent pipe
// also carries lifecycle messages which the renderer port must never accept.
export type { RpcMessage };
export type RpcRequest = Extract<RpcMessage, { method: string; id: string | number }>;
export type RpcResponse = Exclude<RpcMessage, { method: string }>;
export type RpcNotification = Exclude<Extract<RpcMessage, { method: string }>, RpcRequest>;

export const DesktopHostIpc = {
  connect: "desktop-host:connect",
  port: "desktop-host:port",
  status: "desktop-host:status",
} as const;

export const DesktopHostErrors = {
  requestLimit: -32001,
  revoked: -32010,
  reconnecting: -32011,
} as const;
export const DESKTOP_HOST_REQUEST_LIMIT_MESSAGE = "Too many pending Desktop Host requests";

export interface DesktopHostIdentity {
  webContentsId: number;
  frameToken: string;
  frameGeneration: number;
  windowKind: "workbench";
}

export type DesktopHostControl =
  | { type: "runtime-path"; path: string }
  | {type:"mimi-dispatch-port"}
  | {type:"mimi-tasks-port"}
  | { type: "external-provider-port" }
  | { type: "remote-services-port" }
  | { type: "im-gateway-port" }
  | { type: "shutdown" }
  | { type: "remote-terminal-port" }
  | { type: "window-closed"; webContentsId: number }
  | { type: "automation-port"; searchPath: string }
  | { type: "worker-port"; execPath: string; entryPath: string }
  | { type: "session-index-changed"; ids: string[] }
  | { type: "bind" | "revoke"; identity: DesktopHostIdentity }
  | { type: "stream-view"; sessionId: string; enabled: boolean }
  | { type: "owner"; sessionId: string; webContentsId: number | null }
  | { type: "deleting"; sessionId: string; deleting: boolean };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function rpcId(value: unknown): value is number | string {
  return Number.isSafeInteger(value) || (typeof value === "string" && value.length > 0);
}

export function isRpcRequest(value: unknown): value is RpcRequest {
  return (
    record(value) &&
    value.jsonrpc === "2.0" &&
    rpcId(value.id) &&
    typeof value.method === "string" &&
    value.method.length > 0 &&
    (!Object.hasOwn(value, "params") || record(value.params)) &&
    hasOnly(value, ["jsonrpc", "id", "method", "params"])
  );
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (!record(value) || value.jsonrpc !== "2.0" || !rpcId(value.id)) return false;
  if (Object.hasOwn(value, "result")) return hasOnly(value, ["jsonrpc", "id", "result"]);
  return (
    hasOnly(value, ["jsonrpc", "id", "error"]) &&
    record(value.error) &&
    Number.isSafeInteger(value.error.code) &&
    typeof value.error.message === "string"
  );
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isDesktopHostIdentity(value: unknown): value is DesktopHostIdentity {
  return (
    record(value) &&
    value.windowKind === "workbench" &&
    positiveId(value.webContentsId) &&
    positiveId(value.frameGeneration) &&
    typeof value.frameToken === "string" &&
    value.frameToken.length > 0 &&
    hasOnly(value, ["webContentsId", "frameGeneration", "frameToken", "windowKind"])
  );
}

export function isDesktopHostControl(value: unknown): value is DesktopHostControl {
  if (!record(value)) return false;
  if (value.type === "mimi-dispatch-port" || value.type === "mimi-tasks-port" || value.type === "external-provider-port" || value.type === "remote-services-port" || value.type === "im-gateway-port")
    return hasOnly(value, ["type"]);
  if (value.type === "automation-port")
    return Object.keys(value).length === 2 && typeof value.searchPath === "string";
  if (value.type === "worker-port")
    return (
      hasOnly(value, ["type", "execPath", "entryPath"]) &&
      typeof value.execPath === "string" &&
      typeof value.entryPath === "string"
    );
  if (value.type === "runtime-path")
    return hasOnly(value, ["type", "path"]) && typeof value.path === "string" && !value.path.includes("\0");
  if (value.type === "window-closed")
    return hasOnly(value, ["type", "webContentsId"]) && positiveId(value.webContentsId);
  if (value.type === "shutdown" || value.type === "remote-terminal-port") return hasOnly(value, ["type"]);
  if (value.type === "session-index-changed") {
    return (
      hasOnly(value, ["type", "ids"]) &&
      Array.isArray(value.ids) &&
      value.ids.length <= 256 &&
      value.ids.every(isDesktopSessionId)
    );
  }
  if (value.type === "bind" || value.type === "revoke") {
    return hasOnly(value, ["type", "identity"]) && isDesktopHostIdentity(value.identity);
  }
  if (typeof value.sessionId !== "string" || !value.sessionId) return false;
  if (value.type === "stream-view")
    return typeof value.enabled === "boolean" && hasOnly(value, ["type", "sessionId", "enabled"]);
  if (value.type === "owner") {
    return (
      hasOnly(value, ["type", "sessionId", "webContentsId"]) &&
      (value.webContentsId === null || positiveId(value.webContentsId))
    );
  }
  return (
    value.type === "deleting" &&
    typeof value.deleting === "boolean" &&
    hasOnly(value, ["type", "sessionId", "deleting"])
  );
}
