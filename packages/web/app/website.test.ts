import { expect, test } from "bun:test";
import {
  AccountWebClient,
  accountError,
  parseAccountSession,
  parseAccountOverview,
} from "./account-api.js";
import {
  detectWebsiteCloud,
  matchesWebsiteTarget,
  parseWebsiteCloudSession,
} from "./website-cloud.js";
import { parseWebsiteRoute, websiteRouteUrl, parseWorkbenchLocation } from "./website-routes.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const origin = "https://cloud.fixture.invalid";
const target = { cloudOrigin: origin, accountOrigin: origin, installationId: id };
const account = { id, username: "fixture-user", displayName: "测试昵称", role: "member" as const };
const overview = {
  account,
  security: { hasPassword: true, githubLinked: false },
  capabilities: { sessions: true, passwordChange: true, admin: false, links: false },
  stats: { activeSessions: 1, loginMethods: 1 },
};
const webSession = () => ({
  authenticated: true,
  csrfToken: "C".repeat(43),
  account,
  overview,
  session: { id, expiresAt: Date.now() + 600000 },
  cloudTarget: { enabled: true, ...target },
});
const capability = { ...target, version: 1 as const, mode: "cloud-browser" as const };

test("account settings and administrator URLs restore the selected page and preserve only public project context", () => {
  for (const section of ["profile", "security", "sessions", "connections"] as const)
    expect(parseWebsiteRoute(new URL(`/settings/account/${section}`, origin))).toEqual({
      kind: "account",
      section,
    });
  for (const section of ["users", "summary", "audit"] as const)
    expect(parseWebsiteRoute(new URL(`/admin/${section}`, origin))).toEqual({
      kind: "admin",
      section,
    });
  expect(parseWebsiteRoute(new URL("/api/v1/account/manage", origin))).toEqual({
    kind: "account",
    section: "profile",
  });
  expect(parseWebsiteRoute(new URL("/settings/account/%2fadmin", origin))).toEqual({
    kind: "workbench",
  });
  const current = new URL(
    `/?project=${id}&session=chat_123&accessToken=secret&next=https://evil.invalid#receipt=secret`,
    origin,
  );
  const settings = websiteRouteUrl({ kind: "account", section: "security" }, current);
  expect(settings).toBe(`/settings/account/security?project=${id}&session=chat_123`);
  expect(websiteRouteUrl({ kind: "workbench" }, new URL(settings, origin))).toBe(
    `/?project=${id}&session=chat_123`,
  );
  expect(
    websiteRouteUrl({ kind: "workbench" }, new URL("/?project=../../shared&session=other", origin)),
  ).toBe("/");
});

test("only an explicit missing Cloud website capability selects the compatible Hub gate", async () => {
  expect(await detectWebsiteCloud(async () => Response.json({}, { status: 404 }))).toBeNull();
  for (const response of [
    Response.json({}, { status: 503 }),
    Response.json({ mode: "cloud-account" }),
    Response.json({ ...capability, version: 2 }),
  ])
    await expect(detectWebsiteCloud(async () => response)).rejects.toThrow();
  expect(await detectWebsiteCloud(async () => Response.json(capability))).toEqual(capability);
});

test("workspace history and settings selections survive refresh and an account-settings round trip", () => {
  const current = new URL(
    `/?project=${id}&session=chat_123&view=settings&section=models&token=private`,
    origin,
  );
  expect(parseWorkbenchLocation(current)).toEqual({ view: "settings", section: "models" });
  const settings = websiteRouteUrl({ kind: "account", section: "profile" }, current);
  const back = websiteRouteUrl({ kind: "workbench" }, new URL(settings, origin));
  expect(parseWorkbenchLocation(new URL(back, origin))).toEqual({
    view: "settings",
    section: "models",
  });
  expect(back).not.toContain("private");
  expect(parseWorkbenchLocation(new URL("/?view=panel&section=administrator", origin))).toEqual({
    view: "chat",
    section: "overview",
  });
});

test("a public capability cannot select the credential destination or another installation", () => {
  expect(matchesWebsiteTarget(capability, target, origin)).toBe(true);
  for (const changes of [
    { cloudOrigin: "https://evil.invalid" },
    { accountOrigin: "https://evil.invalid" },
    { installationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  ])
    expect(matchesWebsiteTarget({ ...capability, ...changes }, target, origin)).toBe(false);
  expect(matchesWebsiteTarget(capability, target, "https://different.invalid")).toBe(false);
});

test("a Cloud cookie from another account or installation cannot mount the workbench", () => {
  const reply = {
    authenticated: true,
    mode: "cloud-account",
    session: {
      id,
      kind: "cloud-management",
      audience: origin,
      installationId: id,
      accountOrigin: origin,
      accountId: id,
      managementEpoch: id,
      expiresAt: Date.now() + 600000,
    },
  };
  expect(parseWebsiteCloudSession(reply, target, id)).toEqual(reply.session);
  for (const changes of [
    { accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { audience: "https://evil.invalid" },
    { installationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { expiresAt: 1 },
    { kind: "account" },
  ])
    expect(() =>
      parseWebsiteCloudSession({ ...reply, session: { ...reply.session, ...changes } }, target, id),
    ).toThrow();
  expect(() => parseWebsiteCloudSession({ ...reply, mode: undefined }, target, id)).toThrow();
});

test("website Account DTOs reject malformed roles, identities and expired authority", () => {
  expect(parseAccountSession(webSession()).account).toEqual(account);
  expect(
    parseAccountSession({
      authenticated: false,
      refreshRequired: false,
      cloudTarget: { enabled: false },
    }).authenticated,
  ).toBe(false);
  for (const changes of [
    { account: { ...account, role: "owner" } },
    { session: { id, expiresAt: 1 } },
    { csrfToken: "invalid" },
    { cloudTarget: { ...target, cloudOrigin: "https://user:secret@evil.invalid" } },
  ])
    expect(() => parseAccountSession({ ...webSession(), ...changes })).toThrow();
  expect(() =>
    parseAccountOverview(
      {
        account,
        security: { hasPassword: true, githubLinked: false },
        capabilities: { sessions: true, passwordChange: true, admin: true, links: false },
        stats: { activeSessions: 1, loginMethods: 1 },
      },
      id,
    ),
  ).toThrow();
});

test("cookie Account requests have fixed paths, CSRF and bounded polling without root credentials", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new AccountWebClient((async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ ok: true });
  }) as typeof fetch);
  await expect(client.request("/profile", "PATCH", {})).rejects.toThrow("页面验证");
  client.setCsrf("C".repeat(43));
  await client.request("/profile", "PATCH", { displayName: "字面昵称" });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe("/api/v1/account/web/profile");
  expect(requests[0]!.init?.credentials).toBe("include");
  expect(new Headers(requests[0]!.init?.headers).get("X-CodeShell-CSRF")).toBe("C".repeat(43));
  expect(new Headers(requests[0]!.init?.headers).has("Authorization")).toBe(false);
  for (const path of [
    "https://evil.invalid",
    "//evil.invalid",
    "/../profile",
    "/profile#secret",
    "/profile%2fsecret",
  ])
    await expect(client.request(path)).rejects.toThrow("请求地址");
  expect(requests).toHaveLength(1);
});

test("invalidation fences delayed private responses even when the transport ignores abort", async () => {
  let finish!: (value: Response) => void;
  let signal: AbortSignal | null | undefined;
  const client = new AccountWebClient((async (_url, init) => {
    signal = init?.signal;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  }) as typeof fetch);
  const request = client.request("/profile");
  client.invalidate();
  finish(Response.json({ account }));
  await expect(request).rejects.toThrow("状态已改变");
  expect(signal?.aborted).toBe(true);
});

test("the browser refuses root-token response shapes and only displays fixed errors", async () => {
  const client = new AccountWebClient((async () =>
    Response.json({ accessToken: "private", refreshToken: "private" })) as typeof fetch);
  await expect(client.request("/session")).rejects.toThrow("不支持的授权结果");
  expect(
    accountError(
      { error: "github_login_failed", reason: "provider_timeout", message: "secret" },
      502,
      "/github/poll",
    ).message,
  ).toContain("服务器连接 GitHub 超时");
  expect(
    accountError({ error: "github_login_failed", reason: "provider_timeout" }, 502, "/login")
      .message,
  ).toBe("GitHub 登录未完成，请重新发起登录。");
  for (const body of [
    { error: "constructor", message: "secret" },
    { error: "__proto__", reason: "secret" },
  ])
    expect(accountError(body, 502, "/github/poll").message).toBe("操作未完成，请稍后重试。");
});

test("an expired OAuth receipt cannot invalidate an otherwise valid browser account", async () => {
  const client = new AccountWebClient((async () =>
    Response.json({ error: "invalid_github_receipt" }, { status: 401 })) as typeof fetch);
  let lost = false;
  client.onSessionLost = () => {
    lost = true;
  };
  client.setCsrf("C".repeat(43));
  await expect(
    client.request("/github/cancel", "POST", {
      receipt: "R".repeat(43),
      codeVerifier: "V".repeat(43),
    }),
  ).rejects.toThrow("授权请求已失效");
  expect(lost).toBe(false);
});
