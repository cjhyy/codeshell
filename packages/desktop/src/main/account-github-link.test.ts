import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccountGitHubLinkPreparer } from "./account-github-link.js";
import type { NativeLinkAuthorizationInput } from "./remote-link-manager.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture(options: { available?: boolean; dispatch?: Promise<void> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "account-github-link-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const connectionId = randomUUID();
  const grants = new Map<string, string>();
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(req.url!);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/oauth/token") {
      const grantId = randomUUID();
      grants.set(`access-${grantId}`, grantId);
      res.end(
        JSON.stringify({
          access_token: `access-${grantId}`,
          refresh_token: `refresh-${grantId}`,
          token_type: "Bearer",
          expires_in: 900,
          scope: "github:list_repositories",
        }),
      );
    } else if (req.url === "/api/v1/data/authorization") {
      res.end(
        JSON.stringify({
          version: 1,
          providerId: "github",
          connectionId,
          grantId: grants.get(req.headers.authorization!.replace("Bearer ", "")),
          account: { id: "42", login: "fixture" },
          scopes: ["github:list_repositories"],
          repositories: ["owner/repo"],
        }),
      );
    } else if (req.url === "/oauth/revoke") res.end("{}");
    else res.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const originalFetch = globalThis.fetch;
  // Constrain provider discovery/metadata before importing Core or a Host service.
  globalThis.fetch = Object.assign(
    ((url: string | URL | Request, init?: RequestInit) => {
      if (new URL(url instanceof Request ? url.url : url).origin !== issuer)
        throw new Error("Unexpected network origin in account Link fixture");
      return originalFetch(url, init);
    }) as typeof fetch,
    { preconnect: originalFetch.preconnect },
  );
  cleanups.push(() => {
    globalThis.fetch = originalFetch;
  });
  const [{ CredentialStore, PlaintextCipher }, { createLinkService }] = await Promise.all([
    import("@cjhyy/code-shell-core"),
    import("@cjhyy/code-shell-server/links"),
  ]);
  const store = new CredentialStore(undefined, new PlaintextCipher(), directory);
  let created = 0;
  let opened: NativeLinkAuthorizationInput | undefined;
  let opens = 0;
  let closes = 0;
  let allowed = true;
  const openedSignal = deferred();
  const prepare = createAccountGitHubLinkPreparer({
    createService() {
      created++;
      return createLinkService({
        store,
        reuseRemoteConnection: true,
        remoteLink: () => ({
          issuer,
          clientId: "fixture-client",
          redirectUri: "http://127.0.0.1:4900/link/callback",
        }),
        readRemoteCatalog: async () => (options.available === false ? [] : ["github"]),
      });
    },
    async open(input) {
      opened = input;
      opens++;
      openedSignal.resolve();
      await options.dispatch;
      return {
        close() {
          closes++;
          input.onCancel();
        },
      };
    },
  });
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  const authorized = () => allowed;
  const claim = `${issuer}/oauth/account-link/claim?ticket=${"a".repeat(43)}`;
  function callback(state?: string) {
    const authorization = new URL(opened!.authorizationUrl);
    const url = new URL(opened!.redirectUri);
    url.searchParams.set("state", state ?? authorization.searchParams.get("state")!);
    url.searchParams.set("code", "fixture-code");
    return url.href;
  }
  return {
    prepare,
    store,
    requests,
    controller,
    authorized,
    claim,
    callback,
    async waitForOpen(count = 1) {
      await openedSignal.promise;
      for (let tries = 0; opens < count && tries < 100; tries++)
        await new Promise((resolve) => setTimeout(resolve, 1));
      expect(opens).toBe(count);
    },
    revoke() {
      allowed = false;
    },
    get opened() {
      return opened!;
    },
    get created() {
      return created;
    },
    get closes() {
      return closes;
    },
  };
}

test("account Link preparation is lazy and adoption uses the original native OAuth callback", async () => {
  const f = await fixture();
  expect(f.created).toBe(0);
  const prepared = await f.prepare(f.controller.signal, f.authorized);
  expect(f.created).toBe(1);
  expect(f.opened).toBeUndefined();
  expect(f.requests).toEqual([]);
  expect(f.store.list()).toEqual([]);
  expect(Object.keys(prepared).sort()).toEqual(["authorizationUrl", "cancel", "continue"]);
  const continuation = prepared.continue(f.claim);
  await f.waitForOpen();
  expect(f.opened.authorizationUrl).toBe(prepared.authorizationUrl);
  expect(f.opened.navigationUrl).toBe(f.claim);
  expect(f.store.list()).toEqual([]);
  expect(await f.opened.onCallback(f.callback())).toBe(true);
  expect(await continuation).toBe("connected");
  expect(f.store.list()).toHaveLength(1);
  expect(f.store.list()[0]?.meta).toMatchObject({
    linkProvider: "github",
    linkExecutionRuntime: "server",
  });
  expect(f.requests).toEqual(["/oauth/token", "/api/v1/data/authorization"]);
  expect(f.closes).toBe(1);
  expect(JSON.stringify(prepared)).not.toContain("refresh-");
  prepared.cancel();
  expect(f.closes).toBe(1);
});

test("repeated account login adopts a fresh grant into the same user Link connection", async () => {
  const f = await fixture();
  const first = await f.prepare(f.controller.signal, f.authorized);
  const firstContinuation = first.continue(f.claim);
  await f.waitForOpen();
  expect(await f.opened.onCallback(f.callback())).toBe(true);
  expect(await firstContinuation).toBe("connected");
  const original = f.store.list()[0]!;
  f.store.save("user", { ...original, label: "Saved GitHub" });
  const second = await f.prepare(f.controller.signal, f.authorized);
  expect(second.authorizationUrl).not.toBe(first.authorizationUrl);
  const secondContinuation = second.continue(f.claim);
  await f.waitForOpen(2);
  expect(await f.opened.onCallback(f.callback())).toBe(true);
  expect(await secondContinuation).toBe("connected");
  expect(f.store.list()).toHaveLength(1);
  expect(f.store.list()[0]).toMatchObject({ id: original.id, label: "Saved GitHub" });
  expect(f.store.list()[0]!.secret).not.toBe(original.secret);
  expect(f.requests.filter((path) => path === "/oauth/revoke")).toHaveLength(1);
});

test("one prepared account Link flow is reserved until explicit cancellation", async () => {
  const f = await fixture();
  const prepared = await f.prepare(f.controller.signal, f.authorized);
  await expect(f.prepare(f.controller.signal, f.authorized)).rejects.toThrow("当前");
  prepared.cancel();
  prepared.cancel();
  expect(await prepared.continue(f.claim)).toBe("cancelled");
  const next = await f.prepare(f.controller.signal, f.authorized);
  next.cancel();
  expect(f.created).toBe(2);
  expect(f.opened).toBeUndefined();
  expect(f.requests).toEqual([]);
  expect(f.store.list()).toEqual([]);
});

test("missing trusted GitHub provider configuration fails before opening or writing", async () => {
  const f = await fixture({ available: false });
  await expect(f.prepare(f.controller.signal, f.authorized)).rejects.toThrow("尚未配置");
  expect(f.opened).toBeUndefined();
  expect(f.requests).toEqual([]);
  expect(f.store.list()).toEqual([]);
});

test.each(["abort", "owner", "bad-state"] as const)(
  "account Link %s before callback cannot exchange a code or save credentials",
  async (scenario) => {
    const f = await fixture();
    const prepared = await f.prepare(f.controller.signal, f.authorized);
    const continuing = prepared.continue(f.claim);
    await f.waitForOpen();
    if (scenario === "abort") f.controller.abort();
    if (scenario === "owner") f.revoke();
    expect(
      await f.opened.onCallback(f.callback(scenario === "bad-state" ? "foreign" : undefined)),
    ).toBe(false);
    if (scenario === "bad-state") await expect(continuing).rejects.toThrow("未完成");
    else expect(await continuing).toBe("cancelled");
    expect(f.requests).toEqual([]);
    expect(f.store.list()).toEqual([]);
  },
);

test("abort while native browser dispatch waits closes its eventual handle", async () => {
  const dispatch = deferred();
  const f = await fixture({ dispatch: dispatch.promise });
  const prepared = await f.prepare(f.controller.signal, f.authorized);
  const continuing = prepared.continue(f.claim);
  await f.waitForOpen();
  f.controller.abort();
  expect(f.opened.signal?.aborted).toBe(true);
  dispatch.resolve();
  expect(await continuing).toBe("cancelled");
  expect(f.closes).toBe(1);
  expect(f.requests).toEqual([]);
  expect(f.store.list()).toEqual([]);
});

test("foreign claim navigation fails before native dispatch and releases the reservation", async () => {
  const f = await fixture();
  const prepared = await f.prepare(f.controller.signal, f.authorized);
  await expect(prepared.continue(f.claim.replace("127.0.0.1", "attacker.example"))).rejects.toThrow(
    "地址无效",
  );
  expect(f.opened).toBeUndefined();
  expect(f.requests).toEqual([]);
  expect(f.store.list()).toEqual([]);
  const next = await f.prepare(f.controller.signal, f.authorized);
  next.cancel();
});
