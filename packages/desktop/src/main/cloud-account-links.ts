import { isRelayOrigin } from "@cjhyy/code-shell-server/remote-relay";
import type {
  CloudAccountLinksRequest,
  CloudAccountLinkView,
  CloudAccountGitHubRequest,
} from "../shared/cloud-account.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = () => new Error("云服务返回了无效的连接管理信息。");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw invalid();
  return value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw invalid();
  return value;
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalid();
  return value;
}
function strings(value: unknown, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > 100) throw invalid();
  return value.map((item) => text(item, maxLength));
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !(key in value)))
    throw new Error("云账号请求无效。");
}

export function accountGitHubRequest(value: unknown): CloudAccountGitHubRequest {
  const input = object(value);
  if (input.mode === "link") {
    keys(input, ["mode"]);
    return { mode: "link" };
  }
  if (input.mode !== "login") throw new Error("GitHub 登录请求无效。");
  keys(input, ["mode", "input"]);
  const login = object(input.input);
  if (Object.keys(login).some((key) => !["origin", "deviceName", "connectGitHub"].includes(key)))
    throw new Error("GitHub 登录请求无效。");
  if (
    !isRelayOrigin(login.origin) ||
    (login.origin as string).length > 2048 ||
    (login.deviceName !== undefined && typeof login.deviceName !== "string") ||
    (login.connectGitHub !== undefined && typeof login.connectGitHub !== "boolean")
  )
    throw new Error("GitHub 登录请求无效。");
  return {
    mode: "login",
    input: {
      origin: login.origin as string,
      ...(login.deviceName === undefined ? {} : { deviceName: login.deviceName as string }),
      ...(login.connectGitHub === undefined
        ? {}
        : { connectGitHub: login.connectGitHub as boolean }),
    },
  };
}

export function accountLinksRequest(value: unknown): CloudAccountLinksRequest {
  const input = object(value);
  if (!isRelayOrigin(input.origin) || (input.origin as string).length > 2048)
    throw new Error("云账号请求无效。");
  const identity = { origin: input.origin as string, accountId: id(input.accountId) };
  if (input.action === "list") {
    keys(input, ["action", "origin", "accountId"]);
    return { ...identity, action: "list" };
  }
  if (input.action !== "revoke" || !["connections", "grants"].includes(input.kind as string))
    throw new Error("云账号请求无效。");
  keys(input, ["action", "origin", "accountId", "kind", "id"]);
  return {
    ...identity,
    action: "revoke",
    kind: input.kind as "connections" | "grants",
    id: id(input.id),
  };
}

/** Explicit projection strips unknown fields instead of forwarding server objects to the renderer. */
export function accountLinkView(value: unknown): CloudAccountLinkView {
  const view = object(value);
  if (
    !isRelayOrigin(view.linkOrigin) ||
    (view.linkOrigin as string).length > 2048 ||
    !Array.isArray(view.connections) ||
    view.connections.length > 512 ||
    !Array.isArray(view.grants) ||
    view.grants.length > 4096
  )
    throw invalid();
  const connectionIds = new Set<string>();
  const grantIds = new Set<string>();
  const connections = view.connections.map((raw) => {
    const item = object(raw);
    const account = object(item.account);
    const connectionId = id(item.id);
    if (connectionIds.has(connectionId)) throw invalid();
    connectionIds.add(connectionId);
    return {
      id: connectionId,
      provider: text(item.provider, 64),
      account: {
        id: text(account.id, 256),
        ...(account.login === undefined ? {} : { login: text(account.login, 256) }),
        ...(account.label === undefined ? {} : { label: text(account.label, 256) }),
      },
      revoked: flag(item.revoked),
    };
  });
  const grants = view.grants.map((raw) => {
    const item = object(raw);
    const client = object(item.client);
    const grantId = id(item.id);
    const connectionId = id(item.connectionId);
    if (grantIds.has(grantId) || !connectionIds.has(connectionId)) throw invalid();
    grantIds.add(grantId);
    return {
      id: grantId,
      connectionId,
      client: { id: id(client.id), name: text(client.name, 100) },
      scopes: strings(item.scopes, 128),
      resources: strings(item.resources, 2048),
      revoked: flag(item.revoked),
    };
  });
  return { linkOrigin: view.linkOrigin as string, connections, grants };
}

export function accountLinkRevocation(
  value: unknown,
  input: Extract<CloudAccountLinksRequest, { action: "revoke" }>,
) {
  const result = object(value);
  if (result.revoked !== true || result.kind !== input.kind || result.id !== input.id)
    throw invalid();
  return { action: "revoke" as const, revoked: true as const, kind: input.kind, id: input.id };
}
