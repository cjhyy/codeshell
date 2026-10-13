import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repo = process.cwd(), entry = fileURLToPath(import.meta.url), evidence = dirname(entry);
const mode = process.argv[2] ?? "parent";
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-native-smoke-")) {
  throw new Error("Use scripts/run-isolated-node-smoke.mjs");
}
if (process.getuid?.() === 0) throw new Error("Real EACCES fixture requires a non-root process");

let origin = process.argv[3];
if (mode === "parent") {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${reservation.address().port}`;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
}
const { installLocalNetworkGuard } = await import(`${repo}/scripts/runtime-cost-smoke-isolation.mjs`);
installLocalNetworkGuard(origin);
// Host/helper children never make outgoing connections. Parent performs only
// maintained exact-origin HTTP/fetch, and imports no Core/Host code itself.
if (mode !== "parent") {
  const deny = () => { throw new Error("NETWORK_FORBIDDEN_native_file_mutex_round19"); };
  net.connect = net.createConnection = deny;
  tls.connect = deny;
}

if (mode === "holder") {
  const { acquireLockOnPath } = await import(`${repo}/packages/core/dist/utils/file-mutex.js`);
  const release = acquireLockOnPath(process.argv[4]);
  try {
    process.send?.({ event: "held", at: Date.now() });
    await delay(350);
  } finally {
    release();
    process.send?.({ event: "released", at: Date.now() });
    process.disconnect?.();
  }
} else if (mode === "host") {
  const own = process.argv[4], data = join(own, "data"), cwd = join(own, "workspace");
  const titleFile = join(data, "session-titles.json");
  const anchor = join(data, ".session-titles.json.mutex"), lockPath = `${anchor}.lock`;
  const authAnchor = join(data, "hub"), authLockPath = `${authAnchor}.lock`;
  const firstErrorReceipt = join(own, "first-lock-error.json");
  // Resolve the exact CommonJS dependency instance used by Core's lazy adapter.
  // graceful-fs is a clone, so observing only node:fs can miss its cached method.
  const coreRequire = createRequire(`${repo}/packages/core/dist/utils/lockfile.js`);
  const properRequire = createRequire(coreRequire.resolve("proper-lockfile"));
  const lockFs = properRequire("graceful-fs");
  const nativeMkdir = lockFs.mkdirSync;
  const lockErrors = {}, firstErrors = {};
  // Observation only: delegate the real mkdir unchanged and preserve its error.
  // proper-lockfile's sync adapter uses this exact graceful-fs mkdirSync boundary.
  lockFs.mkdirSync = function (path, ...args) {
    try { return nativeMkdir.call(this, path, ...args); }
    catch (error) {
      if (String(path) === lockPath || String(path) === authLockPath) {
        const code = error.code ?? "unknown";
        lockErrors[code] = (lockErrors[code] ?? 0) + 1;
        if (!firstErrors[code]) {
          firstErrors[code] = { code, path: String(path), at: Date.now() };
          if (code === "EACCES") fs.writeFileSync(firstErrorReceipt, JSON.stringify(firstErrors[code]));
          process.send?.({ event: "lock-error", ...firstErrors[code] });
        }
      }
      throw error;
    }
  };
  // No Core/Host import occurs above the exact-origin guard and filesystem observer.
  const { startHeadlessServer } = await import(`${repo}/packages/server/dist/serve/headless-server.js`);
  const { SessionManager } = await import(`${repo}/packages/core/dist/index.js`);
  fs.mkdirSync(cwd, { recursive: true });
  const disk = new SessionManager(join(data, "worker", "sessions"));
  const session = disk.create(cwd, "owned-never-run-model", "owned-provider", "owned-title-session");
  disk.updateSessionState(session.state.sessionId, { title: "Generated title retained" });
  const host = await startHeadlessServer({
    host: "127.0.0.1", port: Number(new URL(origin).port), cwd, dataDir: data,
    authMode: "hub", workerEntryPath: join(own, "no-worker-entry-created.cjs"),
  });
  let ticks = 0, lastTick = performance.now(), maxGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - lastTick);
    lastTick = now;
    ticks++;
  }, 20);
  let closing = false;
  const closeHost = async () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    try {
      await host.close();
      if (process.connected) process.send({ event: "stopped", workerCreated: host.bridge.hasChild() });
    } catch (error) { console.error(error); process.exitCode = 1; }
    finally { if (process.connected) process.disconnect(); }
  };
  process.on("disconnect", () => { void closeHost(); });
  process.on("SIGTERM", () => { void closeHost(); });
  process.on("message", async (message) => {
    if (message.command === "stats") process.send?.({ event: "stats", id: message.id,
      ticks, maxGapMs, lockErrors, firstErrors, workerCreated: host.bridge.hasChild(), workerGeneration: host.bridge.workerGeneration(),
      titleBytes: fs.existsSync(titleFile) ? fs.readFileSync(titleFile, "utf8") : null,
    });
    if (message.command === "stop") await closeHost();
  });
  process.send?.({ event: "ready", url: host.url, bootstrapToken: host.bootstrapToken, sessionId: session.state.sessionId });
} else {
  const own = fs.realpathSync(fs.mkdtempSync(join(process.env.HOME, "owned-file-mutex-")));
  const data = join(own, "data"), titleFile = join(data, "session-titles.json");
  const anchor = join(data, ".session-titles.json.mutex"), lockPath = `${anchor}.lock`;
  const authAnchor = join(data, "hub"), authLockPath = `${authAnchor}.lock`;
  const events = [], children = new Set(), requests = new Set(), requestPromises = new Set(), childReceipts = [];
  let assertions = 0, commandId = 0, parentTicks = 0, closedNormally = false, failure = null;
  const check = (value, message) => { assertions++; assert.ok(value, message); };
  const equal = (actual, expected, message) => { assertions++; assert.deepEqual(actual, expected, message); };
  const ticker = setInterval(() => parentTicks++, 100);
  function child(kind, path) {
    const proc = fork(entry, [kind, origin, path], { cwd: repo, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.add(proc);
    const receipt = { kind, pid: proc.pid, exitCode: null, signal: null }; childReceipts.push(receipt);
    proc.stdout.on("data", (data) => process.stdout.write(`[${kind}] ${data}`));
    proc.stderr.on("data", (data) => process.stderr.write(`[${kind}] ${data}`));
    proc.on("message", (message) => events.push({ child: kind, receivedAt: Date.now(), ...message }));
    proc.closed = new Promise((resolve) => proc.once("close", (code, signal) => {
      children.delete(proc); receipt.exitCode = code; receipt.signal = signal; resolve({ code, signal });
    }));
    return proc;
  }
  async function until(predicate, label, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await delay(5); }
  }
  const host = child("host", own);
  const hardDeadline = setTimeout(() => { for (const proc of children) proc.kill("SIGTERM"); }, 60000);
  let cookie = "";
  function call(path, method = "GET", body) {
    const promise = performCall(path, method, body);
    requestPromises.add(promise);
    // Attach immediately, even while a separate receipt is awaited.
    promise.catch(() => {});
    promise.finally(() => requestPromises.delete(promise)).catch(() => {});
    return promise;
  }
  async function performCall(path, method, body) {
    const start = performance.now();
    const controller = new AbortController(); requests.add(controller);
    try {
      const response = await fetch(origin + path, { method, signal: controller.signal, headers: {
        origin, connection: "close", ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json(), headers: response.headers, elapsedMs: performance.now() - start };
    } catch (error) {
      events.push({ event: "request-error", path, method, elapsedMs: performance.now() - start,
        name: error.name, message: error.message, code: error.cause?.code });
      throw error;
    } finally { requests.delete(controller); }
  }
  async function stats() {
    const id = ++commandId;
    host.send({ command: "stats", id });
    await until(() => events.some((event) => event.event === "stats" && event.id === id), "Host stats");
    return events.find((event) => event.event === "stats" && event.id === id);
  }
  const observations = [];
  try {
    await until(() => events.some((event) => event.event === "ready"), "real headless ready");
    const ready = events.find((event) => event.event === "ready"), id = ready.sessionId;
    const setup = await call("/api/v1/auth/setup", "POST", { token: ready.bootstrapToken, username: "owned", password: "owned-native-mutex-password" });
    equal(setup.status, 200);
    cookie = setup.headers.get("set-cookie").split(";", 1)[0];
    const endpoint = `/api/v1/sessions/${id}`;
    const first = await call(endpoint, "PATCH", { title: "Initial custom title", expectedTitle: null });
    equal(first.status, 200);
    check(fs.statSync(anchor).isDirectory(), "legitimate first title save pre-creates real lock anchor");
    check(!fs.existsSync(lockPath), "successful title writer releases lock");
    const originalTitleBytes = fs.readFileSync(titleFile, "utf8");
    const healthyBefore = await call("/health");
    equal(healthyBefore.status, 200);
    check(healthyBefore.elapsedMs < 1000, "baseline healthy request completes promptly");
    const before = await stats();
    equal(before.workerCreated, false);
    equal(before.workerGeneration, 0);

    // Only the owned data parent is changed. Real Hub authenticate precedes
    // title mutation and first creates data/hub.lock beside its existing hub dir.
    // Observe that production gate rather than bypassing it to reach title.lock.
    fs.chmodSync(data, 0o500);
    const startTicks = parentTicks;
    const failedWrite = call(endpoint, "PATCH", { title: "Retained draft after repair", expectedTitle: "Initial custom title" });
    await until(() => fs.existsSync(join(own, "first-lock-error.json")), "actual mkdir EACCES receipt");
    const firstError = JSON.parse(fs.readFileSync(join(own, "first-lock-error.json"), "utf8"));
    equal(firstError.code, "EACCES");
    equal(firstError.path, authLockPath, "actual authenticate lock fails before title mutation");
    // Different client process can schedule real healthy requests while Host's
    // JS thread remains blocked in the production retry loop.
    const healthyDuring = call("/health");
    const [failed, health] = await Promise.all([failedWrite, healthyDuring]);
    equal(failed.status, 500);
    equal(failed.body.error, "server request failed");
    equal(health.status, 200);
    check(failed.elapsedMs >= 29000, `title request waited ${failed.elapsedMs}ms`);
    check(health.elapsedMs >= 29000, `independent /health waited ${health.elapsedMs}ms`);
    check(parentTicks - startTicks >= 200, "owned caller's event loop continues while Host is blocked");
    await delay(40);
    const after = await stats();
    check(after.maxGapMs >= 29000, `Host 20ms interval gap ${after.maxGapMs}ms`);
    check(after.lockErrors.EACCES > 1, "real EACCES is synchronously retried");
    equal(after.workerCreated, false);
    equal(after.workerGeneration, 0);
    equal(fs.readFileSync(titleFile, "utf8"), originalTitleBytes, "failed title write leaves bytes unchanged");
    check(!fs.existsSync(lockPath), "permission failure did not create an owned lock");
    observations.push({ scenario: "real-EACCES-authenticate-on-title-request", failedStatus: failed.status, failedMs: failed.elapsedMs,
      healthStatus: health.status, healthMs: health.elapsedMs, actualFailureStage: "HubAuthStore.authenticate/acquireFileLock(data/hub/auth.json)",
      parentTimerTicks: parentTicks - startTicks, hostMaxTimerGapMs: after.maxGapMs, retries: after.lockErrors.EACCES,
      firstError, generatedTitleRetained: true, workerCreated: false });

    fs.chmodSync(data, 0o700);
    const environment = await call("/api/v1/environment");
    equal(environment.status, 200);
    check(environment.elapsedMs < 1000, "authenticated environment request is prompt after repair");
    const repair = await call(endpoint, "PATCH", { title: "Retained draft after repair", expectedTitle: "Initial custom title" });
    equal(repair.status, 200);
    check(repair.elapsedMs < 1000, "same-draft retry is prompt after permission repair");
    equal(JSON.parse(fs.readFileSync(titleFile, "utf8"))[id], "Retained draft after repair");
    const detail = await call(endpoint);
    equal(detail.status, 200);
    equal(detail.body.customTitle, "Retained draft after repair");
    equal(JSON.parse(fs.readFileSync(join(data, "worker", "sessions", id, "state.json"), "utf8")).title, "Generated title retained");
    observations.push({ scenario: "permission-repaired", status: repair.status, elapsedMs: repair.elapsedMs, environmentStatus: environment.status, environmentMs: environment.elapsedMs, sameDraftAccepted: true });

    // Normal cross-process contention: the holder runs in a separate owned
    // process, so its short timer/release can progress during Host's sync wait.
    const holder = child("holder", authAnchor);
    await until(() => events.some((event) => event.child === "holder" && event.event === "held"), "owned production auth lock holder");
    const contended = await call(endpoint, "PATCH", { title: "After normal contention", expectedTitle: "Retained draft after repair" });
    equal(contended.status, 200);
    check(contended.elapsedMs >= 100 && contended.elapsedMs < 2500, `normal contention resolves in ${contended.elapsedMs}ms`);
    equal(await holder.closed, { code: 0, signal: null });
    equal(JSON.parse(fs.readFileSync(titleFile, "utf8"))[id], "After normal contention");
    check(!fs.existsSync(lockPath) && !fs.existsSync(authLockPath), "contended success releases title and auth locks");
    const finalStats = await stats();
    check(finalStats.lockErrors.EEXIST > 0, "contention reached the real existing-lock mkdir boundary");
    equal(finalStats.workerCreated, false);
    observations.push({ scenario: "normal-cross-process-contention", status: contended.status, elapsedMs: contended.elapsedMs,
      existingLockAttempts: finalStats.lockErrors.EEXIST, holderExited: true, workerCreated: false });
    host.send({ command: "stop" });
    equal(await host.closed, { code: 0, signal: null });
    closedNormally = true;
    console.log(`Completed native file mutex round19; ${assertions} assertions; real HubAuth/HTTP/Node + normal title store controls; no worker/model/CLI`);
  } catch (error) {
    failure = { name: error.name, message: error.message, stack: error.stack };
    console.error("Native fixture failure:", error);
    process.exitCode = 1;
  } finally {
    clearTimeout(hardDeadline); clearInterval(ticker);
    for (const controller of requests) controller.abort();
    await Promise.allSettled([...requestPromises]);
    if (fs.existsSync(data)) fs.chmodSync(data, 0o700);
    for (const proc of children) {
      if (proc === host && proc.connected) proc.send({ command: "stop" });
      else proc.kill("SIGTERM");
    }
    for (const proc of [...children]) {
      const timer = setTimeout(() => proc.kill("SIGTERM"), 1500);
      await proc.closed;
      clearTimeout(timer);
    }
    const safeEvents = events.map(({ bootstrapToken: _secret, titleBytes: _titleBytes, ...event }) => event);
    fs.writeFileSync(join(evidence, "native-observations.json"), JSON.stringify({
      node: process.version, platform: process.platform, arch: process.arch, uid: process.getuid?.(), assertions,
      exactOrigin: origin, ownedIsolatedHome: true, nativeHeadlessHost: true, actualHubAuth: true,
      workerCreated: false, closedNormally, failure, childReceipts, observations, events: safeEvents,
    }, null, 2));
    fs.rmSync(own, { recursive: true, force: true });
  }
}
