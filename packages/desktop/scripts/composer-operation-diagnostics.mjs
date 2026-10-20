import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createElectronTestDiagnostics, electronChildExitState } from "./electron-harness.mjs";

const phases = [
  "composer-fixture-init",
  "composer-prepare",
  "composer-launch",
  "composer-find-renderer",
  "composer-worker-guard",
  "composer-ui-operations",
  "composer-graceful-close",
  "composer-custody",
  "composer-main-close",
  "composer-transport",
  "composer-final-ledgers",
  "composer-home-cleanup",
  "composer-final-report",
];
const MAX_EVENTS = 256;
const MAX_SNAPSHOT = 512 * 1024;
const MAX_LOG = 1024 * 1024;
const MAX_GUARD = 64 * 1024;
export const COMPOSER_GUARD_FILES = Object.freeze([
  "network-guard.jsonl",
  "real-keyring-bootstrap.jsonl",
  "spawned-workers.jsonl",
]);
const filesystem = {
  appendFileSync,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
};
const sameFile = (left, right) =>
  ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => left[key] === right[key]);

/** Only three already-created owned records; no directory traversal or content generation. */
function readOwnedGuard(home, name, io) {
  const file = join(home, name);
  const parent = io.lstatSync(home, { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error("Guard parent is not plain");
  let before;
  try {
    before = io.lstatSync(file, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_GUARD))
    throw Error("Guard record is not bounded and plain");
  const fd = io.openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = io.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) throw Error("Guard record changed");
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = io.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count <= 0) throw Error("Guard record short read");
      offset += count;
    }
    const after = io.fstatSync(fd, { bigint: true });
    const current = io.lstatSync(file, { bigint: true });
    const parentAfter = io.lstatSync(home, { bigint: true });
    if (
      !sameFile(opened, after) ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameFile(after, current) ||
      !parentAfter.isDirectory() ||
      parentAfter.isSymbolicLink() ||
      parent.dev !== parentAfter.dev ||
      parent.ino !== parentAfter.ino
    )
      throw Error("Guard record changed");
    return bytes;
  } finally {
    io.closeSync(fd);
  }
}

/** Additional qualification only; the driver retains all original exit/custody/live gates. */
export function composerAcceptanceComplete(report, failure) {
  return !failure && report.result === "pass" && report.cases.length === 9;
}

/** Evidence only. Observer failures never authorize signals or prevent existing cleanup. */
export function createComposerOperationDiagnostics({
  evidence,
  ownedRoots = [],
  controller = process,
  io = filesystem,
} = {}) {
  const base = createElectronTestDiagnostics({ ownedRoots, additionalPhases: phases });
  const receipt = {
    schemaVersion: 1,
    started: new Date().toISOString(),
    status: "incomplete",
    finalReportWritten: false,
    privateHomeRemoved: null,
    controllerExit: null,
    clockBoundary:
      "Top-level elapsedMs uses one controller clock; nested base observations have their own origin. Sequence is callback observation order, not native emission or kernel causality.",
    main: electronChildExitState(),
    diagnostics: base.receipt,
    logs: {
      stdout: { observedBytes: 0, retainedBytes: 0, truncated: false },
      stderr: { observedBytes: 0, retainedBytes: 0, truncated: false },
    },
    guards: {},
    journalTruncated: false,
    recordingFailed: false,
    boundary:
      "Catch-observed error before that catch awaits; no SDK-internal or native-fault ordering claim. Cached Main/controller states and observed signal requests are not OS liveness or all descendants/signals. Stdio ordering is received-byte observation only. Missing guard files do not prove zero attempts. Final IO failure after HOME removal cannot restore it.",
  };
  const started = performance.now();
  let child,
    sequence = 0,
    journalBytes = 0;
  const tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const fail = () => {
    receipt.recordingFailed = true;
  };
  const persist = () => {
    try {
      receipt.main = electronChildExitState(child);
      const bytes = JSON.stringify(receipt, null, 2) + "\n";
      if (Buffer.byteLength(bytes) > MAX_SNAPSHOT) throw Error("Diagnostic snapshot cap");
      const temporary = join(evidence, "diagnostics.json.tmp");
      io.writeFileSync(temporary, bytes, { mode: 0o600 });
      io.renameSync(temporary, join(evidence, "diagnostics.json"));
    } catch {
      fail();
    }
  };
  const event = (kind, fields = {}) => {
    try {
      const row = { sequence: ++sequence, elapsedMs: performance.now() - started, kind, ...fields };
      const line = JSON.stringify(row) + "\n";
      const bytes = Buffer.byteLength(line);
      if (sequence <= MAX_EVENTS && journalBytes + bytes <= MAX_SNAPSHOT) {
        io.appendFileSync(join(evidence, "diagnostics.jsonl"), line, { mode: 0o600 });
        journalBytes += bytes;
      } else receipt.journalTruncated = true;
      persist();
    } catch {
      fail();
      persist();
    }
  };
  const invoke = (method, args) => {
    try {
      const before = base.receipt.timeline.length;
      const result = base[method](...args);
      const rows = base.receipt.timeline.slice(before);
      for (const observation of rows) event(observation.kind, { observation });
      if (!rows.length) persist();
      return result;
    } catch {
      fail();
      persist();
      return undefined;
    }
  };
  const api = {
    receipt,
    hasRecordingFailure: () =>
      receipt.recordingFailed ||
      receipt.journalTruncated ||
      base.receipt.truncated ||
      Object.values(receipt.logs).some((row) => row.truncated),
    phase: (...args) => invoke("phase", args),
    error: (...args) => invoke("error", args),
    cleanup: (...args) => invoke("cleanup", args),
    request: (...args) => invoke("request", args),
    settled: (...args) => invoke("settled", args),
    signal: (...args) => invoke("signal", args),
    observeChild(value) {
      try {
        child = value;
        event("main-captured");
        for (const stream of ["stdout", "stderr"]) {
          io.writeFileSync(join(evidence, `main.${stream}.log`), "", { mode: 0o600 });
          child[stream]?.on("data", (data) => {
            try {
              const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
              const meta = receipt.logs[stream];
              meta.observedBytes += bytes.length;
              tails[stream] = Buffer.concat([tails[stream], bytes.subarray(-MAX_LOG)]).subarray(
                -MAX_LOG,
              );
              meta.retainedBytes = tails[stream].length;
              meta.truncated = meta.observedBytes > meta.retainedBytes;
              io.writeFileSync(join(evidence, `main.${stream}.log`), tails[stream], {
                mode: 0o600,
              });
              event("main-stdio", {
                stream,
                firstByte: meta.observedBytes - bytes.length,
                lastByte: meta.observedBytes,
              });
            } catch {
              fail();
              persist();
            }
          });
        }
        child.once("exit", (code, signal) => invoke("exit", ["child-exit", code, signal]));
        child.once("close", (code, signal) => invoke("exit", ["child-close", code, signal]));
      } catch {
        fail();
        persist();
      }
    },
    exportGuards(home, settled) {
      for (const name of COMPOSER_GUARD_FILES) {
        try {
          if (!settled) {
            receipt.guards[name] = { status: "unproven-custody" };
            continue;
          }
          const bytes = readOwnedGuard(home, name, io);
          if (bytes === null) {
            receipt.guards[name] = { status: "missing" };
            continue;
          }
          io.writeFileSync(join(evidence, name), bytes, { mode: 0o600, flag: "wx" });
          receipt.guards[name] = {
            status: "copied",
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        } catch {
          receipt.guards[name] = { status: "error" };
          fail();
        }
      }
      event("guard-records-exported");
    },
    hasRequiredGuards: () =>
      COMPOSER_GUARD_FILES.slice(0, 2).every((name) => receipt.guards[name]?.status === "copied"),
    homeRemoved(value) {
      receipt.privateHomeRemoved = value;
      event("home-removal-observed", { removed: value });
    },
    finalReportWritten(result) {
      receipt.finalReportWritten = true;
      receipt.status = "final-report-written";
      receipt.acceptanceResult = result;
      event("final-report-written", { result });
    },
  };
  event("initial-pending");
  controller.once("exit", (code) => {
    receipt.controllerExit = { code, boundary: "Controller exit only; not the Main exit" };
    event("controller-exit", { code });
    if (api.hasRecordingFailure()) controller.exitCode = 1;
  });
  return api;
}
