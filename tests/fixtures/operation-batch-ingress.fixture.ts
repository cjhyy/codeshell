import { afterAll, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";

await import("./operation-batch-ingress-guard.js");

// This isolated source shard uses the real AgentBridge methods and real Core
// prepareInbound transport. Only Electron/services and the final worker sink
// are fixtures; no constructor, subprocess, provider, or native UI is started.
const main = join(import.meta.dir, "../../packages/desktop/src/main");
const ipc = new EventEmitter();
const sender = { id: 11, isDestroyed: () => false, send: () => {} };
mock.module("electron", () => ({
  ipcMain: ipc,
  BrowserWindow: { fromWebContents: () => undefined },
  app: { getPath: () => process.env.HOME },
}));
mock.module(join(main, "desktop-logger.ts"), () => ({ dlog: () => {} }));
mock.module(join(main, "browser-runtime/index.ts"), () => ({
  browserRuntime: {},
  builtInBrowserHandoffGrants: {},
  chromeExtensionRuntimeService: {},
  annotateBrowserRuntimeStreamEvent: (event: unknown) => event,
  dispatchInteractiveBrowserRuntimeAction: () => {},
  releaseChildBrowserRuntime: () => {},
  activateChildBrowserRuntime: () => {},
  interactiveBrowserRuntimeOwner: () => {},
  replaceStreamEventInLine: (line: string) => line,
}));
mock.module(join(main, "credential-action.ts"), () => ({
  resolveCookieCredentialForBrowser: () => ({ ok: false }),
}));
mock.module(join(main, "cookie-credential-browser.ts"), () => ({
  restoreCookieCredentialToBrowser: () => {},
}));
mock.module(join(main, "credential-access-service.ts"), () => ({
  buildCredentialSnapshot: () => ({ revision: 1, entries: [] }),
  materializeCredentialCookieForWorker: () => {},
  resolveCredentialValueForWorker: () => {},
}));
mock.module(join(main, "automation-service.ts"), () => ({ reloadAutomations: () => {} }));
mock.module(join(main, "trust-store.ts"), () => ({ getTrustCachedSync: () => "trusted" }));
mock.module(join(main, "project-store.ts"), () => ({ getProjectStore: () => {} }));
mock.module(join(main, "session-cwd-index.ts"), () => ({ getSessionCwdIndex: () => {} }));
mock.module(join(main, "external-runtime-state.ts"), () => ({
  readExternalRuntimeBinding: () => {},
}));
mock.module(join(main, "session-workspace-service.ts"), () => ({
  switchSessionWorkspaceForUi: () => {},
}));
const { AgentBridge } = await import("../../packages/desktop/src/main/agent-bridge.js");
const { WorkerBridgeCore } = await import("../../packages/server/src/worker-bridge-core.js");
const { AgentRunMetadataError } =
  await import("../../packages/desktop/src/main/agent-run-metadata.js");
const bridge = Object.create(AgentBridge.prototype) as any;
const sent: string[] = [];
let starts = 0;
const core = new WorkerBridgeCore({
  entryPath: "/unavailable-fixture-worker",
  prepareInbound: (line, meta) => bridge.prepareInboundLine(line, meta),
});
core.canSend = () => true;
core.sendLine = (line) => {
  sent.push(line);
  return true;
};
core.ensureWorker = () => {
  starts++;
  throw new Error("Ingress must not start a worker");
};
bridge.core = core;
bridge.windows = new Set();
bridge.sessionMainRootMigrationClaims = new Set();
bridge.webConfiguration = { runBlocked: false, settleRun: () => {} };
bridge.agentRunMetadataDeps = () => ({
  isProjectTrusted: () => true,
  isNoRepoCwd: () => true,
  isTrustedOperationBatchRequest: () => true,
});
bridge.attachIpcListener();
afterAll(() => ipc.removeAllListeners());

const ordinary = JSON.stringify({ id: "ordinary", method: "agent/cancel", params: {} });
const privateFrames = [
  { id: "operation-batch-authority-pending", result: { kind: "batch", index: 0, count: 2 } },
  { id: "ordinary-private", method: "desktop/operationBatch", params: {} },
  {
    id: "trusted",
    method: "agent/run",
    params: {
      sessionId: "synthetic-session",
      cwd: "/synthetic",
      operationBatchToken: "synthetic-nonce",
    },
  },
].map((frame) => JSON.stringify(frame));

test("actual renderer callback rejects multi-frame, malformed, and non-object ingress before worker send", () => {
  const invalid: unknown[] = [
    null,
    undefined,
    [],
    {},
    7,
    true,
    "{not json",
    "null",
    "[]",
    "7",
    ...privateFrames,
  ];
  for (const frame of privateFrames)
    for (const delimiter of ["\n", "\r", "\r\n"])
      invalid.push(ordinary + delimiter + frame, frame + delimiter + ordinary);
  invalid.push("\n" + ordinary, ordinary + "\r\n");
  for (const line of invalid) {
    ipc.emit("agent:msg", { sender }, line);
    expect(sent).toHaveLength(0);
    expect(starts).toBe(0);
  }
});

test("actual remote injection and WorkerBridgeCore preparation reject the same raw frames", () => {
  const invalid: unknown[] = [
    null,
    undefined,
    [],
    {},
    7,
    true,
    "{not json",
    "null",
    "[]",
    "7",
    ...privateFrames,
  ];
  for (const frame of privateFrames)
    for (const delimiter of ["\n", "\r", "\r\n"])
      invalid.push(ordinary + delimiter + frame, frame + delimiter + ordinary);
  invalid.push("\n" + ordinary, ordinary + "\r\n");
  for (const line of invalid) {
    expect(() =>
      bridge.injectWorkerMessage(line, { origin: "mobile", producer: "fixture" }),
    ).toThrow(AgentRunMetadataError);
    expect(sent).toHaveLength(0);
    expect(starts).toBe(0);
  }
  expect(() =>
    bridge.prepareInboundLine(ordinary + "\n" + privateFrames[0], {
      origin: "host",
      producer: "fixture",
    }),
  ).toThrow(AgentRunMetadataError);
});

test("both actual ingress paths still send one valid non-run frame with escaped field newlines", () => {
  ipc.emit("agent:msg", { sender }, ordinary);
  bridge.injectWorkerMessage(ordinary, { origin: "mobile", producer: "fixture" });
  const frame =
    " \t" +
    JSON.stringify({
      id: "ordinary",
      method: "agent/cancel",
      params: {
        note: "First line\nSecond line\r\nLast line",
      },
    }) +
    "\t ";
  ipc.emit("agent:msg", { sender }, frame);
  bridge.injectWorkerMessage(frame, { origin: "mobile", producer: "fixture" });
  expect(sent).toEqual([ordinary, ordinary, frame, frame]);
  expect(starts).toBe(0);
});
