import { deviceStore } from "./storage.js";
import { generateSecret } from "./deviceCredential.js";

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
  if (value?.accountRelay === true && value.active !== true)
    throw new AccountRelaySessionExpired(
      "账号远程授权已结束，请返回电脑列表并用 Passkey 重新连接。",
      accountEntryUrl,
    );
  if (!response.ok || value?.active !== true) return;
  if (
    typeof value.deviceId !== "string" ||
    !value.deviceId ||
    value.deviceId.length > 512 ||
    typeof value.secretHash !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.secretHash) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= Date.now() ||
    value.expiresAt > Date.now() + 10 * 60_000
  )
    throw new AccountRelaySessionExpired("账号远程授权无效，请重新连接。");
  return {
    deviceId: value.deviceId,
    secretHash: value.secretHash,
    expiresAt: value.expiresAt,
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
