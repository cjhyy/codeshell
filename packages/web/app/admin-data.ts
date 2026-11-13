import { validWebsiteAccount, type WebsiteAccount } from "./account-api.js";

export interface AdminUser extends WebsiteAccount {
  disabled: boolean;
  createdAt: number;
  sessionCount: number;
}
export interface AdminUsers {
  users: AdminUser[];
  nextCursor: string | null;
}
export interface AdminSummary {
  users: { total: number; active: number; disabled: number; administrators: number };
  sessions: { active: number };
  auditEvents: number;
}
export const adminActions = {
  "admin.account.disabled": "停用账号",
  "admin.account.enabled": "恢复账号",
  "admin.sessions.revoked": "撤销登录会话",
};
export interface AdminAudit {
  events: Array<{
    id: string;
    actorId: string;
    targetId: string;
    action: keyof typeof adminActions;
    createdAt: number;
  }>;
  nextCursor: string | null;
}
export interface AdminFilters {
  q: string;
  status: "" | "active" | "disabled";
  role: "" | "admin" | "member";
}
export const emptyAdminFilters: AdminFilters = { q: "", status: "", role: "" };
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const timestamp = (value: unknown) => count(value) && value <= 8_640_000_000_000_000;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function invalid(): never {
  throw new Error("管理员数据无效，请刷新后重试。");
}
export function validAdminUser(value: unknown): value is AdminUser {
  const row = object(value);
  return (
    validWebsiteAccount(value) &&
    typeof row.disabled === "boolean" &&
    timestamp(row.createdAt) &&
    count(row.sessionCount)
  );
}
function page(value: Record<string, unknown>, rows: unknown): rows is unknown[] {
  return (
    Array.isArray(rows) &&
    rows.length <= 30 &&
    (value.nextCursor === null || uuid(value.nextCursor)) &&
    new Set(rows.map((row) => object(row).id)).size === rows.length &&
    (value.nextCursor === null || (rows.length > 0 && value.nextCursor === object(rows.at(-1)).id))
  );
}
export function parseAdminUsers(value: unknown): AdminUsers {
  const data = object(value);
  if (!page(data, data.users) || !data.users.every(validAdminUser)) invalid();
  return data as unknown as AdminUsers;
}
export function parseAdminAudit(value: unknown): AdminAudit {
  const data = object(value);
  if (
    !page(data, data.events) ||
    !data.events.every((item) => {
      const row = object(item);
      return (
        uuid(row.id) &&
        uuid(row.actorId) &&
        uuid(row.targetId) &&
        typeof row.action === "string" &&
        Object.hasOwn(adminActions, row.action) &&
        timestamp(row.createdAt)
      );
    })
  )
    invalid();
  return data as unknown as AdminAudit;
}
export function parseAdminSummary(value: unknown): AdminSummary {
  const data = object(value),
    users = object(data.users),
    sessions = object(data.sessions);
  if (
    ![
      users.total,
      users.active,
      users.disabled,
      users.administrators,
      sessions.active,
      data.auditEvents,
    ].every(count)
  )
    invalid();
  if (
    Number(users.active) + Number(users.disabled) !== users.total ||
    Number(users.administrators) > Number(users.active)
  )
    invalid();
  return data as unknown as AdminSummary;
}
export function adminListPath(
  section: "users" | "audit",
  cursor: string | null,
  filters = emptyAdminFilters,
): string {
  const query = new URLSearchParams({ limit: "30" });
  if (cursor) query.set("cursor", cursor);
  if (section === "users") {
    if (filters.q.trim()) query.set("q", filters.q.trim());
    if (filters.status) query.set("status", filters.status);
    if (filters.role) query.set("role", filters.role);
  }
  return `/admin/${section}?${query}`;
}
