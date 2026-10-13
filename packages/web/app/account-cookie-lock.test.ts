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
