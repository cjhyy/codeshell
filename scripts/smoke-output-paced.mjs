import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  confinedWorkerEnvironment,
  installLocalNetworkGuard,
} from "./runtime-cost-smoke-isolation.mjs";
assert.ok(process.env.CODE_SHELL_TEST_HOME && process.env.CODE_SHELL_HOME);
const repo = resolve("."),
  root = process.env.CODE_SHELL_HOME;
const server = fork(resolve("scripts/fixtures/output-paced-sse.mjs"), [], {
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
server.stderr.pipe(process.stderr);
const [{ origin, pid: serverPid }] = await once(server, "message");
assert.notEqual(serverPid, process.pid);
installLocalNetworkGuard(origin);
const { WorkerBridgeCore } = await import("../packages/server/dist/index.worker.js");
const { sessionsRoot } = await import("../packages/core/dist/index.js");
const core = await import("../packages/core/dist/index.internal.js");
const adapters = resolve("packages/desktop/node_modules/.cache/output-paced-adapters.fixture.mjs");
mkdirSync(resolve("packages/desktop/node_modules/.cache"), { recursive: true });
const built = spawnSync(
  "bun",
  [
    "build",
    "scripts/fixtures/output-journal-adapters.ts",
    "--target=node",
    "--packages=external",
    "--outfile",
    adapters,
  ],
  { encoding: "utf8" },
);
assert.equal(built.status, 0, built.stderr);
const { MainOutputPublisher, SessionSnapshotStore } = await import(pathToFileURL(adapters));
const snapshots = new SessionSnapshotStore({
  coverage: new core.SessionOutputCoverageStore(sessionsRoot),
});
const delays = [],
  controls = [],
  events = [];
const main = new MainOutputPublisher({
  root: sessionsRoot,
  latest: (id) => snapshots.get(id).outputCursor,
  worker: (id, event) => apply(id, event),
});
function apply(id, event) {
  if (!main.observeWorker(id, event)) return false;
  snapshots.append(id, event);
  events.push({ id, event, at: Date.now() });
  if (event.type === "text_delta") {
    for (const line of event.text.trim().split("\n"))
      delays.push(Date.now() - JSON.parse(line).sentAt);
  }
  return true;
}
writeFileSync(
  join(root, "settings.json"),
  JSON.stringify({
    credentials: [
      { id: "fixture", catalogId: "openai", apiKey: "synthetic-paced", baseUrl: origin + "/v1" },
    ],
    modelConnections: [
      { id: "fixture", catalogId: "openai", tag: "text", model: "gpt-4o", credentialId: "fixture" },
    ],
    defaults: { text: "fixture" },
    agent: { preset: "general", maxTurns: 1 },
  }),
  { mode: 0o600 },
);
const env = {
  ...confinedWorkerEnvironment(
    process.env,
    process.env.HOME,
    origin,
    new URL("./runtime-cost-smoke-isolation.mjs", import.meta.url).href,
  ),
  AGENT_CWD: root,
  CODE_SHELL_CAPABILITY_MODULES: "",
  CODE_SHELL_CREDENTIAL_ACCESS: "local",
  CODESHELL_SELF_UPDATE_CHECK: "0",
  CODESHELL_COST_SMOKE_GUARD_LOG: join(root, "paced-worker-guard.jsonl"),
};
const worker = new WorkerBridgeCore({
  execPath: process.execPath,
  entryPath: resolve("packages/core/dist/cli/agent-server-stdio.js"),
  buildEnv: () => env,
  onStderr: (line) => {
    if (!line.includes("Warning:")) process.stderr.write(line);
  },
});
worker.subscribeLines((line) => {
  const message = JSON.parse(line);
  if (message.method === "agent/streamEvent") apply(message.params.sessionId, message.params.event);
});
let serial = 0;
function rpc(method, params) {
  return worker.request(method, params, {
    id: ++serial,
    consume: true,
    timeoutMs: 30000,
    settleOnExit: true,
    failFast: true,
    meta: { origin: "host", producer: "paced-output-smoke" },
  });
}
const quantile = (values, fraction) =>
  values.slice().sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * fraction))
  ];
async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Paced worker did not produce the expected event");
    await new Promise((done) => setTimeout(done, 5));
  }
}
try {
  worker.ensureWorker(root);
  const run = rpc("agent/run", {
    sessionId: "paced-output",
    task: "PACED_FIXTURE",
    clientMessageId: "paced-main",
    behaviorMode: "isolatedTask",
  });
  void run.then((result) => {
    if (result.status !== "result" || result.result?.reason !== "completed")
      console.error("paced fixture run result", result);
  });
  await waitFor(() =>
    events.some((item) => item.id === "paced-output" && item.event.type === "text_delta"),
  );
  for (let index = 0; index < 12; index++) {
    const started = performance.now();
    const result = await rpc("agent/goalGet", { sessionId: "paced-output" });
    controls.push(performance.now() - started);
    assert.equal(result.status, "result");
    await new Promise((done) => setTimeout(done, 100));
  }
  const completed = await run;
  assert.equal(completed.status, "result");
  assert.equal(completed.result.reason, "completed");
  assert.equal(delays.length, 150);
  assert.equal(snapshots.get("paced-output").outputUnpaired, undefined);
  const page = core.readOutputJournal(sessionsRoot(), "paced-output");
  assert.equal(page.complete, true);
  assert.equal(page.through, snapshots.get("paced-output").outputCursor);
  assert.equal(quantile(delays, 0.95) < 200, true, `stream p95 ${quantile(delays, 0.95)}ms`);
  assert.equal(quantile(controls, 0.95) < 200, true, `control p95 ${quantile(controls, 0.95)}ms`);
  const cancelledRun = rpc("agent/run", {
    sessionId: "cancel-output",
    task: "CANCEL_FIXTURE",
    clientMessageId: "cancel-main",
    behaviorMode: "isolatedTask",
  });
  await waitFor(() =>
    events.some((item) => item.id === "cancel-output" && item.event.type === "text_delta"),
  );
  const cancelAt = Date.now(),
    cancel = await rpc("agent/cancel", { sessionId: "cancel-output" });
  assert.equal(cancel.status, "result");
  assert.equal(cancel.result.ok, true);
  const cancelled = await cancelledRun;
  assert.equal(cancelled.status, "result");
  assert.notEqual(cancelled.result.reason, "completed");
  const terminal = events.filter((item) => item.id === "cancel-output").at(-1);
  assert.equal(terminal.event.type, "turn_complete");
  const seq = snapshots.get("cancel-output").nextSeq;
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(snapshots.get("cancel-output").nextSeq, seq);
  assert.equal(
    core.readOutputJournal(sessionsRoot(), "cancel-output").through,
    terminal.event.outputCursor,
  );
  const receipts = readFileSync(env.CODESHELL_COST_SMOKE_GUARD_LOG, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    receipts.some((receipt) => receipt.ppid === process.pid),
    true,
  );
  console.log(
    JSON.stringify({
      pacedIndependentSse: true,
      sourcePid: serverPid,
      workerPid: receipts[0].pid,
      fps: 50,
      frames: 150,
      streamP50Ms: quantile(delays, 0.5),
      streamP95Ms: quantile(delays, 0.95),
      streamMaxMs: Math.max(...delays),
      controlP95Ms: Math.round(quantile(controls, 0.95)),
      controls: controls.length,
      cancelledMs: terminal.at - cancelAt,
      terminalCursorDurable: true,
      noPostTerminalTimer: true,
      mainCoverageComplete: true,
      noExternalNetwork: true,
    }),
  );
} finally {
  await worker.stopAndWait();
  server.disconnect();
  await once(server, "exit");
}
