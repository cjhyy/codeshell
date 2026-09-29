/** Compiled and run from the isolated tarball consumer, never the source workspace. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as exported from "@cjhyy/code-shell-server/auth";
import {
  createHubAuth,
  HUB_SESSION_COOKIE,
  type HubAuth,
  type HubAuthOptions,
  type HubSession,
} from "@cjhyy/code-shell-server/auth";

assert.deepEqual(Object.keys(exported).sort(), ["HUB_SESSION_COOKIE", "createHubAuth"]);
const dataDir = await mkdtemp(join(tmpdir(), "codeshell-packed-owner-auth-"));
const revoked: string[] = [];
const options: HubAuthOptions = {
  dataDir,
  publicOrigin: "https://owner-auth.example.test",
  onRevoke: (sessionId) => revoked.push(sessionId),
};
let auth: HubAuth;
async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (await auth.handle(request, response)) return;
  if (!auth.isOriginAllowed(request)) {
    response.writeHead(403).end();
    return;
  }
  const session: HubSession | null = await auth.authenticate(request);
  if (!session) {
    response.writeHead(401).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ id: session.id, username: session.username }));
}
const server = createServer((request, response) => {
  void handle(request, response).catch(() => response.writeHead(503).end());
});
try {
  auth = await createHubAuth(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const login = { username: "owner", password: "packed-auth-only-password", deviceName: "First" };
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    cookie?: string,
    headers: Record<string, string> = {},
  ) =>
    fetch(url + path, {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: {
        origin: options.publicOrigin!,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const cookieFrom = (response: Response): string => {
    const value = response.headers.get("set-cookie");
    assert(value);
    assert(value.startsWith(`${HUB_SESSION_COOKIE}=`));
    assert(value.includes("; HttpOnly; SameSite=Strict;"));
    assert(value.includes("; Secure"));
    assert(!/;\s*Domain=/i.test(value));
    return value.split(";", 1)[0]!;
  };

  assert.equal((await request("/owner")).status, 401);
  assert.deepEqual(await (await request("/api/v1/auth/status")).json(), {
    initialized: false,
    authenticated: false,
  });
  const setupBody = { ...login, token: auth.bootstrapToken };
  assert.equal(
    (
      await request("/api/v1/auth/setup", "POST", setupBody, undefined, {
        origin: "https://another.example.test",
        "x-forwarded-host": "owner-auth.example.test",
      })
    ).status,
    403,
  );
  const setup = await request("/api/v1/auth/setup", "POST", setupBody);
  assert.equal(setup.status, 200);
  const firstCookie = cookieFrom(setup);
  const first = (await setup.json()).session as HubSession;
  assert.equal((await request("/api/v1/auth/setup", "POST", setupBody)).status, 409);
  assert.equal((await request("/owner", "GET", undefined, firstCookie)).status, 200);
  assert.equal(
    (
      await request("/owner", "GET", undefined, firstCookie, {
        authorization: "Bearer malformed",
      })
    ).status,
    401,
  );
  const rotated = await request("/api/v1/auth/login", "POST", login, firstCookie);
  assert.equal(rotated.status, 200);
  const ownerCookie = cookieFrom(rotated);
  const owner = (await rotated.json()).session as HubSession;
  assert(revoked.includes(first.id));
  assert.equal((await request("/owner", "GET", undefined, firstCookie)).status, 401);
  assert.equal(
    (
      await request("/owner", "GET", undefined, undefined, {
        authorization: `Bearer ${ownerCookie.slice(HUB_SESSION_COOKIE.length + 1)}`,
      })
    ).status,
    200,
  );
  const otherLogin = await request("/api/v1/auth/login", "POST", {
    ...login,
    deviceName: "Second",
  });
  assert.equal(otherLogin.status, 200);
  const otherCookie = cookieFrom(otherLogin);
  const other = (await otherLogin.json()).session as HubSession;
  const listed = await request("/api/v1/auth/sessions", "GET", undefined, ownerCookie);
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).sessions.length, 2);
  assert.equal(auth.store.listSessions().length, 2);
  const revokePath = `/api/v1/auth/sessions/${other.id}`;
  assert.equal(
    (
      await request(revokePath, "DELETE", undefined, ownerCookie, {
        origin: "https://another.example.test",
      })
    ).status,
    403,
  );
  assert.equal((await request("/owner", "GET", undefined, otherCookie)).status, 200);
  assert.equal((await request(revokePath, "DELETE", undefined, ownerCookie)).status, 200);
  assert(revoked.includes(other.id));
  assert.equal((await request("/owner", "GET", undefined, otherCookie)).status, 401);

  // A new composition reuses persisted auth without creating another setup token.
  auth = await createHubAuth(options);
  assert.equal(auth.bootstrapToken, undefined);
  assert.equal((await request("/owner", "GET", undefined, ownerCookie)).status, 200);
  assert.equal((await request("/owner", "GET", undefined, otherCookie)).status, 401);
  const logout = await request("/api/v1/auth/logout", "POST", {}, ownerCookie);
  assert.equal(logout.status, 200);
  assert(logout.headers.get("set-cookie")?.includes("Max-Age=0"));
  assert(revoked.includes(owner.id));
  assert.equal((await request("/owner", "GET", undefined, ownerCookie)).status, 401);
  console.log(
    "PASS packed owner auth: setup, login, origin, cookie/bearer, revoke, reload, logout",
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true });
}
