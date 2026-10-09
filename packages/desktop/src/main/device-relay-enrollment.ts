import { request } from "node:https";
import type { ConnectionOptions } from "node:tls";
import { isRelayOrigin, isRelayToken } from "@cjhyy/code-shell-server/remote-relay";
import type { DesktopRelayEnrollment } from "../shared/device-relay.js";
import { validRegistration, type RelayRegistration } from "./device-relay-store.js";

export function validateRelayEnrollment(input: DesktopRelayEnrollment) {
  if (
    !input ||
    !isRelayOrigin(input.relayOrigin) ||
    input.relayOrigin.length > 2048 ||
    (input.authorization !== undefined && input.authorization !== "account") ||
    (input.authorization !== "account" && !isRelayToken(input.ticket)) ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.trim().length > (input.authorization === "account" ? 80 : 100) ||
    /[\x00-\x1f\x7f]/.test(input.name)
  )
    throw new Error("请填写 HTTPS 目录地址、有效的一次性登记票据和电脑名称。");
}

/** No redirects, cookies, raw server errors or response logging on the credential path. */
export function enrollRelayComputer(
  input: DesktopRelayEnrollment,
  environmentId: string,
  signal: AbortSignal,
  ca?: ConnectionOptions["ca"],
): Promise<RelayRegistration> {
  validateRelayEnrollment(input);
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(
      JSON.stringify({ ticket: input.ticket, environmentId, name: input.name.trim() }),
    );
    const req = request(
      new URL("/api/v1/remote-hosts/enroll", input.relayOrigin),
      {
        method: "POST",
        signal,
        ca,
        headers: {
          Origin: input.relayOrigin,
          "Content-Type": "application/json",
          "Content-Length": bytes.length,
        },
      },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16_384) return req.destroy(new Error("response too large"));
          chunks.push(chunk);
        });
        res.on("error", () =>
          reject(new Error("电脑登记未完成，请检查连接后使用新票据重新登记。")),
        );
        res.on("end", () => {
          if (res.statusCode !== 200 && res.statusCode !== 201) {
            reject(
              new Error(
                res.statusCode === 401 || res.statusCode === 403
                  ? "登记票据已失效，请在目录页面生成新票据。"
                  : "目录拒绝登记，请检查地址并使用新票据重试。",
              ),
            );
            return;
          }
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const registration = {
              ...data,
              relayOrigin: input.relayOrigin,
              name: input.name.trim(),
            };
            if (!validRegistration(registration) || registration.environmentId !== environmentId)
              throw new Error("invalid response");
            resolve(registration);
          } catch {
            reject(new Error("目录返回了无效的登记信息，请使用新票据重新登记。"));
          }
        });
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error("deadline")), 15_000);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", () => reject(new Error("电脑登记未完成，请检查连接后使用新票据重新登记。")));
    req.end(bytes);
  });
}

/** Account token is supplied only by main, for the exact signed-in service origin. */
export async function enrollAccountRelayComputer(
  input: DesktopRelayEnrollment,
  environmentId: string,
  token: string,
  accountId: string,
  signal: AbortSignal,
  transport: import("./cloud-account-http.js").CloudAccountTransport,
): Promise<RelayRegistration> {
  validateRelayEnrollment(input);
  const data = await transport({
    origin: input.relayOrigin,
    path: "/api/v1/remote-hosts/enroll",
    token,
    body: { environmentId, name: input.name.trim() },
    signal,
  });
  const registration = {
    ...(data as object),
    relayOrigin: input.relayOrigin,
    name: input.name.trim(),
  } as RelayRegistration;
  if (
    !validRegistration(registration) ||
    registration.environmentId !== environmentId ||
    registration.accountId !== accountId ||
    !registration.refreshToken ||
    !registration.credentialExpiresAt ||
    registration.credentialExpiresAt <= Date.now()
  )
    throw new Error("云服务返回了无效的电脑授权。");
  return registration;
}
