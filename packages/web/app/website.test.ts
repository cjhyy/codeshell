import { afterEach, expect, test } from "bun:test";
import {
  AccountWebClient,
  accountError,
  parseAccountSession,
  parseAccountOverview,
  validWebsiteProfile,
  validWebsiteAccount,
} from "./account-api.js";
import {
  detectWebsiteCloud,
  matchesWebsiteTarget,
  parseWebsiteCloudSession,
} from "./website-cloud.js";
import {
  isRegistrationRoute,
  isPublicWebsiteOrigin,
  safeWebsiteReturn,
  parseWebsiteRoute,
  websiteRouteUrl,
  parseWorkbenchLocation,
} from "./website-routes.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const origin = "https://cloud.fixture.invalid";
const target = { cloudOrigin: origin, accountOrigin: origin, installationId: id };
const account = { id, username: "fixture-user", displayName: "测试昵称", role: "member" as const };
const overview = {
  account,
  security: { hasPassword: true, githubLinked: false },
  capabilities: { sessions: true, passwordChange: true, admin: false, links: false },
  stats: { activeSessions: 1, loginMethods: 1 },
  features: {},
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
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else delete (globalThis as any).navigator;
});
function installCookieLock() {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: (_name: string, _options: unknown, work: () => Promise<unknown>) => work(),
      },
    },
  });
}

test("only the official HTTPS origins enable the public website", () => {
  for (const value of ["https://codeshell.site", "https://www.codeshell.site"])
    expect(isPublicWebsiteOrigin(new URL(value))).toBe(true);
  for (const value of [
    "http://localhost",
    "https://cloud.fixture.invalid",
    "http://codeshell.site",
    "https://codeshell.site.evil.invalid",
    "https://codeshell.site:8443",
  ])
    expect(isPublicWebsiteOrigin(new URL(value))).toBe(false);
  expect(
    websiteRouteUrl(
      { kind: "workbench" },
      new URL("https://codeshell.site/settings/account/profile"),
    ),
  ).toBe("/app");
});

test("website login destinations reject external URLs, unknown routes and credential queries", () => {
  const origin = "https://codeshell.site";
  for (const destination of [
    null,
    "https://evil.invalid",
    "//evil.invalid",
    "/\\evil.invalid",
    "javascript:alert(1)",
    "/login",
    "/desktop-login?request=secret",
    "/api/v1/account/web/logout",
    "/app#secret",
    "/app\n",
  ])
    expect(safeWebsiteReturn(destination, origin)).toBe("/app");
  expect(
    safeWebsiteReturn(
      `/app?project=${id}&session=chat_123&view=settings&section=models&token=secret&returnTo=https://evil.invalid`,
      origin,
    ),
  ).toBe(`/app?project=${id}&session=chat_123&view=settings&section=models`);
  expect(safeWebsiteReturn("/settings/account/security?accessToken=secret", origin)).toBe(
    "/settings/account/security",
  );
  expect(safeWebsiteReturn("/admin/users", origin)).toBe("/admin/users");
  expect(safeWebsiteReturn("/admin?token=secret", origin)).toBe("/admin/summary");
  expect(safeWebsiteReturn("/admin/", origin)).toBe("/admin/summary");
  expect(safeWebsiteReturn("/settings/account/not-real", origin)).toBe("/app");
});

test("profile DTOs carry display fields while account authority still requires a valid role", () => {
  const profile = { id, username: account.username, displayName: account.displayName };
  expect(validWebsiteProfile(profile)).toBe(true);
  expect(validWebsiteAccount(profile)).toBe(false);
  expect(() => parseAccountSession({ ...webSession(), account: profile })).toThrow();
  expect(() => parseAccountOverview({ ...overview, account: profile }, id)).toThrow();
  for (const invalid of [
    { ...profile, id: "invalid" },
    { ...profile, username: "bad username" },
    { ...profile, displayName: null },
    { ...profile, displayName: "" },
    { ...profile, displayName: "\u0000" },
  ])
    expect(validWebsiteProfile(invalid)).toBe(false);
});

test("account settings and administrator URLs restore the selected page and preserve only public project context", () => {
  for (const section of ["profile", "security", "sessions", "connections"] as const)
    expect(parseWebsiteRoute(new URL(`/settings/account/${section}`, origin))).toEqual({
      kind: "account",
      section,
    });
  for (const path of ["/admin", "/admin/"])
    expect(parseWebsiteRoute(new URL(path, origin))).toEqual({ kind: "admin", section: "summary" });
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

test("Passkey business 401s preserve the account and never replay one-use requests", async () => {
  for (const [path, code] of [
    ["/passkeys/registration/options", "passkey_bootstrap_required"],
    ["/passkeys/registration/verify", "passkey_ceremony_expired"],
    ["/passkeys/registration/verify", "passkey_verification_failed"],
    ["/passkeys/authentication/verify", "passkey_verification_failed"],
    ["/passkeys/registration/options", "passkey_required"],
    ["/passkeys/bootstrap/password", "invalid_credentials"],
    ["/browser/approve", "passkey_required"],
  ]) {
    const calls: string[] = [];
    const client = new AccountWebClient((async (url) => {
      calls.push(String(url));
      return Response.json({ error: code }, { status: 401 });
    }) as typeof fetch);
    client.setSession(parseAccountSession(webSession()));
    let lost = 0;
    client.onSessionLost = () => lost++;
    await expect(client.request(path!, "POST", { ceremonyId: "one-use" })).rejects.toMatchObject({
      code,
      status: 401,
    });
    expect(calls).toEqual(["/api/v1/account/web" + path]);
    expect(lost).toBe(0);
  }
});

test("Passkey requests retry only a pre-ceremony authentication rejection with the same restored root", async () => {
  installCookieLock();
  const calls: string[] = [];
  const client = new AccountWebClient((async (url) => {
    const path = String(url).replace("/api/v1/account/web", "");
    calls.push(path);
    if (path === "/session")
      return Response.json({
        authenticated: false,
        refreshRequired: true,
        csrfToken: "C".repeat(43),
        cloudTarget: { enabled: false },
      });
    if (path === "/refresh") return Response.json(webSession());
    return calls.length === 1
      ? Response.json({ error: "authentication_required" }, { status: 401 })
      : Response.json({ verified: true });
  }) as typeof fetch);
  client.setSession(parseAccountSession(webSession()));
  let lost = 0;
  client.onSessionLost = () => lost++;
  await expect(client.request("/passkeys/registration/verify", "POST", {})).resolves.toEqual({
    verified: true,
  });
  expect(calls).toEqual([
    "/passkeys/registration/verify",
    "/session",
    "/refresh",
    "/passkeys/registration/verify",
  ]);
  expect(lost).toBe(0);
});

test("expired roots and unknown Passkey 401s fail closed without replaying the ceremony", async () => {
  installCookieLock();
  for (const code of ["authentication_required", "invalid_session", "unknown_rejection"]) {
    const calls: string[] = [];
    const client = new AccountWebClient((async (url) => {
      const path = String(url).replace("/api/v1/account/web", "");
      calls.push(path);
      return path === "/session"
        ? Response.json({
            authenticated: false,
            refreshRequired: false,
            cloudTarget: { enabled: false },
          })
        : Response.json({ error: code }, { status: 401 });
    }) as typeof fetch);
    client.setSession(parseAccountSession(webSession()));
    let lost = 0;
    client.onSessionLost = () => lost++;
    await expect(client.request("/passkeys/registration/verify", "POST", {})).rejects.toMatchObject(
      { code },
    );
    expect(calls).toEqual(
      code === "unknown_rejection"
        ? ["/passkeys/registration/verify"]
        : ["/passkeys/registration/verify", "/session"],
    );
    expect(lost).toBe(1);
  }
});

test("a Passkey rejection after safe authentication recovery keeps its original error and login", async () => {
  installCookieLock();
  for (const code of ["passkey_verification_failed", "invalid_session"]) {
    let verifications = 0,
      lost = 0;
    const client = new AccountWebClient((async (url) => {
      if (String(url).endsWith("/session")) return Response.json(webSession());
      return Response.json(
        { error: ++verifications === 1 ? "authentication_required" : code },
        { status: 401 },
      );
    }) as typeof fetch);
    client.setSession(parseAccountSession(webSession()));
    client.onSessionLost = () => lost++;
    await expect(client.request("/passkeys/registration/verify", "POST", {})).rejects.toMatchObject(
      { code },
    );
    expect(verifications).toBe(2);
    expect(lost).toBe(0);
  }
});

test("an access token expiring during a Passkey ceremony reconciles the account without replay", async () => {
  installCookieLock();
  for (const sessionResponse of ["valid", "unavailable"] as const) {
    const calls: string[] = [];
    const client = new AccountWebClient((async (url) => {
      const path = String(url).replace("/api/v1/account/web", "");
      calls.push(path);
      if (path === "/session") {
        if (sessionResponse === "unavailable") throw new TypeError("Owned network interruption");
        return Response.json(webSession());
      }
      return Response.json({ error: "invalid_session" }, { status: 401 });
    }) as typeof fetch);
    client.setSession(parseAccountSession(webSession()));
    let lost = 0;
    client.onSessionLost = () => lost++;
    await expect(client.request("/passkeys/registration/verify", "POST", {})).rejects.toMatchObject(
      { code: "invalid_session" },
    );
    expect(calls).toEqual(["/passkeys/registration/verify", "/session"]);
    expect(lost).toBe(0);
  }
});

test("Passkey recovery never retries or retains an old login when cookies switch roots", async () => {
  installCookieLock();
  for (const code of ["authentication_required", "invalid_session"]) {
    for (const differentAccount of [false, true]) {
      let verifications = 0,
        lost = 0;
      const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const restored = webSession();
      restored.session.id = otherId;
      if (differentAccount) {
        restored.account = { ...account, id: otherId };
        restored.overview = { ...overview, account: restored.account };
      }
      const client = new AccountWebClient((async (url) => {
        if (String(url).endsWith("/session")) return Response.json(restored);
        verifications++;
        return Response.json({ error: code, message: "private credential value" }, { status: 401 });
      }) as typeof fetch);
      client.setSession(parseAccountSession(webSession()));
      client.onSessionLost = () => lost++;
      const cause = await client
        .request("/passkeys/registration/verify", "POST", {})
        .catch((error: unknown) => error);
      expect(cause).toMatchObject({ code });
      expect((cause as Error).message).not.toContain("private credential");
      expect(verifications).toBe(1);
      expect(lost).toBe(1);
    }
  }
});

test("registration selection uses only the fixed path and ignores untrusted redirect parameters", () => {
  expect(
    isRegistrationRoute(new URL("/register?next=https://evil.invalid#token=secret", origin)),
  ).toBe(true);
  expect(isRegistrationRoute(new URL("/?register=true", origin))).toBe(false);
  expect(isRegistrationRoute(new URL("/register/../../admin", origin))).toBe(false);
});
