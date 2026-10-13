/*
 * Real compiled Desktop/IPC composer SVG acceptance. The reviewed native
 * installer prepares both entries first; this smoke never fabricates a registry.
 * Run only after the separate runtime plan, driver guard and pack pins are reviewed.
 */
/* global window, document, localStorage, Image, Node, NodeFilter, getComputedStyle, location */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  navigateSettingsMenu,
} from "./electron-harness.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [planPath, planHash] = process.argv.slice(2);
assert.equal(process.argv.length, 4, "Expected <reviewed-runtime-plan.json> <sha256>");
assert.ok(isAbsolute(planPath) && /^[a-f0-9]{64}$/u.test(planHash));
const driver = globalThis[Symbol.for("codeshell.docker-candidate.pre-core")];
assert.equal(driver?.role, "driver", "Original driver guard must precede the smoke");
assert.equal(driver?.negativeProbes, 6);
assert.equal(driver?.dnsNegativeProbes, 4);
const planStat = await lstat(planPath);
assert.ok(planStat.isFile() && !planStat.isSymbolicLink() && planStat.size <= 65536);
assert.equal(planStat.nlink, 1);
const planBytes = await readFile(planPath);
assert.ok(planBytes.length <= 65536);
assert.equal(hash(planBytes), planHash);
const plan = JSON.parse(planBytes);
assert.equal(plan.version, 1);
assert.equal(plan.kind, "compiled-plugin-composer-svg");
assert.equal(plan.home, await realpath(plan.home));
assert.equal(process.env.HOME, plan.home);
assert.equal(process.env.CODE_SHELL_HOME, join(plan.home, ".code-shell"));
assert.equal(plan.appDir, appDir);
const homeStat = await lstat(plan.home);
assert.ok(homeStat.isDirectory() && !homeStat.isSymbolicLink());
if (process.getuid) assert.equal(homeStat.uid, process.getuid());
if (process.platform !== "win32") assert.equal(homeStat.mode & 0o077, 0);
assert.equal(plan.platform, process.platform);

function readPrivatePinnedFile(pin, limit) {
  assert.ok(isAbsolute(pin.path) && /^[a-f0-9]{64}$/u.test(pin.sha256));
  assert.equal(realpathSync(pin.path), pin.path);
  const before = lstatSync(pin.path);
  const descriptor = openSync(pin.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(descriptor);
    assert.ok(info.isFile() && !before.isSymbolicLink() && info.size <= limit);
    assert.equal(info.nlink, 1);
    assert.equal(info.uid, process.getuid());
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(info.dev, before.dev);
    assert.equal(info.ino, before.ino);
    assert.equal(info.dev, pin.dev);
    assert.equal(info.ino, pin.ino);
    const buffer = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(descriptor, buffer, used, buffer.length - used, used);
      if (!count) break;
      used += count;
    }
    const bytes = buffer.subarray(0, used);
    assert.ok(bytes.length <= limit);
    assert.equal(bytes.length, pin.bytes);
    assert.equal(hash(bytes), pin.sha256);
    const after = fstatSync(descriptor);
    assert.equal(after.size, info.size);
    assert.equal(after.mtimeMs, info.mtimeMs);
    assert.equal(after.ctimeMs, info.ctimeMs);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

// The external, Core-free preparation ran the real native metadata preflight.
// Under the original driver guard this callback verifies its exact custody;
// it never fabricates a query result or calls the native preflight with a stub.
function verifyPreparedKeychainContext({ home, environment }) {
  assert.equal(home, plan.home);
  assert.equal(environment.HOME, plan.home);
  assert.equal(environment.USERPROFILE, plan.home);
  assert.equal(environment.CODE_SHELL_HOME, join(plan.home, ".code-shell"));
  if (process.platform !== "darwin") {
    assert.equal(plan.keychainPreparation, null);
    return null;
  }
  const prepared = JSON.parse(readPrivatePinnedFile(plan.keychainPreparation, 65536));
  assert.equal(prepared.kind, "real-electron-keychain-metadata-preparation");
  assert.equal(prepared.home, plan.home);
  assert.equal(prepared.appDir, appDir);
  assert.equal(prepared.scope, "metadata-only; not safeStorage acceptance");
  assert.equal(prepared.files.length, 3);
  assert.deepEqual(
    prepared.files.map((pin) => pin.path).sort(),
    [
      join(home, "electron-keychain-reference.json"),
      join(home, "electron-keychain-context.json"),
      join(home, "Library/Preferences/com.apple.security.plist"),
    ].sort(),
  );
  for (const directory of [home, join(home, "Library"), join(home, "Library/Preferences")]) {
    const info = lstatSync(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(realpathSync(directory), directory);
    assert.equal(info.uid, process.getuid());
    assert.equal(info.mode & 0o777, 0o700);
  }
  for (const pin of prepared.files) readPrivatePinnedFile(pin, 4096);
  const reference = JSON.parse(
    readPrivatePinnedFile(
      prepared.files.find((pin) => pin.path === join(home, "electron-keychain-reference.json")),
      4096,
    ),
  );
  assert.equal(reference.version, 1);
  assert.equal(reference.home, prepared.operatorHome);
  assert.equal(reference.path, prepared.defaultKeychain.path);
  assert.equal(reference.pathHash, hash(reference.path));
  const info = lstatSync(reference.path);
  assert.ok(info.isFile() && !info.isSymbolicLink());
  for (const key of ["dev", "ino", "uid"]) {
    assert.equal(info[key], prepared.defaultKeychain[key]);
    assert.equal(info[key], reference[key]);
  }
  return { home, preparedMetadataVerified: true };
}
assert.ok(
  Array.isArray(plan.sourcePins) && plan.sourcePins.length >= 3 && plan.sourcePins.length <= 64,
);
for (const pin of plan.sourcePins) {
  assert.ok(isAbsolute(pin.path) && /^[a-f0-9]{64}$/u.test(pin.sha256));
  assert.equal(hash(await readFile(pin.path)), pin.sha256, "Source/build/runtime pin changed");
}
assert.equal(plan.entries.length, 2);
assert.deepEqual(plan.entries.map((entry) => entry.kind).sort(), ["genuine", "svg-only-fixture"]);
for (const entry of plan.entries) {
  assert.ok(typeof entry.installKey === "string" && entry.installKey.length <= 512);
  assert.ok(typeof entry.displayName === "string" && entry.displayName.length <= 120);
  assert.ok(/^[a-f0-9]{64}$/u.test(entry.svgSha256));
  assert.equal(entry.svgBytes, 1733);
  assert.equal(entry.svgSha256, "54a632d9ee6197ccbc10d43d42217e23d08375bea63ba8eb4b6af757c1535038");
}
const evidenceDir = await realpath(plan.evidenceDir);
assert.ok(isAbsolute(evidenceDir));
const userDataDir = join(plan.home, "electron-user-data");
const phases = [];

function composerRefusalMultiset(events, requiredLength = 6) {
  assert.ok(Number.isSafeInteger(requiredLength) && requiredLength >= 0 && requiredLength <= 6);
  assert.ok(Array.isArray(events) && events.length === requiredLength);
  return events
    .map((event) => {
      assert.deepEqual(Object.keys(event).sort(), ["category", "method", "stack"]);
      assert.ok(["network", "process"].includes(event.category));
      assert.ok(typeof event.method === "string" && event.method.length > 0);
      assert.ok(
        typeof event.stack === "string" && event.stack.length > 0 && event.stack.length <= 1024,
      );
      return JSON.stringify([event.category, event.method, event.stack]);
    })
    .sort();
}

function readPrivateObservationFile(path, identity, limit) {
  assert.equal(realpathSync(path), path);
  const before = lstatSync(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    assert.ok(info.isFile() && !before.isSymbolicLink() && info.size <= limit);
    assert.equal(info.nlink, 1);
    assert.equal(info.uid, process.getuid());
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(info.dev, before.dev);
    assert.equal(info.ino, before.ino);
    assert.equal(info.dev, identity.dev);
    assert.equal(info.ino, identity.ino);
    const buffer = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, used);
      if (!count) break;
      used += count;
    }
    assert.equal(used, info.size);
    const after = fstatSync(fd);
    const named = lstatSync(path);
    for (const observed of [after, named]) {
      assert.ok(observed.isFile() && !observed.isSymbolicLink());
      assert.equal(observed.dev, info.dev);
      assert.equal(observed.ino, info.ino);
      assert.equal(observed.nlink, 1);
      assert.equal(observed.size, info.size);
      assert.equal(observed.mtimeMs, info.mtimeMs);
      assert.equal(observed.ctimeMs, info.ctimeMs);
      assert.equal(observed.uid, info.uid);
      assert.equal(observed.mode & 0o777, 0o600);
    }
    return buffer.subarray(0, used);
  } finally {
    closeSync(fd);
  }
}

function assertComposerFixtureSnapshot(snapshot, expected, baseline) {
  assert.ok(Number.isSafeInteger(snapshot.sequence) && snapshot.sequence > 0);
  assert.equal(snapshot.negativeProbes, 6);
  assert.equal(snapshot.dnsNegativeProbes, 4);
  assert.deepEqual(snapshot.bypassNegativeProbes, { directChildSpawn: 1, inspectorAndDatagram: 4 });
  assert.deepEqual(snapshot.counts, expected.counts);
  assert.deepEqual(snapshot.diagnosticStatus, {
    overflow: false,
    truncated: false,
    captureErrors: 0,
  });
  assert.equal(snapshot.ledgerFailure, null);
  assert.deepEqual(
    composerRefusalMultiset(snapshot.denialEvents),
    composerRefusalMultiset(expected.events),
  );
  if (baseline) {
    assert.equal(snapshot.pid, baseline.pid);
    assert.deepEqual(snapshot.ledgerIdentity, baseline.ledgerIdentity);
    assert.ok(snapshot.sequence >= baseline.sequence);
    assert.deepEqual(snapshot.counts, baseline.counts);
    assert.deepEqual(
      composerRefusalMultiset(snapshot.denialEvents),
      composerRefusalMultiset(baseline.denialEvents),
    );
  }
}

function assertComposerObservationLedger(ledger, expected, baseline, mainPid) {
  assert.ok(Array.isArray(ledger) && ledger.length > 0 && ledger.length <= 64);
  assert.equal(ledger[0].stage, "pre-core");
  assert.equal(ledger.filter((row) => row.stage === "pre-core").length, 1);
  assert.deepEqual(ledger[0].counts, {
    networkAttempts: 0,
    processAttempts: 0,
    rendererNetworkAttempts: 0,
  });
  assert.deepEqual(ledger[0].denialEvents, []);
  assert.equal(ledger.at(-1).stage, "process-exit");
  assert.equal(ledger.filter((row) => row.stage === "process-exit").length, 1);
  const budget = new Map();
  for (const fingerprint of composerRefusalMultiset(expected.events)) {
    budget.set(fingerprint, (budget.get(fingerprint) ?? 0) + 1);
  }
  let previous = new Map();
  for (const [index, row] of ledger.entries()) {
    assert.ok(["pre-core", "denial", "checkpoint", "process-exit"].includes(row.stage));
    assert.equal(row.sequence, index + 1);
    assert.equal(row.pid, mainPid);
    assert.deepEqual(row.ledgerIdentity, baseline.ledgerIdentity);
    assert.deepEqual(row.diagnosticStatus, { overflow: false, truncated: false, captureErrors: 0 });
    assert.equal(row.ledgerFailure, null);
    assert.ok(Array.isArray(row.denialEvents) && row.denialEvents.length <= 6);
    const observed = new Map();
    for (const fingerprint of composerRefusalMultiset(row.denialEvents, row.denialEvents.length)) {
      const count = (observed.get(fingerprint) ?? 0) + 1;
      assert.ok(budget.has(fingerprint) && count <= budget.get(fingerprint));
      observed.set(fingerprint, count);
    }
    for (const [fingerprint, count] of previous) {
      assert.ok((observed.get(fingerprint) ?? 0) >= count, "Earlier refusal cannot disappear");
    }
    assert.deepEqual(row.counts, {
      networkAttempts: row.denialEvents.filter((event) => event.category === "network").length,
      processAttempts: row.denialEvents.filter((event) => event.category === "process").length,
      rendererNetworkAttempts: 0,
    });
    previous = observed;
    if (row.sequence >= baseline.sequence) assertComposerFixtureSnapshot(row, expected, baseline);
  }
  assert.ok(ledger.at(-1).sequence > baseline.sequence);
}

function rememberComposerMetrics(metrics, mainPid, knownMetrics) {
  const allowedTypes = new Set(["Browser", "GPU", "Utility", "Tab"]);
  assert.ok(Array.isArray(metrics) && metrics.length > 0 && metrics.length <= 32);
  assert.equal(new Set(metrics.map((item) => item.pid)).size, metrics.length);
  assert.equal(metrics.filter((item) => item.type === "Browser").length, 1);
  assert.equal(metrics.find((item) => item.type === "Browser").pid, mainPid);
  for (const item of metrics) {
    assert.ok(Number.isSafeInteger(item.pid) && item.pid > 0 && allowedTypes.has(item.type));
    if (knownMetrics.has(item.pid)) assert.equal(knownMetrics.get(item.pid), item.type);
    knownMetrics.set(item.pid, item.type);
  }
}

function assertComposerFixtureEffects(mainEffects, metrics, nativePsRows, mainPid, knownMetrics) {
  assert.deepEqual(mainEffects, {
    supported: true,
    truncated: false,
    activeChildProcessHandles: 0,
    unknownChildProcessHandles: 0,
    listeningJsServers: 0,
    connectedOrConnectingJsSockets: 0,
    unknownJsSockets: 0,
  });
  rememberComposerMetrics(metrics, mainPid, knownMetrics);
  assert.ok(Array.isArray(nativePsRows) && nativePsRows.length > 0 && nativePsRows.length <= 160);
  const relevant = nativePsRows.filter((row) =>
    row.ownedSubtree.some((item) => item.pid === mainPid),
  );
  assert.ok(
    relevant.length > 0,
    "Original watchdog must actually observe this owned Electron root",
  );
  const births = new Map();
  for (const row of relevant) {
    assert.equal(row.status, 0);
    assert.equal(row.signal, null);
    assert.equal(row.nativeActualTerminal, true);
    assert.ok(Number.isSafeInteger(row.nativePsPid) && row.nativePsPid > 0);
    for (const item of row.ownedSubtree) {
      assert.ok(
        knownMetrics.has(item.pid),
        "Observed owned subtree contains an unclassified child",
      );
      assert.ok(typeof item.birth === "string" && item.birth.length > 0 && item.birth.length <= 80);
      if (births.has(item.pid)) assert.equal(births.get(item.pid), item.birth);
      births.set(item.pid, item.birth);
    }
  }
}

const fixtureAuthority = JSON.parse(readPrivatePinnedFile(plan.fixtureContractAuthority, 16384));
assert.equal(
  fixtureAuthority.kind,
  "root-explicit-versioned-composer-fixture-contract-amendment-v1",
);
const fixtureClarification = JSON.parse(
  readPrivatePinnedFile(plan.fixtureContractClarification, 16384),
);
assert.equal(
  fixtureClarification.kind,
  "root-composer-fixture-contract-v1.1-clarification-for-real-automatic-media-and-close-ledger",
);
assert.equal(fixtureClarification.parent.sha256, plan.fixtureContractAuthority.sha256);
const fixtureExpected = {
  counts: fixtureAuthority.newContract.perPhaseRawCountsMustEqual,
  events: fixtureAuthority.newContract.requiredRefusalMultiset,
};
assert.deepEqual(fixtureExpected.counts, {
  networkAttempts: 2,
  processAttempts: 4,
  rendererNetworkAttempts: 0,
});
composerRefusalMultiset(fixtureExpected.events);
const compiledSourceMap = JSON.parse(
  readPrivatePinnedFile(plan.fixtureCompiledSourceMapping, 65536),
);
assert.equal(compiledSourceMap.kind, "composer-svg-startup-refusal-compiled-source-map-v1");
assert.equal(compiledSourceMap.authoritySha256, plan.fixtureContractAuthority.sha256);
assert.equal(compiledSourceMap.clarificationSha256, plan.fixtureContractClarification.sha256);
assert.deepEqual(compiledSourceMap.refusalMultiset, fixtureExpected.events);
const framePaths = [
  ...new Set(
    fixtureExpected.events.flatMap((event) =>
      event.stack.split("\n").map((frame) => frame.split(":")[0]),
    ),
  ),
].sort();
assert.deepEqual(compiledSourceMap.sources.map((source) => source.relativePath).sort(), framePaths);
for (const source of compiledSourceMap.sources) {
  const path = resolve(appDir, "../..", source.relativePath);
  assert.equal(path, source.path);
  assert.ok(
    plan.sourcePins.some(
      (pin) => pin.path === path && pin.bytes === source.bytes && pin.sha256 === source.sha256,
    ),
  );
  const bytes = await readFile(path);
  assert.equal(bytes.length, source.bytes);
  assert.equal(hash(bytes), source.sha256);
}
const driverEffects = globalThis[Symbol.for("codeshell.composer-svg.driver-observation")];
assert.equal(driverEffects?.version, 1);
assert.equal(driverEffects?.pid, process.pid);

function mainGuardSource(receipt) {
  return `// Test-only synchronous bootstrap; no product imports before guards/probes.
const assert = require("node:assert/strict");
const { app, net: electronNet } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const cp = require("node:child_process");
const http = require("node:http"), https = require("node:https");
const http2 = require("node:http2"), net = require("node:net"), tls = require("node:tls");
const dns = require("node:dns"), dgram = require("node:dgram");
const workers = require("node:worker_threads");
const inspector = require("node:inspector");
const { syncBuiltinESMExports } = require("node:module");
const home = ${JSON.stringify(plan.home)};
assert.equal(process.env.HOME, home);
assert.equal(fs.realpathSync(home), home);
const counts = { networkAttempts: 0, processAttempts: 0, rendererNetworkAttempts: 0 };
const deniedEvents = [];
const diagnosticStatus = {overflow:false,truncated:false,captureErrors:0};
let recordDeniedEvents = false;
const worktree = path.resolve(${JSON.stringify(appDir)}, "../..");
function recordDenial(category, method) {
  if (!recordDeniedEvents) return;
  if (deniedEvents.length >= 16) { diagnosticStatus.overflow=true; writeObservation("denial"); return; }
  try {
    const frames = [];
    let chars = 0;
    const lines=String(new Error().stack ?? "").split("\\n");
    if(lines.length>32)diagnosticStatus.truncated=true;
    for (const line of lines.slice(0, 32)) {
      const start = line.indexOf(worktree + "/packages/");
      if (start < 0) continue;
      const match = line.slice(start + worktree.length + 1).match(/^(.*\\.(?:mjs|cjs|js)):(\\d+):(\\d+)\\)?$/);
      if (!match) continue;
      const parts = match[1].split("/");
      if (parts[0] !== "packages" || !["dist", "out"].includes(parts[2]) ||
          !parts.every(part => part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part))) continue;
      if (![match[2], match[3]].every(value => Number.isSafeInteger(Number(value)) && Number(value) > 0)) continue;
      const frame = match[1] + ":" + match[2] + ":" + match[3];
      if (chars + frame.length + (frames.length ? 1 : 0) > 1024) { diagnosticStatus.truncated=true; break; }
      chars += frame.length + (frames.length ? 1 : 0);
      frames.push(frame);
    }
    deniedEvents.push(Object.freeze({category, method, stack:frames.join("\\n")}));
  } catch { diagnosticStatus.captureErrors++; }
  writeObservation("denial");
}
function networkDenied(method) { counts.networkAttempts++; recordDenial("network", method); throw new Error("Composer SVG fixture denied network"); }
function processDenied(method) { counts.processAttempts++; recordDenial("process", method); throw new Error("Composer SVG fixture denied process"); }
const denyNetwork = method => function () { return networkDenied(method); };
const denyProcess = method => function () { return processDenied(method); };
globalThis.fetch = denyNetwork("global.fetch");
globalThis.WebSocket = denyNetwork("global.WebSocket");
for (const [name, mod] of [["http",http], ["https",https]]) for (const key of ["request", "get"]) mod[key] = denyNetwork(name + "." + key);
http2.connect = denyNetwork("http2.connect");
net.connect = denyNetwork("net.connect"); net.createConnection = denyNetwork("net.createConnection");
net.Socket.prototype.connect = denyNetwork("net.Socket.connect"); net.Server.prototype.listen = denyNetwork("net.Server.listen");
tls.connect = denyNetwork("tls.connect"); dgram.createSocket = denyNetwork("dgram.createSocket");
for (const key of ["bind", "connect", "send"]) dgram.Socket.prototype[key] = denyNetwork("dgram.Socket." + key);
inspector.open = denyNetwork("inspector.open");
for (const [name, target] of [["dns",dns], ["dns.promises",dns.promises]]) for (const key of Object.keys(target))
  if (typeof target[key] === "function") target[key] = denyNetwork(name + "." + key);
for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[key] = denyProcess("child_process." + key);
cp.ChildProcess.prototype.spawn = denyProcess("ChildProcess.spawn");
workers.Worker = denyProcess("worker_threads.Worker");
electronNet.request = denyNetwork("electron.net.request"); electronNet.fetch = denyNetwork("electron.net.fetch");
syncBuiltinESMExports();
for (const probe of [() => fetch("https://external.invalid/"), () => http.get("http://127.0.0.1:1"),
  () => net.connect(2, "127.0.0.1"), () => tls.connect({host:"127.0.0.1",port:3}),
  () => dgram.createSocket("udp4"), () => cp.spawn("sh", ["-c", "exit 0"])])
  assert.throws(probe, /Composer SVG fixture denied/);
for (const probe of [() => dns.resolveTxt("external.invalid"), () => dns.promises.resolveAny("external.invalid"),
  () => new dns.Resolver(), () => new dns.promises.Resolver()]) assert.throws(probe, /Composer SVG fixture denied/);
const beforeBypass = {...counts};
assert.throws(() => new cp.ChildProcess().spawn({file:"sh",args:["sh","-c","exit 0"]}), /Composer SVG fixture denied/);
assert.throws(() => inspector.open(0,"127.0.0.1"), /Composer SVG fixture denied/);
const socket = new dgram.Socket("udp4");
for (const probe of [() => socket.bind(0,"127.0.0.1"), () => socket.connect(1,"127.0.0.1"),
  () => socket.send(Buffer.from("probe"),1,"127.0.0.1")]) assert.throws(probe, /Composer SVG fixture denied/);
try { socket.close(); } catch (error) { assert.equal(error.code,"ERR_SOCKET_DGRAM_NOT_RUNNING"); }
const bypassNegativeProbes = {directChildSpawn:counts.processAttempts-beforeBypass.processAttempts,
  inspectorAndDatagram:counts.networkAttempts-beforeBypass.networkAttempts};
assert.deepEqual(bypassNegativeProbes,{directChildSpawn:1,inspectorAndDatagram:4});
counts.networkAttempts = 0; counts.processAttempts = 0;
const observationPath=${JSON.stringify(receipt.replace("main-pre-core-", "main-observation-") + "l")};
let observationFd,observationIdentity,observationSequence=0,observationBytes=0,observationFailure=null,observationPrimaryError;
function latchObservationFailure(stage,error) {
  if(observationFailure!==null)return;
  observationFailure={stage};observationPrimaryError=error;diagnosticStatus.captureErrors++;process.exitCode=1;
  if(error){observationFailure.name=error.name;observationFailure.code=typeof error.code==="string"&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:null;}
}
try {
  observationFd=fs.openSync(observationPath,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  observationIdentity=fs.fstatSync(observationFd);
  assert.ok(observationIdentity.isFile()&&observationIdentity.uid===process.getuid()&&observationIdentity.nlink===1&&(observationIdentity.mode&0o777)===0o600);
} catch(error) {
  latchObservationFailure("open-or-identity",error);
  if(observationFd!==undefined)try{fs.closeSync(observationFd);}catch(cleanup){
    try{Object.defineProperty(error,"composerObservationCleanup",{value:{name:cleanup.name}});}catch{}
  }
  throw error;
}
function observationSnapshot() { return {pid:process.pid,ledgerIdentity:{dev:observationIdentity.dev,ino:observationIdentity.ino},negativeProbes:6,dnsNegativeProbes:4,bypassNegativeProbes,counts:{...counts},denialEvents:deniedEvents.map(event=>({...event})),diagnosticStatus:{...diagnosticStatus},ledgerFailure:observationFailure}; }
function writeObservation(stage) {
  if(observationFailure!==null)return {...observationSnapshot(),stage,sequence:observationSequence,ledgerWriteFailed:true};
  try {
    const row={stage,sequence:observationSequence+1,...observationSnapshot()};
    const bytes=Buffer.from(JSON.stringify(row)+"\\n");
    if(row.sequence>64||observationBytes+bytes.length>1024*1024)throw new Error("Composer observation ledger cap");
    let used=0;
    while(used<bytes.length) {
      const count=fs.writeSync(observationFd,bytes,used,bytes.length-used);
      if(!Number.isSafeInteger(count)||count<=0)throw new Error("Composer observation short write");
      used+=count;
    }
    fs.fsyncSync(observationFd);observationSequence++;observationBytes+=bytes.length;return row;
  } catch(error) { latchObservationFailure(stage,error);return {...observationSnapshot(),stage,sequence:observationSequence,ledgerWriteFailed:true}; }
}
function effectSnapshot() {
  const result={supported:true,truncated:false,activeChildProcessHandles:0,unknownChildProcessHandles:0,listeningJsServers:0,connectedOrConnectingJsSockets:0,unknownJsSockets:0};
  try {
    if(typeof process._getActiveHandles!=="function")return {...result,supported:false};
    const handles=process._getActiveHandles();
    const stdio=new Set([process.stdin,process.stdout,process.stderr]);
    if(handles.length>256)result.truncated=true;
    for(const handle of handles.slice(0,256)) {
      if(handle instanceof cp.ChildProcess) {
        if(Number.isSafeInteger(handle.pid)&&handle.pid>0&&handle.exitCode===null&&handle.signalCode===null)result.activeChildProcessHandles++;
        else result.unknownChildProcessHandles++;
      }
      if(handle instanceof net.Server&&handle.listening)result.listeningJsServers++;
      if(handle instanceof net.Socket&&!stdio.has(handle)&&!handle.destroyed) {
        if(handle.connecting||handle.remoteAddress)result.connectedOrConnectingJsSockets++;
        else result.unknownJsSockets++;
      }
    }
    return result;
  } catch { return {...result,supported:false}; }
}
recordDeniedEvents = true;
// Delegate original listeners before terminal audit, including late refusals.
// All other process events retain the original emitter and arguments.
const originalProcessEmit=process.emit;
let observationExitSeen=false;
process.emit=function(event,...args) {
  if(event!=="exit")return Reflect.apply(originalProcessEmit,this,[event,...args]);
  try { return Reflect.apply(originalProcessEmit,this,[event,...args]); }
  finally {
    if(observationExitSeen)latchObservationFailure("duplicate-exit");
    observationExitSeen=true;
    writeObservation("process-exit");
    try { fs.closeSync(observationFd); } catch(error) { latchObservationFailure("close",error); }
    // Only terminate this already-exiting owned Main unsuccessfully on lost audit.
    if(observationFailure!==null)process.reallyExit(1);
  }
};
writeObservation("pre-core");
if(observationFailure!==null)throw observationPrimaryError;
const sessions = new Set();
app.on("web-contents-created", (_event, contents) => {
  if (sessions.has(contents.session)) return;
  sessions.add(contents.session);
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    let ownedFile = false;
    if (url.protocol === "file:") {
      try {
        const rel = path.relative(${JSON.stringify(join(appDir, "out/renderer"))}, fs.realpathSync(fileURLToPath(url)));
        ownedFile = rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
      } catch {}
    }
    const imageData = url.protocol === "data:" && ["png", "jpeg", "webp", "svg+xml"].some(type => details.url.startsWith("data:image/" + type + ";base64,"));
    const permit = ownedFile || imageData || details.url === "about:blank";
    if (!permit) { counts.rendererNetworkAttempts++; recordDenial("renderer-network", "session.webRequest.onBeforeRequest"); }
    callback({cancel:!permit});
  });
  contents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) event.preventDefault();
  });
});
const record = Object.freeze({negativeProbes:6,dnsNegativeProbes:4,bypassNegativeProbes,snapshot:()=>({...counts}),denialEvents:()=>deniedEvents.map(event=>({...event})),diagnosticStatus:()=>({...diagnosticStatus}),effectSnapshot,observe:()=>writeObservation("checkpoint")});
Object.defineProperty(globalThis, Symbol.for("codeshell.composer-svg.electron-pre-core"), {value:record});
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({pid:process.pid,ppid:process.ppid,negativeProbes:6,dnsNegativeProbes:4,bypassNegativeProbes,home,network:"deny-all",children:0})+"\\n",{mode:0o600,flag:"wx"});
`;
}

async function imageReport(win, alt) {
  const image = win.getByRole("img", { name: alt, exact: true }).filter({ visible: true }).first();
  await image.waitFor({ state: "visible" });
  return image.evaluate(async (element) => {
    await element.decode();
    const box = element.getBoundingClientRect();
    return {
      tag: element.tagName,
      src: element.currentSrc,
      width: element.naturalWidth,
      height: element.naturalHeight,
      visibleWidth: box.width,
      visibleHeight: box.height,
    };
  });
}

function imageEvidence({ src, ...geometry }) {
  return { ...geometry, sourceSha256: hash(src), mediaType: src.slice(0, src.indexOf(";")) };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out")), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  for (let phase = 0; phase < 2; phase++) {
    const bootstrap = join(plan.home, `composer-svg-main-${phase}.cjs`);
    const receipt = join(evidenceDir, `main-pre-core-${phase}.json`);
    const source = mainGuardSource(receipt);
    await writeFile(bootstrap, source, { mode: 0o600, flag: "wx" });
    let app;
    let electronProcess;
    let mainClose;
    let primary;
    let win;
    let errors = [];
    const cleanupErrors = [];
    const diagnosticErrors = [];
    let mediaBaseline;
    const knownMetrics = new Map();
    const pids = new Set();
    const phaseReport = {
      phase,
      bootstrapSha256: hash(source),
      entries: [],
      fixtureContract: "versioned-source-bound-composer-v1.1",
      wholeMainRawZeroAttempts: false,
    };
    const observeMainProcess = (application) => {
      if (electronProcess) return;
      electronProcess = application.process();
      assert.ok(Number.isSafeInteger(electronProcess.pid) && electronProcess.pid > 0);
      pids.add(electronProcess.pid);
      mainClose = new Promise((resolve) =>
        electronProcess.once("close", (code, signal) => resolve({ code, signal })),
      );
    };
    const observeMetrics = async (stage) => {
      if (!app) return;
      const metrics = await bounded(
        app.evaluate(({ app }) => app.getAppMetrics().map(({ pid, type }) => ({ pid, type }))),
        "Owned Electron process metrics",
      );
      for (const value of metrics) pids.add(value.pid);
      (phaseReport.processObservations ??= []).push({ stage, metrics });
      rememberComposerMetrics(metrics, electronProcess.pid, knownMetrics);
    };
    const observeFixtureStage = async (stage, installKey) => {
      const actual = await bounded(
        app.evaluate(({ app }) => {
          const guard = globalThis[Symbol.for("codeshell.composer-svg.electron-pre-core")];
          return {
            snapshot: guard.observe(),
            mainEffects: guard.effectSnapshot(),
            metrics: app.getAppMetrics().map(({ pid, type }) => ({ pid, type })),
          };
        }),
        "Composer fixture stage observation",
      );
      const native = driverEffects.snapshot();
      assert.equal(native.pid, process.pid);
      assert.equal(native.policyHash, process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH);
      assert.equal(native.homeHash, hash(plan.home));
      for (const item of actual.metrics) pids.add(item.pid);
      const report = {
        stage,
        installKey,
        ...actual,
        nativePsRows: native.readonlyPsRows,
        observationScope:
          "JS visible handles, Electron metrics, and original periodic watchdog process metadata; no comprehensive kernel or transient-effect attestation",
      };
      (phaseReport.guardStages ??= []).push(report);
      assertComposerFixtureSnapshot(actual.snapshot, fixtureExpected, mediaBaseline);
      assertComposerFixtureEffects(
        actual.mainEffects,
        actual.metrics,
        native.readonlyPsRows,
        electronProcess.pid,
        knownMetrics,
      );
      report.passed = true;
      return actual.snapshot;
    };
    const captureFailureDiagnostics = async () => {
      const diagnostics = {};
      const collect = async (label, action) => {
        let timer;
        try {
          diagnostics[label] = await Promise.race([
            action(),
            new Promise((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error(label + " diagnostic timed out")), 2500);
            }),
          ]);
        } catch (error) {
          diagnosticErrors.push({
            label,
            name: error.name,
            message: String(error.message).slice(0, 1000),
          });
        } finally {
          clearTimeout(timer);
        }
      };
      diagnostics.rendererErrors = errors.slice(0, 32).map((error) => ({
        name: error.name,
        message: String(error.message).slice(0, 1000),
      }));
      if (win) {
        await collect("page", () =>
          win.evaluate(() => {
            const text = [];
            const buttons = [];
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ALL);
            let node;
            let visited = 0;
            let textChars = 0;
            while (visited < 4096 && (node = walker.nextNode())) {
              visited++;
              if (node.nodeType === Node.TEXT_NODE && textChars < 8192) {
                const parent = node.parentElement;
                if (parent && !["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) {
                  const value = (node.textContent ?? "").trim().slice(0, 8192 - textChars);
                  if (value) {
                    text.push(value);
                    textChars += value.length;
                  }
                }
              }
              if (
                node.nodeType === Node.ELEMENT_NODE &&
                buttons.length < 64 &&
                (node.tagName === "BUTTON" || node.getAttribute("role") === "button")
              ) {
                const rect = node.getBoundingClientRect();
                const style = getComputedStyle(node);
                buttons.push({
                  text: (node.textContent ?? "").trim().slice(0, 256),
                  ariaLabel: node.getAttribute("aria-label")?.slice(0, 256),
                  ariaLabelledBy: node.getAttribute("aria-labelledby")?.slice(0, 256),
                  title: node.getAttribute("title")?.slice(0, 256),
                  labelledByText: (node.getAttribute("aria-labelledby") ?? "")
                    .split(/\s+/u)
                    .slice(0, 4)
                    .map((id) => document.getElementById(id)?.textContent?.slice(0, 128) ?? "")
                    .join(" ")
                    .slice(0, 256),
                  expanded: node.getAttribute("aria-expanded")?.slice(0, 256),
                  hasPopup: node.getAttribute("aria-haspopup")?.slice(0, 256),
                  sidebarAction: node.getAttribute("data-sidebar-action")?.slice(0, 256),
                  visible:
                    rect.width > 0 &&
                    rect.height > 0 &&
                    style.display !== "none" &&
                    style.visibility !== "hidden" &&
                    !node.closest('[aria-hidden="true"]'),
                });
              }
            }
            return {
              url: location.href.slice(0, 2048),
              title: document.title.slice(0, 256),
              readyState: document.readyState,
              text,
              buttons,
              visited,
              truncated: visited >= 4096,
            };
          }),
        );
        await collect("screenshot", async () => {
          const path = join(evidenceDir, `phase-${phase}-failure.png`);
          await win.screenshot({ path, animations: "disabled", scale: "css", timeout: 2000 });
          return path;
        });
      }
      if (app) {
        await collect("mainGuard", () =>
          app.evaluate(() => {
            const guard = globalThis[Symbol.for("codeshell.composer-svg.electron-pre-core")];
            return {
              negativeProbes: guard?.negativeProbes,
              dnsNegativeProbes: guard?.dnsNegativeProbes,
              bypassNegativeProbes: guard?.bypassNegativeProbes,
              counts: guard?.snapshot(),
              denialEvents: guard?.denialEvents(),
              diagnosticStatus: guard?.diagnosticStatus(),
            };
          }),
        );
      }
      phaseReport.failureDiagnostics = diagnostics;
    };
    try {
      app = await launchCodeShellElectron(
        { appDir, home: plan.home, userDataDir, mainBootstrap: bootstrap },
        {
          preflight: verifyPreparedKeychainContext,
          launch: async (options) => {
            // Preserve ownership before the harness watchdog can reject.
            app = await (await import("playwright"))._electron.launch(options);
            observeMainProcess(app);
            return app;
          },
        },
      );
      observeMainProcess(app);
      await observeMetrics("immediately-after-launch");
      win = await findCodeShellWindow(app);
      errors = captureRendererErrors(win);
      await win.setViewportSize({ width: 1440, height: 960 });
      await win.evaluate(() => {
        window.__composerSvgSentinel = 0;
        localStorage.setItem("codeshell.uiLanguage", "en");
        window.dispatchEvent(new window.Event("codeshell:language-changed"));
      });
      const trustDialog = win.getByRole("dialog", { name: "Trust this project?", exact: true });
      phaseReport.workspaceTrust = { dialogObserved: false, action: null };
      try {
        await trustDialog.waitFor({ state: "visible", timeout: 2500 });
        phaseReport.workspaceTrust.dialogObserved = true;
      } catch (error) {
        if (error.name !== "TimeoutError") throw error;
      }
      if (phaseReport.workspaceTrust.dialogObserved) {
        const projectPath = join(plan.home, ".code-shell/no-repo");
        assert.equal(await trustDialog.getByText(projectPath, { exact: true }).isVisible(), true);
        phaseReport.workspaceTrust.action = "View only (deny write tools)";
        await trustDialog
          .getByRole("button", { name: "View only (deny write tools)", exact: true })
          .click();
        await trustDialog.waitFor({ state: "hidden" });
        const level = await win.evaluate((path) => window.codeshell.getTrust(path), projectPath);
        phaseReport.workspaceTrust.result = level;
        assert.equal(level, "untrusted", "View only must keep write tools denied");
      }
      const restoredSettings = win
        .getByRole("navigation", { name: "Settings navigation", exact: true })
        .filter({ visible: true });
      const visibleSettingsCount = await restoredSettings.count();
      assert.ok(visibleSettingsCount <= 1, "Visible restored Settings navigation must be unique");
      phaseReport.restoredSettings = { visibleNavigations: visibleSettingsCount, action: null };
      if (visibleSettingsCount === 1) {
        const backToApp = restoredSettings
          .getByRole("button", { name: "Back to app", exact: true })
          .filter({ visible: true });
        assert.equal(
          await backToApp.count(),
          1,
          "Restored Settings must have one visible Back to app",
        );
        await backToApp.click();
        phaseReport.restoredSettings.action = "Back to app";
        await restoredSettings.waitFor({ state: "hidden" });
        phaseReport.restoredSettings.hiddenAfterBack = true;
      }
      await navigateSettingsMenu(win, /Open settings/i);
      await win
        .getByRole("navigation", { name: "Settings navigation" })
        .getByRole("button", { name: "Appearance", exact: true })
        .click();
      await win.getByRole("button", { name: /^Light/ }).click();
      await win.waitForFunction(() => !document.documentElement.classList.contains("dark"));
      await win
        .getByRole("navigation", { name: "Settings navigation" })
        .getByRole("button", { name: "Extensions", exact: true })
        .click();
      await win
        .getByRole("navigation", { name: "Extension categories" })
        .getByRole("button", { name: "Packages", exact: true })
        .click();
      const initialPackagesList = win.getByRole("list").filter({
        has: win.getByRole("button").filter({
          has: win.getByText(plan.entries[0].displayName, { exact: true }),
        }),
      });
      await initialPackagesList.waitFor({ state: "visible" });
      // One immediate snapshot: never poll for desired counts or reset them.
      // Product list mounting may already read its own media; all earlier raw
      // refusals must still be exactly the six source-bound startup records.
      mediaBaseline = await observeFixtureStage("packages-ready-before-fixture-media");
      phaseReport.mediaBaseline = mediaBaseline;
      for (const entry of plan.entries) {
        const media = await win.evaluate(
          (key) => window.codeshell.getPluginMedia(key),
          entry.installKey,
        );
        await observeFixtureStage("after-dto", entry.installKey);
        assert.ok(media?.composerIconDataUrl?.startsWith("data:image/svg+xml;base64,"));
        const bytes = Buffer.from(media.composerIconDataUrl.split(",")[1], "base64");
        assert.equal(bytes.length, entry.svgBytes);
        assert.equal(hash(bytes), entry.svgSha256);
        // Decode the genuine DTO in Chromium, even when the declared PNG logo wins UI priority.
        const decoded = await win.evaluate(async (url) => {
          const image = new Image();
          image.src = url;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = 256;
          canvas.height = 256;
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0, 256, 256);
          const pixels = context.getImageData(0, 0, 256, 256).data;
          let paintedPixels = 0;
          for (let offset = 3; offset < pixels.length; offset += 4)
            if (pixels[offset]) paintedPixels++;
          return { width: image.naturalWidth, height: image.naturalHeight, paintedPixels };
        }, media.composerIconDataUrl);
        await observeFixtureStage("after-svg-decode-and-paint", entry.installKey);
        assert.ok(
          decoded.width > 0 &&
            decoded.height > 0 &&
            decoded.width <= 8192 &&
            decoded.height <= 8192 &&
            decoded.width * decoded.height <= 40_000_000,
        );
        assert.ok(
          decoded.paintedPixels > 100 && decoded.paintedPixels < 256 * 256,
          "Chromium must render the original SVG geometry",
        );
        const listImage = await imageReport(win, entry.displayName);
        await observeFixtureStage("after-list-img", entry.installKey);
        assert.equal(listImage.tag, "IMG");
        assert.equal(
          listImage.src,
          entry.kind === "genuine" ? media.logoDataUrl : media.composerIconDataUrl,
        );
        await win
          .getByRole("button")
          .filter({ has: win.getByText(entry.displayName, { exact: true }) })
          .first()
          .click();
        const detailImage = await imageReport(win, entry.displayName);
        await observeFixtureStage("after-detail-img", entry.installKey);
        assert.equal(detailImage.src, listImage.src);
        assert.ok(
          detailImage.width > 0 &&
            detailImage.height > 0 &&
            detailImage.visibleWidth > 0 &&
            detailImage.visibleHeight > 0,
        );
        await win.screenshot({
          path: join(evidenceDir, `phase-${phase}-${entry.kind}.png`),
          animations: "disabled",
          scale: "css",
        });
        phaseReport.entries.push({
          kind: entry.kind,
          installKey: entry.installKey,
          svgSha256: hash(bytes),
          svgBytes: bytes.length,
          decoded,
          listImage: imageEvidence(listImage),
          detailImage: imageEvidence(detailImage),
        });
        await win.getByRole("button", { name: "‹ Back", exact: true }).click();
        const packagesList = win.getByRole("list").filter({
          has: win.getByRole("button").filter({
            has: win.getByText(entry.displayName, { exact: true }),
          }),
        });
        await packagesList.waitFor({ state: "visible" });
        assert.equal(await packagesList.count(), 1, "Return to the actual Packages list");
        for (const listedEntry of plan.entries) {
          assert.equal(
            await packagesList
              .getByRole("button")
              .filter({ has: win.getByText(listedEntry.displayName, { exact: true }) })
              .isVisible(),
            true,
          );
        }
        (phaseReport.packageListReturns ??= []).push({
          after: entry.installKey,
          displayNames: plan.entries.map((listedEntry) => listedEntry.displayName),
        });
        await observeFixtureStage("after-back-and-packages-return", entry.installKey);
      }
      assert.equal(await win.evaluate(() => window.__composerSvgSentinel), 0);
      assert.deepEqual(errors, [], "Plugin media must not raise renderer page errors");
      const guard = await observeFixtureStage("all-media-assertions-complete");
      await observeMetrics("after-assertions");
      phaseReport.guard = guard;
    } catch (error) {
      primary = error;
      phaseReport.primary = { name: error.name, message: String(error.message).slice(0, 1000) };
      try {
        await captureFailureDiagnostics();
      } catch (diagnosticError) {
        diagnosticErrors.push({
          label: "captureFailureDiagnostics",
          name: diagnosticError.name,
          message: String(diagnosticError.message).slice(0, 1000),
        });
      }
    } finally {
      if (app) {
        try {
          observeMainProcess(app);
          await observeMetrics("before-close-in-finally");
          if (mediaBaseline) await observeFixtureStage("immediately-before-normal-close");
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await bounded(app?.close(), "Owned Electron close");
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (mainClose) {
        try {
          phaseReport.mainClose = await bounded(mainClose, "Owned Electron terminal event");
          assert.equal(phaseReport.mainClose.code, 0);
          assert.equal(phaseReport.mainClose.signal, null);
          if (mediaBaseline) {
            const path = join(evidenceDir, `main-observation-${phase}.jsonl`);
            const ledgerBytes = readPrivateObservationFile(
              path,
              mediaBaseline.ledgerIdentity,
              1024 * 1024,
            );
            const ledger = ledgerBytes
              .toString("utf8")
              .trimEnd()
              .split("\n")
              .map((row) => JSON.parse(row));
            assertComposerObservationLedger(
              ledger,
              fixtureExpected,
              mediaBaseline,
              electronProcess.pid,
            );
            phaseReport.terminalObservationLedger = {
              path,
              bytes: ledgerBytes.length,
              sha256: hash(ledgerBytes),
              rows: ledger.length,
              finalSnapshot: ledger.at(-1),
              passed: true,
            };
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      for (const pid of pids) {
        try {
          let alive = true;
          for (let count = 0; count < 20 && alive; count++) {
            try {
              process.kill(pid, 0);
            } catch (error) {
              if (error.code === "ESRCH") alive = false;
              else {
                cleanupErrors.push(error);
                break;
              }
            }
            if (alive) await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.equal(alive, false, "Owned Electron child remains after close");
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      phaseReport.cleanupErrors = cleanupErrors.map((error) => ({
        name: error.name,
        message: String(error.message).slice(0, 1000),
      }));
      phaseReport.diagnosticErrors = diagnosticErrors;
      phaseReport.observedPids = [...pids].sort((a, b) => a - b);
      phases.push(phaseReport);
      try {
        await writeFile(join(evidenceDir, "phases.json"), JSON.stringify(phases, null, 2) + "\n", {
          mode: 0o600,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (primary) throw primary;
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, "Owned Electron cleanup failed");
  }
  console.log(
    JSON.stringify({
      fixture: "compiled-plugin-composer-svg",
      fixtureContract: "versioned-source-bound-composer-v1.1",
      passed: true,
      wholeMainRawZeroAttempts: false,
      historicalV8OverallUiAcceptance: false,
      phases: phases.length,
      planSha256: planHash,
    }),
  );
} finally {
  // Preserve the owned HOME, installation and receipts for independent review.
  assert.ok(!relative(plan.home, userDataDir).startsWith(".."));
}
