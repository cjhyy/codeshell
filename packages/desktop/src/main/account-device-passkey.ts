import { createHash, randomBytes } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { createCloudAccountTransport, type CloudAccountTransport } from "./cloud-account-http.js";

export interface AccountRemoteAuthorization {
  origin: string;
  token: string;
  hostId: string;
  environmentId: string;
  sourceHostId: string;
  sourceDeviceCredential: string;
  signal: AbortSignal;
}

/** A public browser request can approve, but only its main-owned PKCE receipt can redeem. */
export function createAccountRemoteAuthorizer(deps: {
  openExternal(url: string): Promise<void>;
  request?: CloudAccountTransport;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<unknown>;
}) {
  const request = deps.request ?? createCloudAccountTransport();
  const now = deps.now ?? Date.now;
  const opaque = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
  return async (input: AccountRemoteAuthorization): Promise<string> => {
    input.signal.throwIfAborted();
    const verifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    let receipt: string | undefined;
    let redeemed = false;
    const call = (action: string, body: unknown, signal?: AbortSignal) =>
      request({
        origin: input.origin,
        path: `/api/v1/account/remote-access/${action}`,
        token: input.token,
        body,
        ...(signal ? { signal } : {}),
      });
    try {
      const flow = (await call(
        "start",
        {
          hostId: input.hostId,
          environmentId: input.environmentId,
          sourceHostId: input.sourceHostId,
          sourceDeviceCredential: input.sourceDeviceCredential,
          codeChallenge,
        },
        input.signal,
      )) as Record<string, unknown>;
      if (opaque(flow?.receipt)) receipt = flow.receipt;
      let url: URL | undefined;
      try {
        if (typeof flow?.authorizationUrl === "string") url = new URL(flow.authorizationUrl);
      } catch {
        /* Untrusted navigation. */
      }
      if (
        !url ||
        url.origin !== input.origin ||
        url.protocol !== "https:" ||
        url.pathname !== "/remote-access" ||
        url.username ||
        url.password ||
        url.hash ||
        [...url.searchParams.keys()].length !== 1 ||
        !opaque(url.searchParams.get("request")) ||
        url.searchParams.get("request") === receipt ||
        !receipt ||
        !Number.isSafeInteger(flow.expiresAt) ||
        Number(flow.expiresAt) <= now() ||
        Number(flow.expiresAt) > now() + 15 * 60_000
      )
        throw new Error("远程访问验证地址无效，请重新连接。");
      input.signal.throwIfAborted();
      await deps.openExternal(url.href);
      while (now() < Number(flow.expiresAt)) {
        input.signal.throwIfAborted();
        const result = (await call(
          "poll",
          { receipt, codeVerifier: verifier },
          input.signal,
        )) as Record<string, unknown>;
        input.signal.throwIfAborted();
        if (result?.status !== "pending") {
          if (
            !opaque(result?.authorization) ||
            result.hostId !== input.hostId ||
            result.environmentId !== input.environmentId ||
            result.sourceHostId !== input.sourceHostId ||
            !Number.isSafeInteger(result.expiresAt) ||
            Number(result.expiresAt) <= now() ||
            Number(result.expiresAt) > now() + 60_000
          )
            throw new Error("远程访问验证已失效或与所选电脑不一致，请重新连接。");
          redeemed = true;
          return result.authorization;
        }
        const interval = Math.min(
          10_000,
          Math.max(
            1000,
            typeof flow.pollIntervalMs === "number" && Number.isFinite(flow.pollIntervalMs)
              ? flow.pollIntervalMs
              : 1000,
          ),
        );
        await (deps.sleep ?? ((milliseconds, signal) => wait(milliseconds, undefined, { signal })))(
          Math.min(interval, Number(flow.expiresAt) - now()),
          input.signal,
        );
      }
      throw new Error("远程访问验证已超时，请重新连接并在浏览器使用 Passkey 确认。");
    } finally {
      if (receipt && !redeemed)
        void call("cancel", { receipt, codeVerifier: verifier }).catch(() => {});
    }
  };
}
