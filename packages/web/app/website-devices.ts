import { canonicalWebsiteOrigin } from "./account-api.js";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TICKET = /^[A-Za-z0-9_-]{43}$/;

export interface WebsiteComputer {
  hostId: string;
  environmentId: string;
  name: string;
  online: boolean;
  revoked: boolean;
  publicOrigin: string;
}

export function parseWebsiteComputers(value: unknown, accountOrigin: string): WebsiteComputer[] {
  const hosts = (value as { hosts?: unknown })?.hosts;
  if (!Array.isArray(hosts) || hosts.length > 1000) throw new Error("电脑列表无效，请刷新后重试。");
  const ids = new Set<string>();
  return hosts.map((host) => {
    if (
      !host ||
      !UUID.test(host.hostId) ||
      !UUID.test(host.environmentId) ||
      ids.has(host.hostId) ||
      typeof host.name !== "string" ||
      !host.name.trim() ||
      host.name.length > 128 ||
      /[\p{Cc}\p{Cs}]/u.test(host.name) ||
      typeof host.online !== "boolean" ||
      typeof host.revoked !== "boolean" ||
      !canonicalWebsiteOrigin(host.publicOrigin)
    )
      throw new Error("电脑列表无效，请刷新后重试。");
    const target = new URL(host.publicOrigin);
    if (
      target.protocol !== "https:" ||
      target.hostname === new URL(accountOrigin).hostname ||
      !target.hostname.startsWith(`${host.hostId}.`)
    )
      throw new Error("电脑地址无效，请刷新后重试。");
    ids.add(host.hostId);
    return {
      hostId: host.hostId,
      environmentId: host.environmentId,
      name: host.name,
      online: host.online,
      revoked: host.revoked,
      publicOrigin: host.publicOrigin,
    };
  });
}

/** A one-use relay claim is the only credential allowed in this navigation.
 * Account cookies stay on their original path and no root bearer is requested. */
export function websiteComputerClaim(value: unknown, host: WebsiteComputer): string {
  const claim = value as {
    hostId?: unknown;
    publicOrigin?: unknown;
    claimUrl?: unknown;
    expiresAt?: unknown;
  };
  if (
    !claim ||
    claim.hostId !== host.hostId ||
    claim.publicOrigin !== host.publicOrigin ||
    typeof claim.claimUrl !== "string" ||
    !Number.isSafeInteger(claim.expiresAt) ||
    Number(claim.expiresAt) <= Date.now() ||
    Number(claim.expiresAt) > Date.now() + 120000
  )
    throw new Error("电脑连接授权无效，请重新打开。");
  const target = new URL(claim.claimUrl);
  if (
    target.origin !== host.publicOrigin ||
    target.username ||
    target.password ||
    target.pathname !== "/__relay/claim" ||
    target.search ||
    !TICKET.test(target.hash.slice(1)) ||
    target.href !== `${host.publicOrigin}/__relay/claim#${target.hash.slice(1)}`
  )
    throw new Error("电脑连接授权无效，请重新打开。");
  return target.href;
}
