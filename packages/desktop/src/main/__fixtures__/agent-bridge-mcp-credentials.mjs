import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { join, resolve } from "node:path";
import { mock } from "bun:test";

// Isolate Electron/module mocks and forbid provider access in this child process.
const denyNetwork = () => {
  throw new Error("MCP bridge fixture cannot use the network");
};
globalThis.fetch = denyNetwork;
for (const module of [http, https]) {
  module.request = denyNetwork;
  module.get = denyNetwork;
}
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
mock.module(join(main, "credential-access-service.ts"), () => ({
  buildCredentialSnapshot: (_cwds, revision) => ({ revision, entries: [] }),
  materializeCredentialCookieForWorker: () => {},
  resolveCredentialValueForWorker: () => {},
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

const core = await import("@cjhyy/code-shell-core");
const internal = await import("@cjhyy/code-shell-core/internal");
const { FIGMA_MCP_SERVER_URL } = await import("@cjhyy/code-shell-link");
const dedicated = [];
let blockedSignal;
mock.module("@cjhyy/code-shell-core/internal", () => ({
  ...internal,
  executeFigmaMcpLinkAction: async (input, options) => {
    dedicated.push(input);
    const resolved = await options.resolveOAuthAccess({
      id: input.id,
      serverUrl: FIGMA_MCP_SERVER_URL,
      scope: "full",
    });
    assert.equal(resolved.accessToken, "host-access-only");
    if (input.action === "blocked") {
      blockedSignal = options.signal;
      await new Promise((_, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(new globalThis.DOMException("Cancelled", "AbortError")),
          { once: true },
        ),
      );
    }
    return { content: [{ type: "text", text: "selected design context" }], backend: "mcp" };
  },
}));
const { AgentBridge } = await import("../agent-bridge.ts");
const store = new core.CredentialStore(undefined);
const generic = {
  id: "generic-mcp",
  type: "oauth",
  label: "Generic MCP",
  secret: JSON.stringify({ version: 1, accessToken: "generic-fixture" }),
  meta: { mcpServerUrl: "https://generic.example/mcp" },
};
const figma = {
  id: "figma-mcp",
  type: "oauth",
  label: "Figma MCP",
  secret: JSON.stringify({ version: 1, accessToken: "figma-fixture" }),
  meta: {
    linkProvider: "figma",
    linkExecutionBackend: "mcp",
    linkAuthSource: "mcp-oauth",
    linkExecutionRuntime: "local",
    mcpServerUrl: FIGMA_MCP_SERVER_URL,
    agentExposable: false,
  },
};
store.save("user", generic);
store.save("user", figma);
const bridge = Object.create(AgentBridge.prototype);
const replies = [];
const resolved = [];
let afterResolve;
bridge.localOAuthLinkActions = new Map();
bridge.localOAuthLinkEpoch = 0;
bridge.credentialSnapshotRevision = 0;
bridge.credentialSnapshotCwds = new Set();
bridge.core = { sendLine: (line) => replies.push(JSON.parse(line)) };
bridge.oauthAccessResolver = async (request) => {
  resolved.push(request);
  afterResolve?.();
  return { accessToken: "host-access-only" };
};
const deliver = (id, method, params) => {
  assert.equal(
    bridge.maybeHandleCredentialAccessMessage(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    ),
    true,
  );
};
const waitFor = async (condition) => {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Bridge fixture did not settle");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

deliver("figma-denied", "desktop/oauthAccessResolve", {
  id: figma.id,
  serverUrl: FIGMA_MCP_SERVER_URL,
});
await waitFor(() => replies.length === 1);
assert.match(replies[0].error.message, /Host-owned/);
assert.equal(resolved.length, 0);
assert(!JSON.stringify(replies).includes("host-access-only"));

// The domain guard still applies when a malformed saved Link omits the exposure flag.
store.save("user", { ...figma, meta: { ...figma.meta, agentExposable: undefined } });
deliver("figma-no-flag", "desktop/oauthAccessResolve", {
  id: figma.id,
  serverUrl: FIGMA_MCP_SERVER_URL,
});
await waitFor(() => replies.length === 2);
assert.match(replies[1].error.message, /Host-owned/);
assert.equal(resolved.length, 0);

deliver("generic", "desktop/oauthAccessResolve", {
  id: generic.id,
  serverUrl: generic.meta.mcpServerUrl,
  forceRefresh: true,
});
await waitFor(() => replies.length === 3);
assert.deepEqual(replies[2].result, { accessToken: "host-access-only" });
assert.deepEqual(resolved[0], {
  id: generic.id,
  scope: "full",
  serverUrl: generic.meta.mcpServerUrl,
  forceRefresh: true,
});

// An async resolver cannot return a token after the credential becomes Host-only.
afterResolve = () =>
  store.save("user", { ...generic, meta: { ...generic.meta, agentExposable: false } });
deliver("changed", "desktop/oauthAccessResolve", {
  id: generic.id,
  serverUrl: generic.meta.mcpServerUrl,
});
await waitFor(() => replies.length === 4);
assert.match(replies[3].error.message, /Host-owned/);
assert(!JSON.stringify(replies[3]).includes("host-access-only"));
afterResolve = undefined;

deliver("dedicated", "desktop/mcpLinkAction", {
  id: figma.id,
  action: "get_metadata",
  accountId: "selected",
  verifiedAt: "verified",
  scope: "full",
  params: { file_key: "SelectedFile" },
});
await waitFor(() => replies.length === 5);
assert.equal(dedicated.length, 1);
assert.equal(resolved.at(-1).id, figma.id);
assert.equal(replies[4].result.content[0].text, "selected design context");
assert.equal(replies[4].credentialSnapshot.revision, 1);
assert(!JSON.stringify(replies[4]).includes("host-access-only"));

deliver("cancelled", "desktop/mcpLinkAction", {
  id: figma.id,
  action: "blocked",
  scope: "full",
  params: {},
});
await waitFor(() => blockedSignal !== undefined);
assert.equal(bridge.localOAuthLinkActions.has("cancelled"), true);
deliver(undefined, "desktop/localOAuthLinkActionCancel", { requestId: "cancelled" });
await waitFor(() => replies.length === 6);
assert.equal(blockedSignal.aborted, true);
assert.equal(bridge.localOAuthLinkActions.size, 0);
assert.match(replies[5].error.message, /Cancelled/);
assert.equal(replies[5].credentialSnapshot.revision, 2);
assert(!JSON.stringify(replies[5]).includes("host-access-only"));

// A response from the prior worker generation must not reach its replacement.
blockedSignal = undefined;
deliver("prior-worker", "desktop/mcpLinkAction", {
  id: figma.id,
  action: "blocked",
  scope: "full",
  params: {},
});
await waitFor(() => blockedSignal !== undefined);
bridge.abortLocalOAuthLinkActions();
assert.equal(blockedSignal.aborted, true);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(replies.length, 6);
assert.equal(bridge.localOAuthLinkActions.size, 0);

// Local OAuth preflight failures carry the same ordered Host state receipt.
deliver("local-invalid", "desktop/localOAuthLinkAction", {});
await waitFor(() => replies.length === 7);
assert(replies[6].error);
assert.equal(replies[6].credentialSnapshot.revision, 3);

console.log(
  JSON.stringify({
    figmaTokenDenied: true,
    genericOAuthPreserved: true,
    lateExposureChangeDenied: true,
    dedicatedHostResolverPreserved: true,
    dedicatedActionCancelled: true,
    staleWorkerReplyDiscarded: true,
    atomicStateReplies: true,
  }),
);
