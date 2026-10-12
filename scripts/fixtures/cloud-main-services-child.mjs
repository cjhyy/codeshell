import assert from "node:assert/strict";
import { createServer as createHttpsServer } from "node:https";
import { createServer, request } from "node:http";
import { request as secureRequest } from "node:https";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { installCloudMainGuard } from "./cloud-main-services-guard.mjs";

const isolation = installCloudMainGuard();
// Real compiled Desktop Main and packed Server are imported only after confinement.
const {
  CloudAccountManager,
  createCloudAccountTransport,
  CloudManagementManager,
  createCloudManagementTransport,
} = await import("./adapters.mjs");
const serve = await import("@cjhyy/code-shell-server/serve");
const { startCloudControl } = await import("./apps/cloud-control/server.mjs");
const { createAccountService } = await import("./apps/account-server/http.mjs");
assert.equal(serve.CLOUD_MANAGEMENT_AUTHORITY_VERSION, 2);
const root = process.argv[2];
const pem = (name) => readFile(join(root, name));
const accountCA = await pem("account-ca.pem"),
  cloudCA = await pem("cloud-ca.pem");
const accountTls = { cert: await pem("account.pem"), key: await pem("account.key") };
const cloudTls = { cert: await pem("cloud.pem"), key: await pem("cloud.key") };
const secret = randomBytes(32).toString("hex"),
  password = randomBytes(24).toString("hex");
let backend, service, cloudManager, foreignManager, pause;
const cloudRequests = [],
  accountRequests = [],
  runtimeRecords = [],
  windows = new Map();
const servers = [],
  sockets = new Set(),
  pending = new Set();
const own = (server) => {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return server;
};
const listen = (server) =>
  new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      done();
    });
  });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const waitFor = async (check) => {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("Owned interop operation did not settle");
};
function gate() {
  let release;
  const promise = new Promise((done) => {
    release = done;
  });
  return { promise, release, entered: false };
}
function record(req, target) {
  const row = { path: req.url, headers: { ...req.headers }, body: "" };
  target.push(row);
  // Observe data without switching the request to flowing mode before the real
  // Account handler has awaited its private-route check and installed readJson.
  const emit = req.emit;
  req.emit = function (event, ...args) {
    if (event === "data") row.body += args[0];
    return emit.call(this, event, ...args);
  };
  req.on("error", () => {});
  return row;
}
const accountServer = own(
  createHttpsServer(accountTls, (req, res) => {
    const row = record(req, accountRequests);
    const end = res.end.bind(res);
    res.end = (chunk, ...rest) => {
      if (res.statusCode >= 400 && typeof chunk === "string") {
        try {
          const code = JSON.parse(chunk).error;
          if (/^[a-z_]+$/.test(code)) row.problem = code;
        } catch {}
      }
      return end(chunk, ...rest);
    };
    void service.handle(req, res).then((handled) => {
      if (!handled && !res.writableEnded) {
        res.writeHead(404);
        res.end();
      }
    });
  }),
);
const front = own(
  createHttpsServer(cloudTls, (req, res) => {
    record(req, cloudRequests);
    if (!backend) {
      res.writeHead(503);
      res.end();
      return;
    }
    const upstream = request(
      new URL(req.url, backend.url),
      { method: req.method, headers: req.headers },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(503);
      res.end();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  }),
);
let accountOrigin, cloudOrigin;
const runtime = own(
  createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* private runtime has no model worker */
    }
    if (req.url === "/api/v1/auth/login")
      res.setHeader(
        "Set-Cookie",
        `cs_hub_session=${randomBytes(32).toString("base64url")}; Path=/; HttpOnly`,
      );
    res.end("{}");
  }),
);
const running = new Set();
let stopped = 0;
const provider = {
  async availability() {
    return { available: true };
  },
  async ensure(project) {
    runtimeRecords.push({ ...project });
    if (pause) {
      pause.entered = true;
      await pause.promise;
    }
    running.add(project.id);
    return {
      url: `http://127.0.0.1:${runtime.address().port}`,
      username: project.runtimeUsername,
      password: project.runtimePassword,
      generation: project.generation,
    };
  },
  async status(project) {
    return running.has(project.id)
      ? { state: "running", url: `http://127.0.0.1:${runtime.address().port}` }
      : { state: "stopped" };
  },
  async stop(project) {
    stopped++;
    running.delete(project.id);
  },
  async close() {},
};
const base = {
  host: "127.0.0.1",
  port: 0,
  publicOrigin: cloudOrigin,
  dataDir: join(root, "cloud-data"),
  provider,
};
await mkdir(base.dataDir, { mode: 0o700 });
const rawCloud = (path, body, cookie) =>
  new Promise((done, reject) => {
    const req = secureRequest(
      cloudOrigin + path,
      {
        ca: cloudCA,
        method: "POST",
        headers: {
          Origin: cloudOrigin,
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (part) => chunks.push(part));
        res.on("end", () =>
          done({
            status: res.statusCode,
            cookie: res.headers["set-cookie"]?.[0].split(";", 1)[0],
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
const saved = { owner: undefined, foreign: undefined };
const accountTransport = createCloudAccountTransport(accountCA);
const cloudTransport = createCloudManagementTransport(cloudCA);
const account = (name, retire) =>
  new CloudAccountManager({
    store: {
      load: () => saved[name],
      save: (value) => {
        saved[name] = value;
      },
      forget: () => {
        saved[name] = undefined;
      },
      preflight() {},
    },
    request: accountTransport,
    openExternal: async () => assert.fail("No OAuth/browser process is allowed"),
    changed() {},
    retireRelay: retire,
  });
const owner = account("owner", (identity) => cloudManager?.retireAccount(identity));
const foreign = account("foreign", (identity) => foreignManager?.retireAccount(identity));
const windowAdapter = {
  async open({ grant, projectId, authorized }) {
    assert.equal(authorized(), true);
    windows.set(grant.session.id, grant);
    return { address: `${cloudOrigin}/?project=${projectId}` };
  },
  async close() {
    windows.clear();
  },
};
let receipt,
  failure,
  phase = "owned listener startup";
try {
  await listen(accountServer);
  await listen(front);
  await listen(runtime);
  accountOrigin = `https://127.0.0.1:${accountServer.address().port}`;
  cloudOrigin = `https://127.0.0.1:${front.address().port}`;
  base.publicOrigin = cloudOrigin;
  phase = "legacy setup";
  backend = await startCloudControl(base);
  const legacy = await rawCloud("/api/v1/auth/setup", {
    token: backend.bootstrapToken,
    username: "legacy.main.operator",
    password,
  });
  assert.equal(legacy.status, 200);
  const existing = await rawCloud(
    "/api/v1/projects",
    { name: "Retained Main project" },
    legacy.cookie,
  );
  assert.equal(existing.status, 201);
  await backend.close();
  backend = undefined;
  const inspected = serve.inspectCloudAccountAdoption(base.dataDir);
  service = await createAccountService({
    publicOrigin: accountOrigin,
    dataDir: join(root, "account-data"),
    allowRegistration: true,
    cloudManagementOrigin: cloudOrigin,
    cloudManagementInstallationId: inspected.installationId,
    cloudManagementSecret: secret,
  });
  const beforeWrongCA = accountRequests.length;
  await assert.rejects(
    createCloudAccountTransport(cloudCA)({
      origin: accountOrigin,
      path: "/api/v1/account/login",
      body: { username: "unused", password },
    }),
  );
  assert.equal(
    accountRequests.length,
    beforeWrongCA,
    "wrong CA must fail before password delivery",
  );
  phase = "owner registration";
  const identity = await owner.signIn("register", {
    origin: accountOrigin,
    username: "main.interop.owner",
    password,
  });
  phase = "foreign registration";
  const otherIdentity = await foreign.signIn("register", {
    origin: accountOrigin,
    username: "main.interop.foreign",
    password,
  });
  const credentials = [
    saved.owner.accessToken,
    saved.owner.refreshToken,
    saved.foreign.accessToken,
    saved.foreign.refreshToken,
  ];
  serve.adoptCloudAccount({
    dataDir: base.dataDir,
    evidenceDirectory: join(root, "authority-evidence"),
    accountOrigin,
    accountId: identity.account.id,
    installationId: inspected.installationId,
    ownerId: inspected.owners[0].id,
    legacyUsername: "legacy.main.operator",
  });
  backend = await startCloudControl({ ...base, cloudAccount: { accountOrigin, secret } });
  const beforeCloudWrongCA = cloudRequests.length;
  await assert.rejects(
    createCloudManagementTransport(accountCA)({
      origin: cloudOrigin,
      path: "/api/v1/cloud-management/capabilities",
      method: "GET",
    }),
  );
  assert.equal(cloudRequests.length, beforeCloudWrongCA);
  cloudManager = new CloudManagementManager({
    account: owner,
    request: cloudTransport,
    windows: windowAdapter,
  });
  foreignManager = new CloudManagementManager({
    account: foreign,
    request: cloudTransport,
    windows: windowAdapter,
  });
  const manage = (action, values = {}) =>
    cloudManager.manage(
      { accountOrigin, accountId: identity.account.id, cloudOrigin, action, ...values },
      () => true,
    );
  phase = "Main project list";
  const listed = await manage("list");
  assert.equal(listed.projects[0].id, existing.body.project.id);
  phase = "Main project create";
  const created = await manage("create", { name: "Real Desktop HTTPS project" });
  const projectId = created.project.id;
  phase = "Main project start";
  assert.equal((await manage("start", { projectId })).project.status, "running");
  phase = "Main project open";
  const opened = await manage("open", { projectId });
  assert.equal(opened.address, `${cloudOrigin}/?project=${projectId}`);
  assert.equal(windows.size, 1);
  if (process.env.CLOUD_MAIN_FAIL_AFTER_OPEN === "1") {
    assert.equal(running.size, 1);
    phase = "injected after actual Main start/open";
    throw new Error("Expected interop cleanup fault");
  }
  assert.equal((await manage("stop", { projectId })).project.status, "stopped");
  phase = "wrong target pin";
  const lease = owner.captureRootAccount(accountOrigin, identity.account.id, () => true);
  await assert.rejects(lease.ticket(cloudOrigin, randomUUID()), (error) => error.status === 403);
  await assert.rejects(
    foreignManager.manage(
      { accountOrigin, accountId: otherIdentity.account.id, cloudOrigin, action: "list" },
      () => true,
    ),
    (error) => error.status === 403,
  );
  phase = "separate ticket redemption";
  const singleUse = await lease.ticket(cloudOrigin, inspected.installationId);
  const separateGrant = await cloudTransport({
    origin: cloudOrigin,
    path: "/api/v1/cloud-management/session",
    method: "POST",
    body: { ticket: singleUse.ticket },
  });
  await assert.rejects(
    cloudTransport({
      origin: cloudOrigin,
      path: "/api/v1/cloud-management/session",
      method: "POST",
      body: { ticket: singleUse.ticket },
    }),
    (error) => error.status === 401,
  );
  phase = "late start and logout";
  pause = gate();
  const late = manage("start", { projectId }).then(
    () => ({ accepted: true }),
    () => ({ accepted: false }),
  );
  pending.add(late);
  late.finally(() => pending.delete(late));
  await waitFor(() => pause.entered);
  await owner.logout();
  assert.equal(owner.status().state, "signed-out");
  assert.equal(windows.size, 0);
  assert.equal((await late).accepted, false);
  pause.release();
  await waitFor(() => stopped >= 2 && running.size === 0);
  await assert.rejects(
    cloudTransport({
      origin: cloudOrigin,
      path: "/api/v1/projects",
      method: "GET",
      token: separateGrant.token,
    }),
    (error) => error.status === 401,
  );
  assert.throws(() => lease.current());
  await assert.rejects(async () => manage("list"));
  for (const credential of credentials)
    assert.equal(
      JSON.stringify(cloudRequests).includes(credential),
      false,
      "root credentials must never reach Cloud",
    );
  for (const record of runtimeRecords)
    for (const credential of [...credentials, separateGrant.token, singleUse.ticket, secret])
      assert.equal(JSON.stringify(record).includes(credential), false);
  for (const row of cloudRequests.filter(
    (row) => row.path === "/api/v1/cloud-management/session",
  )) {
    assert.equal(row.headers.origin, undefined);
    assert.equal(row.headers.cookie, undefined);
    assert.equal(row.headers.authorization, undefined);
    assert.equal(row.headers["sec-fetch-site"], undefined);
    assert.deepEqual(Object.keys(JSON.parse(row.body)), ["ticket"]);
  }
  for (const row of accountRequests.filter(
    (row) => row.path === "/api/v1/account/cloud-management/tickets",
  )) {
    assert.equal(row.headers.origin, accountOrigin);
    assert.equal(row.headers.host, new URL(accountOrigin).host);
    assert.ok(row.headers.authorization?.startsWith("Bearer "));
  }
  assert.ok(accountRequests.some((row) => row.path === "/api/v1/account/logout"));
  receipt = {
    status: "passed",
    runtime: process.version,
    isolation,
    actualMainManagersAndHttpsTransports: true,
    twoPrivateCaOrigins: true,
    wrongCaRefusedBeforeCredentialDelivery: true,
    actualAccountServiceAndCloudComposition: true,
    listCreateStartOpenStop: true,
    rootCredentialsNeverAtCloud: true,
    ticketReplayWrongPinForeignRefused: true,
    actualRootLogoutRevokedIndependentGrant: true,
    lateMainOperationRejectedAndRuntimeStopped: true,
    nativeSessionHeadersAndFixedAccountTicketOrigin: true,
    requestCounts: { account: accountRequests.length, cloud: cloudRequests.length },
    controlledRuntimeProvider: true,
    nativeElectronWindow: false,
    docker: false,
    physicalMobile: false,
  };
} catch (error) {
  failure = new Error(
    `Interop phase ${phase} failed (${error?.constructor?.name}/${error?.status ?? "unknown"}; Account problem ${accountRequests.at(-1)?.problem ?? "none"}): ${error?.message}`,
  );
  receipt = {
    status: phase === "injected after actual Main start/open" ? "injected-failure" : "failed",
    phase,
  };
} finally {
  pause?.release();
  await Promise.allSettled([...pending]);
  await Promise.allSettled([cloudManager?.dispose(), foreignManager?.dispose()]);
  await Promise.allSettled([owner.logout(), foreign.logout()]);
  await backend?.close();
  await service?.close();
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  await waitFor(() => sockets.size === 0);
  assert.equal(running.size, 0);
  assert.equal(windows.size, 0);
  assert.equal(pending.size, 0);
  if (receipt) {
    receipt.runtime = process.version;
    receipt.ownedListenersAndSocketsClosed = true;
    receipt.ownedRuntimeAndWindowsClosed = true;
  }
}
console.log(JSON.stringify(receipt));
if (failure) throw failure;
