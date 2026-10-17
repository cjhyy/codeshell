import { writeSync } from "node:fs";

export const NSIS_CHECKPOINT_LIMITS = Object.freeze({
  events: 256,
  bytes: 128 * 1024,
  stderr: 4096,
});
const phases = new Set([
  "initial",
  "preflight",
  "baseline",
  "stage-copy",
  "toolchain",
  "nsis-build",
  "payload-identity",
  "install",
  "installed-identity",
  "installed-ui",
  "replacement-marker",
  "replace",
  "replacement-identity",
  "replacement-ui",
  "uninstall",
  "cache-cleanup",
  "final-integrity",
]);
const kinds = new Set([
  "initial-pending",
  "stage-start",
  "stage-complete",
  "process-spawn",
  "process-exit",
  "custody-error",
  "cleanup-signal-request",
  "process-first-error",
  "process-cleanup-start",
  "process-cleanup-settled",
  "process-final",
  "first-error",
  "controller-final",
]);
const labels = new Set([
  "nsis-build",
  "install",
  "ui-first",
  "replace",
  "ui-replaced",
  "uninstall",
]);
const integer = (value) => value === null || (Number.isSafeInteger(value) && value >= 0);
const exitCode = (value) => value === null || Number.isSafeInteger(value);
const signal = (value) =>
  value === null || (typeof value === "string" && /^SIG[A-Z0-9]{1,12}$/.test(value));
const requireValue = (value) => {
  if (!value) throw Error("Invalid diagnostic shape");
};
const result = (value) => {
  if (value == null) return null;
  requireValue(exitCode(value.code) && signal(value.signal));
  const output = { code: value.code, signal: value.signal };
  if (typeof value.error === "string") output.error = value.error.slice(0, 2048);
  return output;
};
const firstError = (value) => {
  requireValue(typeof value?.name === "string" && typeof value.message === "string");
  return { name: value.name.slice(0, 80), message: value.message.slice(0, 2048) };
};
const logMetadata = (value) => {
  if (value == null) return null;
  requireValue(
    integer(value.observedBytes) &&
      integer(value.retainedBytes) &&
      typeof value.truncated === "boolean",
  );
  return {
    observedBytes: value.observedBytes,
    retainedBytes: value.retainedBytes,
    truncated: value.truncated,
  };
};

/** Mirrors existing observations only. It never reads files/env, queries a PID,
 * acquires custody, or decides cleanup. A failed mirror cannot turn green. */
export function createNsisCheckpointDiagnostics({
  write = (bytes) => writeSync(1, bytes),
  recordingFailure = () => {},
} = {}) {
  const receipt = {
    schemaVersion: 1,
    attemptedEvents: 0,
    attemptedBytes: 0,
    writtenEvents: 0,
    writtenBytes: 0,
    failed: false,
    limits: NSIS_CHECKPOINT_LIMITS,
    boundary:
      "Bounded CI stdout observations; not native emission timing, cleanup authority or a replacement for retained runtime receipts",
  };
  let lastSequence = 0;
  const fail = () => {
    receipt.failed = true;
    try {
      recordingFailure("CI checkpoint mirror failed/truncated");
    } catch {
      /* Evidence must not stop cleanup. */
    }
  };
  return {
    receipt,
    checkpoint(event, detail) {
      if (receipt.failed) return;
      try {
        requireValue(
          Number.isSafeInteger(event.sequence) &&
            event.sequence > lastSequence &&
            Number.isFinite(event.elapsedMs) &&
            event.elapsedMs >= 0 &&
            phases.has(event.phase) &&
            kinds.has(event.kind),
        );
        if (event.label !== undefined) requireValue(labels.has(event.label));
        const output = {
          fixture: "owned-windows-nsis-checkpoint",
          schemaVersion: 1,
          sequence: event.sequence,
          elapsedMs: event.elapsedMs,
          phase: event.phase,
          kind: event.kind,
          ...(event.label === undefined ? {} : { label: event.label }),
        };
        if (typeof detail === "function") detail = detail();
        if (event.kind === "first-error" || event.kind === "process-first-error")
          output.firstError = firstError(detail?.error);
        if (event.kind === "process-first-error") {
          requireValue(["incomplete", "failed", "passed"].includes(detail.status));
          const child = detail.child;
          if (child != null) requireValue(integer(child.pid) && integer(child.ppid));
          output.process = {
            status: detail.status,
            child:
              child == null
                ? null
                : {
                    pid: child.pid,
                    ppid: child.ppid,
                    birth:
                      typeof child.birth === "string" &&
                      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/.test(child.birth)
                        ? child.birth
                        : null,
                    boundary: "Recorded spawn metadata only; not a new liveness/custody query",
                  },
            cachedExit: result(detail.cachedExit),
            result: result(detail.result),
            logs: {
              stdout: logMetadata(detail.logs?.stdout),
              stderr: logMetadata(detail.logs?.stderr),
            },
          };
          if (Buffer.isBuffer(detail.stderr)) {
            const tail = detail.stderr.subarray(-NSIS_CHECKPOINT_LIMITS.stderr);
            const observed = output.process.logs.stderr?.observedBytes ?? 0;
            requireValue(observed >= detail.stderr.length);
            output.stderrTail = {
              encoding: "base64",
              bytes: tail.length,
              observedBytes: observed,
              truncated: observed > tail.length,
              data: tail.toString("base64"),
              boundary:
                "Already-observed stderr byte tail at this checkpoint; arrival order only, not cause or native emission time",
            };
          }
        }
        const bytes = Buffer.from(JSON.stringify(output) + "\n");
        if (
          receipt.attemptedEvents >= NSIS_CHECKPOINT_LIMITS.events ||
          receipt.attemptedBytes + bytes.length > NSIS_CHECKPOINT_LIMITS.bytes
        ) {
          fail();
          return;
        }
        lastSequence = event.sequence;
        receipt.attemptedEvents++;
        receipt.attemptedBytes += bytes.length;
        const written = write(bytes);
        if (Number.isSafeInteger(written) && written >= 0 && written <= bytes.length)
          receipt.writtenBytes += written;
        requireValue(written === bytes.length);
        receipt.writtenEvents++;
      } catch {
        fail();
      }
    },
  };
}
