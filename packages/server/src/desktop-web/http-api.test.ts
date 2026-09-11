import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@cjhyy/code-shell-core";
import { createDesktopWebApi, type DesktopWebApiOptions } from "./http-api.js";
import { RemoteHostManager } from "../mobile-remote/remote-host-manager.js";
import { TrustedDeviceStore } from "../mobile-remote/trusted-device-store.js";
import { AccessPasscode } from "../mobile-remote/access-passcode.js";

// This suite boots a native server. Renderer suites share Bun's process and
// may have installed a mini DOM; preserve the production SDK browser guard.
const nativeHostGlobals = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => {
  for (const name of ["window", "document"]) {
    nativeHostGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Reflect.deleteProperty(globalThis, name);
  }
});
afterAll(() => {
  for (const [name, descriptor] of nativeHostGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(overrides: Partial<DesktopWebApiOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "desktop-web-api-"));
  const cwd = join(root, "项目 %20");
  const other = join(root, "other");
  const dataDir = join(root, "desktop");
  const sessionRootDir = join(root, "sessions");
  for (const path of [cwd, other, dataDir, sessionRootDir, join(root, "mobile")])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(root, "mobile", "index.html"), "<title>Shared Web fixture</title>");
  const settingsFile = join(cwd, ".code-shell", "settings.local.json");
  mkdirSync(join(cwd, ".code-shell"));
  const seed = {
    defaults: { text: "desktop-http-test" },
    credentials: [
      { id: "desktop-http-secret", catalogId: "openai", apiKey: "only-a-synthetic-fixture-secret" },
    ],
    modelConnections: [
      {
        id: "desktop-http-test",
        catalogId: "openai",
        tag: "text",
        model: "fixture-model",
        baseUrl: "http://127.0.0.1:1/v1",
        credentialId: "desktop-http-secret",
      },
    ],
  };
  writeFileSync(settingsFile, JSON.stringify(seed));
  writeFileSync(join(cwd, "hello.txt"), "中文 workspace file\n");
  writeFileSync(join(other, "hello.txt"), "other workspace file\n");
  const devices = new TrustedDeviceStore(join(root, "devices.json"));
  const device = devices.addDevice({
    name: "Browser fixture",
    secretHash: "synthetic-pairing-secret",
  });
  const changed: string[] = [];
  const revoked: string[] = [];
  const running = new Set<string>();
  let busy = false;
  let mutations = 0;
  const api = createDesktopWebApi({
    devices,
    dataDir,
    sessionRootDir,
    resolveWorkspace: (input, id) =>
      id === device.id && [undefined, cwd, other].includes(input) ? (input ?? cwd) : undefined,
    withConfigurationMutation: async (_cwd, write) => {
      if (busy) throw Object.assign(new Error("busy"), { status: 409 });
      const result = await write();
      mutations++;
      return result;
    },
    isRunning: (id) => running.has(id),
    onSessionsChanged: (_cwd, id) => changed.push(id),
    onSessionRevoked: (id) => revoked.push(id),
    ...overrides,
  });
  const host = new RemoteHostManager({
    devices,
    onClientEvent: () => {},
    webApi: api,
    mobileRootDir: join(root, "mobile"),
  });
  let started = await host.start({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const request = (path: string, cookie?: string, options: RequestInit = {}) => {
    const headers = new Headers({
      origin: started.url,
      ...Object.fromEntries(new Headers(options.headers)),
    });
    if (cookie) headers.set("cookie", cookie);
    return fetch(started.url + path, { ...options, headers });
  };
  const login = () =>
    request("/api/v1/desktop/session", undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: device.id, secretHash: "synthetic-pairing-secret" }),
    });
  const authenticate = async () => {
    const response = await login();
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")!.split(";", 1)[0]!;
  };
  const put = (path: string, cookie: string, body: unknown) =>
    request(path, cookie, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    root,
    cwd,
    other,
    dataDir,
    settingsFile,
    seed,
    sessionRootDir,
    devices,
    device,
    host,
    api,
    request,
    login,
    authenticate,
    put,
    changed,
    revoked,
    running,
    setBusy: (value: boolean) => {
      busy = value;
    },
    getMutations: () => mutations,
    origin: () => started.url,
    restart: async () => {
      await host.stop();
      started = await host.start({ host: "127.0.0.1", port: 0 });
    },
  };
}

test("paired credentials exchange a private cookie without creating a Hub account; logout preserves pairing", async () => {
  const f = await fixture();
  expect(await (await f.request("/api/v1/auth/status")).json()).toEqual({
    host: "desktop",
    initialized: true,
    authenticated: false,
  });
  expect((await f.request("/api/v1/configuration")).status).toBe(401);
  const login = await f.login();
  const cookie = login.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly; SameSite=Strict; Max-Age=1800");
  expect(cookie).not.toContain("synthetic-pairing-secret");
  const body = await login.json();
  expect(body).toMatchObject({
    host: "desktop",
    authenticated: true,
    session: { username: "Browser fixture", deviceName: "Browser fixture" },
  });
  expect(JSON.stringify(body)).not.toContain("secret");
  const token = cookie.split(";", 1)[0]!;
  expect((await f.request("/api/v1/auth/status", token)).status).toBe(200);
  expect((await f.request("/api/v1/auth/logout", token, { method: "POST" })).status).toBe(200);
  expect((await f.request("/api/v1/configuration", token)).status).toBe(401);
  expect(f.revoked).toContain(body.session.id);
  expect(f.devices.authenticate(f.device.id, "synthetic-pairing-secret")?.id).toBe(f.device.id);
  expect((await f.request("/mobile/", token)).status).toBe(200);
});

test("rejects foreign, absent, null Origin and forged Host while permitting same-origin file navigation", async () => {
  const f = await fixture();
  const credentials = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: f.device.id, secretHash: "synthetic-pairing-secret" }),
  };
  expect((await fetch(f.origin() + "/api/v1/desktop/session", credentials)).status).toBe(403);
  for (const origin of ["https://attacker.invalid", "null"])
    expect(
      (
        await f.request("/api/v1/desktop/session", undefined, {
          ...credentials,
          headers: { ...credentials.headers, origin },
        })
      ).status,
    ).toBe(403);
  const cookie = await f.authenticate();
  expect(
    (await f.request("/api/v1/configuration", cookie, { headers: { host: "attacker.invalid" } }))
      .status,
  ).toBe(403);
  expect(
    (
      await f.request("/api/v1/configuration", cookie, {
        headers: { "sec-fetch-site": "cross-site" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(f.origin() + "/api/v1/files/content?path=hello.txt", { headers: { cookie } }))
      .status,
  ).toBe(200);
});

test("revoking/removing a paired device and stopping/restarting the host invalidate HTTP sessions", async () => {
  const f = await fixture();
  const cookie = await f.authenticate();
  await f.restart();
  expect((await f.request("/api/v1/configuration", cookie)).status).toBe(401);
  const next = await f.authenticate();
  f.devices.revoke(f.device.id);
  expect((await f.request("/api/v1/configuration", next)).status).toBe(401);
  expect((await f.login()).status).toBe(401);
  const fresh = await fixture();
  const removed = await fresh.authenticate();
  fresh.devices.remove(fresh.device.id);
  expect((await fresh.request("/api/v1/configuration", removed)).status).toBe(401);
});

test("expired HTTP sessions are rejected and can be renewed using an existing pairing", async () => {
  let now = 1000;
  const f = await fixture({ now: () => now, sessionTtlMs: 1000 });
  const cookie = await f.authenticate();
  now = 2000;
  expect((await f.request("/api/v1/configuration", cookie)).status).toBe(401);
  expect((await f.request("/api/v1/configuration", await f.authenticate())).status).toBe(200);
});

test("same-device reconnect refreshes cookie expiry without revoking its probe or Link owner", async () => {
  let now = 1000;
  const f = await fixture({ now: () => now, sessionTtlMs: 1000 });
  const login = await f.login();
  const first = await login.json();
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  now = 1500;
  const refreshed = await f.request("/api/v1/desktop/session", cookie, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: f.device.id, secretHash: "synthetic-pairing-secret" }),
  });
  expect(refreshed.status).toBe(200);
  expect((await refreshed.json()).session.id).toBe(first.session.id);
  expect(refreshed.headers.get("set-cookie")!.split(";", 1)[0]).toBe(cookie);
  expect(f.revoked).toHaveLength(0);
  now = 2000;
  expect((await f.request("/api/v1/configuration", cookie)).status).toBe(200);
  now = 2500;
  expect((await f.request("/api/v1/configuration", cookie)).status).toBe(401);
  expect(f.revoked).toEqual([first.session.id]);
});

test("only authoritative workspaces are exposed; Unicode headers decode once and conflicting query selectors fail", async () => {
  const f = await fixture();
  const cookie = await f.authenticate();
  const header = { "x-codeshell-workspace": encodeURIComponent(f.cwd) };
  const config = await f.request("/api/v1/configuration", cookie, { headers: header });
  expect((await config.json()).workspace.path).toBe(f.cwd);
  const path = "/api/v1/files/content?path=hello.txt&" + new URLSearchParams({ workspace: f.cwd });
  expect(await (await f.request(path, cookie, { headers: header })).text()).toBe(
    "中文 workspace file\n",
  );
  expect(
    (
      await f.request(path, cookie, {
        headers: { "x-codeshell-workspace": encodeURIComponent(f.other) },
      })
    ).status,
  ).toBe(400);
  expect(
    (await f.request("/api/v1/configuration?workspace=" + encodeURIComponent("/etc"), cookie))
      .status,
  ).toBe(403);
  expect((await f.request("/api/v1/configuration?workspace=a&workspace=a", cookie)).status).toBe(
    400,
  );
  expect(
    (
      await f.request("/api/v1/configuration", cookie, {
        headers: { "x-codeshell-workspace": "%GG" },
      })
    ).status,
  ).toBe(400);
  expect(
    await (
      await f.request(
        "/api/v1/files/content?path=hello.txt&" + new URLSearchParams({ workspace: f.other }),
        cookie,
      )
    ).text(),
  ).toBe("other workspace file\n");
});

test("configuration writes use the existing Desktop busy gate, retain revisions, preserve secrets, and share Skills/MCP APIs", async () => {
  const f = await fixture();
  const cookie = await f.authenticate();
  const snapshot = () =>
    f.request("/api/v1/configuration", cookie).then((response) => response.json());
  const first = (await snapshot()).connections.find((row: any) => row.id === "desktop-http-test");
  expect((await snapshot()).connections.find((row: any) => row.id === first.id).revision).toBe(
    first.revision,
  );
  expect(JSON.stringify(first)).not.toContain("synthetic-fixture-secret");
  const update = {
    id: first.id,
    catalogId: "openai",
    model: "second-model",
    expectedRevision: first.revision,
  };
  f.setBusy(true);
  expect((await f.put("/api/v1/configuration/connections", cookie, update)).status).toBe(409);
  expect(JSON.parse(readFileSync(f.settingsFile, "utf8"))).toEqual(f.seed);
  expect(f.getMutations()).toBe(0);
  f.setBusy(false);
  expect((await f.put("/api/v1/configuration/connections", cookie, update)).status).toBe(200);
  expect((await f.put("/api/v1/configuration/connections", cookie, update)).status).toBe(409);
  const current = JSON.parse(readFileSync(f.settingsFile, "utf8"));
  expect(current.credentials[0].apiKey).toBe("only-a-synthetic-fixture-secret");
  expect(f.getMutations()).toBe(1);
  const skill = await f.request("/api/v1/skills/local", cookie, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "desktop-remote-fixture",
      content:
        "---\nname: desktop-remote-fixture\ndescription: fixture\n---\nTemporary instructions.\n",
    }),
  });
  expect(skill.status).toBe(201);
  expect(
    (await (await f.request("/api/v1/skills", cookie)).json()).skills.some(
      (row: any) => row.name === "desktop-remote-fixture",
    ),
  ).toBe(true);
  expect((await f.request("/api/v1/mcp", cookie)).status).toBe(200);
  expect(f.getMutations()).toBe(2);
});

test("queued configuration mutations recheck a revoked identity before writing", async () => {
  const entered = deferred();
  const resume = deferred();
  const f = await fixture({
    withConfigurationMutation: async (_cwd, write) => {
      entered.resolve();
      await resume.promise;
      return write();
    },
  });
  const cookie = await f.authenticate();
  const pending = f.put("/api/v1/configuration/connections", cookie, {
    id: "desktop-http-test",
    catalogId: "openai",
    model: "must-not-write",
  });
  await entered.promise;
  f.devices.revoke(f.device.id);
  resume.resolve();
  expect((await pending).status).toBe(401);
  expect(JSON.parse(readFileSync(f.settingsFile, "utf8"))).toEqual(f.seed);
});

test("the shared session API uses Desktop's existing history and custom titles", async () => {
  const f = await fixture();
  const manager = new SessionManager(f.sessionRootDir);
  const { state } = manager.create(f.cwd, "model", "provider");
  const other = manager.create(f.other, "model", "provider").state;
  const cookie = await f.authenticate();
  const list = await (await f.request("/api/v1/sessions", cookie)).json();
  expect(list.sessions.map((row: any) => row.sessionId)).toEqual([state.sessionId]);
  expect((await f.request(`/api/v1/sessions/${other.sessionId}`, cookie)).status).toBe(404);
  const response = await f.request(`/api/v1/sessions/${state.sessionId}`, cookie, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Desktop shared title", expectedTitle: null }),
  });
  expect(response.status).toBe(200);
  expect(
    JSON.parse(readFileSync(join(f.dataDir, "session-titles.json"), "utf8"))[state.sessionId],
  ).toBe("Desktop shared title");
  expect(f.changed).toEqual([state.sessionId]);
  f.running.add(state.sessionId);
  expect(
    (
      await f.request(`/api/v1/sessions/${state.sessionId}`, cookie, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      })
    ).status,
  ).toBe(409);
});

test("the tunnel passcode still gates auth exchange, including secure public-origin cookies", async () => {
  const f = await fixture();
  await f.host.stop();
  const passcode = new AccessPasscode({ filePath: join(f.root, "passcode.json") });
  passcode.set("fixture-passcode");
  const started = await f.host.start({ host: "127.0.0.1", port: 0, mode: "tunnel", passcode });
  f.host.setPublicBaseUrl("https://desktop.example.test");
  const params = {
    method: "POST",
    headers: {
      host: "desktop.example.test",
      origin: "https://desktop.example.test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId: f.device.id, secretHash: "synthetic-pairing-secret" }),
  };
  expect((await fetch(started.url + "/api/v1/desktop/session", params)).status).toBe(401);
  const token = passcode.verify("fixture-passcode")!;
  const authorized = await fetch(started.url + "/api/v1/desktop/session", {
    ...params,
    headers: { ...params.headers, cookie: `cs_access=${token}` },
  });
  expect(authorized.status).toBe(200);
  expect(authorized.headers.get("set-cookie")).toContain("; Secure");
});

test("logout cancels a real local model probe and forwards extra-route lifecycle ownership", async () => {
  const entered = deferred();
  const model: Server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    entered.resolve();
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
  });
  let owner: string | undefined;
  let stopped = 0;
  const f = await fixture({
    handleExtra: async (_req, res, context) => {
      owner = context.sessionId;
      expect(await context.isAuthorized()).toBe(true);
      res.end("extra route");
      return true;
    },
    onClose: () => {
      stopped++;
    },
  });
  const seed = structuredClone(f.seed);
  Object.assign(seed.modelConnections[0]!, {
    baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
  });
  writeFileSync(f.settingsFile, JSON.stringify(seed));
  const cookie = await f.authenticate();
  expect(await (await f.request("/api/v1/extra", cookie)).text()).toBe("extra route");
  const pending = f.request("/api/v1/configuration/connections/probe", cookie, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "desktop-http-test" }),
  });
  await Promise.race([
    entered.promise,
    pending.then(async (response) => {
      throw new Error(
        `Probe returned before reaching local fixture: ${response.status} ${JSON.stringify(await response.json())}`,
      );
    }),
  ]);
  expect((await f.request("/api/v1/auth/logout", cookie, { method: "POST" })).status).toBe(200);
  expect((await pending).status).toBe(401);
  expect(f.revoked).toContain(owner!);
  await f.host.stop();
  expect(stopped).toBe(1);
}, 10_000);
