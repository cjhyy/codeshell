import { deviceAcceptanceServer } from "./account-device-server.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
const root = process.argv[2];
const { CloudAccountManager } = await import(`${root}/cloud-account-manager.js`);
const { createCloudAccountTransport } = await import(`${root}/cloud-account-http.js`);
const token = () => randomBytes(32).toString("base64url");
const cert = await readFile(join(root, "cert.pem")),
  key = await readFile(join(root, "key.pem"));
const requests = [];
const installationId = randomUUID(),
  projectId = randomUUID();
let managementTicket, managementToken;
const project = {
  id: projectId,
  name: "fixture",
  status: "running",
  generation: 1,
  createdAt: 1,
  updatedAt: 1,
};
let active,
  saved,
  redirectTargetRequests = 0,
  mode = "normal";
const devices = deviceAcceptanceServer(root, projectId, () => ({
  origin,
  token: active?.accessToken,
}));
const server = createServer({ cert, key }, async (req, res) => {
  req.on("error", () => {});
  res.on("error", () => {});
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  requests.push({ url: req.url, token: req.headers.authorization, body });
  assert.equal(
    req.headers.origin,
    req.url === "/api/v1/cloud-management/session" ? undefined : origin,
  );
  if (req.url === "/api/v1/account/leak") {
    redirectTargetRequests++;
    res.end("{}");
    return;
  }
  if (mode === "redirect") {
    res.writeHead(307, { Location: `${origin}/api/v1/account/leak` });
    res.end("{}");
    return;
  }
  if (mode === "oversized") {
    res.end(JSON.stringify({ value: "x".repeat(20_000) }));
    return;
  }
  res.setHeader("Content-Type", "application/json");
  const deviceReply = devices.response(req, body);
  if (deviceReply) {
    res.end(JSON.stringify(deviceReply));
    return;
  }
  if (req.url === "/api/v1/cloud-management/capabilities") {
    assert.equal(req.headers.authorization, undefined);
    res.end(
      JSON.stringify({
        version: 2,
        mode: "cloud-account",
        cloudOrigin: origin,
        accountOrigin: origin,
        installationId,
      }),
    );
    return;
  }
  if (req.url === "/api/v1/account/cloud-management/tickets") {
    assert.equal(req.headers.authorization, "Bearer " + active.accessToken);
    assert.deepEqual(body, { cloudOrigin: origin, installationId });
    managementTicket = token();
    res.end(
      JSON.stringify({
        ticket: managementTicket,
        cloudOrigin: origin,
        accountOrigin: origin,
        installationId,
        expiresAt: Date.now() + 30_000,
      }),
    );
    return;
  }
  if (req.url === "/api/v1/cloud-management/session") {
    assert.equal(req.headers.authorization, undefined);
    assert.deepEqual(body, { ticket: managementTicket });
    managementTicket = undefined;
    managementToken = token();
    res.end(
      JSON.stringify({
        token: managementToken,
        session: {
          id: randomUUID(),
          kind: "cloud-management",
          audience: origin,
          installationId,
          accountOrigin: origin,
          accountId: active.account.id,
          managementEpoch: randomUUID(),
          expiresAt: Date.now() + 60_000,
        },
      }),
    );
    return;
  }
  if (req.url === "/api/v1/projects" || req.url === "/api/v1/projects/" + projectId + "/open") {
    assert.equal(req.headers.authorization, "Bearer " + managementToken);
    res.end(
      JSON.stringify(
        req.url.endsWith("/open")
          ? { project, url: origin + "/?project=" + projectId }
          : { runtime: "docker", available: true, projects: [project] },
      ),
    );
    return;
  }
  if (req.url === "/api/v1/cloud-management/logout") {
    assert.equal(req.headers.authorization, "Bearer " + managementToken);
    res.end('{"revoked":true}');
    return;
  }
  if (req.url === "/api/v1/account/overview") {
    assert.equal(req.headers.authorization, "Bearer " + active.accessToken);
    res.end(
      JSON.stringify({ account: { ...active.account, displayName: "Fixture" }, features: {} }),
    );
    return;
  }
  if (req.url === "/api/v1/account/status") {
    res.end(
      JSON.stringify({
        registrationAllowed: false,
        githubEnabled: false,
        browserLoginEnabled: true,
      }),
    );
    return;
  }
  if (req.url === "/api/v1/account/browser/start") {
    res.end(
      JSON.stringify({
        authorizationUrl: origin + "/desktop-login?request=" + token(),
        receipt: token(),
        expiresAt: Date.now() + 60_000,
      }),
    );
    return;
  }
  if (req.url === "/api/v1/account/browser/cancel") {
    res.end("{}");
    return;
  }
  if (req.url === "/api/v1/account/login" || req.url === "/api/v1/account/browser/poll") {
    if (req.url.endsWith("/login")) {
      assert.equal(body.username, "alice");
      assert.equal(body.password, "native fixture password");
    } else {
      assert.match(body.receipt, /^[A-Za-z0-9_-]{43}$/);
      assert.match(body.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
    }
    active = {
      accessToken: token(),
      refreshToken: token(),
      accessTokenExpiresAt: Date.now() + 1000,
      refreshTokenExpiresAt: Date.now() + 86400_000,
      sessionId: randomUUID(),
      account: { id: randomUUID(), username: "alice" },
      kind: "account",
      audience: origin,
    };
    res.end(JSON.stringify(active));
  } else if (req.url === "/api/v1/account/refresh") {
    assert.equal(body.refreshToken, active.refreshToken);
    active = {
      ...active,
      accessToken: token(),
      refreshToken: token(),
      accessTokenExpiresAt: Date.now() + 600_000,
    };
    res.end(JSON.stringify(active));
  } else if (req.url === "/api/v1/account/logout") {
    assert.equal(req.headers.authorization, `Bearer ${active.accessToken}`);
    res.end('{"ok":true}');
  } else {
    res.writeHead(404);
    res.end("{}");
  }
});
devices.bind(server);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `https://127.0.0.1:${server.address().port}`;
const transport = createCloudAccountTransport(cert);
const manager = new CloudAccountManager({
  store: {
    load: () => saved,
    save: (value) => {
      saved = value;
    },
    forget: () => {
      saved = undefined;
    },
    preflight: () => {},
  },
  request: transport,
  openExternal: async () => {
    assert.fail("password login must not launch a browser");
  },
  changed: () => {},
});
try {
  assert.equal(manager.status().state, "signed-out");
  assert.equal(requests.length, 0);
  await assert.rejects(
    createCloudAccountTransport()({ origin, path: "/api/v1/account/login", body: {} }),
  );
  assert.equal(requests.length, 0, "untrusted TLS cannot deliver a password");
  await manager.signIn("login", { origin, username: "alice", password: "native fixture password" });
  const oldAccess = active.accessToken;
  const values = await Promise.all([manager.getCredential(origin), manager.getCredential(origin)]);
  assert.equal(values[0], active.accessToken);
  assert.equal(values[1], active.accessToken);
  assert.notEqual(active.accessToken, oldAccess);
  assert.equal(requests.filter((req) => req.url.endsWith("refresh")).length, 1);
  saved.accessTokenExpiresAt = Date.now() - 1000;
  assert.deepEqual(await manager.logout(), { state: "signed-out", revocation: "confirmed" });
  assert.equal(saved, undefined);
  assert.equal(manager.status().state, "signed-out");
  assert.equal(
    requests.filter((req) => req.url.endsWith("refresh")).length,
    2,
    "expired logout refreshes before server revocation",
  );
  const { exerciseHostedAccount } = await import(`${root}/cloud-account-hosted.js`);
  await exerciseHostedAccount({
    origin,
    ca: cert,
    root,
    projectId,
    token: () => active.accessToken,
  });
  devices.finish();
  mode = "redirect";
  await assert.rejects(transport({ origin, path: "/api/v1/account/login", body: {} }));
  assert.equal(redirectTargetRequests, 0);
  mode = "oversized";
  await assert.rejects(transport({ origin, path: "/api/v1/account/session", method: "GET" }));
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    transport({ origin, path: "/api/v1/account/session", method: "GET", signal: abort.signal }),
  );
  console.log(
    "PASS native cloud account: verified TLS, no redirects, bounded JSON, singleflight refresh, fresh-token logout and cancellation",
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
