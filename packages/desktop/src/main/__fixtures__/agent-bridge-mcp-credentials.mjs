import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { join, resolve } from "node:path";
import { mock } from "bun:test";
import {
  annotateBrowserRuntimeStreamEvent,
  replaceStreamEventInLine,
} from "../browser-runtime/stream-projection.ts";

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
  annotateBrowserRuntimeStreamEvent,
  beginBrowserRunForStartedRun: () => false,
  cancelBrowserActionsForStoppedRun: () => false,
  dispatchInteractiveBrowserRuntimeAction: () => {},
  releaseChildBrowserRuntime: () => {},
  activateChildBrowserRuntime: () => {},
  interactiveBrowserRuntimeOwner: () => {},
  replaceStreamEventInLine,
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

// Exercise the real AgentBridge chain in the existing isolated Electron fixture.
// Persistence adapters are in-memory so only worker-line decoding is counted;
// WorkerBridgeCore framing/correlation is intentionally outside this boundary.
const forwarded = [];
const tapped = [];
const privateReplies = [];
const forkReplies = [];
const fakeWindow = new EventEmitter();
fakeWindow.id = 101;
fakeWindow.isDestroyed = () => false;
fakeWindow.webContents = { id: 101, send: (channel, payload) => forwarded.push({ channel, payload }) };
const parsingBridge = new AgentBridge(fakeWindow, undefined, {
  begin: () => true,
  settle: () => {},
});
parsingBridge.core.sendLine = (line) => privateReplies.push(line);
parsingBridge.mainOutput = { observeWorker: (_sessionId, event) => event.text !== "drop-source" };
let nextSeq = 0;
parsingBridge.snapshots = {
  epoch: "parse-once-epoch",
  append(_sessionId, event) {
    if (event.text === "snapshot-error") throw new Error("snapshot unavailable");
    return { seq: ++nextSeq, event };
  },
};
parsingBridge.outboundTaps.add((line) => tapped.push(line));
const fork = parsingBridge.quickChatForkRouter.start(
  { requestId: 42, sessionId: "qchat-parse-once" },
  { id: 101, isDestroyed: () => false, send: (_channel, payload) => forkReplies.push(payload) },
  JSON.stringify({ jsonrpc: "2.0", id: 42, method: "agent/forkSession", params: {} }),
);
assert(fork);
const stream = (event) => JSON.stringify({
  jsonrpc: "2.0", method: "agent/streamEvent", params: { sessionId: "parse-once", event },
});
const approval = (toolName, args) => JSON.stringify({
  jsonrpc: "2.0", method: "agent/approvalRequest",
  params: { sessionId: "parse-once", requestId: "parse-approval", request: { toolName, args } },
});
const lines = [
  stream({ type: "text_delta", text: "streamed text" }),
  stream({ type: "steer_injected", text: "no persisted steer id" }),
  stream({ type: "tool_use_start", toolCall: { id: "browser-call", toolName: "browser_act" } }),
  "{invalid worker JSON",
  JSON.stringify({ jsonrpc: "2.0", id: "ordinary-response", result: {} }),
  JSON.stringify({ jsonrpc: "2.0", method: "agent/cronChanged" }),
  JSON.stringify({ jsonrpc: "2.0", method: "agent/petProjectionDelta", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", method: "agent/petReportToMimi", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", method: "desktop/operationBatch", params: { phase: "ready", version: 1 } }),
  JSON.stringify({ jsonrpc: "2.0", method: "desktop/automationCreate", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", method: "desktop/oauthAccessResolve", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", method: "desktop/localOAuthLinkActionCancel", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", id: "unsupported", method: "desktop/unknownAuthority" }),
  approval("__host_action__", { action: "unknown", args: {} }),
  approval("__host_action__", { action: "malformed", args: "not-an-object" }),
  approval("__browser_action__", {}),
  approval("__credential_action__", { action: "unsupported", credentialId: "fixture" }),
  approval("__workspace_action__", {}),
  approval("__panel_action__", {}),
  JSON.stringify({ jsonrpc: "2.0", id: fork.wireId, result: { sessionId: "qchat-parse-once" } }),
  stream({ type: "text_delta", text: "drop-source" }),
  stream({ type: "text_delta", text: "snapshot-error" }),
];
const stages = [];
const trace = (object, method, label) => {
  const original = object[method];
  object[method] = function (...args) {
    stages.push(label);
    return original.apply(this, args);
  };
};
trace(parsingBridge.webConfiguration, "observe", "configuration");
trace(parsingBridge, "updateTentativeRunLifecycle", "tentative");
trace(parsingBridge.workerHost, "intercept", "host");
trace(parsingBridge, "maybeHandleCronChanged", "cron");
trace(parsingBridge, "routePetProjectionLine", "projection");
trace(parsingBridge, "routePetReportLine", "report");
trace(parsingBridge.quickChatForkRouter, "routeWorkerResponse", "fork");
const stageOrder = ["configuration", "tentative", "host", "cron", "projection", "report", "fork"];
const originalParse = JSON.parse;
const sharedMessages = [];
const freezeMessage = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeMessage);
    Object.freeze(value);
  }
  return value;
};
let workerLineParses = 0;
JSON.parse = (...args) => {
  workerLineParses++;
  const message = originalParse(...args);
  sharedMessages.push({ message, before: JSON.stringify(message) });
  return freezeMessage(message);
};
try {
  for (const line of lines) {
    const before = workerLineParses;
    stages.length = 0;
    parsingBridge.handleWorkerLine(line);
    assert.equal(workerLineParses - before, 1, `expected one Desktop parse for ${line}`);
    assert.deepEqual(stages, stageOrder.slice(0, stages.length), "intercept order must stay stable");
    if (line === lines[5]) assert.equal(stages.length, 4, "cron must stop the intercept chain");
    if (line === lines[6]) assert.equal(stages.length, 5, "projection must stop the intercept chain");
    if (line === lines[7]) assert.equal(stages.length, 6, "report must stop the intercept chain");
    if (line === lines[8]) assert.equal(stages.length, 3, "Host authority must return first");
    if (line === lines[3]) assert.equal(stages.length, 7, "invalid JSON still reaches forwarding");
  }
} finally {
  JSON.parse = originalParse;
  parsingBridge.workerHost.runtime.stop();
}
await Promise.resolve();
assert.equal(workerLineParses, lines.length);
for (const { message, before } of sharedMessages) {
  assert.equal(
    JSON.stringify(message),
    before,
    "downstream readers must not mutate shared messages",
  );
}
assert(forwarded.some(({ channel, payload }) => channel === "agent:msg" && payload === lines[3]));
assert(!tapped.includes(lines[5]), "cron notification must be consumed");
assert(!tapped.includes(lines[6]), "pet projection must be consumed");
assert(!tapped.includes(lines[7]), "pet report must be consumed");
assert(!tapped.includes(lines[19]), "quick-chat reply belongs only to its original window");
assert(!tapped.includes(lines[20]), "unowned source must stop before snapshot/forwarding");
assert(!tapped.includes(lines[21]), "failed snapshot must stop before forwarding");
assert.equal(JSON.parse(forkReplies[0]).id, 42);
const projectedBrowser = tapped.map((line) => {
  try { return JSON.parse(line); } catch { return undefined; }
}).find((message) => message?.params?.event?.toolCall?.id === "browser-call");
assert.equal(projectedBrowser.params.event.toolCall.uiVisibility, "milestones");
assert.equal(forwarded.filter(({ channel }) => channel === "agent:streamEvent").length, 3);
assert(privateReplies.length > 0, "private Host requests still receive replies");

console.log(
  JSON.stringify({
    figmaTokenDenied: true,
    genericOAuthPreserved: true,
    lateExposureChangeDenied: true,
    dedicatedHostResolverPreserved: true,
    dedicatedActionCancelled: true,
    staleWorkerReplyDiscarded: true,
    atomicStateReplies: true,
    workerLineParsing: { lines: lines.length, parses: workerLineParses },
  }),
);
