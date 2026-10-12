import { isRelayOrigin } from "@cjhyy/code-shell-server/remote-relay";
import type { CloudAccountIdentity, CloudAccountProfileRequest } from "../shared/cloud-account.js";
import {
  normalizeCloudDisplayName,
  normalizeCloudUsername,
} from "../shared/cloud-account-profile.js";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function accountProfileRequest(raw: unknown): CloudAccountProfileRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("云账号资料请求无效。");
  const input = raw as Record<string, unknown>;
  if (
    !isRelayOrigin(input.origin) ||
    (input.origin as string).length > 2048 ||
    typeof input.accountId !== "string" ||
    !uuid.test(input.accountId)
  )
    throw new Error("云账号资料请求无效。");
  const identity = { origin: input.origin as string, accountId: input.accountId };
  if (input.action === "read" && Object.keys(input).length === 3)
    return { ...identity, action: "read" };
  if (
    input.action !== "update" ||
    Object.keys(input).some(
      (key) => !["origin", "accountId", "action", "displayName", "username"].includes(key),
    ) ||
    (input.displayName === undefined && input.username === undefined)
  )
    throw new Error("云账号资料请求无效。");
  const displayName = normalizeCloudDisplayName(input.displayName);
  const username = normalizeCloudUsername(input.username);
  if (input.displayName !== undefined && displayName === undefined)
    throw new Error("昵称需为 1–64 个字符，不能包含控制字符。");
  if (input.username !== undefined && username === undefined)
    throw new Error("用户名需为 3–64 位字母、数字、点、下划线或连字符，并以字母或数字开头。");
  return {
    ...identity,
    action: "update",
    ...(displayName === undefined ? {} : { displayName }),
    ...(username === undefined ? {} : { username }),
  };
}

/** Project only public identity fields, never server authority or unknown data. */
export function accountProfile(raw: unknown, accountId: string): CloudAccountIdentity {
  const account = (raw as { account?: unknown } | undefined)?.account;
  if (!account || typeof account !== "object" || Array.isArray(account))
    throw new Error("云服务返回了无效的账号资料。");
  const value = account as Record<string, unknown>;
  if (
    value.id !== accountId ||
    normalizeCloudUsername(value.username) !== value.username ||
    typeof value.username !== "string" ||
    typeof value.displayName !== "string" ||
    normalizeCloudDisplayName(value.displayName) !== value.displayName
  )
    throw new Error("云服务返回了无效的账号资料。");
  return { id: accountId, username: value.username, displayName: value.displayName };
}
