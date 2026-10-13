import { afterEach, expect, test } from "bun:test";
import { AccountWebClient, type AccountWebSession } from "./account-api.js";
import { withAccountCookieLock } from "./account-cookie-lock.js";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else delete (globalThis as any).navigator;
});
function installLocks() {
  let queue = Promise.resolve();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request(name: string, options: { mode: string }, operation: () => Promise<unknown>) {
          expect(name).toBe("codeshell:account-web:cookie-v1");
          expect(options.mode).toBe("exclusive");
          const current = queue.then(operation);
          queue = current.then(
            () => {},
            () => {},
          );
          return current;
        },
      },
    },
  });
}
const rootA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  rootB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function snapshot(id = rootA, expiresAt = Date.now() + 600000): AccountWebSession {
  const account = {
    id,
    username: "fixture-user",
    displayName: "测试账号",
    role: "member" as const,
  };
  return {
    authenticated: true,
    csrfToken: "C".repeat(43),
    cloudTarget: null,
    account,
    session: { id, expiresAt },
    overview: {
      account,
      security: { hasPassword: true, githubLinked: false },
      capabilities: { sessions: true, passwordChange: true, admin: false, links: false },
      stats: { activeSessions: 1, loginMethods: 1 },
    },
  };
}
const anonymous = { authenticated: false, refreshRequired: false, cloudTarget: { enabled: false } };
function grant(id = rootA) {
  return {
    account: { id },
    sessionId: id,
    accessToken: "A".repeat(43),
    refreshToken: "R".repeat(43),
    accessTokenExpiresAt: Date.now() + 600000,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("two tabs re-read cookies under one origin lock and redeem a refresh credential only once", async () => {
  installLocks();
  let refreshRequired = true,
    refreshes = 0;
  const fetcher = (async (url, init) => {
    if (String(url).endsWith("/session"))
      return Response.json(
        refreshRequired
          ? { ...anonymous, refreshRequired: true, csrfToken: "C".repeat(43) }
          : snapshot(),
      );
    expect(String(url)).toBe("/api/v1/account/web/refresh");
    expect(init?.method).toBe("POST");
    refreshes++;
    await Promise.resolve();
    refreshRequired = false;
    return Response.json(snapshot());
  }) as typeof fetch;
  const tabs = [new AccountWebClient(fetcher), new AccountWebClient(fetcher)];
  const results = await Promise.all(tabs.map((tab) => tab.restoreSession()));
  expect(refreshes).toBe(1);
  expect(results.every((value) => value.authenticated && value.session?.id === rootA)).toBe(true);
});

test("logout waits for an in-flight cookie rotation and uses its final cookie state", async () => {
  installLocks();
  const entered = deferred<void>(),
    release = deferred<Response>();
  const posts: string[] = [];
  let refreshed = false;
  const client = new AccountWebClient((async (url, init) => {
    const path = String(url);
    if (path.endsWith("/session"))
      return Response.json(snapshot(rootA, Date.now() + (refreshed ? 600000 : 10000)));
    posts.push(path);
    if (path.endsWith("/refresh")) {
      entered.resolve();
      const response = await release.promise;
      refreshed = true;
      return response;
    }
    expect(path).toBe("/api/v1/account/web/logout");
    expect(new Headers(init?.headers).get("X-CodeShell-CSRF")).toBe("C".repeat(43));
    return Response.json({ ok: true });
  }) as typeof fetch);
  client.setSession(snapshot());
  const refresh = client.restoreSession(60000);
  await entered.promise;
  const logout = client.logoutSession();
  await Promise.resolve();
  expect(posts).toEqual(["/api/v1/account/web/refresh"]);
  release.resolve(Response.json(snapshot()));
  await refresh;
  expect((await logout).authenticated).toBe(false);
  expect(posts).toEqual(["/api/v1/account/web/refresh", "/api/v1/account/web/logout"]);
});

test("a stale tab cannot sign out or delete the current session of a newly selected account", async () => {
  installLocks();
  let writes = 0;
  const client = new AccountWebClient((async (_url, init) => {
    if (init?.method !== "GET") writes++;
    return Response.json(snapshot(rootB));
  }) as typeof fetch);
  client.setSession(snapshot(rootA));
  await expect(client.logoutSession()).rejects.toThrow("其他页面已切换账号");
  client.setSession(snapshot(rootA));
  await expect(client.request(`/sessions/${rootA}`, "DELETE")).rejects.toThrow("账号状态已改变");
  expect(writes).toBe(0);
});

test("a login cancelled during cookie exchange revokes its own result before releasing the lock", async () => {
  installLocks();
  const entered = deferred<void>(),
    release = deferred<Response>();
  let live = true;
  const posts: string[] = [];
  const client = new AccountWebClient((async (url, init) => {
    if (init?.method === "GET") return Response.json(anonymous);
    posts.push(String(url));
    if (String(url).endsWith("/session")) {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer " + "A".repeat(43));
      entered.resolve();
      return release.promise;
    }
    expect(String(url)).toBe("/api/v1/account/web/logout");
    return Response.json({ ok: true });
  }) as typeof fetch);
  const exchange = client.exchangeGrant(grant(), () => live);
  await entered.promise;
  live = false;
  release.resolve(Response.json(snapshot()));
  await expect(exchange).rejects.toThrow("账号状态已改变");
  expect(posts).toEqual(["/api/v1/account/web/session", "/api/v1/account/web/logout"]);
});

test("unsupported cross-tab locking fails closed before cookie mutation", async () => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  let ran = false;
  await expect(
    withAccountCookieLock(async () => {
      ran = true;
    }),
  ).rejects.toThrow("浏览器不支持");
  expect(ran).toBe(false);
});

test("an OAuth result started before another tab signed in cannot replace the new browser account", async () => {
  installLocks();
  const writes: string[] = [];
  const client = new AccountWebClient((async (url, init) => {
    if (init?.method === "POST") {
      writes.push(String(url));
      return Response.json({ ok: true });
    }
    return Response.json(snapshot(rootB));
  }) as typeof fetch);
  await expect(client.exchangeGrant(grant(rootA), () => true)).rejects.toThrow(
    "其他页面已切换账号",
  );
  expect(writes).toEqual(["/api/v1/account/logout"]);
});

test("a delayed 401 cannot retry an old profile write or clear the newer root", async () => {
  installLocks();
  const entered = deferred<void>(),
    late = deferred<Response>();
  const writes: string[] = [];
  const client = new AccountWebClient((async (_url, init) => {
    if (init?.method === "PATCH") {
      writes.push(new Headers(init.headers).get("X-CodeShell-CSRF")!);
      if (writes.length === 1) {
        entered.resolve();
        return late.promise;
      }
      return Response.json({ account: snapshot(rootB).account });
    }
    return Response.json({ ...snapshot(rootB), csrfToken: "D".repeat(43) });
  }) as typeof fetch);
  let lost = false;
  client.onSessionLost = () => {
    lost = true;
  };
  client.setSession(snapshot(rootA));
  const pending = client
    .request("/profile", "PATCH", { displayName: "A 的旧编辑" })
    .catch((cause) => cause);
  await entered.promise;
  client.setSession({ ...snapshot(rootB), csrfToken: "D".repeat(43) });
  late.resolve(Response.json({ error: "authentication_required" }, { status: 401 }));
  await pending;
  expect(writes).toEqual(["C".repeat(43)]);
  expect(lost).toBe(false);
});

test("cancelling a completed exchange resets client authority for the next anonymous sign-in", async () => {
  installLocks();
  const entered = deferred<void>(),
    release = deferred<Response>();
  let live = true,
    exchanges = 0;
  let current: unknown = anonymous;
  const client = new AccountWebClient((async (url, init) => {
    if (init?.method === "GET") return Response.json(current);
    if (String(url) === "/api/v1/account/web/session") {
      exchanges++;
      if (exchanges === 1) {
        entered.resolve();
        const response = await release.promise;
        current = snapshot(rootA);
        return response;
      }
      current = snapshot(rootB);
      return Response.json(current);
    }
    if (String(url) === "/api/v1/account/web/logout") {
      current = anonymous;
      return Response.json({ ok: true });
    }
    return Response.json({ ok: true });
  }) as typeof fetch);
  const cancelled = client.exchangeGrant(grant(rootA), () => live).catch((cause) => cause);
  await entered.promise;
  live = false;
  release.resolve(Response.json(snapshot(rootA)));
  await cancelled;
  expect((await client.exchangeGrant(grant(rootB), () => true)).session?.id).toBe(rootB);
});
