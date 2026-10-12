import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import type { CloudAccountStore, SavedCloudAccount } from "./cloud-account-store.js";
import type { CloudManagementRequest } from "../shared/cloud-management.js";

let unexpectedRequests = 0;
const deny = () => {
  unexpectedRequests++;
  throw new Error("Cloud manager fixture denies network");
};
globalThis.fetch = deny as never;
http.request = http.get = https.request = https.get = deny as never;
net.connect = net.createConnection = tls.connect = deny as never;
syncBuiltinESMExports();
assert.throws(() => https.request("https://fixture.invalid"));
assert.throws(() => net.connect(9, "127.0.0.1"));
assert.equal(unexpectedRequests, 2);
unexpectedRequests = 0;
assert.equal(process.env.NODE_ENV, "test");
assert.ok(process.env.CODE_SHELL_TEST_HOME?.startsWith(`${process.env.HOME}/`));
const { CloudAccountManager } = await import("./cloud-account-manager.js");
const { CloudManagementManager } = await import("./cloud-management-manager.js");
const { cloudManagementRequest, cloudProject, managedCloudGrant, managedCloudPartition } =
  await import("./cloud-management-contract.js");
const { CloudManagementHttpError } = await import("./cloud-management-http.js");
const token = () => randomBytes(32).toString("base64url");
const accountOrigin = "https://account.example",
  cloudOrigin = "https://cloud.example";
const accountId = randomUUID(),
  projectId = randomUUID(),
  installationId = randomUUID();
const request = { accountOrigin, accountId, cloudOrigin, action: "list" as const };
let clock = Date.now();
const makeAccount = (): SavedCloudAccount => ({
  origin: accountOrigin,
  kind: "account",
  audience: accountOrigin,
  accessToken: token(),
  refreshToken: token(),
  accessTokenExpiresAt: clock + 600_000,
  refreshTokenExpiresAt: clock + 86_400_000,
  sessionId: randomUUID(),
  account: { id: accountId, username: "alice" },
});
let saved = makeAccount();
const rootToken = saved.accessToken;
const project = {
  id: projectId,
  name: "Private project",
  status: "stopped",
  generation: 0,
  createdAt: clock,
  updatedAt: clock,
};
const view = () => ({
  runtime: "docker",
  available: true,
  projects: [{ ...project, runtimePassword: "must-not-cross" }],
  token: "must-not-cross",
});
const makeGrant = () => ({
  token: token(),
  session: {
    id: randomUUID(),
    kind: "cloud-management",
    audience: cloudOrigin,
    accountOrigin,
    accountId,
    installationId,
    managementEpoch: randomUUID(),
    expiresAt: clock + 600_000,
    rootSessionId: "must-not-cross",
    ownerId: "must-not-cross",
  },
});
const accountCalls: any[] = [];
const issuedTickets = new Set<string>();
const calls: any[] = [],
  closed: string[] = [],
  opened: any[] = [];
let owned = true,
  failClose = false,
  failLogout = false,
  failList = false;
let exchangeWait: ReturnType<typeof deferred> | undefined,
  listWait: ReturnType<typeof deferred> | undefined;
function deferred() {
  let resolve!: (v: any) => void;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const account = new CloudAccountManager({
  store: {
    load: () => saved,
    preflight: () => {},
    save: (value) => {
      saved = value;
    },
    forget: () => {
      saved = undefined as never;
    },
  } as unknown as CloudAccountStore,
  changed: () => {},
  openExternal: async () => {},
  now: () => clock,
  retireRelay: (identity) => manager.retireAccount(identity),
  request: async (input) => {
    accountCalls.push(input);
    assert.equal(input.origin, accountOrigin);
    if (input.path.endsWith("/tickets")) {
      assert.equal(input.token, saved.accessToken);
      assert.deepEqual(input.body, { cloudOrigin, installationId });
      if (scenario === "ticket-denied") throw new Error("Target is not configured");
      const ticket = token();
      issuedTickets.add(ticket);
      return {
        ticket,
        expiresAt: clock + 60_000,
        accountOrigin,
        cloudOrigin,
        installationId: scenario === "ticket-identity" ? randomUUID() : installationId,
        rootToken: "must-not-cross",
      };
    }
    return input.path.endsWith("/login")
      ? makeAccount()
      : input.path.endsWith("/refresh")
        ? { ...saved, accessToken: token(), accessTokenExpiresAt: clock + 600_000 }
        : { revoked: true };
  },
});
const manager = new CloudManagementManager({
  account,
  now: () => clock,
  windows: {
    open: async (input) => {
      assert.equal(input.authorized(), true);
      opened.push(input);
      return { address: `${cloudOrigin}/?project=${input.projectId}` };
    },
    close: async (partition) => {
      closed.push(partition);
      if (failClose) throw new Error("cookie cleanup failed");
    },
  },
  request: async (input) => {
    calls.push(input);
    assert.equal(input.origin, cloudOrigin);
    assert.ok(
      !JSON.stringify(input).includes(rootToken),
      "Root credential must never reach Cloud origin",
    );
    if (input.path.endsWith("/capabilities")) {
      assert.equal(input.token, undefined);
      assert.equal(input.body, undefined);
      return {
        version: 2,
        mode: "cloud-account",
        cloudOrigin,
        accountOrigin: scenario === "foreign-capability" ? "https://evil.example" : accountOrigin,
        installationId,
      };
    }
    if (input.path.endsWith("/session")) {
      assert.equal(input.token, undefined);
      assert.deepEqual(Object.keys(input.body as object), ["ticket"]);
      assert.ok(issuedTickets.delete((input.body as any).ticket));
      return exchangeWait ? exchangeWait.promise : makeGrant();
    }
    assert.match(input.token!, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(input.token, rootToken);
    assert.ok(!(JSON.stringify(input.body) ?? "").includes(rootToken));
    if (input.path.endsWith("/logout")) {
      if (failLogout) throw new Error("lost revoke acknowledgement");
      return { revoked: true };
    }
    if (input.method === "GET") {
      if (failList) throw new CloudManagementHttpError(401);
      return listWait ? listWait.promise : view();
    }
    if (input.path === "/api/v1/projects")
      return { project: { ...project, runtimePassword: "must-not-cross" } };
    if (input.path.endsWith("/start")) project.status = "running";
    if (input.path.endsWith("/stop")) project.status = "stopped";
    return {
      project: { ...project },
      ...(input.path.endsWith("/open") ? { url: `${cloudOrigin}/?project=${projectId}` } : {}),
    };
  },
});
const send = (input: CloudManagementRequest = request) => manager.manage(input, () => owned);
const tick = () => new Promise((done) => setImmediate(done));
const scenario = process.argv[2];
try {
  if (scenario === "contract") {
    assert.deepEqual(cloudManagementRequest(request), request);
    for (const bad of [
      { ...request, path: "/global" },
      { ...request, cloudOrigin: "http://127.0.0.1" },
      { ...request, accountId: "bad" },
      { ...request, action: "create", name: "x", cwd: "/" },
      { ...request, action: "open", projectId: "../x" },
    ])
      assert.throws(() => cloudManagementRequest(bad));
    assert.deepEqual(cloudProject({ ...project, runtimePassword: rootToken }), project);
    const g = makeGrant(),
      projected = managedCloudGrant(g, request, clock);
    assert.ok(!JSON.stringify(projected).includes("must-not-cross"));
    for (const changed of [
      { audience: "https://other.example" },
      { accountId: randomUUID() },
      { expiresAt: clock + 600_001 },
      { kind: "device" },
    ])
      assert.throws(() =>
        managedCloudGrant({ ...g, session: { ...g.session, ...changed } }, request, clock),
      );
    const partition = managedCloudPartition(projected);
    for (const changed of [
      { id: randomUUID() },
      { managementEpoch: randomUUID() },
      { accountOrigin: "https://other.example" },
      { accountId: randomUUID() },
      { audience: "https://other.example" },
    ])
      assert.notEqual(
        managedCloudPartition({ ...projected, session: { ...projected.session, ...changed } }),
        partition,
      );
    assert.equal(calls.length, 0);
  } else if (["foreign-capability", "ticket-denied", "ticket-identity"].includes(scenario)) {
    await assert.rejects(send());
    assert.equal(calls.filter((c) => c.path.endsWith("/session")).length, 0);
    assert.equal(opened.length, 0);
    assert.equal(accountCalls.length, scenario === "foreign-capability" ? 0 : 1);
  } else if (scenario === "lifecycle") {
    assert.equal(calls.length, 0);
    const result = await send();
    assert.equal(result.action, "list");
    assert.ok(!JSON.stringify(result).includes("must-not-cross"));
    await send({ ...request, action: "create", name: "Work" });
    await send({ ...request, action: "start", projectId });
    assert.equal(
      ((await send({ ...request, action: "open", projectId })) as any).address,
      `${cloudOrigin}/?project=${projectId}`,
    );
    assert.equal(opened.length, 1);
    assert.equal(opened[0].grant.session.accountId, accountId);
    await send({ ...request, action: "stop", projectId });
    assert.equal(calls.filter((c) => c.path.endsWith("/session")).length, 1);
    assert.deepEqual(await send({ ...request, action: "logout" }), {
      action: "logout",
      revoked: true,
    });
    assert.equal(closed.length, 1);
    assert.equal(account.status().state, "signed-in");
  } else if (scenario === "late-exchange") {
    exchangeWait = deferred();
    const pending = send();
    await tick();
    await account.logout();
    exchangeWait.resolve(makeGrant());
    await assert.rejects(pending);
    await tick();
    assert.equal(opened.length, 0);
    assert.equal(calls.filter((c) => c.path === "/api/v1/projects").length, 0);
    assert.equal(calls.filter((c) => c.path.endsWith("/logout")).length, 1);
  } else if (scenario === "same-account-relogin") {
    await send();
    listWait = deferred();
    const pending = send();
    await tick();
    await account.logout();
    await account.signIn("login", {
      origin: accountOrigin,
      username: "alice",
      password: "fixture-password",
    });
    listWait.resolve(view());
    await assert.rejects(pending);
    assert.ok(closed.length > 0);
    listWait = undefined;
    await send();
    assert.equal(calls.filter((c) => c.path.endsWith("/session")).length, 2);
  } else if (scenario === "unknown-revoke") {
    await send();
    failLogout = true;
    await assert.rejects(send({ ...request, action: "logout" }), /未确认/);
    await assert.rejects(send({ ...request, action: "logout" }), /未确认/);
    assert.equal(opened.length, 0);
    assert.equal(account.status().state, "signed-in");
    failLogout = false;
    assert.equal((await send({ ...request, action: "logout" })).action, "logout");
    assert.equal(calls.filter((c) => c.path.endsWith("/logout")).length, 3);
  } else if (scenario === "cleanup-failure") {
    await send();
    failClose = true;
    await assert.rejects(send({ ...request, action: "logout" }), /cleanup/);
    failClose = false;
    await send({ ...request, action: "logout" });
    assert.equal(closed.length, 2);
  } else if (scenario === "expiry-and-rejection") {
    await send();
    clock += 600_001;
    await send();
    assert.equal(closed.length, 1);
    failList = true;
    await assert.rejects(send(), /授权已失效/);
    assert.equal(closed.length, 2);
  } else if (scenario === "owner-loss") {
    exchangeWait = deferred();
    const pending = send();
    await tick();
    owned = false;
    exchangeWait.resolve(makeGrant());
    await assert.rejects(pending);
    await tick();
    assert.equal(opened.length, 0);
    assert.equal(calls.filter((c) => c.path.endsWith("/logout")).length, 1);
  } else throw new Error(`Unknown scenario: ${scenario}`);
} finally {
  failLogout = false;
  failClose = false;
  await manager.retireAccount({ origin: accountOrigin, accountId });
}
assert.equal(unexpectedRequests, 0);
console.log(JSON.stringify({ scenario, passed: true, unexpectedRequests }));
