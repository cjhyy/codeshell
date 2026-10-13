import {
  canonicalWebsiteOrigin,
  validCloudTarget,
  type CloudWebsiteTarget,
} from "./account-api.js";
import type { CloudManagementSession } from "./auth.js";
import { withAccountCookieLock } from "./account-cookie-lock.js";

export interface WebsiteCloudCapability extends CloudWebsiteTarget {
  version: 1;
  mode: "cloud-browser";
}

/** Only the explicit opt-in selects website Account authority. Other failures never downgrade it. */
export async function detectWebsiteCloud(
  fetcher = globalThis.fetch,
  signal?: AbortSignal,
): Promise<WebsiteCloudCapability | null> {
  const response = await fetcher("/api/v1/cloud-browser/capabilities", {
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("暂时无法确认工作台登录方式，请重试。");
  const value = await response.json();
  if (value?.version !== 1 || value?.mode !== "cloud-browser" || !validCloudTarget(value))
    throw new Error("工作台返回了无效的登录配置，请联系管理员。");
  return { ...value, version: 1, mode: "cloud-browser" };
}
export function matchesWebsiteTarget(
  capability: WebsiteCloudCapability,
  target: CloudWebsiteTarget,
  currentOrigin: string,
): boolean {
  return (
    canonicalWebsiteOrigin(currentOrigin) &&
    validCloudTarget(target) &&
    capability.cloudOrigin === currentOrigin &&
    target.cloudOrigin === currentOrigin &&
    capability.accountOrigin === currentOrigin &&
    target.accountOrigin === currentOrigin &&
    capability.installationId === target.installationId
  );
}
export function parseWebsiteCloudSession(
  value: unknown,
  target: CloudWebsiteTarget,
  accountId: string,
): CloudManagementSession {
  const reply = value as {
    authenticated?: unknown;
    mode?: unknown;
    session?: CloudManagementSession;
  };
  const session = reply?.session;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (
    reply?.authenticated !== true ||
    reply.mode !== "cloud-account" ||
    !session ||
    session.kind !== "cloud-management" ||
    session.accountId !== accountId ||
    session.accountOrigin !== target.accountOrigin ||
    session.audience !== target.cloudOrigin ||
    session.installationId !== target.installationId ||
    ![session.id, session.accountId, session.managementEpoch].every((id) => uuid.test(id)) ||
    !Number.isSafeInteger(session.expiresAt) ||
    session.expiresAt <= Date.now()
  )
    throw new Error("工作区登录与当前账号不一致，请重新连接。");
  return session;
}

/** A stale tab may revoke only the Cloud session it displayed, never a newer tab's cookie. */
export async function logoutWebsiteCloudSession(
  expected: CloudManagementSession,
  fetcher = globalThis.fetch,
): Promise<void> {
  await withAccountCookieLock(async () => {
    const options = {
      credentials: "include" as const,
      cache: "no-store" as const,
      redirect: "error" as const,
    };
    const response = await fetcher("/api/v1/cloud-browser/status", {
      ...options,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return;
    const value = await response.json();
    if (
      value?.authenticated !== true ||
      value.mode !== "cloud-account" ||
      value.session?.id !== expected.id ||
      value.session?.accountId !== expected.accountId ||
      value.session?.managementEpoch !== expected.managementEpoch ||
      value.session?.audience !== expected.audience
    )
      return;
    await fetcher("/api/v1/cloud-browser/logout", {
      ...options,
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  });
}
