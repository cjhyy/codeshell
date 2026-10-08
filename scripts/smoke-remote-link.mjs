/** Cross-product contract smoke: real standalone Link + built Host SDK.
 * GitHub responses are controlled; this does not claim a real provider login.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
// The verifier takes a separately built/selected service entry. No product depends on sibling sources.
if (!process.argv[2])
  throw new Error(
    "Usage: node scripts/smoke-remote-link.mjs /absolute/path/to/link-server/http.mjs",
  );
const { startLinkServer } = await import(pathToFileURL(resolve(process.argv[2])).href);
import {
  CredentialStore,
  executeRemoteLinkAction,
  linkActionTool,
} from "../packages/core/dist/index.js";
import { createLinkService } from "../packages/server/dist/index.links.js";
import {
  launchCodeShellElectron,
  findCodeShellWindow,
} from "../packages/desktop/scripts/electron-harness.mjs";
let host, desktop;
const root = await mkdtemp(join(tmpdir(), "codeshell-link-real-http-"));
process.env.HOME = join(root, "home");
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const issuer = `http://127.0.0.1:${port}`;
let calls = 0;
const app = await startLinkServer({
  port,
  publicOrigin: issuer,
  ownerPassword: "long-private-fixture-password",
  databasePath: join(root, "link.sqlite"),
  masterKey: randomBytes(32),
  provider: {
    async begin(state) {
      return {
        url: `https://github.com/login/oauth/authorize?client_id=fixture-client&state=${state}`,
        verifier: "fixture",
      };
    },
    async exchange(url) {
      return {
        account:
          url.searchParams.get("code") === "admin-fixture"
            ? { id: "1", login: "administrator-only" }
            : { id: "2", login: "alice" },
        credential: { access_token: "UPSTREAM-ONLY-IN-LINK" },
      };
    },
    async repositories() {
      return { repositories: [{ fullName: "owner/repo", private: true }], truncated: false };
    },
    async action(action, input, credential, resources) {
      assert.equal(credential.access_token, "UPSTREAM-ONLY-IN-LINK");
      assert.deepEqual(resources, ["owner/repo"]);
      calls++;
      return action === "get_issue"
        ? { number: input.number, title: "real Link route" }
        : [{ id: 1, full_name: "owner/repo" }];
    },
  },
});
try {
  const request = (path, init = {}) => fetch(issuer + path, { redirect: "manual", ...init });
  const form = (path, body, cookie) =>
    request(path, {
      method: "POST",
      headers: {
        origin: issuer,
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams(body),
    });
  const login = await form("/login", { password: "long-private-fixture-password" });
  assert.equal(login.status, 303);
  const adminCookie = login.headers.get("set-cookie").split(";")[0];
  const snapshot = await (
    await request("/api/v1/links", { headers: { cookie: adminCookie } })
  ).json();
  const upstream = await form(
    "/api/v1/links/providers/github/authorize",
    { csrf: snapshot.csrf },
    adminCookie,
  );
  const state = new URL(upstream.headers.get("location")).searchParams.get("state");
  assert.equal(
    (
      await request(`/oauth/upstream/github/callback?code=admin-fixture&state=${state}`, {
        headers: { cookie: adminCookie },
      })
    ).status,
    303,
  );
  const linked = await (
    await request("/api/v1/links", { headers: { cookie: adminCookie } })
  ).json();
  assert.equal(linked.connections[0].account.login, "administrator-only");
  const client = await (
    await request("/api/v1/links/clients", {
      method: "POST",
      headers: {
        origin: issuer,
        cookie: adminCookie,
        "x-csrf-token": snapshot.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Host integration fixture",
        redirectUris: ["http://localhost:4900/callback"],
      }),
    })
  ).json();
  const browserCookies = new Map();
  let githubAuthorizations = 0;
  const browserRequest = async (url) => {
    assert.equal(new URL(url, issuer).origin, issuer);
    const response = await fetch(new URL(url, issuer), {
      redirect: "manual",
      headers: { cookie: [...browserCookies.values()].join("; ") },
    });
    for (const value of response.headers.getSetCookie()) {
      const cookie = value.split(";")[0];
      browserCookies.set(cookie.slice(0, cookie.indexOf("=")), cookie);
    }
    return response;
  };
  const approvePublicAuthorization = async (authorizationUrl) => {
    let response = await browserRequest(authorizationUrl);
    if (response.status === 303) {
      const upstream = new URL(response.headers.get("location"));
      assert.equal(upstream.origin, "https://github.com");
      assert.equal(upstream.pathname, "/login/oauth/authorize");
      assert.ok(upstream.searchParams.get("state"));
      githubAuthorizations++;
      response = await browserRequest(
        `/oauth/upstream/github/callback?${new URLSearchParams({
          code: "public-fixture",
          state: upstream.searchParams.get("state"),
        })}`,
      );
      assert.equal(response.status, 303);
      response = await browserRequest(response.headers.get("location"));
    }
    assert.equal(response.status, 200);
    const consent = await response.text();
    assert.ok(consent.includes("alice"));
    assert.ok(!consent.includes("administrator-only"));
    assert.ok(!consent.includes('name="password"'));
    const value = (name) => {
      const match = consent.match(new RegExp(`name="${name}" value="([^"]+)"`));
      assert.ok(match, `Missing public consent field ${name}`);
      return match[1];
    };
    const browserCookie = [...browserCookies.values()].join("; ");
    assert.equal(
      (await request("/api/v1/links", { headers: { cookie: browserCookie } })).status,
      401,
    );
    const approved = await form(
      "/oauth/authorize",
      {
        csrf: value("csrf"),
        intent: value("intent"),
        decision: "allow",
        connectionId: value("connectionId"),
        repositories: "owner/repo",
      },
      browserCookie,
    );
    assert.equal(approved.status, 303);
    return approved.headers.get("location");
  };
  const store = new CredentialStore(join(root, "project"));
  const owner = { ownerId: "fixture-owner", authorize: () => true };
  host = createLinkService({
    store,
    remoteLink: () => ({ issuer, clientId: client.id, redirectUri: client.redirectUris[0] }),
  });
  const attempt = await host.startRemoteAuth(owner, {
    providerId: "github",
    methodId: "remote-link",
    label: "Fixture Link",
    connectionId: "remote-github",
    expectedRevision: null,
  });
  const callbackUrl = await approvePublicAuthorization(attempt.redirect.authorizationUrl);
  const completed = await host.completeRemoteAuth(owner, attempt.id, callbackUrl);
  const credential = store.resolve(completed.connection.id);
  assert.ok(!JSON.stringify(credential).includes("UPSTREAM-ONLY-IN-LINK"));
  assert.equal(host.snapshot().connections[0].runtime, "server");
  const result = JSON.parse(
    await linkActionTool(
      {
        provider: "github",
        action: "get_issue",
        connectionId: credential.id,
        params: { owner: "owner", repo: "repo", issue_number: 5 },
      },
      { cwd: join(root, "project"), settingsScope: "full" },
    ),
  );
  assert.deepEqual(result.data, { number: 5, title: "real Link route" });
  assert.equal(result.runtime, "server");
  const secret = JSON.parse(credential.secret);
  secret.expiresAt = new Date(Date.now() - 1000).toISOString();
  store.save("user", { ...credential, secret: JSON.stringify(secret) });
  assert.deepEqual(
    await executeRemoteLinkAction({
      cwd: join(root, "project"),
      scope: "full",
      id: credential.id,
      grantId: credential.meta.linkRemoteGrantId,
      action: "list_repositories",
      params: {},
    }),
    { repositories: [{ id: 1, full_name: "owner/repo" }] },
  );
  const revoked = await request("/api/v1/links/grants/" + credential.meta.linkRemoteGrantId, {
    method: "DELETE",
    headers: {
      origin: issuer,
      cookie: adminCookie,
      "x-csrf-token": snapshot.csrf,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(revoked.status, 200);
  await assert.rejects(() =>
    executeRemoteLinkAction({
      cwd: join(root, "project"),
      scope: "full",
      id: credential.id,
      grantId: credential.meta.linkRemoteGrantId,
      action: "list_repositories",
      params: {},
    }),
  );
  const reviewed = host.snapshot().connections[0];
  await host.disconnect(owner, reviewed.id, reviewed.revision);
  assert.equal(store.resolve(credential.id), undefined);
  assert.equal(calls, 2);
  let desktopStartupCleanup = false;
  if (process.argv[3] === "desktop-retirement") {
    const pending = await host.startRemoteAuth(owner, {
      providerId: "github",
      methodId: "remote-link",
      label: "Recovery fixture",
      connectionId: "remote-recovery",
      expectedRevision: null,
    });
    const recoveryCallback = await approvePublicAuthorization(pending.redirect.authorizationUrl);
    const saved = await host.completeRemoteAuth(owner, pending.id, recoveryCallback);
    const retired = store.resolve(saved.connection.id);
    host.close();
    store.stageRemoteLinkRetirement(retired, 0);
    store.remove("user", retired.id);
    assert.equal(store.remoteLinkRetirementCount(), 1);
    const grantId = retired.meta.linkRemoteGrantId;
    const grants = async () =>
      (await (await request("/api/v1/links", { headers: { cookie: adminCookie } })).json()).grants;
    assert.equal(Boolean((await grants()).find((g) => g.id === grantId).revoked), false);
    await mkdir(join(process.env.HOME, ".code-shell"), { recursive: true });
    await writeFile(
      join(process.env.HOME, ".code-shell/settings.json"),
      JSON.stringify({ autoUpdates: false }),
    );
    desktop = await launchCodeShellElectron({
      appDir: resolve("packages/desktop"),
      home: process.env.HOME,
    });
    await findCodeShellWindow(desktop);
    // Do not navigate to credentials or open Link: startup alone must recover persisted custody.
    const deadline = Date.now() + 15_000;
    while (!(await grants()).find((g) => g.id === grantId).revoked && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(Boolean((await grants()).find((g) => g.id === grantId).revoked), true);
    assert.equal(store.remoteLinkRetirementCount(), 0);
    assert.equal(store.list().length, 0);
    desktopStartupCleanup = true;
  }
  console.log(
    JSON.stringify({
      realStandaloneLink: true,
      pkce: true,
      hostLinkAction: true,
      hostManagement: true,
      hostDisconnect: true,
      selectedAccount: true,
      noLinkLogin: true,
      publicAccountIsolation: true,
      githubAuthorizations,
      tokenRotation: true,
      revocation: true,
      upstream: "controlled fixture",
      desktopStartupCleanup,
    }),
  );
} finally {
  await desktop?.close();
  host?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
