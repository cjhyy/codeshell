import assert from "node:assert/strict";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.notEqual(process.platform, "win32", "This fixture exercises native POSIX process groups");
const repo = process.cwd();
const evidence = dirname(fileURLToPath(import.meta.url));
const ownedRoot = mkdtempSync(join(tmpdir(), "codeshell-download-round11-"));
const ownIdentities = new Map();
const responses = new Set();
const server = http.createServer((request, response) => {
  assert.equal(request.url, "/slow");
  responses.add(response);
  response.writeHead(200, { "Content-Type": "application/octet-stream" });
  const timer = setInterval(() => response.write(Buffer.alloc(8192, 11)), 15);
  response.on("close", () => {
    clearInterval(timer);
    responses.delete(response);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const isolationUrl = pathToFileURL(join(repo, "scripts/runtime-cost-smoke-isolation.mjs")).href;
const { installLocalNetworkGuard, confinedWorkerEnvironment } = await import(isolationUrl);
installLocalNetworkGuard(origin); // Before every Core import; descendants inherit a preload.
let negativeProbes = 0;
for (const probe of [() => fetch("https://example.invalid/"), () => http.get("http://127.0.0.1:1/")]) {
  assert.throws(probe, /non-fixture request/);
  negativeProbes++;
}
const environment = confinedWorkerEnvironment(process.env, process.env.HOME, origin, isolationUrl);
environment.CODE_SHELL_HOME = join(ownedRoot, "state");
process.env.CODE_SHELL_HOME = environment.CODE_SHELL_HOME;
const imported = (file) => import(pathToFileURL(join(repo, file)).href);
const { backgroundShellManager } = await imported("packages/core/dist/runtime/background-shell.js");
const { AgentServer } = await imported("packages/core/dist/protocol/server.js");
const { ChatSessionManager } = await imported("packages/core/dist/protocol/chat-session-manager.js");
const { groupAlive } = await imported("packages/core/dist/runtime/spawn-common.js");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const size = (file) => { try { return statSync(file).size; } catch { return 0; } };
async function waitUntil(check, label, timeout = 4000) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) { if (check()) return; await pause(20); }
  throw new Error(`Timed out: ${label}`);
}
const identity = (pid) => {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};
let receive;
let requestId = 0;
const pending = new Map();
const manager = new ChatSessionManager({
  runtime: {},
  engineFactory() { throw new Error("Fixture must never construct an Engine/model"); },
});
const agent = new AgentServer({
  chatManager: manager,
  ownsBackgroundWakeups: false,
  connectionId: "round11-owned-fixture",
  transport: {
    onMessage(callback) { receive = callback; },
    send(message) { pending.get(message.id)?.(message); },
    close() {},
  },
});
async function rpc(method, params) {
  const id = ++requestId;
  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`RPC timed out: ${method}`)), 5000);
    pending.set(id, (message) => { clearTimeout(timeout); pending.delete(id); resolve(message); });
    receive({ jsonrpc: "2.0", id, method, params });
  });
  assert.equal(response.error, undefined, JSON.stringify(response));
  return response.result;
}
let worker;
let workerClosed = false;
const observed = { baseline: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), guard: { negativeProbes, origin, unexpectedRequests: 0 }, ownsOnlyFixtureProcesses: true };
try {
  const destination = join(ownedRoot, "owned-orphan-download.bin");
  const sessionId = "round11-orphan-owner";
  worker = spawn(process.execPath, [join(evidence, "crash-worker.mjs"), repo, origin, destination, join(evidence, "quiet-download.mjs"), sessionId], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let workerError = "";
  worker.stderr.on("data", (chunk) => { workerError += chunk; });
  worker.once("close", () => { workerClosed = true; });
  const started = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`Worker did not start: ${workerError}`)), 4000);
    worker.stdout.on("data", (chunk) => {
      text += chunk;
      const newline = text.indexOf("\n");
      if (newline !== -1) { clearTimeout(timer); resolve(JSON.parse(text.slice(0, newline))); }
    });
    worker.once("error", reject);
  });
  await waitUntil(() => size(destination) >= 16384, "download writing before crash");
  const beforeIdentity = identity(started.pgid);
  assert(beforeIdentity.includes(destination), "PID command owns this unique destination");
  ownIdentities.set(started.pgid, beforeIdentity);
  worker.kill("SIGKILL");
  await waitUntil(() => workerClosed, "own worker exits after SIGKILL");
  const afterCrashSize = size(destination);
  await waitUntil(() => size(destination) > afterCrashSize + 16384, "same download survives worker crash");
  assert.equal(identity(started.pgid), beforeIdentity, "OS start time and command are unchanged");
  const recovered = backgroundShellManager.reapOrphansFromPidfiles();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].pgid, started.pgid);
  assert.equal(recovered[0].sessionId, sessionId);
  assert.equal(backgroundShellManager.get(started.shellId).status, "orphaned");
  const items = (await rpc("agent/backgroundWork", { sessionId, scope: "all" })).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].canCancel, false);
  const cancelled = await rpc("agent/backgroundWorkCancel", { sessionId, kind: "shell", workId: started.shellId, expectedStartedAt: started.startedAt });
  assert.equal(cancelled.cancelled, false);
  const closeResult = await rpc("agent/closeSession", { sessionId });
  assert.deepEqual(closeResult, { ok: true });
  const sizeAtClose = size(destination);
  await waitUntil(() => size(destination) > sizeAtClose + 16384, "download continues after successful session close");
  assert.equal(groupAlive(started.pgid), true);
  assert.equal(identity(started.pgid), beforeIdentity);
  await backgroundShellManager.killAll();
  const sizeAtKillAll = size(destination);
  await waitUntil(() => size(destination) > sizeAtKillAll + 16384, "download continues after killAll");
  assert.equal(identity(started.pgid), beforeIdentity);
  const beforeManualKill = size(destination);
  assert.deepEqual(await rpc("agent/backgroundShells", { sessionId, action: "kill", shellId: started.shellId }), { ok: true });
  await waitUntil(() => !groupAlive(started.pgid), "explicit scoped kill stops owned orphan");
  const afterManualKill = size(destination);
  await pause(100);
  assert.equal(size(destination), afterManualKill);
  observed.orphan = { sessionId, shellId: started.shellId, pgid: started.pgid, osIdentityBeforeCrash: beforeIdentity, osIdentityAfterRecovery: beforeIdentity, pidfile: recovered[0], items, closeResult, cancelled, bytesAtClose: sizeAtClose, bytesAfterClose: sizeAtKillAll, bytesAfterKillAll: beforeManualKill, bytesAfterExplicitKill: afterManualKill, explicitKillRecovered: true };

  // Counter resets across processes. The now-dead orphan may share an id with
  // this new child, but it cannot overwrite a live child in this control.
  const normalDestination = join(ownedRoot, "owned-normal-download.bin");
  const normalSession = "round11-normal-owner";
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `exec ${[process.execPath, join(evidence, "quiet-download.mjs"), origin, normalDestination, repo].map(quote).join(" ")}`;
  const normal = backgroundShellManager.spawnBackground({ command, cwd: repo, shell: "/bin/sh", sessionId: normalSession, shellEnv: environment });
  assert.equal(normal.ok, true);
  const live = backgroundShellManager.get(normal.shellId);
  await waitUntil(() => size(normalDestination) >= 16384, "normal download starts");
  const normalIdentity = identity(live.pgid);
  assert(normalIdentity.includes(normalDestination));
  ownIdentities.set(live.pgid, normalIdentity);
  const normalItems = (await rpc("agent/backgroundWork", { sessionId: normalSession, scope: "session" })).items;
  assert.equal(normalItems.length, 1);
  assert.equal(normalItems[0].canCancel, true);
  assert.deepEqual(await rpc("agent/closeSession", { sessionId: normalSession }), { ok: true });
  await waitUntil(() => !groupAlive(live.pgid), "normal session close kills its download");
  const normalFinalSize = size(normalDestination);
  await pause(100);
  assert.equal(size(normalDestination), normalFinalSize);
  observed.normal = { items: normalItems, statusAfterClose: backgroundShellManager.get(normal.shellId).status, processStopped: true, bytes: normalFinalSize };
  await agent.close();
  observed.noEngineOrProviderStarted = true;
  writeFileSync(join(evidence, "native-observations.json"), JSON.stringify(observed, null, 2) + "\n");
  console.log("PASS native owned orphan download, close/delete barrier, killAll, scoped kill recovery and normal control");
} finally {
  if (worker && !workerClosed) worker.kill("SIGKILL");
  // Only signal this fixture's own groups, and only while ps still reports
  // the exact recorded OS birth and unique command. Never reap arbitrary IDs.
  for (const [pid, expected] of ownIdentities) {
    if (expected && identity(pid) === expected) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
  }
  await agent.close().catch(() => {});
  for (const response of responses) response.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(ownedRoot, { recursive: true, force: true });
}
