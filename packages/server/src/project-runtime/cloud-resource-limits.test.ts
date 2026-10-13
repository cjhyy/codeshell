import { afterAll, afterEach, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudAccountPrincipal } from "./control-authority.js";
import type { ProjectControlServerOptions } from "./control-server.js";
import { installCloudControlConfinement } from "./__fixtures__/cloud-control-confinement.js";

// This transport fixture runs in its own guarded shard. No Docker command,
// worker, provider request or operator application state is permitted.
const confinement = installCloudControlConfinement();
afterAll(() => confinement.restore());
const { startProjectControlServer } = await import("./control-server.js");
const { ProjectRegistry } = await import("./registry.js");
const roots: string[] = [];
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cloud-resource-config-")));
  roots.push(root);
  return root;
}
const publicOrigin = "https://cloud.limits.example.test";
const accountOrigin = "https://account.limits.example.test";

test("trusted runtime limits reach the real Docker constructor and reject invalid bounds before serving", async () => {
  for (const runtimeLimits of [
    { memoryMb: 127 },
    { memoryMb: NaN },
    { cpus: 0 },
    { cpus: Infinity },
    { pids: 15 },
    { pids: 256.5 },
  ]) {
    const forbiddenProvider = {
      availability: async () => {
        throw Error("configuration must fail before provider use");
      },
      ensure: async () => {
        throw Error("configuration must fail before provider use");
      },
      stop: async () => {
        throw Error("configuration must fail before provider use");
      },
      status: async () => {
        throw Error("configuration must fail before provider use");
      },
      close: async () => {},
    };
    for (const provider of [undefined, forbiddenProvider]) {
      const dataDir = directory();
      await expect(
        startProjectControlServer({
          dataDir,
          host: "127.0.0.1",
          port: 0,
          runtimeLimits,
          provider,
        }),
      ).rejects.toThrow(/Invalid (?:project|resource)/);
      // A failed configuration releases its controller lease and serves no API.
      const registry = new ProjectRegistry(dataDir);
      registry.close();
    }
  }
  const server = await startProjectControlServer({
    dataDir: directory(),
    host: "127.0.0.1",
    port: 0,
    runtimeLimits: { memoryMb: 1024, cpus: 1, pids: 256 },
  });
  closes.push(() => server.close());
  confinement.allow(server.url);
  const health = await fetch(server.url + "/health");
  expect(health.status).toBe(200);
  expect((await health.json()).mode).toBe("project-sandbox");
});

test("trusted project quota bounds are validated by the real manager before serving", async () => {
  for (const projectLimits of [
    { maxRunning: 0 },
    { maxRunning: 33 },
    { maxRunningPerOwner: 0 },
    { maxRunningPerOwner: 33 },
    { maxProjectsPerOwner: 0 },
    { maxProjectsPerOwner: 129 },
    { maxProjectsPerOwner: 1.5 },
  ]) {
    const dataDir = directory();
    await expect(
      startProjectControlServer({
        dataDir,
        host: "127.0.0.1",
        port: 0,
        projectLimits,
      }),
    ).rejects.toThrow(/Project .*limit/);
    const registry = new ProjectRegistry(dataDir);
    registry.close();
  }
});

async function fixture(projectLimits: NonNullable<ProjectControlServerOptions["projectLimits"]>) {
  const tickets = new Map<string, CloudAccountPrincipal>();
  const running = new Set<string>();
  const server = await startProjectControlServer({
    dataDir: directory(),
    host: "127.0.0.1",
    port: 0,
    publicOrigin,
    accountMode: "multi-account",
    projectLimits,
    accountAuthority: {
      accountOrigin,
      async redeem(ticket) {
        const principal = tickets.get(ticket);
        tickets.delete(ticket);
        if (!principal) throw Error("unknown synthetic ticket");
        return { ...principal };
      },
      async validate(principal) {
        return { ...principal };
      },
    },
    provider: {
      availability: async () => ({ available: true }),
      async ensure(record) {
        running.add(record.id);
        return {
          url: "http://127.0.0.1:9",
          username: record.runtimeUsername,
          password: record.runtimePassword,
          generation: record.generation,
        };
      },
      async stop(record) {
        running.delete(record.id);
      },
      async status(record) {
        return running.has(record.id)
          ? { state: "running", url: "http://127.0.0.1:9" }
          : { state: "stopped" };
      },
      close: async () => {},
    },
  });
  closes.push(() => server.close());
  confinement.allow(server.url);
  const call = async (path: string, body?: unknown, cookie?: string) => {
    const response = await fetch(server.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Host: new URL(publicOrigin).host,
        Origin: publicOrigin,
        "Sec-Fetch-Site": "same-origin",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await response.clone().arrayBuffer();
    return response;
  };
  const login = async () => {
    const ticket = randomBytes(32).toString("base64url"),
      sessionId = randomUUID();
    tickets.set(ticket, {
      accountOrigin,
      accountId: randomUUID(),
      sessionId,
      rootSessionId: sessionId,
      authorityEpoch: randomUUID(),
      expiresAt: Date.now() + 900_000,
    });
    const response = await call("/api/v1/cloud-browser/session", { ticket });
    expect(response.status).toBe(201);
    return response.headers.get("set-cookie")!.split(";", 1)[0]!;
  };
  const create = async (cookie: string, name: string) => {
    const response = await call("/api/v1/projects", { name }, cookie);
    expect(response.status).toBe(201);
    return (await response.json()).project.id as string;
  };
  return { call, login, create, running };
}

test("configured owner/global quotas govern actual HTTP lifecycle requests and cannot be overridden by project input", async () => {
  const f = await fixture({ maxRunning: 2, maxRunningPerOwner: 1, maxProjectsPerOwner: 2 });
  const alice = await f.login(),
    bob = await f.login(),
    charlie = await f.login();
  const a1 = await f.create(alice, "A1"),
    a2 = await f.create(alice, "A2"),
    b1 = await f.create(bob, "B1"),
    c1 = await f.create(charlie, "C1");
  expect((await f.call("/api/v1/projects", { name: "A3" }, alice)).status).toBe(429);
  expect(
    (
      await f.call(
        "/api/v1/projects",
        { name: "Override", projectLimits: { maxProjectsPerOwner: 128 } },
        alice,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.call(
        "/api/v1/projects",
        { name: "Override", runtimeLimits: { memoryMb: 262144 } },
        alice,
      )
    ).status,
  ).toBe(400);
  expect((await f.call(`/api/v1/projects/${a1}/start`, {}, alice)).status).toBe(200);
  expect((await f.call(`/api/v1/projects/${a2}/start`, {}, alice)).status).toBe(429);
  expect((await f.call(`/api/v1/projects/${b1}/start`, {}, bob)).status).toBe(200);
  expect((await f.call(`/api/v1/projects/${c1}/start`, {}, charlie)).status).toBe(429);
  expect((await f.call(`/api/v1/projects/${a1}/stop`, {}, alice)).status).toBe(200);
  expect((await f.call(`/api/v1/projects/${c1}/start`, {}, charlie)).status).toBe(200);
  expect(f.running).toEqual(new Set([b1, c1]));
});
