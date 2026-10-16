import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { mock } from "bun:test";

// Only synthetic action responses at this exact loopback origin are admitted.
// No authorization, token refresh, provider API or design content is requested.
const connectionId = "12345678-1234-1234-1234-123456789abc";
const actionPath = `/api/v1/data/connections/${connectionId}/actions/get_comments`;
let actionStatus = 200;
let actionGate;
let actionStarted;
const server = http.createServer(async (request, response) => {
  assert.equal(request.method, "POST");
  assert.equal(request.url, actionPath);
  let body = "";
  for await (const chunk of request) body += chunk;
  assert.deepEqual(JSON.parse(body), { file_url_or_key: "FixtureFile123" });
  actionStarted?.();
  if (actionGate) await actionGate;
  response.writeHead(actionStatus, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify(
      actionStatus === 200
        ? { result: { comments: [] } }
        : { error: "invalid_request", description: "DO-NOT-PROJECT-PROVIDER-BODY" },
    ),
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const issuer = `http://127.0.0.1:${server.address().port}`;
const originalRequest = http.request;
const denyNetwork = () => {
  throw new Error("Remote bridge fixture cannot use external network or OAuth");
};
globalThis.fetch = denyNetwork;
http.request = (input, ...args) => {
  const url = new URL(input);
  assert.equal(url.origin, issuer);
  assert.equal(url.pathname, actionPath);
  assert.equal(url.search, "");
  return originalRequest(input, ...args);
};
http.get = denyNetwork;
https.request = denyNetwork;
https.get = denyNetwork;
syncBuiltinESMExports();

const main = resolve(import.meta.dir, "..");
const diagnostics = [];
let rejectDiagnostic = false;
mock.module("electron", () => ({
  ipcMain: new EventEmitter(),
  BrowserWindow: { fromWebContents: () => undefined },
  app: { getPath: () => process.env.HOME },
}));
mock.module(join(main, "desktop-logger.ts"), () => ({
  dlog: (_source, event, data) => {
    if (rejectDiagnostic) throw new Error("Diagnostic logger unavailable");
    diagnostics.push({ event, data });
  },
}));
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
  // Use the real Host store projection, Bridge RPC handler, Worker metadata
  // transport and Link status function; none of these are mocked.
  const core = await import("@cjhyy/code-shell-core");
  const { AgentBridge } = await import("../agent-bridge.ts");
  const cwd = process.env.HOME;
  const store = new core.CredentialStore(cwd);
  const grantId = "12345678-1234-1234-1234-123456789def";
  const credential = {
    id: "fixture-figma-remote",
    type: "oauth",
    label: "Synthetic Figma Link",
    secret: JSON.stringify({
      version: 1,
      accessToken: "SYNTHETIC-ACCESS-NEVER-PROJECT",
      refreshToken: "SYNTHETIC-REFRESH-NEVER-REQUEST",
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
      linkAccountId: "fixture-original",
      linkAccountLabel: "Original fixture account",
      linkResourceGroups: [{ id: "files", items: [{ id: "FixtureFile123", label: "Fixture" }] }],
      linkResourceLabels: ["FixtureFile123"],
      linkCapabilityIds: ["figma.get_comments"],
      linkLastVerifiedAt: new Date().toISOString(),
      agentExposable: false,
    },
  };
  const bridge = Object.create(AgentBridge.prototype);
  bridge.localOAuthLinkActions = new Map();
  bridge.localOAuthLinkEpoch = 0;
  bridge.credentialSnapshotRevision = 0;
  bridge.credentialSnapshotCwds = new Set();
  const messages = [];
  let receive;
  let rejectSnapshot = false;
  const buildSnapshot = bridge.buildLatestCredentialSnapshot.bind(bridge);
  bridge.buildLatestCredentialSnapshot = () => {
    if (rejectSnapshot) throw new Error("Snapshot capture failure with DO-NOT-PROJECT diagnostic");
    return buildSnapshot();
  };
  bridge.core = {
    hasLiveWorker: () => true,
    sendLine: (line) => {
      const message = JSON.parse(line);
      messages.push(message);
      receive(message);
    },
  };
  const access = core.createIpcCredentialAccess({
    onMessage: (listener) => {
      receive = listener;
    },
    send: (message) =>
      assert.equal(bridge.maybeHandleCredentialAccessMessage(JSON.stringify(message)), true),
  });
  core.setDefaultCredentialAccess(access);
  const reset = () => {
    store.save("user", credential);
    bridge.pushCredentialSnapshot(cwd);
  };
  const status = async () => {
    const result = await core.getLinkStatus(
      { provider: "figma", cwd, settingsScope: "full", probeCli: false },
      { credentialAccess: access },
    );
    assert.equal(result.credentialStore.state, "checked");
    assert.equal(result.providers[0].connections.length, 1);
    return result.providers[0].connections[0];
  };
  const run = () =>
    access.executeRemoteLinkAction({
      cwd,
      id: credential.id,
      scope: "full",
      grantId,
      action: "get_comments",
      params: { file_url_or_key: "FixtureFile123" },
    });
  const runTool = (signal) =>
    core.linkActionTool(
      {
        provider: "figma",
        connectionId: credential.id,
        action: "get_comments",
        params: { file_url_or_key: "FixtureFile123" },
      },
      { cwd, settingsScope: "full", signal },
    );
  const waitFor = async (condition) => {
    const deadline = Date.now() + 1000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("Remote Bridge fixture did not settle");
      await new Promise((done) => setTimeout(done, 1));
    }
  };
  const expectFailure = async (promise, code) => {
    await assert.rejects(
      promise,
      (error) => error instanceof core.RemoteLinkError && error.code === code,
    );
    const reply = messages.at(-1);
    assert.equal(reply.error.data.remoteLinkCode, code);
    assert(!JSON.stringify(reply).includes("DO-NOT-PROJECT"));
  };

  reset();
  assert.equal((await status()).state, "ready");
  actionStatus = 401;
  await expectFailure(run(), "reconnect");
  assert.equal(messages.at(-1).credentialSnapshot.revision, bridge.credentialSnapshotRevision);
  assert.equal((await status()).state, "unavailable");
  assert.equal(access.resolveMeta(cwd, credential.id, "full").meta.linkRemoteState, "reconnect");

  reset();
  const unauthorized = JSON.parse(await runTool());
  assert.equal(unauthorized.kind, "error");
  assert.equal(unauthorized.code, "reconnect");
  assert.equal((await status()).state, "unavailable");

  reset();
  actionStatus = 400;
  await expectFailure(run(), "invalid_request");
  assert.equal((await status()).state, "ready");
  assert.equal(store.resolve(credential.id).meta.linkRemoteState, "connected");
  const invalidParams = JSON.parse(await runTool());
  assert.equal(invalidParams.kind, "error");
  assert.equal(invalidParams.code, "invalid_request");
  assert.equal((await status()).state, "ready");

  actionStatus = 200;
  const revisionBeforeSuccess = bridge.credentialSnapshotRevision;
  assert.deepEqual(await run(), { comments: [] });
  assert.equal(messages.at(-1).credentialSnapshot.revision, bridge.credentialSnapshotRevision);
  assert.equal(bridge.credentialSnapshotRevision, revisionBeforeSuccess + 1);

  // A late failure for the old grant must report changed and publish the new
  // grant, rather than overwrite its store record or roll back Worker metadata.
  reset();
  const oldSnapshot = messages.at(-1);
  actionStatus = 401;
  let release;
  actionGate = new Promise((done) => {
    release = done;
  });
  const started = new Promise((done) => {
    actionStarted = done;
  });
  const pending = run();
  await started;
  const replacement = {
    ...credential,
    meta: {
      ...credential.meta,
      linkRemoteGrantId: "22345678-1234-1234-1234-123456789def",
      linkAccountId: "fixture-new",
      linkAccountLabel: "New fixture account",
    },
  };
  store.save("user", replacement);
  bridge.pushCredentialSnapshot(cwd);
  release();
  await expectFailure(pending, "changed");
  receive(oldSnapshot);
  assert.equal((await status()).state, "ready");
  assert.equal((await status()).account, "New fixture account");
  assert.equal(
    access.resolveMeta(cwd, credential.id, "full").meta.linkRemoteGrantId,
    replacement.meta.linkRemoteGrantId,
  );
  assert.equal(
    store.resolve(credential.id).meta.linkRemoteGrantId,
    replacement.meta.linkRemoteGrantId,
  );
  actionGate = undefined;
  actionStarted = undefined;

  // A separate Host snapshot replacing a selected grant cancels the real tool.
  // Its late successful HTTP response cannot publish content for that old grant.
  reset();
  actionStatus = 200;
  actionGate = new Promise((done) => {
    release = done;
  });
  const replacedStarted = new Promise((done) => {
    actionStarted = done;
  });
  const replacedTool = runTool();
  await replacedStarted;
  store.save("user", replacement);
  bridge.pushCredentialSnapshot(cwd);
  const replacedOutput = JSON.parse(await replacedTool);
  assert.equal(replacedOutput.kind, "error");
  assert.equal(replacedOutput.data, undefined);
  const beforeLateReply = messages.length;
  release();
  await waitFor(() => messages.length > beforeLateReply);
  assert.equal((await status()).account, "New fixture account");
  assert.equal((await status()).state, "ready");
  actionGate = undefined;
  actionStarted = undefined;

  // Task cancellation wins over a subsequent reviewed provider failure.
  reset();
  actionStatus = 401;
  actionGate = new Promise((done) => {
    release = done;
  });
  const cancelStarted = new Promise((done) => {
    actionStarted = done;
  });
  const taskController = new AbortController();
  const cancelledTool = runTool(taskController.signal);
  await cancelStarted;
  taskController.abort();
  const cancelledOutput = JSON.parse(await cancelledTool);
  assert.equal(cancelledOutput.kind, "error");
  assert.equal(cancelledOutput.code, undefined);
  assert.match(cancelledOutput.error, /cancelled/i);
  const beforeCancelledReply = messages.length;
  release();
  await waitFor(() => messages.length > beforeCancelledReply);
  assert.equal((await status()).state, "unavailable");
  assert.equal(access.resolveMeta(cwd, credential.id, "full").meta.linkRemoteState, "reconnect");
  assert.equal(cancelledOutput.code, undefined);
  assert.match(cancelledOutput.error, /cancelled/i);
  actionGate = undefined;
  actionStarted = undefined;

  // Snapshot failures are diagnostic-only, never a replacement for the original
  // remote error. The same is true of failures in the diagnostic logger.
  reset();
  rejectSnapshot = true;
  actionStatus = 400;
  await expectFailure(run(), "invalid_request");
  assert.deepEqual(diagnostics.at(-1), {
    event: "remote_link.credential_snapshot_failed",
    data: {},
  });
  rejectDiagnostic = true;
  await expectFailure(run(), "invalid_request");
  rejectDiagnostic = false;
  rejectSnapshot = false;

  // A reply from an old worker generation cannot settle a replacement worker's
  // reused request ID or send it a snapshot belonging to an unrelated request.
  reset();
  actionStatus = 200;
  actionGate = new Promise((done) => {
    release = done;
  });
  const staleStarted = new Promise((done) => {
    actionStarted = done;
  });
  assert.equal(
    bridge.maybeHandleCredentialAccessMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "old-worker-request",
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
  await staleStarted;
  const beforeReplacement = messages.length;
  bridge.abortLocalOAuthLinkActions();
  release();
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(messages.length, beforeReplacement);
  assert(!JSON.stringify(messages).includes("SYNTHETIC-ACCESS"));
  assert(!JSON.stringify(messages).includes("SYNTHETIC-REFRESH"));
  console.log(
    JSON.stringify({
      unauthorizedSnapshotUpdated: true,
      invalidParamsKeepGrant: true,
      successSnapshotPrecedesResult: true,
      replacementGrantPreserved: true,
      realToolErrorsPreserved: true,
      replacementContentDiscarded: true,
      taskCancellationPreserved: true,
      snapshotFailureKeepsError: true,
      priorWorkerReplyDiscarded: true,
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
