import { expect, test } from "bun:test";
import { AccountWebClient } from "./account-api.js";
import {
  adminListPath,
  parseAdminUsers,
  parseAdminAudit,
  parseAdminSummary,
} from "./admin-data.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const user = {
  id,
  username: "member",
  displayName: "测试用户",
  role: "member",
  disabled: false,
  createdAt: 1,
  sessionCount: 2,
};

test("encoded administrator search crosses the account client without query injection", async () => {
  const calls: string[] = [];
  const client = new AccountWebClient((async (url: string) => {
    calls.push(url);
    return Response.json({ users: [user], nextCursor: null });
  }) as typeof fetch);
  const query = " 测试 用户.+%&_?role=admin ";
  const path = adminListPath("users", id, { q: query, status: "disabled", role: "member" });
  const result = parseAdminUsers(await client.request(path));
  expect(result.users[0]?.id).toBe(id);
  const received = new URL(calls[0]!, "https://owned.invalid");
  expect(received.pathname).toBe("/api/v1/account/web/admin/users");
  expect(received.searchParams.get("q")).toBe(query.trim());
  expect(received.searchParams.getAll("role")).toEqual(["member"]);
  expect(received.searchParams.get("cursor")).toBe(id);
  for (const invalid of [
    "//evil.invalid",
    "/admin/users#fragment",
    "/../session",
    "/%2e%2e/session",
    "/admin/users?q=%xx",
    "/admin/users?q=raw\nvalue",
    "https://evil.invalid/",
  ])
    await expect(client.request(invalid)).rejects.toThrow("账号请求地址无效");
  expect(calls).toHaveLength(1);
});

test("malformed user or pagination data cannot become actionable account rows", () => {
  expect(parseAdminUsers({ users: [user], nextCursor: id }).users).toHaveLength(1);
  for (const value of [
    { users: [{ ...user, disabled: "false" }], nextCursor: null },
    { users: [{ ...user, createdAt: Number.MAX_SAFE_INTEGER }], nextCursor: null },
    { users: [user, user], nextCursor: null },
    { users: [user], nextCursor: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { users: [], nextCursor: id },
    { users: [user] },
  ])
    expect(() => parseAdminUsers(value)).toThrow("管理员数据无效");
});

test("audit dates and summary totals must be usable before rendering", () => {
  const event = { id, actorId: id, targetId: id, action: "admin.account.disabled", createdAt: 1 };
  expect(parseAdminAudit({ events: [event], nextCursor: null }).events).toHaveLength(1);
  for (const changes of [{ createdAt: "1" }, { createdAt: -1 }, { action: "unknown" }])
    expect(() =>
      parseAdminAudit({ events: [{ ...event, ...changes }], nextCursor: null }),
    ).toThrow();
  const summary = {
    users: { total: 2, active: 1, disabled: 1, administrators: 1 },
    sessions: { active: 3 },
    auditEvents: 4,
  };
  expect(parseAdminSummary(summary)).toEqual(summary);
  expect(() => parseAdminSummary({ ...summary, users: { ...summary.users, total: 5 } })).toThrow();
  expect(() => parseAdminSummary({ ...summary, sessions: { active: -1 } })).toThrow();
});
