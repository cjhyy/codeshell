import { request } from "node:https";
import type { ConnectionOptions } from "node:tls";
import { isRelayOrigin } from "@cjhyy/code-shell-server/remote-relay";

function accountErrorMessage(status: number, path?: string, code?: unknown): string {
  const register = path === "/api/v1/account/register";
  const login = path === "/api/v1/account/login";
  if ((register || login) && status === 400) {
    if (code === "invalid_username")
      return "用户名需为 3–64 位字母、数字、点、下划线或连字符，并以字母或数字开头。";
    if (code === "invalid_password") return "密码需为 12–1024 位字符。";
  }
  if (register && status === 409 && code === "username_unavailable")
    return "此用户名已被使用，请换一个用户名。";
  if (login && status === 401 && code === "invalid_credentials")
    return "用户名或密码错误，请重新输入。";
  if (
    (register || path === "/api/v1/account/github/poll") &&
    status === 403 &&
    code === "registration_disabled"
  )
    return "此云服务暂未开放注册，请登录已有账号。";
  const github = ["status", "start", "poll", "cancel"].some(
    (action) => path === `/api/v1/account/github/${action}`,
  );
  if (github && status === 503) {
    if (code === "github_disabled") return "此云服务尚未配置 GitHub 登录，请使用账号密码。";
    if (code === "github_unavailable") return "GitHub 登录暂时不可用，请稍后重试。";
  }
  if (path === "/api/v1/account/github/poll") {
    if (status === 409 && code === "provider_already_linked")
      return "GitHub 关联冲突：当前账号或此 GitHub 已有其他关联。";
    if (status === 401 && code === "github_login_denied")
      return "GitHub 登录未获授权，请重新发起登录。";
    if (status === 401 && code === "invalid_github_receipt")
      return "GitHub 登录请求已过期，请重新发起登录。";
    if (status === 502 && code === "github_login_failed")
      return "GitHub 登录未完成，请重新发起登录。";
  }
  return status === 401 || status === 403
    ? "云账号授权已失效，请重新登录。"
    : status === 409
      ? "账号或关联已存在冲突，请检查当前账号。"
      : status === 429
        ? "请求过于频繁，请稍后重试。"
        : "云服务请求未完成，请检查服务地址和网络。";
}

export class CloudAccountHttpError extends Error {
  constructor(
    readonly status: number,
    path?: string,
    code?: unknown,
  ) {
    super(accountErrorMessage(status, path, code));
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
              let code: unknown;
              try {
                const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (value && typeof value === "object" && !Array.isArray(value)) code = value.error;
              } catch {
                // Invalid error bodies retain their HTTP status and safe fallback text.
              }
              reject(new CloudAccountHttpError(res.statusCode ?? 0, input.path, code));
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
