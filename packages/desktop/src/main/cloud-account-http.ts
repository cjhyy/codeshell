import { request } from "node:https";
import type { ConnectionOptions } from "node:tls";
import { isRelayOrigin } from "@cjhyy/code-shell-server/remote-relay";

export class CloudAccountHttpError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 403
        ? "云账号授权已失效，请重新登录。"
        : status === 409
          ? "账号或关联已存在冲突，请检查当前账号。"
          : status === 429
            ? "请求过于频繁，请稍后重试。"
            : "云服务请求未完成，请检查服务地址和网络。",
    );
  }
}

export interface CloudAccountRequest {
  origin: string;
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  token?: string;
  signal?: AbortSignal;
}
export type CloudAccountTransport = (input: CloudAccountRequest) => Promise<unknown>;

/** Exact-origin HTTPS, bounded JSON, no redirect/cookie inheritance or raw errors. */
export function createCloudAccountTransport(ca?: ConnectionOptions["ca"]): CloudAccountTransport {
  return (input) => {
    if (!isRelayOrigin(input.origin) || !/^\/api\/v1\/(?:account|remote-hosts)\//.test(input.path))
      return Promise.reject(new Error("无效的云服务地址。"));
    return new Promise((resolve, reject) => {
      const bytes = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body));
      const req = request(
        new URL(input.path, input.origin),
        {
          method: input.method ?? "POST",
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
            if (size > 16_384) req.destroy(new Error("response too large"));
            else chunks.push(chunk);
          });
          res.on("error", () => reject(new CloudAccountHttpError(0)));
          res.on("end", () => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              reject(new CloudAccountHttpError(res.statusCode ?? 0));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new CloudAccountHttpError(0));
            }
          });
        },
      );
      const timer = setTimeout(() => req.destroy(new Error("deadline")), 15_000);
      req.on("close", () => clearTimeout(timer));
      req.on("error", () => reject(new CloudAccountHttpError(0)));
      req.end(bytes);
    });
  };
}
