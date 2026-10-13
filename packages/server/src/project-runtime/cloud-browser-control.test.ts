import { afterAll, afterEach, expect, test } from "bun:test";
import { createServer, request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { CloudAccountPrincipal } from "./control-authority.js";
import { installCloudControlConfinement } from "./__fixtures__/cloud-control-confinement.js";

const confinement = installCloudControlConfinement();
afterAll(() => confinement.restore());
const { ProjectRegistry } = await import("./registry.js");
const { startProjectControlServer } = await import("./control-server.js");
const { createCloudBrowserAuth } = await import("./cloud-browser-auth.js");
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
const publicOrigin = "https://cloud.browser.invalid";
const accountOrigin = "https://account.browser.invalid";
const pause = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
};

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cs-cloud-browser-control-")));
  writeFileSync(join(root, "index.html"), "<title>Account workbench</title>");
  const tickets = new Map<string, CloudAccountPrincipal>();
  const active = new Set<string>();
  const innerRequests: Array<{
    path: string;
    cookie?: string;
    authorization?: string;
    body: string;
  }> = [];
  const running = new Set<string>();
  const stopped: string[] = [];
  const peers = new Set<WebSocket>();
  let holdRedeem: Promise<void> | undefined,
    holdEnsure: Promise<void> | undefined,
    holdValidation: { pause: Promise<void>; fail: boolean } | undefined,
    rejectLogout = false;
  const innerCookie = `cs_hub_session=${randomBytes(32).toString("base64url")}`;
  const assetToken = randomBytes(32).toString("base64url");
  const wss = new WebSocketServer({ noServer: true });
  const inner = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    innerRequests.push({
      path: req.url!,
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
      body,
    });
    if (req.url === "/api/v1/auth/login") {
      res.setHeader("Set-Cookie", innerCookie + "; HttpOnly");
      res.end(JSON.stringify({ authenticated: true }));
    } else if (req.url === "/api/v1/auth/logout") {
      if (!rejectLogout) for (const peer of peers) peer.terminate();
      res.writeHead(rejectLogout ? 503 : 200);
      res.end("{}");
    } else if (req.url === "/api/v1/panels/runtime/prepare") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          src: `/api/v1/panel-assets/${assetToken}/index.html`,
          instanceId: "fixture-panel-instance",
          expiresAt: Date.now() + 60_000,
        }),
      );
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ path: req.url, privateProject: true }));
    }
  });
  inner.on("upgrade", (req, socket, head) => {
    expect(req.headers.cookie).toBe(innerCookie);
    expect(req.headers.authorization).toBeUndefined();
    wss.handleUpgrade(req, socket, head, (ws) => {
      peers.add(ws);
      ws.on("error", () => {});
      ws.on("close", () => peers.delete(ws));
      ws.on("message", (data) => ws.send(data));
      ws.send("ready");
    });
  });
  await new Promise<void>((resolve) => inner.listen(0, "127.0.0.1", resolve));
  const innerUrl = `http://127.0.0.1:${(inner.address() as { port: number }).port}`;
  confinement.allow(innerUrl);
  const server = await startProjectControlServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: root,
    staticRootDir: root,
    publicOrigin,
    accountMode: "multi-account",
    accountAuthority: {
      accountOrigin,
      async redeem(ticket, installationId) {
        expect(installationId).toMatch(/^[a-f0-9-]{36}$/);
        const principal = tickets.get(ticket);
        tickets.delete(ticket);
        const pending = holdRedeem;
        holdRedeem = undefined;
        await pending;
        if (!principal || !active.has(principal.rootSessionId))
          throw Error("private provider detail");
        return { ...principal };
      },
      async validate(principal) {
        const pending = holdValidation;
        holdValidation = undefined;
        await pending?.pause;
        if (pending?.fail) throw Error("old access deadline expired");
        if (!active.has(principal.rootSessionId)) throw Error("private provider detail");
        return { ...principal };
      },
    },
    provider: {
      async availability() {
        return { available: true };
      },
      async ensure(project) {
        await holdEnsure;
        running.add(project.id);
        return {
          url: innerUrl,
          generation: project.generation,
          username: project.runtimeUsername,
          password: project.runtimePassword,
        };
      },
      async stop(project) {
        running.delete(project.id);
        stopped.push(project.id);
      },
      async status(project) {
        return running.has(project.id) ? { state: "running", url: innerUrl } : { state: "stopped" };
      },
      async close() {},
    },
  });
  confinement.allow(server.url);
  closes.push(async () => {
    for (const peer of peers) peer.terminate();
    await server.close();
    wss.close();
    inner.closeAllConnections();
    await new Promise<void>((resolve) => inner.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const browser = { Origin: publicOrigin, "Sec-Fetch-Site": "same-origin" };
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    cookie?: string,
    headers: Record<string, string> = browser,
  ) =>
    fetch(server.url + path, {
      method,
      redirect: "manual",
      headers: {
        Host: new URL(publicOrigin).host,
        ...headers,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (response) => {
      // All fixture replies are bounded JSON. Drain a clone like the real
      // browser api() does, including refusals, before asserting status alone.
      await response.clone().arrayBuffer();
      return response;
    });
  const identity = (accountId = randomUUID()): CloudAccountPrincipal => {
    const rootSessionId = randomUUID();
    active.add(rootSessionId);
    return {
      accountOrigin,
      accountId,
      sessionId: rootSessionId,
      rootSessionId,
      authorityEpoch: randomUUID(),
      expiresAt: Date.now() + 900_000,
    };
  };
  const issue = (principal: CloudAccountPrincipal) => {
    const ticket = randomBytes(32).toString("base64url");
    tickets.set(ticket, { ...principal });
    return ticket;
  };
  const login = async (principal: CloudAccountPrincipal, previous?: string) => {
    const response = await request(
      "/api/v1/cloud-browser/session",
      "POST",
      { ticket: issue(principal) },
      previous,
    );
    expect(response.status).toBe(201);
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    const body = await response.json();
    expect(body.authenticated).toBe(true);
    expect(body.mode).toBe("cloud-account");
    expect(body.session.accountId).toBe(principal.accountId);
    expect(body.token).toBeUndefined();
    expect(body.session.ownerId).toBeUndefined();
    return { cookie: setCookie.split(";", 1)[0]!, session: body.session };
  };
  const project = async (cookie: string, name: string) => {
    const response = await request("/api/v1/projects", "POST", { name }, cookie);
    expect(response.status).toBe(201);
    return (await response.json()).project;
  };
  const socket = (cookie: string, id: string) => {
    const ws = new WebSocket(server.url.replace("http:", "ws:") + `/p/${id}/ws`, {
      headers: {
        Host: new URL(publicOrigin).host,
        Origin: publicOrigin,
        Cookie: cookie,
        "Sec-Fetch-Site": "same-origin",
      },
    });
    ws.on("error", () => {});
    return ws;
  };
  return {
    root,
    server,
    request,
    identity,
    issue,
    login,
    project,
    socket,
    active,
    running,
    stopped,
    innerRequests,
    holdRedeem: (value?: Promise<void>) => {
      holdRedeem = value;
    },
    holdEnsure: (value?: Promise<void>) => {
      holdEnsure = value;
    },
    holdValidation: (pause: Promise<void>, fail = false) => {
      holdValidation = { pause, fail };
    },
    failLogout: () => {
      rejectLogout = true;
    },
  };
}

test("multi-account capability is explicit and bootstrap rejects CSRF before consuming a ticket", async () => {
  const f = await fixture();
  const caps = await (await f.request("/api/v1/cloud-browser/capabilities")).json();
  expect(caps).toEqual({
    version: 1,
    mode: "cloud-browser",
    cloudOrigin: publicOrigin,
    installationId: expect.any(String),
    accountOrigin,
  });
  const anonymousStatus = await f.request("/api/v1/cloud-browser/status");
  expect(anonymousStatus.status).toBe(200);
  expect(await anonymousStatus.json()).toEqual({
    initialized: true,
    mode: "cloud-account",
    authenticated: false,
  });
  const ticket = f.issue(f.identity());
  for (const headers of [
    {},
    { Origin: publicOrigin },
    { Origin: "https://attacker.invalid", "Sec-Fetch-Site": "same-origin" },
    { Origin: publicOrigin, "Sec-Fetch-Site": "same-site" },
    {
      Origin: publicOrigin,
      "Sec-Fetch-Site": "same-origin",
      Authorization: "Bearer " + "A".repeat(43),
    },
  ]) {
    const response = await f.request(
      "/api/v1/cloud-browser/session",
      "POST",
      { ticket },
      undefined,
      headers,
    );
    expect(response.status).toBe(403);
  }
  expect(
    (await f.request("/api/v1/cloud-browser/session?ticket=forbidden", "POST", { ticket })).status,
  ).toBe(400);
  expect(
    (await f.request("/api/v1/cloud-browser/session", "POST", { ticket, ownerId: randomUUID() }))
      .status,
  ).toBe(400);
  const response = await f.request("/api/v1/cloud-browser/session", "POST", { ticket });
  expect(response.status).toBe(201);
  expect((await f.request("/api/v1/cloud-browser/session", "POST", { ticket })).status).toBe(401);
  expect((await f.request("/api/v1/cloud-management/session", "POST", { ticket })).status).toBe(
    403,
  );
});

test("browser-specific environment and status aliases retain their exact authority gates", async () => {
  const f = await fixture();
  expect((await f.request("/api/v1/cloud-browser/environment")).status).toBe(401);
  const a = await f.login(f.identity());
  const response = await f.request("/api/v1/cloud-browser/environment", "GET", undefined, a.cookie);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    version: 1,
    id: expect.any(String),
    name: "云端项目",
    kind: "project-host",
    entryPath: "/",
  });
  for (const path of ["/api/v1/cloud-browser/status", "/api/v1/cloud-browser/environment"]) {
    expect((await f.request(path + "?ignored=1", "GET", undefined, a.cookie)).status).toBe(400);
    for (const headers of [
      { "Sec-Fetch-Site": "cross-site" },
      { Origin: "https://attacker.invalid", "Sec-Fetch-Site": "same-origin" },
    ])
      expect((await f.request(path, "GET", undefined, a.cookie, headers)).status).toBe(403);
  }
  expect((await f.request("/api/v1/cloud-browser/environment", "POST", {}, a.cookie)).status).toBe(
    405,
  );
  f.active.delete(a.session.rootSessionId);
  expect(
    (await f.request("/api/v1/cloud-browser/environment", "GET", undefined, a.cookie)).status,
  ).toBe(401);
});

test("two Account UUIDs cannot list, control or proxy each other's files, sessions and Panel assets", async () => {
  const f = await fixture();
  const a = await f.login(f.identity()),
    b = await f.login(f.identity());
  const safeStatus = await (
    await f.request("/api/v1/cloud-browser/status", "GET", undefined, a.cookie)
  ).json();
  expect(safeStatus.session.accountId).toBe(a.session.accountId);
  expect(safeStatus.session.ownerId).toBeUndefined();
  const pa = await f.project(a.cookie, "A private project"),
    pb = await f.project(b.cookie, "B private project");
  for (const [own, other] of [
    [a, pb],
    [b, pa],
  ]) {
    const list = await (await f.request("/api/v1/projects", "GET", undefined, own.cookie)).json();
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0].id).not.toBe(other.id);
    for (const suffix of ["", "/start", "/stop", "/open"])
      expect(
        (
          await f.request(
            `/api/v1/projects/${other.id}${suffix}`,
            suffix ? "POST" : "GET",
            suffix ? {} : undefined,
            own.cookie,
          )
        ).status,
      ).toBe(404);
    for (const resource of [
      "configuration",
      "files",
      "sessions",
      "panels",
      "panels/resources/guessed-resource",
    ])
      expect(
        (await f.request(`/p/${other.id}/api/v1/${resource}`, "GET", undefined, own.cookie)).status,
      ).toBe(404);
  }
  expect(f.innerRequests).toHaveLength(0);
  expect((await f.request(`/api/v1/projects/${pa.id}/start`, "POST", {}, a.cookie)).status).toBe(
    200,
  );
  const opened = await (
    await f.request(`/api/v1/projects/${pa.id}/open`, "POST", {}, a.cookie)
  ).json();
  expect(opened.url).toBe(`${publicOrigin}/?project=${pa.id}`);
  const own = await f.request(`/p/${pa.id}/api/v1/sessions`, "GET", undefined, a.cookie);
  expect(own.status).toBe(200);
  expect(own.headers.get("set-cookie")).toBeNull();
  const prepare = await f.request(
    `/p/${pa.id}/api/v1/panels/runtime/prepare`,
    "POST",
    {},
    a.cookie,
  );
  expect(prepare.status).toBe(200);
  const prepared = await prepare.json();
  // Opaque sandbox assets use their scoped capability; ordinary APIs still
  // require the browser cookie and exact origin. Other signed-in users cannot borrow it.
  expect(
    (
      await f.request(`/p/${pa.id}${prepared.src}`, "GET", undefined, undefined, {
        Origin: "null",
        "Sec-Fetch-Site": "cross-site",
      })
    ).status,
  ).toBe(200);
  expect((await f.request(`/p/${pa.id}${prepared.src}`, "GET", undefined, b.cookie)).status).toBe(
    403,
  );
  for (const inner of f.innerRequests) {
    expect(inner.authorization).toBeUndefined();
    if (inner.cookie) expect(inner.cookie).not.toContain(a.cookie);
    expect(inner.body).not.toContain(a.cookie);
  }
  const foreignSocket = f.socket(b.cookie, pa.id);
  await new Promise<void>((resolve) => foreignSocket.once("close", () => resolve()));
  expect((await f.request("/api/v1/auth/logout", "POST", {}, a.cookie)).status).toBe(200);
  expect((await f.request("/api/v1/projects", "GET", undefined, a.cookie)).status).toBe(401);
  expect((await f.request("/api/v1/projects", "GET", undefined, b.cookie)).status).toBe(200);
});

test("live Account revocation blocks proxy and cancels a delayed project start without affecting another account", async () => {
  const f = await fixture();
  const identity = f.identity(),
    a = await f.login(identity),
    b = await f.login(f.identity());
  const pa = await f.project(a.cookie, "A delayed"),
    pb = await f.project(b.cookie, "B running");
  expect((await f.request(`/api/v1/projects/${pb.id}/start`, "POST", {}, b.cookie)).status).toBe(
    200,
  );
  const ensure = pause();
  f.holdEnsure(ensure.promise);
  const start = f.request(`/api/v1/projects/${pa.id}/start`, "POST", {}, a.cookie);
  for (let n = 0; n < 100; n++) {
    const registry = JSON.parse(
      readFileSync(join(f.root, "project-control/registry.json"), "utf8"),
    );
    if (registry.projects.find((row: { id: string }) => row.id === pa.id).status === "starting")
      break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  f.active.delete(identity.rootSessionId);
  ensure.release();
  expect((await start).status).toBe(401);
  expect(f.running.has(pa.id)).toBe(false);
  expect(f.running.has(pb.id)).toBe(true);
  expect((await f.request(`/p/${pa.id}/api/v1/sessions`, "GET", undefined, a.cookie)).status).toBe(
    401,
  );
  expect((await f.request(`/p/${pb.id}/api/v1/sessions`, "GET", undefined, b.cookie)).status).toBe(
    200,
  );
});

test("cookie replacement revokes its predecessor and cannot claim another Account origin", async () => {
  const f = await fixture(),
    identity = f.identity();
  const first = await f.login(identity),
    fresh = await f.login(identity, first.cookie);
  expect(fresh.cookie).not.toBe(first.cookie);
  expect(fresh.session.id).toBe(first.session.id);
  expect((await f.request("/api/v1/projects", "GET", undefined, first.cookie)).status).toBe(401);
  expect((await f.request("/api/v1/projects", "GET", undefined, fresh.cookie)).status).toBe(200);
  const bad = f.issue({ ...identity, accountOrigin: "https://foreign.invalid" });
  const denied = await f.request("/api/v1/cloud-browser/session", "POST", { ticket: bad });
  expect(denied.status).toBe(401);
  expect(await denied.text()).not.toContain("private provider detail");
  const registry = JSON.parse(readFileSync(join(f.root, "project-control/registry.json"), "utf8"));
  expect(registry.owners).toHaveLength(1);
});

test("same-root browser renewal keeps the WebSocket and fences a stale failed validation", async () => {
  const f = await fixture(),
    identity = f.identity(),
    a = await f.login(identity);
  const project = await f.project(a.cookie, "Long running project");
  expect(
    (await f.request(`/api/v1/projects/${project.id}/start`, "POST", {}, a.cookie)).status,
  ).toBe(200);
  const ws = f.socket(a.cookie, project.id),
    ready = once(ws, "message");
  await once(ws, "open");
  await ready;
  const gate = pause();
  f.holdValidation(gate.promise, true);
  const oldRequest = f.request("/api/v1/projects", "GET", undefined, a.cookie);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const next = await f.login({ ...identity, expiresAt: identity.expiresAt + 60_000 }, a.cookie);
  expect(next.session.id).toBe(a.session.id);
  gate.release();
  expect((await oldRequest).status).toBe(200);
  expect((await f.request("/api/v1/projects", "GET", undefined, next.cookie)).status).toBe(200);
  const echo = once(ws, "message");
  ws.send("renewal retained the stream");
  expect((await echo)[0].toString()).toBe("renewal retained the stream");
  expect(f.running.has(project.id)).toBe(true);
  ws.close();
  await once(ws, "close");
  const changedRoot = await f.login(f.identity(identity.accountId), next.cookie);
  expect(changedRoot.session.id).not.toBe(next.session.id);
  expect((await f.request("/api/v1/projects", "GET", undefined, next.cookie)).status).toBe(401);
});

test("failed inner revocation stops only that account's runtimes", async () => {
  const f = await fixture();
  const a = await f.login(f.identity()),
    b = await f.login(f.identity());
  const pa = await f.project(a.cookie, "A private"),
    pb = await f.project(b.cookie, "B retained");
  for (const [grant, project] of [
    [a, pa],
    [b, pb],
  ]) {
    expect(
      (await f.request(`/api/v1/projects/${project.id}/start`, "POST", {}, grant.cookie)).status,
    ).toBe(200);
    expect(
      (await f.request(`/p/${project.id}/api/v1/sessions`, "GET", undefined, grant.cookie)).status,
    ).toBe(200);
  }
  f.failLogout();
  expect((await f.request("/api/v1/auth/logout", "POST", {}, a.cookie)).status).toBe(200);
  for (let n = 0; n < 100 && f.running.has(pa.id); n++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(f.running.has(pa.id)).toBe(false);
  expect(f.running.has(pb.id)).toBe(true);
  expect(f.stopped).not.toContain(pb.id);
});

test("close fences a late ticket redemption before any owner or browser grant is issued", async () => {
  const f = await fixture(),
    redeem = pause();
  f.holdRedeem(redeem.promise);
  const request = f.request("/api/v1/cloud-browser/session", "POST", {
    ticket: f.issue(f.identity()),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const closing = f.server.close();
  redeem.release();
  const response = await request.catch(() => undefined);
  if (response) {
    expect(response.status).not.toBe(201);
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  await closing;
  const registry = JSON.parse(readFileSync(join(f.root, "project-control/registry.json"), "utf8"));
  expect(registry.owners).toHaveLength(0);
});

test("logout fences a pending renewal so its late response cannot restore a browser cookie", async () => {
  const f = await fixture(),
    identity = f.identity(),
    first = await f.login(identity),
    gate = pause();
  f.holdRedeem(gate.promise);
  const pending = f.request(
    "/api/v1/cloud-browser/session",
    "POST",
    { ticket: f.issue(identity) },
    first.cookie,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect((await f.request("/api/v1/auth/logout", "POST", {}, first.cookie)).status).toBe(200);
  gate.release();
  const late = await pending;
  expect(late.status).toBe(401);
  expect(late.headers.get("set-cookie")).toBeNull();
  expect((await f.request("/api/v1/projects", "GET", undefined, first.cookie)).status).toBe(401);
});

test("an account switch fences the prior account's pending browser renewal", async () => {
  const f = await fixture(),
    identity = f.identity(),
    a = await f.login(identity),
    gate = pause();
  f.holdRedeem(gate.promise);
  const pending = f.request(
    "/api/v1/cloud-browser/session",
    "POST",
    { ticket: f.issue(identity) },
    a.cookie,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const b = await f.login(f.identity(), a.cookie);
  gate.release();
  const late = await pending;
  expect(late.status).toBe(401);
  expect(late.headers.get("set-cookie")).toBeNull();
  const status = await (await f.request("/api/v1/auth/status", "GET", undefined, b.cookie)).json();
  expect(status.session.accountId).toBe(b.session.accountId);
  expect((await f.request("/api/v1/projects", "GET", undefined, a.cookie)).status).toBe(401);
});

test("a delayed logout body cannot clear a different root's newly issued cookie", async () => {
  const f = await fixture(),
    a = await f.login(f.identity());
  let finish!: () => void;
  const pending = new Promise<{ status: number; cookie?: string[] }>((resolve, reject) => {
    const request = httpRequest(
      f.server.url + "/api/v1/auth/logout",
      {
        method: "POST",
        headers: {
          Host: new URL(publicOrigin).host,
          Origin: publicOrigin,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "Content-Length": "2",
          Cookie: a.cookie,
        },
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({ status: response.statusCode!, cookie: response.headers["set-cookie"] }),
        );
      },
    );
    request.on("error", reject);
    request.write("{");
    finish = () => request.end("}");
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const b = await f.login(f.identity(), a.cookie);
  finish();
  const late = await pending;
  expect(late.status).toBe(401);
  expect(late.cookie).toBeUndefined();
  expect((await f.request("/api/v1/projects", "GET", undefined, b.cookie)).status).toBe(200);
});

test("repeated authorized login and logout cannot exhaust other users' session capacity", async () => {
  let now = Date.now();
  const root = randomUUID(),
    accountId = randomUUID(),
    ownerId = randomUUID();
  const principal: CloudAccountPrincipal = {
    accountOrigin,
    accountId,
    sessionId: root,
    rootSessionId: root,
    authorityEpoch: randomUUID(),
    expiresAt: now + 3_600_000,
  };
  const auth = createCloudBrowserAuth({
    accountOrigin,
    publicOrigin,
    installationId: randomUUID(),
    managementEpoch: randomUUID(),
    now: () => now,
    ownerForAccount: () => ownerId,
    onRevoke() {},
    authority: {
      accountOrigin,
      redeem: async () => ({ ...principal }),
      validate: async (value) => ({ ...value }),
    },
  });
  const call = async (path: string, body: unknown, cookie?: string) => {
    const headers: Record<string, string> = {
      host: new URL(publicOrigin).host,
      origin: publicOrigin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    };
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method: "POST",
      url: path,
      headers,
      rawHeaders: Object.entries(headers).flat(),
    });
    const result = { status: 0, cookie: "" };
    const response = {
      destroyed: false,
      writableEnded: false,
      setHeader(name: string, value: string) {
        if (name === "Set-Cookie") result.cookie = value;
      },
      writeHead(status: number) {
        result.status = status;
      },
      end() {
        this.writableEnded = true;
      },
    };
    await auth.handle(
      request as unknown as import("node:http").IncomingMessage,
      response as unknown as import("node:http").ServerResponse,
    );
    return result;
  };
  try {
    for (let n = 0; n < 270; n++) {
      if (n && n % 59 === 0) now += 60_001;
      const login = await call("/api/v1/cloud-browser/session", {
        ticket: randomBytes(32).toString("base64url"),
      });
      expect(login.status).toBe(201);
      expect((await call("/api/v1/auth/logout", {}, login.cookie.split(";", 1)[0])).status).toBe(
        200,
      );
    }
    expect(auth.store.listSessions()).toHaveLength(0);
  } finally {
    auth.close?.();
  }
});

test("multi-account startup refuses legacy state unchanged and does not mint a Hub administrator", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cs-cloud-browser-refusal-")));
  try {
    const registry = new ProjectRegistry(root);
    registry.create("old.operator", "Private legacy project");
    registry.close();
    const file = join(root, "project-control/registry.json"),
      before = readFileSync(file);
    await expect(
      startProjectControlServer({
        host: "127.0.0.1",
        port: 0,
        dataDir: root,
        publicOrigin,
        accountMode: "multi-account",
        accountAuthority: {
          accountOrigin,
          redeem: async () => {
            throw Error();
          },
          validate: async () => {
            throw Error();
          },
        },
      }),
    ).rejects.toThrow();
    expect(readFileSync(file)).toEqual(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
