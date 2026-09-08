import { afterEach, describe, expect, test } from "bun:test";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHubAuth, HUB_SESSION_COOKIE, type HubAuthOptions } from "./auth-http.js";
import { handlePanelProcessDirectory } from "../panels/process-files.js";

const directories: string[] = [];
const servers: Server[] = [];
const credentials = { username: "admin", password: "correct-horse-battery", deviceName: "Laptop" };

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(options: Partial<HubAuthOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "hub-auth-http-"));
  directories.push(dataDir);
  const revoked: string[] = [];
  const auth = await createHubAuth({ dataDir, onRevoke: (id) => revoked.push(id), ...options });
  const server = createServer((req, res) => {
    void auth.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  async function api(
    path: string,
    method = "GET",
    body?: unknown,
    cookie?: string,
    headers: Record<string, string> = {},
  ) {
    return fetch(`${origin}/api/v1/auth/${path}`, {
      method,
      headers: {
        Origin: options.publicOrigin ?? origin,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  return { auth, revoked, api, origin };
}

function cookieFrom(response: Response): string {
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

describe("Hub authentication HTTP", () => {
  test("requires HTTPS for external origins and rejects unconfigured non-loopback hosts", async () => {
    await expect(start({ publicOrigin: "http://hub.example.com" })).rejects.toThrow("HTTPS");
    const { auth, api, origin } = await start();
    const body = { ...credentials, token: auth.bootstrapToken };
    expect(
      (
        await api("setup", "POST", body, undefined, {
          Host: "evil.example.com",
          Origin: "http://evil.example.com",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${origin}/api/v1/auth/setup`, {
          method: "POST",
          headers: { Host: "evil.example.com", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(403);
  });

  test("initializes, restores cookie and bearer sessions, rotates login, lists devices, revokes and logs out", async () => {
    const { auth, revoked, api } = await start();
    expect(await (await api("status")).json()).toEqual({
      initialized: false,
      authenticated: false,
    });
    expect((await api("sessions")).status).toBe(401);
    const setup = await api("setup", "POST", { ...credentials, token: auth.bootstrapToken });
    expect(setup.status).toBe(200);
    const firstCookie = cookieFrom(setup);
    const firstSession = (await setup.json()).session;
    expect(setup.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    expect(setup.headers.get("cache-control")).toBe("no-store");
    expect(firstSession).not.toHaveProperty("tokenHash");
    const bearer = firstCookie.slice(HUB_SESSION_COOKIE.length + 1);
    expect(
      (
        await (
          await api("status", "GET", undefined, undefined, { Authorization: `Bearer ${bearer}` })
        ).json()
      ).authenticated,
    ).toBe(true);
    expect(
      (
        await (
          await api("status", "GET", undefined, firstCookie, { Authorization: "Bearer invalid" })
        ).json()
      ).authenticated,
    ).toBe(false);
    const login = await api("login", "POST", credentials, firstCookie);
    expect(login.status).toBe(200);
    const secondCookie = cookieFrom(login);
    const secondSession = (await login.json()).session;
    expect(secondCookie).not.toBe(firstCookie);
    expect(revoked).toEqual([firstSession.id]);
    expect((await (await api("status", "GET", undefined, firstCookie)).json()).authenticated).toBe(
      false,
    );
    const other = await api("login", "POST", { ...credentials, deviceName: "Phone" });
    const otherCookie = cookieFrom(other);
    const otherSession = (await other.json()).session;
    const listed = (await (await api("sessions", "GET", undefined, secondCookie)).json()).sessions;
    expect(listed).toHaveLength(2);
    expect(listed.find((row: any) => row.id === secondSession.id).current).toBe(true);
    expect(listed.find((row: any) => row.id === otherSession.id).current).toBe(false);
    expect(
      (await api(`sessions/${otherSession.id}`, "DELETE", undefined, secondCookie)).status,
    ).toBe(200);
    expect(revoked).toContain(otherSession.id);
    expect((await api("sessions", "GET", undefined, otherCookie)).status).toBe(401);
    const logout = await api("logout", "POST", {}, secondCookie);
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(revoked).toContain(secondSession.id);
    expect((await api("sessions", "GET", undefined, secondCookie)).status).toBe(401);
  });

  test("rejects cross-origin writes and HTML forms, using configured origin behind HTTPS proxy", async () => {
    const { auth, api, origin } = await start({ publicOrigin: "https://hub.example.com" });
    const body = { ...credentials, token: auth.bootstrapToken };
    expect(
      (await api("setup", "POST", body, undefined, { Origin: "https://evil.example.com" })).status,
    ).toBe(403);
    expect((await api("setup", "POST", body, undefined, { Origin: "null" })).status).toBe(403);
    expect((await api("setup", "POST", body, undefined, { Origin: origin })).status).toBe(403);
    expect(
      (
        await fetch(`${origin}/api/v1/auth/setup`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "text/plain" },
        })
      ).status,
    ).toBe(415);
    const setup = await api("setup", "POST", body);
    expect(setup.status).toBe(200);
    expect(setup.headers.get("set-cookie")).toContain("; Secure");
    const cookie = cookieFrom(setup);
    const id = (await setup.json()).session.id;
    expect(
      (
        await api(`sessions/${id}`, "DELETE", undefined, cookie, {
          Origin: "https://evil.example.com",
        })
      ).status,
    ).toBe(403);
    expect(
      (await api("logout", "POST", {}, cookie, { "Sec-Fetch-Site": "cross-site" })).status,
    ).toBe(403);
    expect((await api("sessions", "GET", undefined, cookie)).status).toBe(200);
  });

  test("rate limits incorrect login attempts and permits retry after the window", async () => {
    let now = 10_000;
    const { auth, api } = await start({ now: () => now, maxLoginAttempts: 2 });
    await api("setup", "POST", { ...credentials, token: auth.bootstrapToken });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        (await api("login", "POST", { ...credentials, password: "this-is-incorrect" })).status,
      ).toBe(401);
    }
    const limited = await api("login", "POST", credentials);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    now += 60_000;
    expect((await api("login", "POST", credentials)).status).toBe(200);
  });

  test("rejects malformed and oversized JSON, including chunked bodies", async () => {
    const { api, origin } = await start();
    expect((await api("setup", "POST", null)).status).toBe(400);
    expect((await api("setup", "POST", {})).status).toBe(400);
    expect((await api("setup", "POST", { padding: "x".repeat(9_000) })).status).toBe(413);
    const chunkedStatus = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${origin}/api/v1/auth/setup`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: origin,
            "Transfer-Encoding": "chunked",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject);
      req.write('{"padding":"');
      req.write("x".repeat(9_000));
      req.end('"}');
    });
    expect(chunkedStatus).toBe(413);
  });

  test("expired sessions fail and corrupt state returns a generic error without reopening setup", async () => {
    let now = 10_000;
    const { auth, api } = await start({ now: () => now, sessionTtlMs: 1_000 });
    const setup = await api("setup", "POST", { ...credentials, token: auth.bootstrapToken });
    const cookie = cookieFrom(setup);
    now += 1_000;
    expect((await api("sessions", "GET", undefined, cookie)).status).toBe(401);
    writeFileSync(auth.store.filePath, "broken-secret-store");
    const status = await api("status");
    expect(status.status).toBe(503);
    expect(await status.json()).toEqual({ error: "Authentication service unavailable" });
    expect(
      (await api("setup", "POST", { ...credentials, token: auth.bootstrapToken })).status,
    ).toBe(503);
  });

  test("initialization stays single-use and unknown routes never bypass auth", async () => {
    const { auth, api, origin } = await start();
    const body = { ...credentials, token: auth.bootstrapToken };
    await api("setup", "POST", body);
    expect((await api("setup", "POST", body)).status).toBe(409);
    expect((await api("unknown")).status).toBe(401);
    expect((await fetch(`${origin}/not-an-auth-route`)).status).toBe(404);
  });
});

test("origin-less top-level read navigation is allowed without weakening writes, fetches or explicit Origin checks", async () => {
  const { auth, origin } = await start();
  const headers = {
    host: new URL(origin).host,
    "sec-fetch-site": "none",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  };
  const allows = (method: string, extra: Record<string, string | undefined> = {}) =>
    auth.isOriginAllowed({
      method,
      headers: { ...headers, ...extra },
      socket: {},
    } as unknown as IncomingMessage);
  expect(allows("GET")).toBe(true);
  expect(allows("HEAD")).toBe(true);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    expect(allows(method)).toBe(false);
  expect(allows("GET", { origin: "https://evil.example" })).toBe(false);
  expect(allows("GET", { origin: "null" })).toBe(false);
  expect(allows("GET", { "sec-fetch-site": "cross-site" })).toBe(false);
  expect(allows("GET", { "sec-fetch-site": "same-site" })).toBe(false);
  expect(allows("GET", { "sec-fetch-mode": "cors" })).toBe(false);
  expect(allows("GET", { "sec-fetch-mode": "websocket", "sec-fetch-dest": "empty" })).toBe(false);
  expect(allows("GET", { "sec-fetch-dest": "iframe" })).toBe(false);
  expect(allows("GET", { "sec-fetch-mode": undefined })).toBe(false);
  expect(allows("GET", { host: "evil.example" })).toBe(false);
  const proxy = await start({ publicOrigin: "https://hub.example.com" });
  expect(
    proxy.auth.isOriginAllowed({
      method: "GET",
      headers: { ...headers, host: "localhost:9000" },
      socket: {},
    } as unknown as IncomingMessage),
  ).toBe(true);
});

function rawNavigation(url: string, method: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: Buffer; headers: IncomingMessage["headers"] }>(
    (resolve, reject) => {
      const operation = request(url, { method, headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      });
      operation.once("error", reject);
      operation.end();
    },
  );
}

test("authenticated browser navigation opens the Hub process directory and downloads with the same cookie", async () => {
  const { auth, api } = await start();
  const setup = await api("setup", "POST", { ...credentials, token: auth.bootstrapToken });
  expect(setup.status).toBe(200);
  const cookie = cookieFrom(setup);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hub-browser-download-")));
  directories.push(root);
  const bytes = Buffer.alloc(20 * 1024, 0x61);
  writeFileSync(join(root, "browser-video.mp4"), bytes);
  const baseUrl = "/api/v1/panels/runtime/browser-panel/directory/output-grant";
  const server = createServer((req, res) => {
    void (async () => {
      if (!auth.isOriginAllowed(req)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (!(await auth.authenticate(req))) {
        res.writeHead(401);
        res.end();
        return;
      }
      await handlePanelProcessDirectory(req, res, {
        root,
        baseUrl,
        isAuthorized: async () => !!(await auth.authenticate(req)),
      });
    })();
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const navigation = {
    Cookie: cookie,
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-User": "?1",
  };
  const listing = await rawNavigation(origin + baseUrl, "GET", navigation);
  expect(listing.status).toBe(200);
  expect(listing.body.toString()).toContain("browser-video.mp4");
  const fileUrl = origin + baseUrl + "?file=browser-video.mp4";
  const download = await rawNavigation(fileUrl, "GET", navigation);
  expect(download.status).toBe(200);
  expect(download.body).toEqual(bytes);
  expect(download.headers["content-disposition"]).toContain("attachment");
  const head = await rawNavigation(fileUrl, "HEAD", navigation);
  expect(head.status).toBe(200);
  expect(head.headers["content-length"]).toBe(String(bytes.length));
  expect(head.body.length).toBe(0);
  expect(
    (await rawNavigation(fileUrl, "GET", { ...navigation, Origin: "https://evil.example" })).status,
  ).toBe(403);
  expect(
    (await rawNavigation(fileUrl, "GET", { ...navigation, "Sec-Fetch-Site": "cross-site" })).status,
  ).toBe(403);
  expect((await rawNavigation(fileUrl, "POST", navigation)).status).toBe(403);
  expect((await rawNavigation(fileUrl, "GET", { ...navigation, Cookie: "" })).status).toBe(401);
});
