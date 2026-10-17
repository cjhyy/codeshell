import assert from "node:assert/strict";
import children from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";
import { watchElectronTestProcess } from "../../desktop/scripts/electron-test-watchdog.mjs";

const MAX_LOG = 1024 * 1024;
function diagnosticText(value, limit, fallback) {
  try {
    return String(value).slice(0, limit);
  } catch {
    return fallback;
  }
}
function diagnosticError(error) {
  try {
    return diagnosticText(error?.message ?? error, 4096, "[unprintable failure]");
  } catch {
    return diagnosticText(error, 4096, "[unprintable failure]");
  }
}
function executableIdentity(file) {
  const before = lstatSync(file, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink(), "Canonical browser must remain regular");
  assert.ok(
    before.size > 0n && before.size <= 512n * 1024n * 1024n,
    "Browser binary must be bounded",
  );
  const keys = ["dev", "ino", "size", "mtimeNs", "ctimeNs"];
  const bytes = Buffer.alloc(Number(before.size));
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    for (const key of keys)
      assert.equal(opened[key], before[key], "Browser identity changed before its bounded read");
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      assert.ok(count > 0, "Browser file ended before its pinned size");
      offset += count;
    }
    assert.equal(
      readSync(descriptor, Buffer.alloc(1), 0, 1, offset),
      0,
      "Browser file grew beyond its pinned size",
    );
    const openedAfter = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(file, { bigint: true });
    for (const key of keys) {
      assert.equal(
        openedAfter[key],
        before[key],
        "Browser binary changed during its identity read",
      );
      assert.equal(after[key], before[key], "Browser path changed during its identity read");
    }
  } finally {
    closeSync(descriptor);
  }
  return {
    dev: String(before.dev),
    ino: String(before.ino),
    size: Number(before.size),
    mtimeNs: String(before.mtimeNs),
    ctimeNs: String(before.ctimeNs),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
const outside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};
async function bounded(invoke, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(invoke),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(label)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Fixture-only custody. The existing watchdog alone decides which births may
 * receive signals. All public Playwright contexts/cases remain driver-owned. */
export async function prepareBrowserOperationCustody({
  evidence,
  executablePath,
  executableSHA256,
  environment = process.env,
  timeoutMs = 120_000,
  reportFailure = () => {},
  onCheckpoint = () => {},
  closeTimeoutMs = 8_000,
  settlementTimeoutMs = 15_000,
  exitTimeoutMs = 3_000,
  dependencies = {},
}) {
  const childProcesses = dependencies.children ?? children;
  const synchronize = dependencies.syncBuiltinESMExports ?? syncBuiltinESMExports;
  const watch = dependencies.watch ?? watchElectronTestProcess;
  const signalProcess = dependencies.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
  const remove = dependencies.remove ?? rm;
  const checkout = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));
  evidence = realpathSync(evidence);
  assert.ok(outside(checkout, evidence), "Evidence must remain outside the checkout");
  assert.ok(
    outside(realpathSync(environment.HOME), evidence),
    "Evidence must survive runner HOME cleanup",
  );
  assert.ok(lstatSync(evidence).isDirectory(), "Evidence must be an owned directory");
  const executable = realpathSync(executablePath);
  const executablePin = executableIdentity(executable);
  if (executableSHA256 !== undefined) {
    assert.match(executableSHA256, /^[a-f0-9]{64}$/, "Expected browser SHA256 must be exact");
    assert.equal(executablePin.sha256, executableSHA256, "Browser differs from the resolver's pin");
  }
  for (const value of [timeoutMs, closeTimeoutMs, settlementTimeoutMs, exitTimeoutMs])
    assert.ok(Number.isInteger(value) && value > 0, "Custody deadlines must be positive integers");
  const privateRoot = path.join(evidence, "private-browser");
  mkdirSync(privateRoot, { mode: 0o700 }); // Never adopt an existing HOME or symlink.
  const rootIdentity = lstatSync(privateRoot);
  const env = createBunTestEnvironment(environment, privateRoot);
  const profile = path.join(env.HOME, "chromium-profile");
  mkdirSync(profile, { mode: 0o700 });
  const receipt = {
    schemaVersion: 1,
    status: "preparing",
    privateRoot,
    privateHome: env.HOME,
    profile,
    executable,
    executableSHA256: executablePin.sha256,
    executableIdentity: executablePin,
    privateHomeRemoved: false,
    retainedHome: env.HOME,
    capture: null,
    processExit: null,
    settlement: null,
    failures: [],
    firstFailure: null,
    signals: [],
    logs: {
      stdout: { observedBytes: 0, retainedBytes: 0, truncated: false },
      stderr: { observedBytes: 0, retainedBytes: 0, truncated: false },
    },
    timeline: [],
    truncated: false,
    recordingFailed: false,
    boundary:
      "Exact owned Chromium spawn observed before handshake; existing watchdog PID/parent/birth authority only. Normal close and observed disappearance are distinct. Failure retains the owned HOME/profile; a final report-write failure after successful removal cannot restore it. Not all OS processes or an OS egress sandbox.",
  };
  let child,
    childClosed,
    monitor,
    ownerContext,
    launchStarted = false,
    settled = false;
  let settlementPromise;
  const tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const fail = (stage, error) => {
    const entry = {
      stage: diagnosticText(stage, 120, "[unprintable stage]"),
      message: diagnosticError(error),
    };
    receipt.status = "failed";
    receipt.firstFailure ??= entry;
    if (receipt.failures.length < 64) receipt.failures.push(entry);
    else receipt.truncated = true;
    try {
      const result = reportFailure(`${entry.stage}: ${entry.message}`);
      if (result?.then) {
        receipt.recordingFailed = true;
        // Diagnostic callbacks must be synchronous. Suppress a rejected
        // callback promise without recursively calling the same failed sink.
        Promise.resolve(result).catch(() => {
          receipt.recordingFailed = true;
        });
      }
    } catch {
      receipt.recordingFailed = true;
    }
    return entry;
  };
  const checkpoint = (phase) => {
    if (receipt.timeline.length < 128)
      receipt.timeline.push({
        phase: diagnosticText(phase, 80, "[unprintable phase]"),
        at: Date.now(),
      });
    else receipt.truncated = true;
    try {
      const temporary = path.join(evidence, "browser-custody.json.tmp");
      writeFileSync(temporary, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
      renameSync(temporary, path.join(evidence, "browser-custody.json"));
      const result = onCheckpoint(receipt);
      if (result?.then) {
        Promise.resolve(result).catch((error) => fail("asynchronous diagnostic callback", error));
        throw Error("Custody checkpoint callback must be synchronous");
      }
    } catch (error) {
      receipt.recordingFailed = true;
      fail("diagnostic persistence", error);
      try {
        writeFileSync(
          path.join(evidence, "browser-custody.json"),
          JSON.stringify(receipt, null, 2) + "\n",
          { mode: 0o600 },
        );
      } catch {
        // A broken filesystem cannot be repaired by claiming durable evidence.
      }
    }
  };
  const noteFailure = (stage, error) => {
    fail(stage, error);
    checkpoint("failure");
  };
  checkpoint("prepared");
  const api = {
    env,
    profile,
    privateRoot,
    receipt,
    noteFailure,
    checkpoint,
    logs: () =>
      Object.fromEntries(Object.entries(tails).map(([key, bytes]) => [key, Buffer.from(bytes)])),
    async launchPersistentContext(chromium, options = {}) {
      try {
        assert.equal(launchStarted, false, "Only one owned Chromium launch is allowed");
        launchStarted = true;
        assert.equal(receipt.recordingFailed, false, "Initial custody evidence must be durable");
        assert.ok(
          options.env === undefined || options.env === env,
          "Foreign browser environment refused",
        );
        assert.ok(
          options.executablePath === undefined || options.executablePath === executable,
          "Foreign executable refused",
        );
        assert.ok(
          options.serviceWorkers === undefined || options.serviceWorkers === "block",
          "Owner context must block ServiceWorkers",
        );
      } catch (error) {
        noteFailure("browser launch validation", error);
        throw error;
      }
      const previousSpawn = childProcesses.spawn;
      childProcesses.spawn = function (command, args, spawnOptions) {
        if (command !== executable) {
          assert.ok(
            spawnOptions?.env?.HOME !== env.HOME && !args?.includes(`--user-data-dir=${profile}`),
            "Foreign executable cannot use the owned Chromium launch scope",
          );
          return previousSpawn.call(this, command, args, spawnOptions);
        }
        assert.equal(child, undefined, "Repeated owned Chromium capture refused before spawn");
        assert.equal(
          spawnOptions?.env?.HOME,
          env.HOME,
          "Foreign Chromium HOME refused before spawn",
        );
        assert.ok(Array.isArray(args) && args.every((arg) => typeof arg === "string"));
        assert.deepEqual(
          args.filter((arg) => arg.startsWith("--user-data-dir")),
          [`--user-data-dir=${profile}`],
          "Exactly the owned Chromium profile is required before spawn",
        );
        assert.equal(realpathSync(executable), executable, "Canonical browser path changed");
        assert.deepEqual(
          executableIdentity(executable),
          executablePin,
          "Browser identity changed before spawn",
        );
        child = previousSpawn.call(this, command, args, spawnOptions);
        childClosed = new Promise((resolve) =>
          child.once("close", (code, signal) => {
            receipt.processExit = { code, signal };
            checkpoint("child-close");
            resolve(receipt.processExit);
          }),
        );
        child.once("error", (error) => noteFailure("Chromium spawn", error));
        for (const stream of ["stdout", "stderr"])
          child[stream]?.on("data", (data) => {
            const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
            const meta = receipt.logs[stream];
            meta.observedBytes += bytes.length;
            tails[stream] = Buffer.concat([tails[stream], bytes.subarray(-MAX_LOG)]).subarray(
              -MAX_LOG,
            );
            meta.retainedBytes = tails[stream].length;
            meta.truncated = meta.observedBytes > meta.retainedBytes;
          });
        receipt.capture = {
          pid: child.pid,
          parentPid: process.pid,
          beforeHandshake: true,
          homeMatched: true,
          profileMatched: true,
        };
        // This synchronous constructor captures the fresh root birth before
        // Playwright receives the ChildProcess or its handshake can fail.
        monitor = watch(child, {
          timeoutMs,
          reportFailure: (message) => noteFailure("watchdog", message),
          signalProcess: (pid, signal) => {
            if (receipt.signals.length < 512) receipt.signals.push({ pid, signal });
            else receipt.truncated = true;
            checkpoint("watchdog-signal-request");
            signalProcess(pid, signal);
          },
        });
        assert.equal(typeof monitor?.terminate, "function", "Missing owned termination custody");
        checkpoint("spawn-captured");
        assert.equal(receipt.recordingFailed, false, "Spawn custody evidence must be durable");
        return child;
      };
      try {
        synchronize();
        checkpoint("launch-started");
        assert.equal(receipt.recordingFailed, false, "Launch evidence must be durable");
        ownerContext = await chromium.launchPersistentContext(profile, {
          ...options,
          executablePath: executable,
          env,
          serviceWorkers: "block",
        });
        assert.ok(child && monitor, "Browser birth custody must precede handshake completion");
        assert.equal(
          receipt.failures.length,
          0,
          "Known startup failure must precede UI operations",
        );
        assert.ok(ownerContext.browser(), "Public persistent context must expose its Browser");
        receipt.status = "launched";
        receipt.capture.handshakeCompleted = true;
        checkpoint("handshake-completed");
        return ownerContext;
      } catch (error) {
        noteFailure("browser launch", error);
        throw error;
      } finally {
        childProcesses.spawn = previousSpawn;
        try {
          synchronize();
        } catch (error) {
          noteFailure("spawn hook restore", error);
        }
      }
    },
    async settle() {
      settlementPromise ??= (async () => {
        checkpoint("settling");
        try {
          if (ownerContext) {
            assert.ok(monitor, "No birth custody: unsafe ordinary browser close skipped");
            await bounded(
              () => ownerContext.close(),
              closeTimeoutMs,
              "Owned browser graceful close timed out",
            );
          }
        } catch (error) {
          noteFailure("browser graceful close", error);
        } finally {
          try {
            assert.ok(monitor, "Browser custody was never established");
            receipt.settlement = await bounded(
              () => monitor.terminate(),
              settlementTimeoutMs,
              "Owned browser custody did not settle",
            );
            assert.equal(receipt.settlement.status, "cleaned");
            assert.equal(receipt.settlement.queryFailed, false);
            assert.equal(receipt.settlement.remainingCount, 0);
            assert.equal(receipt.settlement.evidenceTruncated, false);
            assert.deepEqual(receipt.settlement.remaining, []);
            assert.equal(receipt.settlement.ownedCount, receipt.settlement.owned.length);
            assert.ok(
              receipt.settlement.owned.some(
                (row) =>
                  row.pid === child.pid &&
                  row.ppid === process.pid &&
                  typeof row.birth === "string" &&
                  row.birth.length > 0,
              ),
              "Settlement must include the exact captured root incarnation",
            );
            receipt.processExit = await bounded(
              () => childClosed,
              exitTimeoutMs,
              "Owned browser close tuple unavailable",
            );
            assert.deepEqual(receipt.processExit, { code: 0, signal: null });
            assert.equal(
              receipt.signals.some((row) => row.pid === child.pid),
              false,
              "Browser root required a watchdog signal",
            );
          } catch (error) {
            noteFailure("browser settled custody", error);
            child?.unref();
            child?.stdout?.unref?.();
            child?.stderr?.unref?.();
          }
        }
        settled = true;
        receipt.status =
          receipt.failures.length || receipt.recordingFailed || receipt.truncated
            ? "failed"
            : "settled";
        checkpoint("settled");
        return receipt;
      })();
      return settlementPromise;
    },
    async cleanupPrivateHome({ acceptancePassed } = {}) {
      checkpoint("home-cleanup-gate");
      if (receipt.privateHomeRemoved) return { removed: true, retainedHome: null };
      if (
        acceptancePassed === true &&
        settled &&
        receipt.status === "settled" &&
        !receipt.failures.length &&
        !receipt.recordingFailed &&
        !receipt.truncated
      ) {
        try {
          const current = lstatSync(privateRoot);
          assert.ok(current.isDirectory() && !current.isSymbolicLink());
          assert.equal(realpathSync(privateRoot), privateRoot);
          assert.equal(current.dev, rootIdentity.dev);
          assert.equal(current.ino, rootIdentity.ino);
          await remove(privateRoot, { recursive: true, force: false });
          receipt.privateHomeRemoved = true;
          receipt.retainedHome = null;
        } catch (error) {
          noteFailure("owned HOME removal", error);
        }
      }
      checkpoint("home-cleanup-result");
      return { removed: receipt.privateHomeRemoved, retainedHome: receipt.retainedHome };
    },
  };
  return api;
}
