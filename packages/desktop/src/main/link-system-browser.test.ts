import { afterEach, expect, test } from "bun:test";
import { createServer, request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { createLinkLoopbackCallbackBroker } from "./link-loopback-callback.js";
import { createSystemBrowserLinkAuthorization } from "./link-system-browser.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
const nonce = () => randomBytes(32).toString("base64url");
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function fixture(now?: () => number) {
  const port = await freePort();
  const redirectUri = `http://127.0.0.1:${port}/link/callback`;
  const callbacks = createLinkLoopbackCallbackBroker({ port, now });
  cleanups.push(() => callbacks.close());
  const state = nonce();
  const registration = {
    redirectUri,
    state,
    expiresAt: Date.now() + 60_000,
    onCallback: (_url: string): boolean | Promise<boolean> => true,
    onCancel: () => {},
  };
  return {
    port,
    redirectUri,
    callbacks,
    state,
    registration,
    url: (value = state) => `${redirectUri}?state=${value}&code=synthetic`,
    request(path: string, method = "GET", host = `127.0.0.1:${port}`) {
      return new Promise<{ status: number; text: string }>((resolve, reject) => {
        const request = httpRequest(
          { host: "127.0.0.1", port, path, method, headers: { host }, agent: false },
          (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              text += chunk;
            });
            response.on("end", () => resolve({ status: response.statusCode!, text }));
          },
        );
        request.on("error", reject);
        request.end();
      });
    },
  };
}

test("shared loopback isolates states and rejects malformed requests without consuming a flow", async () => {
  const f = await fixture();
  let first = 0,
    second = 0;
  const a = await f.callbacks.register({
    ...f.registration,
    onCallback: () => {
      first++;
      return true;
    },
  });
  const other = nonce();
  await f.callbacks.register({
    ...f.registration,
    state: other,
    onCallback: () => {
      second++;
      return true;
    },
  });
  const path = `/link/callback?state=${f.state}&code=synthetic`;
  for (const invalid of [
    { path, method: "POST", status: 405 },
    { path, host: "attacker.example", status: 400 },
    { path: `/other?state=${f.state}&code=synthetic`, status: 404 },
    { path: `${path}&state=${f.state}`, status: 400 },
    { path: `${path}&code=second`, status: 400 },
    { path: `${path}&error=access_denied`, status: 400 },
    { path: `/link/callback?state=${f.state}`, status: 400 },
    { path: `/link/callback?state=${nonce()}&code=synthetic`, status: 400 },
    { path: "//attacker.example/link/callback", status: 404 },
    { path: `${path}&padding=${"x".repeat(16_384)}`, status: 431 },
  ]) {
    expect((await f.request(invalid.path, invalid.method, invalid.host)).status).toBe(
      invalid.status,
    );
  }
  expect(first).toBe(0);
  expect(second).toBe(0);
  a.close();
  expect((await f.request(path)).status).toBe(400);
  expect((await f.request(`/link/callback?state=${other}&code=synthetic`)).text).toContain(
    "连接已完成",
  );
  expect(first).toBe(0);
  expect(second).toBe(1);
});

test("callback is consumed once and success waits for the owning Host to confirm saving", async () => {
  const f = await fixture();
  const complete = deferred<boolean>();
  const entered = deferred<void>();
  let calls = 0,
    replied = false;
  await f.callbacks.register({
    ...f.registration,
    onCallback: async () => {
      calls++;
      entered.resolve();
      return complete.promise;
    },
  });
  const pending = fetch(f.url()).then(async (response) => {
    replied = true;
    return { status: response.status, text: await response.text() };
  });
  await entered.promise;
  expect(replied).toBe(false);
  expect((await fetch(f.url())).status).toBe(400);
  const another = await f.callbacks.register({ ...f.registration, state: nonce() });
  expect(calls).toBe(1);
  complete.resolve(true);
  expect((await pending).text).toContain("连接已完成");
  another.close();
});

test("provider denial and failed exchange never report a saved connection", async () => {
  const f = await fixture();
  await f.callbacks.register({
    ...f.registration,
    onCallback: (url) => {
      expect(new URL(url).searchParams.get("error")).toBe("access_denied");
      return false;
    },
  });
  const response = await fetch(`${f.redirectUri}?state=${f.state}&error=access_denied`);
  const text = await response.text();
  expect(text).not.toContain("连接已完成");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
});

test("cancel before bind completion and expiry cannot consume a live owner's callback", async () => {
  let now = Date.now();
  const f = await fixture(() => now);
  const abort = new AbortController();
  const cancelled = f.callbacks.register({ ...f.registration, signal: abort.signal });
  abort.abort();
  await expect(cancelled).rejects.toThrow("取消或过期");
  let consumed = false;
  await f.callbacks.register({ ...f.registration, state: nonce() });
  await f.callbacks.register({
    ...f.registration,
    onCallback: () => {
      consumed = true;
      return true;
    },
  });
  now = f.registration.expiresAt + 1;
  expect((await fetch(f.url())).status).toBe(410);
  expect(consumed).toBe(false);
});

test("occupied fixed port fails before browser dispatch and can be retried", async () => {
  const f = await fixture();
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(f.port, "127.0.0.1", resolve));
  cleanups.push(() => blocker.close());
  let opened = 0;
  const open = createSystemBrowserLinkAuthorization({
    callbacks: f.callbacks,
    openExternal: async () => {
      opened++;
    },
  });
  const input = browserInput(f);
  await expect(open(input)).rejects.toThrow("端口被占用");
  expect(opened).toBe(0);
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
  const handle = await open(input);
  expect(opened).toBe(1);
  handle.close();
});

function browserInput(f: Awaited<ReturnType<typeof fixture>>) {
  const authorization = new URL("https://link.example/oauth/authorize");
  authorization.searchParams.set("state", f.state);
  authorization.searchParams.set("redirect_uri", f.redirectUri);
  return {
    authorizationUrl: authorization.href,
    redirectUri: f.redirectUri,
    expiresAt: new Date(f.registration.expiresAt).toISOString(),
    onCallback: f.registration.onCallback,
    onCancel: f.registration.onCancel,
  };
}

test("system browser callback is listening before dispatch and repeated open shares one launch", async () => {
  const f = await fixture();
  const launch = deferred<void>();
  let opened = 0;
  const open = createSystemBrowserLinkAuthorization({
    callbacks: f.callbacks,
    openExternal: async () => {
      opened++;
      expect((await f.request("/not-a-callback")).status).toBe(404);
      if (opened > 1) await launch.promise;
    },
  });
  const handle = await open(browserInput(f));
  const first = handle.focus!(),
    second = handle.focus!();
  expect(opened).toBe(2);
  launch.resolve();
  await Promise.all([first, second]);
  handle.close();
  await handle.focus!();
  expect(opened).toBe(2);
});

test("cancel during browser dispatch prevents reopening and closes the late handle", async () => {
  const f = await fixture();
  const launch = deferred<void>(),
    entered = deferred<void>();
  const abort = new AbortController();
  let calls = 0;
  const open = createSystemBrowserLinkAuthorization({
    callbacks: f.callbacks,
    openExternal: async () => {
      calls++;
      entered.resolve();
      await launch.promise;
    },
  });
  const pending = open({ ...browserInput(f), signal: abort.signal });
  await entered.promise;
  abort.abort();
  launch.resolve();
  const handle = await pending;
  await handle.focus!();
  expect(calls).toBe(1);
  await expect(fetch(f.url(), { signal: AbortSignal.timeout(500) })).rejects.toThrow();
});

test("external launch failure cleans callback custody and plain HTTP is restricted to loopback", async () => {
  const f = await fixture();
  const open = createSystemBrowserLinkAuthorization({
    callbacks: f.callbacks,
    openExternal: async () => {
      throw new Error("dispatch failed");
    },
  });
  await expect(open(browserInput(f))).rejects.toThrow("dispatch failed");
  await expect(fetch(f.url(), { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  await expect(
    open({
      ...browserInput(f),
      authorizationUrl: browserInput(f).authorizationUrl.replace(
        "https://link.example",
        "http://attacker.example",
      ),
    }),
  ).rejects.toThrow("地址无效");
  const local = createSystemBrowserLinkAuthorization({
    callbacks: f.callbacks,
    openExternal: async () => {},
  });
  const handle = await local({
    ...browserInput(f),
    authorizationUrl: browserInput(f).authorizationUrl.replace(
      "https://link.example",
      "http://127.0.0.1:9999",
    ),
  });
  handle.close();
});

test("pure Node HTTP shutdown and listener races pass", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const result = await promisify(execFile)(
    "node",
    [
      // Node 22.16 supports erasable TypeScript behind this explicit flag.
      "--experimental-strip-types",
      fileURLToPath(new URL("./link-loopback-callback.smoke.mjs", import.meta.url)),
    ],
    { timeout: 10_000 },
  );
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    globalClose: true,
    closingRace: true,
  });
});
