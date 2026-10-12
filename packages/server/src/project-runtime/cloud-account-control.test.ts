import { afterAll, afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudAccountPrincipal } from "./control-authority.js";
import { installCloudControlConfinement } from "./__fixtures__/cloud-control-confinement.js";

// Install the real exact-origin/child-process denial guard before importing Core/Main.
// This network fixture runs as its own guarded shard, never alongside unrelated tests.
const confinement = installCloudControlConfinement();
const allowOwnedOrigin = confinement.allow;
afterAll(() => confinement.restore());
const { ProjectRegistry } = await import("./registry.js");
const { startProjectControlServer } = await import("./control-server.js");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const publicOrigin = "https://cloud.fixture.invalid";
const accountOrigin = "https://account.fixture.invalid";
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cs-cloud-account-control-")));
  writeFileSync(join(root, "index.html"), "<title>Shared Cloud workbench</title>");
  const registry = new ProjectRegistry(root);
  const existing = registry.create("old.operator", "Existing legacy project");
  const installationId = registry.installationId;
  const accountId = randomUUID(),
    rootId = randomUUID();
  registry.bindAccount({
    version: 1,
    accountOrigin,
    accountId,
    ownerId: existing.ownerId,
    managementEpoch: randomUUID(),
    createdAt: Date.now(),
  });
  registry.close();
  let active = true,
    exchangeAccountId = accountId,
    pauseEnsure: Promise<void> | undefined,
    pauseAvailability: Promise<void> | undefined;
  let ensured = 0,
    validations = 0,
    stopped = 0;
  const innerCookie = `cs_hub_session=${randomBytes(32).toString("base64url")}`;
  const innerRequests: Array<{ url: string; auth?: string; cookie?: string; body: string }> = [];
  const streams = new Set<import("node:http").ServerResponse>();
  const inner = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    innerRequests.push({
      url: req.url!,
      auth: req.headers.authorization,
      cookie: req.headers.cookie,
      body,
    });
    if (req.url === "/api/v1/auth/login") {
      res.setHeader("Set-Cookie", innerCookie + "; Path=/; HttpOnly");
      res.end(JSON.stringify({ authenticated: true }));
    } else if (req.url === "/api/v1/auth/logout") {
      for (const stream of streams) stream.end();
      streams.clear();
      res.end("{}");
    } else if (req.url === "/api/v1/sessions/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: ready\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end("<title>Managed project</title>");
    }
  });
  await new Promise<void>((resolve) => inner.listen(0, "127.0.0.1", resolve));
  const innerUrl = `http://127.0.0.1:${(inner.address() as { port: number }).port}`;
  allowOwnedOrigin(innerUrl);
  const running = new Set<string>();
  const principal: CloudAccountPrincipal = {
    accountOrigin,
    accountId,
    sessionId: rootId,
    rootSessionId: rootId,
    authorityEpoch: randomUUID(),
    expiresAt: Date.now() + 3_600_000,
  };
  const server = await startProjectControlServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: root,
    staticRootDir: root,
    publicOrigin,
    accountAuthority: {
      accountOrigin,
      async exchange(_token, installation) {
        expect(installation).toBe(installationId);
        return { ...principal, accountId: exchangeAccountId };
      },
      async validate(value, installation) {
        expect(installation).toBe(installationId);
        validations++;
        if (!active) throw new Error("synthetic revoked secret must not leak");
        return { ...value };
      },
    },
    provider: {
      async availability() {
        await pauseAvailability;
        return { available: true };
      },
      async ensure(project) {
        ensured++;
        await pauseEnsure;
        running.add(project.id);
        return {
          url: innerUrl,
          username: project.runtimeUsername,
          password: project.runtimePassword,
          generation: project.generation,
        };
      },
      async stop(project) {
        stopped++;
        running.delete(project.id);
      },
      async status(project) {
        return running.has(project.id) ? { state: "running", url: innerUrl } : { state: "stopped" };
      },
      async close() {},
    },
  });
  allowOwnedOrigin(server.url);
  cleanups.push(async () => {
    await server.close();
    inner.closeAllConnections();
    await new Promise<void>((resolve) => inner.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    grant?: string,
    extra: Record<string, string> = {},
  ) =>
    fetch(server.url + path, {
      method,
      redirect: "manual",
      headers: {
        Host: new URL(publicOrigin).host,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(grant ? { Authorization: `Bearer ${grant}` } : {}),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const token = randomBytes(32).toString("base64url");
  const login = async () => {
    const response = await request("/api/v1/cloud-management/session", "POST", {
      accountToken: token,
    });
    return {
      response,
      body: (await response.json()) as {
        token: string;
        session: { id: string; expiresAt: number };
      },
    };
  };
  return {
    root,
    server,
    request,
    login,
    existing,
    token,
    innerRequests,
    running,
    principal,
    get validations() {
      return validations;
    },
    get ensured() {
      return ensured;
    },
    get stopped() {
      return stopped;
    },
    revoke() {
      active = false;
    },
    otherAccount() {
      exchangeAccountId = randomUUID();
    },
    pauseEnsure(value: Promise<void>) {
      pauseEnsure = value;
    },
    pauseAvailability(value: Promise<void>) {
      pauseAvailability = value;
    },
  };
}

test("bound Account grant lists, creates, starts, opens and stops projects without forwarding credentials", async () => {
  const f = await fixture();
  const { response, body } = await f.login();
  expect(response.status).toBe(201);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(body.session.expiresAt).toBeLessThanOrEqual(Date.now() + 600000);
  expect(JSON.stringify(body)).not.toContain("ownerId");
  expect(JSON.stringify(body)).not.toContain(f.token);
  const listed = await f.request("/api/v1/projects", "GET", undefined, body.token);
  expect(((await listed.json()) as any).projects[0].id).toBe(f.existing.id);
  const created = await f.request(
    "/api/v1/projects",
    "POST",
    { name: "New managed project" },
    body.token,
  );
  expect(created.status).toBe(201);
  const project = ((await created.json()) as any).project;
  expect(
    (await f.request(`/api/v1/projects/${project.id}/start`, "POST", {}, body.token)).status,
  ).toBe(200);
  const opened = await f.request(`/api/v1/projects/${project.id}/open`, "POST", {}, body.token);
  expect(opened.status).toBe(200);
  expect(((await opened.json()) as any).url).toBe(`${publicOrigin}/?project=${project.id}`);
  const browserHeaders = { Cookie: `cs_cloud_management=${body.token}`, Accept: "text/html" };
  const page = await f.request(
    `/?project=${project.id}`,
    "GET",
    undefined,
    undefined,
    browserHeaders,
  );
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Shared Cloud workbench");
  const status = await f.request(
    "/api/v1/auth/status",
    "GET",
    undefined,
    undefined,
    browserHeaders,
  );
  expect(((await status.json()) as any).authenticated).toBe(true);
  expect(
    (
      await f.request(
        `/p/${project.id}/api/v1/configuration`,
        "GET",
        undefined,
        undefined,
        browserHeaders,
      )
    ).status,
  ).toBe(200);
  for (const request of f.innerRequests) {
    expect(request.auth).toBeUndefined();
    expect(request.cookie ?? "").not.toContain(body.token);
    expect(request.body).not.toContain(f.token);
    expect(request.body).not.toContain(body.token);
  }
  expect(
    f.innerRequests.some(
      (request) =>
        request.url === "/api/v1/auth/login" && request.body.includes(f.existing.runtimePassword),
    ),
  ).toBe(false);
  expect(
    (await f.request(`/api/v1/projects/${project.id}/stop`, "POST", {}, body.token)).status,
  ).toBe(200);
  expect(f.running.size).toBe(0);
  expect(f.validations).toBeGreaterThan(10);
});

test("foreign Accounts, legacy login, browser credential exchange and wrong Host/origin fail closed", async () => {
  const f = await fixture();
  f.otherAccount();
  expect((await f.login()).response.status).toBe(403);
  for (const [path, extra] of [
    ["/api/v1/auth/login", {}],
    ["/api/v1/cloud-management/session", { Origin: publicOrigin }],
    ["/api/v1/cloud-management/session", { Host: "wrong.invalid" }],
    ["/api/v1/cloud-management/session", { Origin: "https://other.invalid" }],
  ] as const)
    expect(
      (await f.request(path, "POST", { accountToken: f.token }, undefined, extra)).status,
    ).toBe(403);
  expect((await f.request("/api/v1/projects")).status).toBe(401);
  expect(f.ensured).toBe(0);
});

test("revocation during provider readiness stops the late runtime and returns no usable project", async () => {
  const f = await fixture();
  const { body } = await f.login();
  const pause = gate();
  f.pauseEnsure(pause.promise);
  const pending = f.request(`/api/v1/projects/${f.existing.id}/start`, "POST", {}, body.token);
  while (!f.ensured) await new Promise((resolve) => setTimeout(resolve, 5));
  f.revoke();
  pause.release();
  const response = await pending;
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("synthetic revoked secret");
  expect(f.stopped).toBeGreaterThan(0);
  expect(f.running.size).toBe(0);
  expect((await f.request("/api/v1/projects", "GET", undefined, body.token)).status).toBe(401);
});

test("authority revocation during availability suppresses the pending list response", async () => {
  const f = await fixture();
  const { body } = await f.login();
  const pause = gate();
  f.pauseAvailability(pause.promise);
  const pending = f.request("/api/v1/projects", "GET", undefined, body.token);
  await new Promise((resolve) => setTimeout(resolve, 20));
  f.revoke();
  pause.release();
  expect((await pending).status).toBe(401);
});

test("continuous proxy sweep closes a live stream and explicit Cloud logout remains idempotent", async () => {
  const f = await fixture();
  const { body } = await f.login();
  expect(
    (await f.request(`/api/v1/projects/${f.existing.id}/start`, "POST", {}, body.token)).status,
  ).toBe(200);
  const stream = await f.request(
    `/p/${f.existing.id}/api/v1/sessions/stream`,
    "GET",
    undefined,
    body.token,
  );
  const reader = stream.body!.getReader();
  expect((await reader.read()).value!.length).toBeGreaterThan(0);
  const ended = reader.read().then(
    (value) => value.done,
    () => true,
  );
  f.revoke();
  expect(await ended).toBe(true);
  expect((await f.request("/api/v1/cloud-management/logout", "POST", {}, body.token)).status).toBe(
    200,
  );
  expect((await f.request("/api/v1/cloud-management/logout", "POST", {}, body.token)).status).toBe(
    200,
  );
  expect((await f.request("/api/v1/projects", "GET", undefined, body.token)).status).toBe(401);
}, 10000);
