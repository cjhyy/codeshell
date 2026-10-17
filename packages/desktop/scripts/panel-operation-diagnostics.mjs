import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createElectronTestDiagnostics, electronChildExitState } from "./electron-harness.mjs";

const phases = [
  "panel-fixture-init",
  "panel-launch",
  "panel-find-renderer",
  "panel-session-seed",
  "panel-image",
  "panel-mentions",
  "panel-files",
  "panel-browser-navigation",
  "panel-browser-layout",
  "panel-browser-markers",
  "panel-browser-draft",
  "panel-browser-retry",
  "panel-browser-background",
  "panel-browser-close",
  "panel-browser-idle",
  "panel-review-working",
  "panel-review-stage",
  "panel-review-corrupt",
  "panel-review-repair",
  "panel-review-root-commit",
  "panel-terminal-input",
  "panel-terminal-switch",
  "panel-terminal-interrupt",
  "panel-terminal-exit",
  "panel-terminal-reopen",
  "panel-graceful-close",
  "panel-custody",
  "panel-main-close",
  "panel-transport",
  "panel-home-cleanup",
  "panel-server-close",
  "panel-final-report",
];
const MAX_EVENTS = 256;
const MAX_JOURNAL = 512 * 1024;
const MAX_LOG = 1024 * 1024;

/** Synchronous, bounded evidence only. No process authority or acceptance decision. */
export function createPanelOperationDiagnostics({
  evidence,
  ownedRoots = [],
  controller = process,
  io = { appendFileSync, renameSync, writeFileSync },
}) {
  const base = createElectronTestDiagnostics({ ownedRoots, additionalPhases: phases });
  const receipt = {
    schemaVersion: 1,
    status: "incomplete",
    finalReportWritten: false,
    completedCases: [],
    privateHomeRemoved: null,
    controllerExit: null,
    main: electronChildExitState(),
    logs: {
      stdout: { observedBytes: 0, retainedBytes: 0, truncated: false },
      stderr: { observedBytes: 0, retainedBytes: 0, truncated: false },
    },
    diagnostics: base.receipt,
    journalTruncated: false,
    recordingFailed: false,
    boundary:
      "Progress is incomplete evidence until the original final report is written. Cached ChildProcess exit observations are not OS liveness, Main normal-exit proof, or proof of all descendants. Logs are bounded tails; no cleanup authority is granted.",
  };
  let child,
    sequence = 0,
    journalBytes = 0;
  const started = performance.now();
  const tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const fail = () => {
    receipt.recordingFailed = true;
  };
  const persist = () => {
    try {
      receipt.main = electronChildExitState(child);
      const temp = join(evidence, "diagnostics.json.tmp");
      io.writeFileSync(temp, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
      io.renameSync(temp, join(evidence, "diagnostics.json"));
    } catch {
      fail();
    }
  };
  const event = (kind, fields = {}) => {
    try {
      const record = {
        sequence: ++sequence,
        elapsedMs: performance.now() - started,
        kind,
        ...fields,
      };
      const line = JSON.stringify(record) + "\n";
      const bytes = Buffer.byteLength(line);
      if (sequence <= MAX_EVENTS && journalBytes + bytes <= MAX_JOURNAL) {
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
      const additions = base.receipt.timeline.slice(before);
      for (const record of additions) event(record.kind, { observation: record });
      // A repeated error still flushes the latched first error before cleanup.
      if (!additions.length) persist();
      return result;
    } catch {
      fail();
      persist();
      return undefined;
    }
  };
  const api = {
    receipt,
    phase: (...args) => invoke("phase", args),
    error: (...args) => invoke("error", args),
    cleanup: (...args) => invoke("cleanup", args),
    request: (...args) => invoke("request", args),
    settled: (...args) => invoke("settled", args),
    signal: (...args) => invoke("signal", args),
    exit: (...args) => invoke("exit", args),
    caseCompleted(name, count) {
      try {
        if (receipt.completedCases.length < 20)
          receipt.completedCases.push({ name: String(name).slice(0, 300), count });
        else receipt.journalTruncated = true;
        event("case-returned", { count, phase: base.receipt.phase });
      } catch {
        fail();
        persist();
      }
    },
    provenance(value) {
      try {
        receipt.provenance = Object.fromEntries(
          ["sourceHead", "fixtureSHA256", "platform", "arch", "privateHome"].map((key) => [
            key,
            String(value[key]).slice(0, key === "privateHome" ? 4096 : 128),
          ]),
        );
        event("source-provenance");
      } catch {
        fail();
        persist();
      }
    },
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
              persist();
            } catch {
              fail();
              persist();
            }
          });
        }
        child.once("exit", (code, signal) => api.exit("child-exit", code, signal));
        child.once("close", (code, signal) => api.exit("child-close", code, signal));
      } catch {
        fail();
        persist();
      }
    },
    closeReturned(value) {
      event("application-close-returned", { child: electronChildExitState(value) });
    },
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
    receipt.controllerExit = { code, boundary: "Controller exit code; not the Main exit code" };
    event("controller-exit", { code });
  });
  return api;
}
