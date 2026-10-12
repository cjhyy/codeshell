import { request } from "node:https";
import type { ConnectionOptions } from "node:tls";
import { cloudId, cloudObject, cloudOrigin, cloudToken } from "./cloud-management-contract.js";

export class CloudManagementHttpError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 403
        ? "云端管理授权已失效，请重新连接。"
        : status === 409
          ? "云端项目状态已变化，请重新加载列表。"
          : status === 429
            ? "云端运行数量已达上限或请求过于频繁，请稍后重试。"
            : "云端操作未确认完成，请检查网络并重新加载列表。",
    );
  }
}
export interface CloudManagementHttpRequest {
  origin: string;
  path: string;
  method: "GET" | "POST";
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
}
export type CloudManagementTransport = (input: CloudManagementHttpRequest) => Promise<unknown>;
/** Fixed HTTPS endpoints, bounded bodies/deadlines, no inherited cookies or redirects. */
export function createCloudManagementTransport(
  ca?: ConnectionOptions["ca"],
): CloudManagementTransport {
  return async (input) => {
    cloudOrigin(input.origin);
    const body = input.body === undefined ? undefined : cloudObject(input.body);
    const empty = body && Object.keys(body).length === 0;
    const valid =
      input.path === "/api/v1/cloud-management/capabilities"
        ? input.method === "GET" && body === undefined && input.token === undefined
        : input.path === "/api/v1/cloud-management/session"
          ? input.method === "POST" &&
            body &&
            Object.keys(body).length === 1 &&
            cloudToken(body.ticket) &&
            input.token === undefined
          : cloudToken(input.token) &&
            (input.path === "/api/v1/cloud-management/logout"
              ? input.method === "POST" && empty
              : input.path === "/api/v1/projects"
                ? (input.method === "GET" && body === undefined) ||
                  (input.method === "POST" &&
                    body &&
                    Object.keys(body).length === 1 &&
                    typeof body.name === "string" &&
                    body.name.length > 0 &&
                    body.name.length <= 80)
                : /^\/api\/v1\/projects\/([0-9a-f-]{36})\/(start|stop|open)$/.test(input.path) &&
                  cloudId(input.path.split("/")[4]) &&
                  input.method === "POST" &&
                  empty);
    if (!valid) throw new Error("云端管理请求无效。");
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (bytes && bytes.length > 8192) throw new Error("云端管理请求过大。");
    const limit = input.path === "/api/v1/projects" && input.method === "GET" ? 1_048_576 : 16_384;
    return new Promise((resolve, reject) => {
      const req = request(
        new URL(input.path, input.origin),
        {
          method: input.method,
          ca,
          signal: input.signal,
          headers: {
            Origin: input.origin,
            Accept: "application/json",
            ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
            ...(bytes
              ? { "Content-Type": "application/json", "Content-Length": bytes.length }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) req.destroy();
            else chunks.push(chunk);
          });
          res.on("error", () => reject(new CloudManagementHttpError(0)));
          res.on("end", () => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              reject(new CloudManagementHttpError(res.statusCode ?? 0));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new CloudManagementHttpError(0));
            }
          });
        },
      );
      const timer = setTimeout(() => req.destroy(), 15_000);
      req.on("close", () => clearTimeout(timer));
      req.on("error", () => reject(new CloudManagementHttpError(0)));
      req.end(bytes);
    });
  };
}
