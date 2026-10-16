import type { CloudAccountManager } from "./cloud-account-manager.js";

export interface LinkAccountAccessLease {
  current(): void;
  signal: AbortSignal;
}

/** Main-owned authority. Renderer and worker requests cannot supply an account lease. */
export type CaptureLinkAccountAccess = () => LinkAccountAccessLease;

export function createLinkAccountAccess(
  account: Pick<CloudAccountManager, "status" | "captureRootAccount">,
): CaptureLinkAccountAccess {
  return () => {
    const status = account.status();
    if (
      status.state !== "signed-in" ||
      typeof status.origin !== "string" ||
      !status.origin.trim() ||
      typeof status.account?.id !== "string" ||
      !status.account.id.trim()
    )
      throw new Error("请先登录 CodeShell 账号，再使用远程 Link。");
    return account.captureRootAccount(status.origin, status.account.id, () => true);
  };
}

export function requireLinkAccountAccess(
  capture?: CaptureLinkAccountAccess,
): LinkAccountAccessLease {
  if (!capture) throw new Error("请先登录 CodeShell 账号，再使用远程 Link。");
  const lease = capture();
  lease.signal.throwIfAborted();
  lease.current();
  return lease;
}

/** Compose the desktop account with the caller's existing operation authority. */
export function linkAccountExecutionOptions(
  capture: CaptureLinkAccountAccess | undefined,
  options: { signal?: AbortSignal; assertAuthorized?: () => void } = {},
): { signal: AbortSignal; assertAuthorized: () => void } {
  const lease = requireLinkAccountAccess(capture);
  const signal = options.signal ? AbortSignal.any([options.signal, lease.signal]) : lease.signal;
  const assertAuthorized = () => {
    signal.throwIfAborted();
    lease.current();
    options.assertAuthorized?.();
  };
  assertAuthorized();
  return { signal, assertAuthorized };
}
