import { createHash } from "node:crypto";
import { isRelayOrigin } from "@cjhyy/code-shell-server/remote-relay";
import type { CloudManagementRequest, CloudProject } from "../shared/cloud-management.js";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const cloudToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const invalid = () => new Error("云端管理信息无效，请重新连接。");
export function cloudObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
export function cloudId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid();
  return value;
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
function time(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}
export function cloudOrigin(value: unknown): string {
  if (!isRelayOrigin(value) || (value as string).length > 2048) throw invalid();
  return value as string;
}
export function cloudManagementRequest(value: unknown): CloudManagementRequest {
  const input = cloudObject(value);
  const identity = {
    accountOrigin: cloudOrigin(input.accountOrigin),
    accountId: cloudId(input.accountId),
    cloudOrigin: cloudOrigin(input.cloudOrigin),
  };
  let fields = ["accountOrigin", "accountId", "cloudOrigin", "action"];
  if (input.action === "create") fields = [...fields, "name"];
  else if (["start", "stop", "open"].includes(input.action as string))
    fields = [...fields, "projectId"];
  else if (input.action !== "list" && input.action !== "logout") throw invalid();
  if (Object.keys(input).length !== fields.length || fields.some((key) => !(key in input)))
    throw invalid();
  if (input.action === "create") {
    const name = text(input.name, 80).trim();
    if (!name) throw invalid();
    return { ...identity, action: "create", name };
  }
  if (input.action === "list" || input.action === "logout")
    return { ...identity, action: input.action };
  return {
    ...identity,
    action: input.action as "start" | "stop" | "open",
    projectId: cloudId(input.projectId),
  };
}
export function cloudProject(value: unknown): CloudProject {
  const row = cloudObject(value);
  if (!["stopped", "starting", "running", "stopping", "error"].includes(row.status as string))
    throw invalid();
  return {
    id: cloudId(row.id),
    name: text(row.name, 80),
    status: row.status as CloudProject["status"],
    generation: time(row.generation),
    createdAt: time(row.createdAt),
    updatedAt: time(row.updatedAt),
    ...(row.error === undefined ? {} : { error: text(row.error, 2048) }),
  };
}
export interface ManagedCloudGrant {
  token: string;
  session: {
    id: string;
    kind: "cloud-management";
    audience: string;
    installationId: string;
    accountOrigin: string;
    accountId: string;
    managementEpoch: string;
    expiresAt: number;
  };
}
export interface CloudManagementTarget {
  version: 2;
  mode: "cloud-account";
  cloudOrigin: string;
  accountOrigin: string;
  installationId: string;
}
export interface CloudManagementTicket {
  ticket: string;
  expiresAt: number;
  cloudOrigin: string;
  accountOrigin: string;
  installationId: string;
}
export function cloudManagementTarget(
  value: unknown,
  input: CloudManagementRequest,
): CloudManagementTarget {
  const row = cloudObject(value);
  if (
    row.version !== 2 ||
    row.mode !== "cloud-account" ||
    row.cloudOrigin !== input.cloudOrigin ||
    row.accountOrigin !== input.accountOrigin
  )
    throw invalid();
  return {
    version: 2,
    mode: "cloud-account",
    cloudOrigin: input.cloudOrigin,
    accountOrigin: input.accountOrigin,
    installationId: cloudId(row.installationId),
  };
}
export function cloudManagementTicket(
  value: unknown,
  target: Omit<CloudManagementTarget, "version" | "mode">,
  now: number,
): CloudManagementTicket {
  const row = cloudObject(value);
  if (
    !cloudToken(row.ticket) ||
    row.cloudOrigin !== target.cloudOrigin ||
    row.accountOrigin !== target.accountOrigin ||
    row.installationId !== target.installationId ||
    time(row.expiresAt) <= now ||
    (row.expiresAt as number) > now + 60_000
  )
    throw invalid();
  return { ticket: row.ticket, expiresAt: row.expiresAt as number, ...target };
}
export function managedCloudGrant(
  value: unknown,
  input: CloudManagementRequest,
  now: number,
): ManagedCloudGrant {
  const row = cloudObject(value),
    s = cloudObject(row.session);
  if (
    !cloudToken(row.token) ||
    s.kind !== "cloud-management" ||
    s.audience !== input.cloudOrigin ||
    s.accountOrigin !== input.accountOrigin ||
    s.accountId !== input.accountId ||
    time(s.expiresAt) <= now ||
    (s.expiresAt as number) > now + 600_000
  )
    throw invalid();
  return {
    token: row.token,
    session: {
      id: cloudId(s.id),
      kind: "cloud-management",
      audience: input.cloudOrigin,
      installationId: cloudId(s.installationId),
      accountOrigin: input.accountOrigin,
      accountId: input.accountId,
      managementEpoch: cloudId(s.managementEpoch),
      expiresAt: s.expiresAt as number,
    },
  };
}
/** Include the grant incarnation so an old cleanup cannot erase a new login's cookie. */
export function managedCloudPartition(grant: ManagedCloudGrant): string {
  const s = grant.session;
  return `persist:codeshell-account-cloud-${createHash("sha256")
    .update(JSON.stringify([s.audience, s.accountOrigin, s.accountId, s.managementEpoch, s.id]))
    .digest("hex")}`;
}
