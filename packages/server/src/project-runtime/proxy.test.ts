import { afterEach, expect, test } from "bun:test";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import type { HubAuth } from "../hub/auth-http.js";
import type { HubSession } from "../hub/auth-store.js";
import { createProjectRuntimeProxy, type RuntimeTarget } from "./proxy.js";

const PROJECT_A = "9f6ebd0c-5589-4cac-84db-bd6c54bf6c91";
const PROJECT_B = "65902b21-b2d4-493e-a82c-3bcb44f39f66";
const ORIGIN = "https://codeshell.example";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function until(check: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

async function fixture() {
  const sessions = new Map<string, HubSession>(
    ["owner-a", "owner-b"].map((id) => [
      id,
      {
        id,
        username: "outer-admin",
        deviceName: id,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    ]),
  );
  const auth = {
    store: { listSessions: () => [...sessions.values()] },
    authenticate: async (req: IncomingMessage) =>
      sessions.get(req.headers.cookie?.split("=")[1] ?? "") ?? null,
    isOriginAllowed: (req: IncomingMessage) =>
      req.headers.origin === ORIGIN && req.headers["sec-fetch-site"] !== "cross-site",
  } as unknown as HubAuth;
  const logins: Array<{ token: string; body: Record<string, unknown> }> = [];
  const logouts: string[] = [];
  const revocationFailures: string[] = [];
  const innerSessions = new Set<string>();
  const requests: Array<{ url: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const connections = new Map<WebSocket, string>();
  const assetToken = randomBytes(32).toString("base64url");
  const instanceId = randomUUID();
  let nextPrepareExpiry = Date.now() + 30_000;
  let releaseLogin: (() => void) | undefined;
  let pauseLogin = false;
  let pauseResolve = false;
  let releaseResolve: (() => void) | undefined;
  let unavailable = false;
  let failLogout = false;
  let generation = 1;
  const innerWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const inner = createServer((req, res) => {
    void (async () => {
      const cookie = req.headers.cookie ?? "";
      if (req.url === "/api/v1/auth/login") {
        const value = JSON.parse((await body(req)).toString());
        expect(value.username).toBe("private-runtime-user");
        expect(value.password).toBe("private-runtime-password");
        expect(req.headers.origin).toBe(ORIGIN);
        expect(req.headers.authorization).toBeUndefined();
        expect(req.headers.cookie).toBeUndefined();
        const token = randomBytes(32).toString("base64url");
        const innerCookie = `cs_hub_session=${token}`;
        innerSessions.add(innerCookie);
        logins.push({ token: innerCookie, body: value });
        if (pauseLogin)
          await new Promise<void>((resolve) => {
            releaseLogin = resolve;
          });
        res.setHeader("Set-Cookie", `${innerCookie}; Path=/; HttpOnly`);
        json(res, { authenticated: true, session: { id: token } });
        return;
      }
      if (req.url === "/api/v1/auth/logout") {
        await body(req);
        logouts.push(cookie);
        if (failLogout) {
          json(res, { error: "logout unavailable" }, 503);
          return;
        }
        innerSessions.delete(cookie);
        for (const [ws, owner] of connections) if (owner === cookie) ws.terminate();
        json(res, { ok: true });
        return;
      }
      if (!innerSessions.has(cookie)) {
        json(res, { error: "inner login required" }, 401);
        return;
      }
      requests.push({
        url: req.url!,
        headers: { ...req.headers },
        body: (await body(req)).toString(),
      });
      res.setHeader("Set-Cookie", "runtime-secret=must-not-reach-browser; HttpOnly");
      if (req.url === "/api/v1/panels/runtime/prepare") {
        json(res, {
          instanceId,
          src: `/api/v1/panel-assets/${assetToken}/index.html`,
          expiresAt: nextPrepareExpiry,
        });
      } else if (req.url === `/api/v1/panels/runtime/${instanceId}/renew`) {
        json(res, { expiresAt: Date.now() + 60_000 });
      } else if (req.url?.startsWith("/api/v1/panel-assets/")) {
        res.writeHead(200, { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" });
        res.end("<p>isolated panel</p>");
      } else if (req.url === "/api/v1/files/stream") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.write("first chunk");
      } else if (req.url === "/api/v1/files/redirect") {
        res.writeHead(302, { location: "http://127.0.0.1/private" });
        res.end();
      } else json(res, { ok: true });
    })().catch(() => json(res, { error: "fixture request failed" }, 500));
  });
  inner.on("upgrade", (req, socket, head) => {
    const cookie = req.headers.cookie ?? "";
    if (!innerSessions.has(cookie)) {
      socket.destroy();
      return;
    }
    requests.push({ url: req.url!, headers: { ...req.headers }, body: "" });
    innerWss.handleUpgrade(req, socket, head, (ws) => {
      connections.set(ws, cookie);
      ws.on("error", () => {});
      ws.on("close", () => connections.delete(ws));
      ws.on("message", (value, isBinary) => ws.send(value, { binary: isBinary }));
    });
  });
  inner.listen(0, "127.0.0.1");
  await once(inner, "listening");
  const innerUrl = `http://127.0.0.1:${(inner.address() as { port: number }).port}`;
  let targetUrl = innerUrl;
  const target = (): RuntimeTarget => ({
    url: targetUrl,
    username: "private-runtime-user",
    password: "private-runtime-password",
    generation,
  });
  const proxy = createProjectRuntimeProxy({
    auth,
    publicOrigin: () => ORIGIN,
    onRevocationFailure: (projectId) => {
      revocationFailures.push(projectId);
    },
    resolveTarget: async (projectId, session) => {
      if (![PROJECT_A, PROJECT_B].includes(projectId) || !sessions.has(session.id) || unavailable)
        throw new Error("not an owned running project");
      if (pauseResolve)
        await new Promise<void>((resolve) => {
          releaseResolve = resolve;
        });
      return target();
    },
  });
  const outer = createServer((req, res) => {
    void proxy.handle(req, res).then((handled) => {
      if (!handled) json(res, { root: true }, 404);
    });
  });
  outer.on("upgrade", (req, socket, head) => {
    void proxy.handleUpgrade(req, socket, head).then((handled) => {
      if (!handled) socket.destroy();
    });
  });
  outer.listen(0, "127.0.0.1");
  await once(outer, "listening");
  const origin = `http://127.0.0.1:${(outer.address() as { port: number }).port}`;
  const fetchProject = (
    path: string,
    options: RequestInit & { owner?: string; project?: string } = {},
  ) => {
    const { owner = "owner-a", project = PROJECT_A, ...init } = options;
    return fetch(`${origin}/p/${project}${path}`, {
      ...init,
      headers: {
        origin: ORIGIN,
        cookie: `cs_hub_session=${owner}`,
        ...init.headers,
      },
    });
  };
  const socket = async (owner = "owner-a", project = PROJECT_A) => {
    const ws = new WebSocket(`${origin.replace("http", "ws")}/p/${project}/ws`, {
      headers: {
        origin: ORIGIN,
        cookie: `cs_hub_session=${owner}`,
        authorization: "must-be-filtered",
      },
    });
    ws.on("error", () => {});
    await once(ws, "open");
    return ws;
  };
  cleanups.push(async () => {
    releaseLogin?.();
    releaseResolve?.();
    await proxy.close();
    for (const ws of connections.keys()) ws.terminate();
    innerWss.close();
    outer.closeAllConnections();
    inner.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => outer.close(() => resolve())),
      new Promise<void>((resolve) => inner.close(() => resolve())),
    ]);
  });
  return {
    proxy,
    origin,
    fetchProject,
    socket,
    requests,
    logins,
    logouts,
    revocationFailures,
    sessions,
    target,
    assetToken,
    instanceId,
    connections,
    setGeneration: (value: number) => {
      generation = value;
    },
    setTargetUrl: (value: string) => {
      targetUrl = value;
    },
    setLogoutFailure: (value: boolean) => {
      failLogout = value;
    },
    setUnavailable: () => {
      unavailable = true;
    },
    shortPrepareExpiry: () => {
      nextPrepareExpiry = Date.now() + 200;
    },
    pauseLogin: () => {
      pauseLogin = true;
    },
    releaseLogin: () => releaseLogin?.(),
    pauseResolve: () => {
      pauseResolve = true;
    },
    releaseResolve: () => {
      pauseResolve = false;
      releaseResolve?.();
    },
    resolveWaiting: () => !!releaseResolve,
  };
}

test("isolates inner cookies by outer session, project and generation; strips browser credentials and workspace selectors", async () => {
  const f = await fixture();
  const response = await f.fetchProject("/api/v1/files?workspace=%2Fprivate&path=readme.txt", {
    headers: {
      authorization: "private-outer-bearer",
      "x-codeshell-workspace": "/host/path",
      "x-forwarded-host": "attacker.invalid",
    },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: true });
  expect(f.requests[0]!.url).toBe("/api/v1/files?path=readme.txt");
  expect(f.requests[0]!.headers.cookie).toBe(f.logins[0]!.token);
  expect(f.requests[0]!.headers.authorization).toBeUndefined();
  expect(f.requests[0]!.headers["x-codeshell-workspace"]).toBeUndefined();
  expect(f.requests[0]!.headers["x-forwarded-host"]).toBeUndefined();
  expect(f.requests[0]!.headers.origin).toBe(ORIGIN);
  await f.fetchProject("/api/v1/skills");
  expect(f.logins).toHaveLength(1);
  await f.fetchProject("/api/v1/skills", { owner: "owner-b" });
  await f.fetchProject("/api/v1/skills", { project: PROJECT_B });
  expect(new Set(f.logins.map((login) => login.token)).size).toBe(3);
  f.setGeneration(2);
  expect((await f.fetchProject("/api/v1/skills")).status).toBe(200);
  expect(f.logins).toHaveLength(4);
  await until(() => f.logouts.includes(f.logins[0]!.token));
});

test("coalesces concurrent first requests into one private login and refuses non-loopback targets", async () => {
  const f = await fixture();
  f.pauseLogin();
  const first = f.fetchProject("/api/v1/skills");
  const second = f.fetchProject("/api/v1/files");
  await until(() => f.logins.length === 1);
  f.releaseLogin();
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
  expect(f.logins).toHaveLength(1);
  f.setTargetUrl("http://169.254.169.254:80/");
  expect((await f.fetchProject("/api/v1/files", { owner: "owner-b" })).status).toBe(503);
  expect(f.logins).toHaveLength(1);
  expect(f.requests).toHaveLength(2);
});

test("rejects non-session requests, wrong Origin, control endpoints, traversal and runtime redirects", async () => {
  const f = await fixture();
  expect((await f.fetchProject("/api/v1/files", { owner: "absent" })).status).toBe(401);
  expect((await f.fetchProject("/api/v1/files", { headers: { origin: "null" } })).status).toBe(403);
  for (const path of [
    "/api/v1/auth/status",
    "/api/v1/projects",
    "/api/v1/desktop/session",
    "/api/v1/unknown",
    "/ws",
  ])
    expect((await f.fetchProject(path)).status).toBe(path === "/ws" ? 426 : 404);
  expect(f.logins).toHaveLength(0);
  const code = await new Promise<number>((resolve, reject) => {
    const req = request(
      f.origin,
      {
        path: `/p/${PROJECT_A}/api/v1/files/%2e%2e/auth`,
        headers: { origin: ORIGIN, cookie: "cs_hub_session=owner-a" },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on("error", reject);
    req.end();
  });
  // Node retains the encoded segment; Bun's HTTP shim normalizes it first.
  expect([400, 404]).toContain(code);
  expect(f.logins).toHaveLength(0);
  const redirected = await f.fetchProject("/api/v1/files/redirect");
  expect(redirected.status).toBe(502);
  expect(redirected.headers.get("location")).toBeNull();
});

test("only registered panel assets work without cookies, are bound to owner/project/generation, and follow renew/close", async () => {
  const f = await fixture();
  f.shortPrepareExpiry();
  const prepared = (await (
    await f.fetchProject("/api/v1/panels/runtime/prepare", { method: "POST", body: "{}" })
  ).json()) as { src: string };
  expect(prepared.src).toBe(`/api/v1/panel-assets/${f.assetToken}/index.html`);
  const asset = (project = PROJECT_A, extra: Record<string, string> = {}) =>
    fetch(`${f.origin}/p/${project}${prepared.src}`, { headers: { origin: "null", ...extra } });
  expect(await (await asset()).text()).toBe("<p>isolated panel</p>");
  expect((await asset(PROJECT_B)).status).toBe(410);
  expect((await asset(PROJECT_A, { cookie: "cs_hub_session=owner-b" })).status).toBe(403);
  expect(
    (
      await fetch(
        `${f.origin}/p/${PROJECT_A}/api/v1/panel-assets/${randomBytes(32).toString("base64url")}/index.html`,
        { headers: { origin: "null" } },
      )
    ).status,
  ).toBe(410);
  expect(
    (
      await f.fetchProject(`/api/v1/panels/runtime/${f.instanceId}/renew`, {
        method: "POST",
        body: "{}",
      })
    ).status,
  ).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect((await asset()).status).toBe(200);
  await f.fetchProject(`/api/v1/panels/runtime/${f.instanceId}`, { method: "DELETE" });
  expect((await asset()).status).toBe(410);
});

test("forwards actual text/binary socket frames and owner revocation closes HTTP streams, WS peers and internal sessions", async () => {
  const f = await fixture();
  const ws = await f.socket();
  const text = once(ws, "message");
  ws.send('{"method":"agent/run","id":1}');
  expect((await text)[0].toString()).toBe('{"method":"agent/run","id":1}');
  const binary = once(ws, "message");
  ws.send(Buffer.from([1, 2, 255]));
  const [data, isBinary] = await binary;
  expect(Buffer.from(data)).toEqual(Buffer.from([1, 2, 255]));
  expect(isBinary).toBe(true);
  const streaming = await f.fetchProject("/api/v1/files/stream");
  const reader = streaming.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first chunk");
  const next = reader.read().then(
    (result) => result.done,
    () => true,
  );
  const closed = once(ws, "close");
  await f.proxy.revokeOwner("owner-a");
  await closed;
  expect(await next).toBe(true);
  expect(f.logouts).toContain(f.logins[0]!.token);
  expect((await f.fetchProject("/api/v1/files")).status).toBe(401);
  expect((await f.fetchProject("/api/v1/files", { owner: "owner-b" })).status).toBe(200);
});

test("revocation while login or target resolution is pending cannot launch a request", async () => {
  const f = await fixture();
  f.pauseLogin();
  const pending = f.fetchProject("/api/v1/files");
  await until(() => f.logins.length === 1);
  const revoked = f.proxy.revokeOwner("owner-a");
  f.releaseLogin();
  await revoked;
  expect((await pending).status).toBe(401);
  expect(f.logouts).toEqual([f.logins[0]!.token]);
  expect(f.requests).toHaveLength(0);
  f.pauseResolve();
  const resolving = f.fetchProject("/api/v1/files", { owner: "owner-b" });
  await until(f.resolveWaiting);
  await f.proxy.revokeOwner("owner-b");
  f.releaseResolve();
  expect((await resolving).status).toBe(401);
  expect(f.logins).toHaveLength(1);
});

test("periodic authentication/generation validation retires idle sockets and their inner sessions", async () => {
  const f = await fixture();
  const first = await f.socket();
  const second = await f.socket("owner-b", PROJECT_B);
  const firstClosed = once(first, "close");
  const secondClosed = once(second, "close");
  f.sessions.delete("owner-a");
  f.setGeneration(2);
  await Promise.all([firstClosed, secondClosed]);
  await until(() => f.logouts.length === 2);
  expect(new Set(f.logouts)).toEqual(new Set(f.logins.map((entry) => entry.token)));
}, 10_000);

test("failed runtime logout closes access immediately, reports failure, and retries the private revocation", async () => {
  const f = await fixture();
  const ws = await f.socket();
  const closed = once(ws, "close");
  f.setLogoutFailure(true);
  await expect(f.proxy.revokeOwner("owner-a")).rejects.toThrow(
    "Runtime authentication unavailable",
  );
  await closed;
  await until(() => f.revocationFailures.includes(PROJECT_A));
  expect((await f.fetchProject("/api/v1/files")).status).toBe(401);
  f.setLogoutFailure(false);
  await until(() => f.logouts.length >= 2);
  expect(new Set(f.logouts)).toEqual(new Set([f.logins[0]!.token]));
}, 10_000);

test("project revocation removes asset capabilities; target changes cannot resurrect them", async () => {
  const f = await fixture();
  const prepared = (await (
    await f.fetchProject("/api/v1/panels/runtime/prepare", { method: "POST", body: "{}" })
  ).json()) as { src: string };
  const ws = await f.socket();
  const closed = once(ws, "close");
  await f.proxy.revokeProject(PROJECT_A);
  await closed;
  f.setGeneration(2);
  expect(
    (await fetch(`${f.origin}/p/${PROJECT_A}${prepared.src}`, { headers: { origin: "null" } }))
      .status,
  ).toBe(410);
  expect(f.logouts).toHaveLength(1);
  expect((await f.fetchProject("/api/v1/files")).status).toBe(200);
  expect(f.logins).toHaveLength(2);
});
