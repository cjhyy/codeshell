import type { CloudRequestMethod } from "../shared/cloud-environment";

export const CLOUD_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Match the Hub session/history contract, including older dotted IDs, without traversal. */
export const CLOUD_SESSION_ID = /^(?!.*\.\.)[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
export const CLOUD_MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const CLOUD_MAX_REQUEST_BYTES = 1024 * 1024;
export const CLOUD_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Origins only: no redirects, paths, URL credentials, query tokens or fragments. */
export function normalizeCloudNativeOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("请输入云端服务地址。");
  const raw = value.trim();
  if (!/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(raw) || /[\x00-\x20\x7f]/.test(raw))
    throw new Error("请填写完整的云端服务首页地址。");
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("云端服务需要 HTTPS；仅本机回环地址允许 HTTP。");
  return url.origin;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("请求参数无效。");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, empty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    (empty || value.length > 0) &&
    !value.includes("\0")
  );
}
function only(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("云端不支持这个操作参数。");
}

/** Project roots and execution policy remain host-owned; never relay Desktop RunOptions. */
export function validateCloudRequest(
  method: unknown,
  value: unknown,
): {
  method: CloudRequestMethod;
  params: Record<string, unknown>;
} {
  const params = record(value);
  if (Buffer.byteLength(JSON.stringify(params)) > CLOUD_MAX_REQUEST_BYTES)
    throw new Error("请求过大。");
  if (!["agent/run", "agent/cancel", "agent/approve", "agent/query"].includes(String(method)))
    throw new Error("云端不支持这个操作。");
  if (method === "agent/query" && params.type === "sessions") {
    only(params, ["type"]);
  } else {
    if (typeof params.sessionId !== "string" || !CLOUD_SESSION_ID.test(params.sessionId))
      throw new Error("会话标识无效。");
    if (method === "agent/run") {
      only(params, [
        "sessionId",
        "task",
        "clientMessageId",
        "displayText",
        "model",
        "permissionMode",
        "planMode",
        "uploadIds",
      ]);
      if (
        !text(params.task, 768 * 1024, true) ||
        !text(params.clientMessageId, 128) ||
        (params.displayText !== undefined && !text(params.displayText, 768 * 1024, true)) ||
        (params.model !== undefined && !text(params.model, 256)) ||
        (params.permissionMode !== undefined &&
          !["plan", "default", "acceptEdits", "dontAsk", "bypassPermissions", "auto"].includes(
            String(params.permissionMode),
          )) ||
        (params.planMode !== undefined && typeof params.planMode !== "boolean") ||
        (params.uploadIds !== undefined &&
          (!Array.isArray(params.uploadIds) ||
            params.uploadIds.length > 16 ||
            new Set(params.uploadIds).size !== params.uploadIds.length ||
            params.uploadIds.some(
              (id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(id),
            )))
      )
        throw new Error("云端运行参数无效。");
    } else if (method === "agent/cancel") {
      only(params, ["sessionId"]);
    } else if (method === "agent/approve") {
      only(params, ["sessionId", "requestId", "decision"]);
      const decision = record(params.decision);
      only(decision, ["approved", "answer", "reason"]);
      if (
        !text(params.requestId, 256) ||
        typeof decision.approved !== "boolean" ||
        (decision.answer !== undefined && !text(decision.answer, 64 * 1024, true)) ||
        (decision.reason !== undefined && !text(decision.reason, 64 * 1024, true))
      )
        throw new Error("云端审批参数无效。");
    } else {
      only(params, [
        "type",
        "sessionId",
        "outputRecovery",
        "after",
        "through",
        "maxBytes",
        "maxFrames",
      ]);
      if (
        !["session_detail", "output_coverage", "output_journal"].includes(String(params.type)) ||
        (params.outputRecovery !== undefined && typeof params.outputRecovery !== "boolean") ||
        ["after", "through"].some((key) => params[key] !== undefined && !text(params[key], 1024)) ||
        (params.maxBytes !== undefined &&
          (!Number.isSafeInteger(params.maxBytes) ||
            Number(params.maxBytes) < 1 ||
            Number(params.maxBytes) > 8 * 1024 * 1024)) ||
        (params.maxFrames !== undefined &&
          (!Number.isSafeInteger(params.maxFrames) ||
            Number(params.maxFrames) < 1 ||
            Number(params.maxFrames) > 8192))
      )
        throw new Error("云端历史查询参数无效。");
    }
  }
  return { method: method as CloudRequestMethod, params };
}
