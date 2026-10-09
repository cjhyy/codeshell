import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBunTestEnvironment } from "./bun-test-completion.mjs";
import { installRetentionGuard } from "./operation-retention-smoke-isolation.mjs";
import { retentionPlan, seedRetentionMetadata } from "./fixtures/operation-retention-data.mjs";
import { runRetentionCapacity } from "./fixtures/operation-retention-capacity.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../packages/core/package.json", import.meta.url));
const [major, minor] = process.versions.node.split(".").map(Number);
assert.ok(major > 22 || (major === 22 && minor >= 16), "Actual Node >=22.16 required");
assert.equal(process.versions.bun, undefined, "This fixture requires actual Node");
const childMode = process.argv[2] === "--child";
const evidence = childMode
  ? process.argv[5]
  : resolve(process.argv[2] ?? join(process.env.HOME, "retention-evidence"));
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const guards = join(evidence, "guard-receipts.jsonl");
const metrics = [];

// Actual proper-lockfile custody, without changing production stale/wait tuning.
const lockfile = require("proper-lockfile");
const originalLock = lockfile.lockSync;
lockfile.lockSync = function (path, options) {
  const release = originalLock.call(this, path, options);
  const start = performance.now();
  return () => {
    try {
      return release();
    } finally {
      if (String(path).endsWith("/.operations")) {
        assert.equal(options.stale, 10_000);
        metrics.push(performance.now() - start);
      }
    }
  };
};

const hash = (path) => createHash("sha256").update(fs.readFileSync(path)).digest("hex");
const owned = new Set();
async function launch(mode, root, origin, expectedSignal = null, extra = {}) {
  const childHome = fs.mkdtempSync(join(process.env.HOME, "retention-child-"));
  const env = createBunTestEnvironment(process.env, childHome);
  Object.assign(env, {
    CODESHELL_RETENTION_ORIGIN: origin,
    CODESHELL_RETENTION_GUARD_LOG: guards,
    NODE_OPTIONS: `--import ${new URL("./operation-retention-smoke-isolation.mjs", import.meta.url).href}`,
    ...extra,
  });
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--child", mode, root, evidence],
    {
      cwd: repository,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  owned.add(child);
  let output = "";
  child.stdout.on("data", (data) => {
    output += String(data);
  });
  child.stderr.on("data", (data) => {
    output += String(data);
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 50_000);
  const hard = setTimeout(() => child.kill("SIGKILL"), 52_000);
  try {
    const result = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done({ code, signal }));
    });
    fs.writeFileSync(join(evidence, `${mode}-${child.pid}.log`), output, { mode: 0o600 });
    if (expectedSignal) assert.equal(result.signal, expectedSignal, output);
    else {
      assert.equal(result.signal, null, output);
      assert.equal(result.code, 0, output);
    }
    return { ...result, pid: child.pid, output };
  } finally {
    clearTimeout(timer);
    clearTimeout(hard);
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((done) => child.once("close", done));
      child.kill("SIGKILL");
      await closed;
    }
    owned.delete(child);
  }
}

if (childMode) {
  const mode = process.argv[3];
  const root = process.argv[4];
  const origin = process.env.CODESHELL_RETENTION_ORIGIN;
  const file = join(root, ".operations", "ledger.json");
  if (mode.startsWith("crash-")) {
    let publishedArchive = false;
    const write = fs.writeFileSync;
    fs.writeFileSync = (path, ...args) => {
      const value = write(path, ...args);
      if (mode === "crash-after-stage" && String(path).includes("/.stage-"))
        process.kill(process.pid, "SIGKILL");
      return value;
    };
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (
        (["crash-before-manifest", "crash-settle-before-manifest"].includes(mode) && to === file) ||
        (mode === "crash-final-verification" && publishedArchive && to === file) ||
        (mode === "crash-recovery-before-rename" && String(to).includes("/recovery/"))
      )
        process.kill(process.pid, "SIGKILL");
      const value = rename(from, to);
      if (String(from).includes("/.stage-")) publishedArchive = true;
      if (
        (["crash-after-blob", "crash-settle-after-blob"].includes(mode) &&
          String(from).includes("/.stage-")) ||
        (mode === "crash-recovery-after-rename" && String(to).includes("/recovery/")) ||
        (mode === "crash-after-manifest" && to === file)
      )
        process.kill(process.pid, "SIGKILL");
      return value;
    };
    syncBuiltinESMExports();
  }
  const { OperationLedger } = await import("../packages/core/dist/operations/ledger.js");
  const { PlaintextCipher } = await import("../packages/core/dist/credentials/cipher.js");
  const ledger = new OperationLedger(root, new PlaintextCipher());
  if (mode === "crash-final-verification") {
    const { OperationController } = await import("../packages/core/dist/operations/controller.js");
    await new OperationController(ledger).run(
      retentionPlan("verification", "crash-verification-session"),
      {
        assertAuthorized() {},
        async preflight() {},
        async validate() {},
        async authorize() {
          return true;
        },
        async execute() {
          const response = await fetch(`${origin}/send`, {
            method: "POST",
            body: "verification-crash",
          });
          return response.json();
        },
        async verify() {
          return (await fetch(`${origin}/read`)).status === 200;
        },
      },
    );
    assert.fail("Expected abrupt final verification death");
  } else if (mode.startsWith("crash-")) {
    if (mode.startsWith("crash-settle-") || mode.startsWith("crash-recovery-")) {
      const original = JSON.parse(fs.readFileSync(join(root, "fixture-receipt.json"), "utf8"));
      if (mode.startsWith("crash-settle-"))
        ledger.settle(original.id, original.attemptId, "verified");
      else {
        ledger.prepare(retentionPlan());
        ledger.captureRecovery(retentionPlan(), original.id, "identity", { id: "original/read" });
      }
    } else ledger.prepare(retentionPlan(`crash-${mode}`));
    assert.fail("Expected abrupt process death");
  } else if (mode === "claim") {
    const receipt = ledger.prepare(retentionPlan("race"));
    const claim = ledger.claim(receipt.id);
    if (claim.claimed) {
      const response = await fetch(`${origin}/send`, { method: "POST", body: "race" });
      assert.equal(response.status, 200);
      ledger.settle(receipt.id, claim.receipt.attemptId, "succeeded", {
        reference: { id: "race/reference" },
      });
      ledger.settle(receipt.id, claim.receipt.attemptId, "verified");
    }
  } else if (mode === "old-reader") {
    const { default: ts } = await import("typescript");
    const sourceFile = join(repository, "tests/fixtures/operations/schema1-ledger.ts");
    assert.equal(
      hash(sourceFile),
      "a2cf02f3a9486d5fcb054afaa2672b21efdac6663e9153bb75bd224cb48eb0c9",
    );
    let output = ts.transpileModule(fs.readFileSync(sourceFile, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    for (const [from, to] of [
      ["../credentials/cipher.js", "credentials/cipher.js"],
      ["../utils/file-mutex.js", "utils/file-mutex.js"],
      ["./recovery.js", "operations/recovery.js"],
    ])
      output = output.replaceAll(
        `"${from}"`,
        JSON.stringify(pathToFileURL(join(repository, "packages/core/dist", to)).href),
      );
    output = output.replaceAll('"zod"', JSON.stringify(pathToFileURL(require.resolve("zod")).href));
    const oldFile = join(process.env.HOME, "actual-old-schema1-reader.mjs");
    fs.writeFileSync(oldFile, output, { mode: 0o600 });
    const old = await import(pathToFileURL(oldFile).href);
    const reader = new old.OperationLedger(root, new PlaintextCipher());
    assert.throws(() => reader.prepare(retentionPlan("old-must-not-send")));
    const original = JSON.parse(fs.readFileSync(join(evidence, "original-receipt.json"), "utf8"));
    assert.throws(() => reader.claim(original.id));
  } else if (mode === "cold") {
    const original = JSON.parse(fs.readFileSync(join(evidence, "original-receipt.json"), "utf8"));
    assert.deepEqual(ledger.prepare(retentionPlan()), original);
    assert.equal(ledger.claim(original.id).claimed, false);
    assert.deepEqual(ledger.settle(original.id, original.attemptId, "verified"), original);
    assert.equal(ledger.provePlan(original, retentionPlan()), true);
    assert.throws(() => ledger.prepare({ ...retentionPlan(), parameters: { body: "changed" } }));
  } else if (mode === "full-reject") {
    assert.throws(() => ledger.prepare(retentionPlan("full-cold-matrix")), /ledger is full/);
  } else assert.fail(`Unknown fixture mode ${mode}`);
  fs.writeFileSync(
    join(evidence, `${mode}-${process.pid}-metrics.json`),
    JSON.stringify({ pid: process.pid, metrics }),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ mode, metrics, passed: true }));
} else {
  const root = fs.mkdtempSync(join(process.env.HOME, "retention-data-"));
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    assert.ok(body.length < 1024);
    calls.push({ method: request.method, path: request.url, body });
    response
      .writeHead(200, { "content-type": "application/json" })
      .end('{"id":"fixture/reference"}');
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  installRetentionGuard(origin, guards);
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    for (const child of owned) child.kill("SIGKILL");
    process.exitCode = 1;
    server.close();
    server.closeAllConnections();
  }, 240_000);
  const { OperationLedger } = await import("../packages/core/dist/operations/ledger.js");
  const { OperationController } = await import("../packages/core/dist/operations/controller.js");
  const { PlaintextCipher } = await import("../packages/core/dist/credentials/cipher.js");
  const cipher = new PlaintextCipher();
  const adapter = {
    assertAuthorized() {},
    async preflight() {},
    async validate() {},
    async authorize() {
      return true;
    },
    async execute() {
      const response = await fetch(`${origin}/send`, { method: "POST", body: "controller" });
      assert.equal(response.status, 200);
      return response.json();
    },
    async verify() {
      const response = await fetch(`${origin}/read`);
      return response.status === 200;
    },
  };
  try {
    const ledger = new OperationLedger(root, cipher);
    const original = await new OperationController(ledger).run(retentionPlan(), adapter);
    assert.equal(original.state, "verified");
    fs.writeFileSync(join(evidence, "original-receipt.json"), JSON.stringify(original), {
      mode: 0o600,
    });
    const seeded = seedRetentionMetadata(root, 10_000, {
      decrypt: (value) => cipher.decrypt(value),
    });
    const beforeKey = seeded.state.key;
    const sentBefore = calls.length;
    const next = await new OperationController(ledger).run(
      retentionPlan("after-capacity"),
      adapter,
    );
    assert.equal(next.state, "verified");
    assert.equal(calls.length, sentBefore + 2, "one HTTP send and independent read");
    const compacted = JSON.parse(fs.readFileSync(seeded.file, "utf8"));
    assert.equal(compacted.schema, 2);
    assert.equal(compacted.key, beforeKey);
    assert.ok(Object.keys(compacted.records).length < 10_000);
    await launch("cold", root, origin);
    await launch("old-reader", root, origin);
    assert.equal(calls.length, sentBefore + 2, "cold and actual old reader send zero HTTP");
    const rollbacks = [];
    for (const missing of [false, true]) {
      const rollbackRoot = fs.mkdtempSync(join(process.env.HOME, "retention-rollback-"));
      const rollbackLedger = new OperationLedger(rollbackRoot, cipher);
      const first = rollbackLedger.prepare(retentionPlan());
      const claim = rollbackLedger.claim(first.id).receipt;
      rollbackLedger.settle(first.id, claim.attemptId, "succeeded", {
        reference: { id: "rollback/reference" },
      });
      rollbackLedger.settle(first.id, claim.attemptId, "verified");
      const backup = seedRetentionMetadata(rollbackRoot, 9000, {
        decrypt: (value) => cipher.decrypt(value),
      });
      rollbackLedger.prepare(retentionPlan("new-generation"));
      const archiveDirectory = join(rollbackRoot, ".operations", "archives");
      const archiveBefore = fs
        .readdirSync(archiveDirectory)
        .map((name) => [name, hash(join(archiveDirectory, name))]);
      if (missing) delete backup.state.records[first.id];
      else {
        Object.assign(backup.state.records[first.id], { state: "planned" });
        for (const field of ["attemptId", "reference", "verifiedAt"])
          delete backup.state.records[first.id][field];
      }
      fs.writeFileSync(backup.file, JSON.stringify(backup.state), { mode: 0o600 });
      const before = hash(backup.file);
      const httpBefore = calls.length;
      await assert.rejects(
        new OperationController(new OperationLedger(rollbackRoot, cipher)).run(
          retentionPlan(),
          adapter,
        ),
        /not covered/,
      );
      assert.equal(calls.length, httpBefore, "rolled-back manifest cannot issue HTTP");
      assert.equal(hash(backup.file), before);
      assert.deepEqual(
        fs.readdirSync(archiveDirectory).map((name) => [name, hash(join(archiveDirectory, name))]),
        archiveBefore,
      );
      rollbacks.push({ missing, zeroHttp: true, preservedEvidence: true });
    }
    const raceRoot = fs.mkdtempSync(join(process.env.HOME, "retention-race-"));
    const raceLedger = new OperationLedger(raceRoot, cipher);
    const base = raceLedger.prepare(retentionPlan());
    const attempt = raceLedger.claim(base.id).receipt.attemptId;
    raceLedger.settle(base.id, attempt, "succeeded", { reference: { id: "seed/reference" } });
    raceLedger.settle(base.id, attempt, "verified");
    seedRetentionMetadata(raceRoot, 10_000, { decrypt: (value) => cipher.decrypt(value) });
    const raceBefore = calls.length;
    const race = await Promise.all(
      Array.from({ length: 8 }, () => launch("claim", raceRoot, origin)),
    );
    assert.equal(
      calls.length,
      raceBefore + 1,
      "eight actual processes issue exactly one physical HTTP write",
    );
    const raceReceipt = new OperationLedger(raceRoot, cipher).prepare(retentionPlan("race"));
    assert.equal(raceReceipt.state, "verified");
    const crashes = [];
    for (const mode of [
      "crash-after-stage",
      "crash-after-blob",
      "crash-before-manifest",
      "crash-after-manifest",
    ]) {
      const crashRoot = fs.mkdtempSync(join(process.env.HOME, "retention-crash-"));
      const file = join(crashRoot, ".operations", "ledger.json");
      const value = new OperationLedger(crashRoot, cipher);
      const receipt = value.prepare(retentionPlan());
      const id = value.claim(receipt.id).receipt.attemptId;
      value.settle(receipt.id, id, "succeeded", { reference: { id: "crash/reference" } });
      const verified = value.settle(receipt.id, id, "verified");
      seedRetentionMetadata(crashRoot, 9000, { decrypt: (value) => cipher.decrypt(value) });
      const before = JSON.parse(fs.readFileSync(file, "utf8"));
      const result = await launch(mode, crashRoot, origin, "SIGKILL");
      const recovered = new OperationLedger(crashRoot, cipher);
      const start = performance.now();
      assert.deepEqual(recovered.prepare(retentionPlan()), verified);
      const coldWaitMs = performance.now() - start;
      recovered.prepare(retentionPlan(`recover-${mode}`));
      const after = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(after.key, before.key);
      assert.equal(after.schema, 2);
      assert.equal(
        fs.readdirSync(join(crashRoot, ".operations")).some((name) => name.endsWith(".tmp")),
        false,
      );
      const referenced = new Set(
        Object.entries(after.archives.buckets).map(
          ([prefix, entry]) => `${prefix}-${entry.digest}.json`,
        ),
      );
      for (const name of fs.readdirSync(join(crashRoot, ".operations", "archives")))
        assert.ok(referenced.has(name));
      crashes.push({
        mode,
        pid: result.pid,
        coldWaitMs,
        keyUnchanged: true,
        originalUnchanged: true,
      });
    }
    const atomicRecovery = [];
    const noHttpBefore = calls.length;
    for (const mode of [
      "crash-settle-after-blob",
      "crash-settle-before-manifest",
      "crash-recovery-before-rename",
      "crash-recovery-after-rename",
    ]) {
      // Capacity metadata only; the existing controller/race cases above prove real HTTP.
      const crashRoot = fs.mkdtempSync(join(process.env.HOME, "atomic-recovery-"));
      const file = join(crashRoot, ".operations", "ledger.json");
      const value = new OperationLedger(crashRoot, cipher);
      const planned = value.prepare(retentionPlan());
      value.captureRecovery(retentionPlan(), planned.id, "prepared", { authority: "synthetic" });
      const attemptId = value.claim(planned.id).receipt.attemptId;
      const original = value.settle(planned.id, attemptId, "succeeded", {
        reference: { id: "original/reference" },
      });
      value.settle(planned.id, attemptId, "verified");
      const seeded = seedRetentionMetadata(crashRoot, 9000, {
        decrypt: (key) => cipher.decrypt(key),
      });
      // Restore the actual pre-verification receipt; fake capacity records stay labelled metadata.
      seeded.state.records[original.id] = original;
      fs.writeFileSync(file, JSON.stringify(seeded.state), { mode: 0o600 });
      fs.writeFileSync(join(crashRoot, "fixture-receipt.json"), JSON.stringify(original), {
        mode: 0o600,
      });
      const result = await launch(mode, crashRoot, origin, "SIGKILL");
      const recovered = new OperationLedger(crashRoot, cipher);
      assert.deepEqual(recovered.prepare(retentionPlan()), original);
      assert.equal(recovered.claim(original.id).claimed, false);
      if (mode.startsWith("crash-settle-")) {
        // The orphan's proof never upgrades the durable succeeded receipt. A genuine
        // finalization must retain uncertainty and clear only provably redundant staging.
        assert.equal(recovered.sealForFinalization(retentionPlan().sessionId), true);
        const current = new OperationLedger(crashRoot, cipher).prepare(retentionPlan());
        assert.equal(current.state, "unknown");
        assert.equal(current.attemptId, original.attemptId);
        assert.deepEqual(current.reference, original.reference);
        assert.deepEqual(current.recovery, original.recovery);
        assert.equal(recovered.hasUnverifiedWrites(retentionPlan().sessionId), true);
        const other = new OperationLedger(crashRoot, cipher);
        const next = other.prepare(retentionPlan("blocked-by-original"));
        assert.equal(other.claim(next.id).claimed, false);
        assert.equal(other.prepare(retentionPlan()).state, "unknown");
      } else {
        // A new explicit verification may archive the original receipt, but never
        // adopts an unreferenced completed identity snapshot left by the dead process.
        const verified = recovered.settle(original.id, original.attemptId, "verified");
        assert.deepEqual(verified.recovery, original.recovery);
        const cold = new OperationLedger(crashRoot, cipher).prepare(retentionPlan());
        assert.deepEqual(cold, verified);
        const recoveryDirectory = join(crashRoot, ".operations", "recovery", original.id);
        const files = fs.readdirSync(recoveryDirectory);
        assert.equal(
          files.some((name) => name.endsWith(".tmp")),
          false,
        );
        assert.equal(files.length, mode.endsWith("after-rename") ? 2 : 1);
        const retained = JSON.parse(fs.readFileSync(file, "utf8"));
        assert.equal(retained.records[original.id], undefined);
        assert.ok(retained.archives.buckets[original.id.slice(0, 2)].recoveryBytes > 0);
      }
      const after = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(after.key, seeded.state.key);
      atomicRecovery.push({
        mode,
        pid: result.pid,
        signal: result.signal,
        originalIdentityPreserved: true,
      });
    }
    assert.equal(
      calls.length,
      noHttpBefore,
      "atomic metadata recovery never replays a provider write",
    );
    const failedCommitRoot = fs.mkdtempSync(join(process.env.HOME, "retention-verified-commit-"));
    const failedCommitLedger = new OperationLedger(failedCommitRoot, cipher);
    const seedPlan = retentionPlan();
    const seed = failedCommitLedger.prepare(seedPlan);
    const seedAttempt = failedCommitLedger.claim(seed.id).receipt.attemptId;
    failedCommitLedger.settle(seed.id, seedAttempt, "succeeded", {
      reference: { id: "seed/reference" },
    });
    failedCommitLedger.settle(seed.id, seedAttempt, "verified");
    const failedCommitSeed = seedRetentionMetadata(failedCommitRoot, 9000, {
      decrypt: (value) => cipher.decrypt(value),
      unknown: true,
    });
    const verificationPlan = retentionPlan("verification", "crash-verification-session");
    const httpBeforeFailedCommit = calls.length;
    const failedCommitProcess = await launch(
      "crash-final-verification",
      failedCommitRoot,
      origin,
      "SIGKILL",
    );
    assert.equal(
      calls.length,
      httpBeforeFailedCommit + 2,
      "one send and read before abrupt commit death",
    );
    const failedCommitCold = new OperationLedger(failedCommitRoot, cipher);
    const coldFailedCommitReceipt = failedCommitCold.prepare(verificationPlan);
    assert.equal(coldFailedCommitReceipt.state, "succeeded");
    assert.equal(failedCommitCold.claim(coldFailedCommitReceipt.id).claimed, false);
    assert.equal(failedCommitCold.hasUnverifiedWrites(verificationPlan.sessionId), true);
    // A real finalization discards only the unpublished verified copy. The durable
    // provider attempt stays unknown; neither the original nor a new same-session
    // intent may replay the already sent request.
    assert.equal(failedCommitCold.sealForFinalization(verificationPlan.sessionId), true);
    const finalized = new OperationLedger(failedCommitRoot, cipher).prepare(verificationPlan);
    assert.equal(finalized.state, "unknown");
    for (const field of ["id", "attemptId", "reference", "recovery", "createdAt", "fingerprint"])
      assert.deepEqual(finalized[field], coldFailedCommitReceipt[field]);
    assert.equal(finalized.verifiedAt, undefined);
    assert.equal(failedCommitCold.hasUnverifiedWrites(verificationPlan.sessionId), true);
    const controller = new OperationController(new OperationLedger(failedCommitRoot, cipher));
    assert.equal((await controller.run(verificationPlan, adapter)).state, "unknown");
    const blocked = await controller.run(
      retentionPlan("same-session-after-death", verificationPlan.sessionId),
      adapter,
    );
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.attemptId, undefined);
    assert.equal(
      calls.length,
      httpBeforeFailedCommit + 2,
      "unpublished verified proof cannot upgrade or replay the original provider attempt",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(failedCommitSeed.file, "utf8")).key,
      failedCommitSeed.state.key,
    );
    const capacity = await runRetentionCapacity({
      home: process.env.HOME,
      cipher,
      OperationLedger,
      launch,
      origin,
      criticalMetrics: metrics,
    });
    const receipts = fs.readFileSync(guards, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(receipts.length >= 14);
    for (const receipt of receipts) assert.equal(receipt.negativeProbes, 3);
    const allMetrics = [...metrics];
    for (const name of fs.readdirSync(evidence).filter((name) => name.endsWith("-metrics.json")))
      allMetrics.push(...JSON.parse(fs.readFileSync(join(evidence, name), "utf8")).metrics);
    assert.ok(
      Math.max(...allMetrics) < 5000,
      "critical sections retain margin below unchanged 10s stale threshold",
    );
    const receipt = {
      schema: 1,
      passed: true,
      node: {
        version: process.version,
        realpath: fs.realpathSync(process.execPath),
        sha256: hash(process.execPath),
        pid: process.pid,
        ppid: process.ppid,
      },
      seededMetadataNotProviderActions: 10_000,
      physicalHttp: calls,
      capacity,
      racePids: race.map((item) => item.pid),
      crashes,
      atomicRecovery,
      rollbacks,
      failedVerificationCommit: {
        pid: failedCommitProcess.pid,
        durableState: "unknown",
        barrier: true,
        originalIdentityPreserved: true,
        unpublishedProofAdopted: false,
        additionalHttp: 0,
        repairRequired: false,
      },
      maxCriticalMs: Math.max(...allMetrics),
      lockStaleMs: 10_000,
      guards: receipts,
      originalReaderGitBlob: "698256ae14db0fd4fde8e0101b00584fdff969d4",
    };
    assert.equal(expired, false, "whole native fixture deadline expired");
    fs.writeFileSync(join(evidence, "native-receipt.json"), JSON.stringify(receipt, null, 2), {
      mode: 0o600,
    });
    console.log(JSON.stringify(receipt));
  } finally {
    clearTimeout(deadline);
    await Promise.all(
      [...owned].map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = new Promise((done) => child.once("close", done));
        child.kill("SIGKILL");
        await closed;
      }),
    );
    await new Promise((done) => {
      server.close(done);
      server.closeAllConnections();
    });
  }
}
