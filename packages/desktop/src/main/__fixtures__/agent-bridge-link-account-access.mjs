import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { mock } from "bun:test";

const connectionId = randomUUID();
const grantId = randomUUID();
const actionPath = `/api/v1/data/connections/${connectionId}/actions/get_comments`;
let requests = 0;
let gate;
let entered;
let deliverAfterAbort = false;
const bounded = async (promise, stage) => {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Bridge fixture stalled at ${stage}`)), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
const server = http.createServer(async (request, response) => {
  requests++;
  assert.equal(request.method, "POST");
  assert.equal(request.url, actionPath);
  let body = "";
  for await (const chunk of request) body += chunk;
  assert.deepEqual(JSON.parse(body), { file_url_or_key: "FixtureFile123" });
  entered?.();
  await gate;
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ result: { comments: [{ body: "synthetic provider response" }] } }));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const issuer = `http://127.0.0.1:${server.address().port}`;
const originalRequest = http.request;
const deny = () => {
  throw new Error("Link account bridge fixture refuses external network or OAuth");
};
// Install every guard before importing Core or Desktop modules.
globalThis.fetch = deny;
http.request = (input, ...args) => {
  const url = new URL(input);
  assert.equal(url.origin, issuer);
  assert.equal(url.pathname, actionPath);
  assert.equal(url.search, "");
  return originalRequest(input, ...args);
};
http.get = deny;
https.request = deny;
https.get = deny;
syncBuiltinESMExports();

const main = resolve(import.meta.dir, "..");
mock.module("electron", () => ({
  ipcMain: new EventEmitter(),
  BrowserWindow: { fromWebContents: () => undefined },
  app: { getPath: () => process.env.HOME },
}));
mock.module(join(main, "desktop-logger.ts"), () => ({ dlog: () => {} }));
mock.module(join(main, "browser-runtime/index.ts"), () => ({
  browserRuntime: {},
  builtInBrowserHandoffGrants: {},
  chromeExtensionRuntimeService: {},
  annotateBrowserRuntimeStreamEvent: (event) => event,
  dispatchInteractiveBrowserRuntimeAction: () => {},
  releaseChildBrowserRuntime: () => {},
  activateChildBrowserRuntime: () => {},
  interactiveBrowserRuntimeOwner: () => {},
  replaceStreamEventInLine: (line) => line,
}));
mock.module(join(main, "credential-action.ts"), () => ({
  resolveCookieCredentialForBrowser: () => ({ ok: false }),
}));
mock.module(join(main, "cookie-credential-browser.ts"), () => ({
  restoreCookieCredentialToBrowser: () => {},
}));
mock.module(join(main, "automation-service.ts"), () => ({ reloadAutomations: () => {} }));
mock.module(join(main, "trust-store.ts"), () => ({ getTrustCachedSync: () => "trusted" }));
mock.module(join(main, "project-store.ts"), () => ({ getProjectStore: () => {} }));
mock.module(join(main, "session-cwd-index.ts"), () => ({ getSessionCwdIndex: () => ({}) }));
mock.module(join(main, "external-runtime-state.ts"), () => ({
  readExternalRuntimeBinding: () => {},
}));
mock.module(join(main, "session-workspace-service.ts"), () => ({
  switchSessionWorkspaceForUi: () => {},
}));

try {
  const core = await import("@cjhyy/code-shell-core");
  const [{ AgentBridge }, { CloudAccountManager }, { createLinkAccountAccess }] = await Promise.all(
    [
      import("../agent-bridge.ts"),
      import("../cloud-account-manager.ts"),
      import("../link-account-access.ts"),
    ],
  );
  const cwd = process.env.HOME;
  const store = new core.CredentialStore(cwd);
  const credential = {
    id: "fixture-account-gated-figma",
    type: "oauth",
    label: "Preserved synthetic provider grant",
    secret: JSON.stringify({
      version: 1,
      accessToken: "synthetic-provider-access",
      refreshToken: "synthetic-provider-refresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      clientId: "fixture-client",
      issuer,
      scope: "figma:get_comments",
    }),
    meta: {
      linkProvider: "figma",
      linkExecutionRuntime: "server",
      linkExecutionBackend: "remote",
      linkRemoteIssuer: issuer,
      linkRemoteState: "connected",
      linkRemoteGrantId: grantId,
      linkRemoteConnectionId: connectionId,
      linkAccountId: "provider-account",
      linkResourceGroups: [{ id: "files", items: [{ id: "FixtureFile123", label: "Fixture" }] }],
      linkResourceLabels: ["FixtureFile123"],
      linkCapabilityIds: ["figma.get_comments"],
      linkLastVerifiedAt: new Date().toISOString(),
      agentExposable: false,
    },
  };
  store.save("user", credential);
  const original = store.resolve(credential.id);
  const accountOrigin = "https://account.example";
  let saved;
  const accountGrant = {
    origin: accountOrigin,
    account: { id: randomUUID(), username: "fixture" },
    sessionId: randomUUID(),
    accessToken: "a".repeat(43),
    refreshToken: "r".repeat(43),
    accessTokenExpiresAt: Date.now() + 600_000,
    refreshTokenExpiresAt: Date.now() + 86_400_000,
    kind: "account",
    audience: accountOrigin,
  };
  const account = new CloudAccountManager({
    store: {
      load: () => saved,
      preflight: () => {},
      save: (value) => {
        saved = value;
      },
      forget: () => {
        saved = undefined;
      },
    },
    request: async (request) => {
      if (request.path.endsWith("/login")) return accountGrant;
      if (request.path.endsWith("/logout")) return { ok: true };
      throw new Error("Unexpected account request");
    },
    openExternal: deny,
    changed: () => {},
  });
  const bridge = Object.create(AgentBridge.prototype);
  const captureAccount = createLinkAccountAccess(account);
  let lastCapturedLease;
  bridge.captureLinkAccount = () => {
    const lease = captureAccount();
    lastCapturedLease = lease;
    // Model an uninterruptible response already in flight. Keep the real account
    // incarnation check so execution must discard it after logout even when an
    // abort signal cannot stop the physical transport in time.
    return deliverAfterAbort
      ? { current: lease.current, signal: new AbortController().signal }
      : lease;
  };
  bridge.localOAuthLinkActions = new Map();
  bridge.localOAuthLinkEpoch = 0;
  bridge.credentialSnapshotCwds = new Set();
  bridge.buildLatestCredentialSnapshot = () => ({ revision: 1, entries: [] });
  const waiters = new Map();
  bridge.core = {
    hasLiveWorker: () => true,
    sendLine: (line) => {
      const message = JSON.parse(line);
      waiters.get(message.id)?.(message);
    },
  };
  const invoke = () => {
    const id = randomUUID();
    return new Promise((done) => {
      waiters.set(id, (message) => {
        waiters.delete(id);
        done(message);
      });
      assert.equal(
        bridge.maybeHandleCredentialAccessMessage(
          JSON.stringify({
            id,
            method: "desktop/remoteLinkAction",
            params: {
              cwd,
              id: credential.id,
              scope: "full",
              grantId,
              action: "get_comments",
              params: { file_url_or_key: "FixtureFile123" },
            },
          }),
        ),
        true,
      );
    });
  };
  const denied = await invoke();
  assert.ok(denied.error);
  assert.equal(denied.result, undefined);
  assert.equal(requests, 0);
  assert.deepEqual(store.resolve(credential.id), original);

  await account.signIn("login", {
    origin: accountOrigin,
    username: "fixture",
    password: "synthetic-password-123456",
  });
  const allowed = await invoke();
  assert.equal(allowed.error, undefined);
  assert.ok(allowed.result);
  assert.equal(requests, 1);

  let release;
  const enteredPromise = new Promise((done) => {
    entered = done;
  });
  gate = new Promise((done) => {
    release = done;
  });
  deliverAfterAbort = true;
  const pending = invoke();
  await bounded(enteredPromise, "pending request entry");
  await account.logout();
  assert.equal(lastCapturedLease.signal.aborted, true);
  release();
  const interrupted = await bounded(pending, "logout reply");
  assert.ok(interrupted.error);
  assert.equal(interrupted.result, undefined);
  assert.equal(JSON.stringify(interrupted).includes("synthetic provider response"), false);
  assert.equal(requests, 2);
  assert.deepEqual(store.resolve(credential.id), original);
  console.log(
    JSON.stringify({
      signedOutNoRequest: true,
      signedInRequest: true,
      logoutResultDiscarded: true,
      providerGrantPreserved: true,
    }),
  );
} finally {
  server.closeAllConnections();
  await bounded(new Promise((done) => server.close(done)), "server cleanup");
}
