import { deviceStore } from "./storage.js";
import { generateSecret } from "./deviceCredential.js";

import {
  accountRelayBootstrap,
  type AccountRelayBootstrapCredential,
} from "./accountRelayBootstrap.js";

export type AccountRelayCredential = AccountRelayBootstrapCredential;

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
  options: { renew?: boolean; expectedAccount?: boolean } = {},
): Promise<AccountRelayCredential | undefined> {
  const result = await accountRelayBootstrap(signal, options.renew, options.expectedAccount);
  if (result.kind === "ready") return result.credential;
  if (result.kind === "legacy") return;
  if (result.kind === "expired")
    throw new AccountRelaySessionExpired(
      "账号远程授权已结束，请返回电脑列表并用 Passkey 重新连接。",
      result.accountEntryUrl,
    );
  throw new Error("电脑暂时无法连接，正在恢复连接。");
}

export async function endAccountRelaySession(): Promise<void> {
  account = undefined;
  try {
    await fetch("/api/v1/relay/session/logout", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // The computer may be offline. Its outer session must still be ended.
  }
  const response = await fetch("/__relay/logout", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || (await response.json()).ok !== true)
    throw new Error("当前连接已停止，但未能确认服务器退出，请重试退出。");
}
