import { deviceStore } from "./storage.js";
import { generateSecret } from "./deviceCredential.js";

const MAX_ACCOUNT_RELAY_AGE_MS = 10 * 60_000;
const ACCOUNT_RELAY_CLOCK_SKEW_MS = 30_000;

export interface AccountRelayCredential {
  deviceId: string;
  secretHash: string;
  expiresAt: number;
  accountEntryUrl?: string;
}

// Account Host grants are never written over a browser's durable legacy pairing.
let account: AccountRelayCredential | undefined;
export class AccountRelaySessionExpired extends Error {
  constructor(
    message: string,
    readonly accountEntryUrl?: string,
  ) {
    super(message);
  }
}

export function setAccountRelayCredential(value?: AccountRelayCredential): void {
  account = value;
}
export function hasAccountRelayCredential(): boolean {
  return !!account;
}
export function remoteDeviceCredential(): { deviceId: string; secretHash: string } {
  return account
    ? { deviceId: account.deviceId, secretHash: account.secretHash }
    : { deviceId: deviceStore.getId(), secretHash: deviceStore.getOrCreateSecret(generateSecret) };
}

export async function loadAccountRelayCredential(
  signal: AbortSignal,
): Promise<AccountRelayCredential | undefined> {
  const response = await fetch("/api/v1/relay/session", {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  // Older Hosts and LAN/tunnel mode have no account bootstrap endpoint.
  if (!response.headers.get("content-type")?.includes("application/json")) return;
  const value = await response.json();
  let accountEntryUrl: string | undefined;
  try {
    const url = new URL(value?.accountEntryUrl);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/app" &&
      !url.search &&
      !url.hash
    )
      accountEntryUrl = url.href;
  } catch {
    /* Missing or malformed navigation is not followed. */
  }
  // The public gateway rejects an expired outer grant before the request can
  // reach the Host's accountRelay envelope. It is an account handoff, never a
  // signal to try this origin's legacy pairing or retry WebSocket admission.
  if (
    (response.status === 401 && value?.error === "invalid_relay_authorization") ||
    (value?.accountRelay === true && value.active !== true)
  )
    throw new AccountRelaySessionExpired(
      "账号远程授权已结束，请返回电脑列表并用 Passkey 重新连接。",
      accountEntryUrl,
    );
  if (!response.ok || value?.active !== true) return;
  const now = Date.now();
  if (
    typeof value.deviceId !== "string" ||
    !value.deviceId ||
    value.deviceId.length > 512 ||
    typeof value.secretHash !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.secretHash) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= now ||
    value.expiresAt > now + MAX_ACCOUNT_RELAY_AGE_MS + ACCOUNT_RELAY_CLOCK_SKEW_MS
  )
    throw new AccountRelaySessionExpired("账号远程授权无效，请重新连接。");
  return {
    deviceId: value.deviceId,
    secretHash: value.secretHash,
    // A small clock difference must not reject a fresh Host grant. The browser
    // still treats it as valid for at most ten minutes on its own clock; Host
    // and gateway expiry remain authoritative for every connection.
    expiresAt: Math.min(value.expiresAt, now + MAX_ACCOUNT_RELAY_AGE_MS),
    accountEntryUrl,
  };
}

export async function endAccountRelaySession(): Promise<void> {
  account = undefined;
  await fetch("/api/v1/relay/session/logout", {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
  });
}
