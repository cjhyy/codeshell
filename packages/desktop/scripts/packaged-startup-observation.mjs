import { createHash } from "node:crypto";
import { errorMonitor } from "node:events";
import { performance } from "node:perf_hooks";

/** Passive projection of callbacks that the packaged fixture already awaits.
 * This module performs no I/O and grants no launch, query or cleanup authority. */
const MAX_LAUNCHES = 8;
const METHOD = "inspect-brk first-JavaScript pause, synchronous CJS require, then resume";
const PHASES = ["playwright-launch", "startup-barrier", "identity-read", "ready"];
const FAILURE = "Packaged startup observation was not completely recorded";
const BIRTH =
  /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) +(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2} +\d{2}:\d{2}:\d{2} +\d{4})$/;

const field = (value, key, optional = false) => {
  if (!value || typeof value !== "object") throw Error(FAILURE);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor && optional) return undefined;
  if (!descriptor || !("value" in descriptor)) throw Error(FAILURE);
  return descriptor.value;
};
const integer = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw Error(FAILURE);
  return value;
};
const project = (receipt, childPid) => {
  const pid = integer(field(receipt, "pid"), 1);
  const launcherPid = integer(field(receipt, "launcherPid"), 1);
  const identity = field(receipt, "mainIdentity");
  const location = field(receipt, "pausedLocation");
  const birth = field(identity, "birth", true);
  const column = field(location, "columnNumber", true);
  if (
    launcherPid !== childPid ||
    field(identity, "pid") !== pid ||
    field(receipt, "method") !== METHOD ||
    field(receipt, "reason") !== "Break on start" ||
    field(receipt, "firstUserInstruction") !== true ||
    (birth !== undefined && (typeof birth !== "string" || birth.length > 96 || !BIRTH.test(birth)))
  )
    throw Error(FAILURE);
  return {
    pid,
    launcherPid,
    mainIdentity: {
      pid,
      ppid: integer(field(identity, "ppid")),
      ...(birth === undefined ? {} : { birth }),
    },
    method: METHOD,
    reason: "Break on start",
    firstUserInstruction: true,
    hostScriptsParsedBeforeGuard: integer(field(receipt, "hostScriptsParsedBeforeGuard"), 0, 4096),
    pausedLocation: {
      lineNumber: integer(field(location, "lineNumber")),
      columnNumber: column === undefined ? null : integer(column),
    },
  };
};
const copyResult = (result) =>
  result && {
    ...result,
    mainIdentity: { ...result.mainIdentity },
    pausedLocation: { ...result.pausedLocation },
  };

function projectSnapshotTiming(value) {
  const finite = (number) => {
    if (
      typeof number !== "number" ||
      !Number.isFinite(number) ||
      number < 0 ||
      number > Number.MAX_SAFE_INTEGER
    )
      throw Error(FAILURE);
    return number;
  };
  const count = integer(field(value, "count"));
  const totalMs = finite(field(value, "totalMs")),
    maxMs = finite(field(value, "maxMs"));
  const recent = field(value, "recent");
  if (!Array.isArray(recent)) throw Error(FAILURE);
  const length = integer(field(recent, "length"), 0, Math.min(count, 32));
  const samples = Array.from({ length }, (_, index) => finite(field(recent, String(index))));
  if (maxMs > totalMs || samples.some((sample) => sample > maxMs)) throw Error(FAILURE);
  return {
    count,
    totalMs,
    maxMs,
    recent: samples,
    maxTickGapMs: finite(field(value, "maxTickGapMs")),
  };
}
const copyTiming = (value) => value && { ...value, recent: [...value.recent] };

export function createPackagedStartupObservation() {
  const launches = [];
  const records = new WeakMap();
  let recordingFailed = false;
  let truncated = false;
  const update = (handle, run) => {
    // An SDK failure before capture leaves no startup result to observe.
    if (handle === undefined) return;
    try {
      const record = records.get(handle);
      if (!record) throw Error(FAILURE);
      run(record);
    } catch {
      recordingFailed = true;
    }
  };
  return {
    captured(pid) {
      try {
        integer(pid, 1);
        if (launches.length === MAX_LAUNCHES) {
          truncated = true;
          throw Error(FAILURE);
        }
        const record = {
          childPid: pid,
          launchPhase: PHASES[0],
          sdkLaunchReturned: false,
          failurePhase: null,
          atFailure: null,
          preloadResultObserved: false,
          privateReceiptWrite: "not-attempted",
          preloadChainRejected: false,
          result: null,
        };
        const handle = {};
        launches.push(record);
        records.set(handle, record);
        return handle;
      } catch {
        recordingFailed = true;
        return undefined;
      }
    },
    preloadReturned(handle, receipt) {
      update(handle, (record) => {
        record.preloadResultObserved = true;
        record.result = project(receipt, record.childPid);
      });
    },
    privateWriteStarted(handle) {
      update(handle, (record) => {
        record.privateReceiptWrite = "pending";
      });
    },
    privateWriteFulfilled(handle) {
      update(handle, (record) => {
        record.privateReceiptWrite = "fulfilled";
      });
    },
    preloadRejected(handle) {
      update(handle, (record) => {
        record.preloadChainRejected = true;
        if (record.privateReceiptWrite === "pending") record.privateReceiptWrite = "rejected";
      });
    },
    sdkReturned(handle) {
      update(handle, (record) => {
        record.sdkLaunchReturned = true;
        record.launchPhase = PHASES[1];
      });
    },
    identityRead(handle) {
      update(handle, (record) => {
        record.launchPhase = PHASES[2];
      });
    },
    ready(handle) {
      update(handle, (record) => {
        record.launchPhase = PHASES[3];
      });
    },
    failed(handle, phase) {
      update(handle, (record) => {
        if (!PHASES.slice(0, 3).includes(phase)) throw Error(FAILURE);
        if (record.atFailure === null) {
          record.failurePhase = phase;
          record.atFailure = {
            sdkLaunchReturned: record.sdkLaunchReturned,
            preloadResultObserved: record.preloadResultObserved,
            privateReceiptWrite: record.privateReceiptWrite,
          };
        }
      });
    },
    snapshot() {
      return {
        schemaVersion: 1,
        maxLaunches: MAX_LAUNCHES,
        recordingFailed,
        truncated,
        launches: launches.map((record) => ({
          ...record,
          atFailure: record.atFailure && { ...record.atFailure },
          result: copyResult(record.result),
        })),
        boundary:
          "Existing preload return/private-write and SDK phase observations only; not native fault causality or process/query/cleanup authority",
      };
    },
    assertComplete(expectedLaunches = launches.length) {
      if (
        !Number.isSafeInteger(expectedLaunches) ||
        expectedLaunches < 1 ||
        launches.length !== expectedLaunches ||
        recordingFailed ||
        truncated ||
        launches.some(
          (record) =>
            record.launchPhase !== "ready" ||
            !record.sdkLaunchReturned ||
            record.failurePhase !== null ||
            !record.preloadResultObserved ||
            record.privateReceiptWrite !== "fulfilled" ||
            record.preloadChainRejected ||
            !record.result,
        )
      )
        throw Error(FAILURE);
    },
  };
}

/** Opt-in metadata only; these fields grant no process or cleanup authority. */
export function hostedWindowsLaunchDiagnosticsEnabled(platform, arch, ci) {
  try {
    return (
      platform === "win32" &&
      arch === "x64" &&
      field(ci, "GITHUB_ACTIONS", true) === "true" &&
      field(ci, "RUNNER_OS", true) === "Windows" &&
      field(ci, "RUNNER_ARCH", true) === "X64" &&
      field(ci, "RUNNER_ENVIRONMENT", true) === "github-hosted" &&
      field(ci, "ImageOS", true) === "win22" &&
      field(ci, "GITHUB_REPOSITORY", true) === "cjhyy/codeshell" &&
      /^[1-9]\d{0,19}$/.test(field(ci, "GITHUB_RUN_ID", true) ?? "") &&
      /^[a-f0-9]{40}$/.test(field(ci, "GITHUB_SHA", true) ?? "") &&
      field(ci, "ACT", true) === undefined
    );
  } catch {
    return false;
  }
}

/** Bounded, passive callbacks on the very same captured ChildProcess.
 * Cached properties and text are observations, never OS liveness or fault proof.
 * Reads only an explicitly bound watchdog's bounded diagnostic getter; no file
 * reads, timers, process methods, ordinary error listeners or new await. */
export function createPackagedLaunchDiagnostics({
  redactRoots = [],
  now = () => performance.now(),
} = {}) {
  const maxEvents = 64;
  const maxTailBytes = 64 * 1024;
  const launches = [];
  const records = new WeakMap();
  let recordingFailed = false;
  let truncated = false;
  let sequence = 0;
  let origin;
  let lastTime = 0;
  let roots = [];
  const attempt = (run) => {
    try {
      return run();
    } catch {
      recordingFailed = true;
      return null;
    }
  };
  attempt(() => {
    if (!Array.isArray(redactRoots) || redactRoots.length > 8) throw Error(FAILURE);
    for (const root of redactRoots) {
      if (
        typeof root !== "string" ||
        root.length < 8 ||
        root.length > 4096 ||
        /[\x00-\x1f]/.test(root)
      )
        throw Error(FAILURE);
      roots.push(root, root.replaceAll("\\", "/"));
    }
    roots = [...new Set(roots)].sort((a, b) => b.length - a.length);
  });
  const stamp = () => {
    sequence = integer(sequence + 1, 1);
    const time = now();
    if (
      typeof time !== "number" ||
      !Number.isFinite(time) ||
      time < 0 ||
      (origin !== undefined && time < lastTime)
    )
      throw Error(FAILURE);
    origin ??= time;
    lastTime = time;
    return { sequence, monotonicMs: time - origin };
  };
  const code = (value) => (value === null ? null : integer(value, -Number.MAX_SAFE_INTEGER));
  const signal = (value) => {
    if (value !== null && (typeof value !== "string" || !/^SIG[A-Z0-9]{1,20}$/.test(value)))
      throw Error(FAILURE);
    return value;
  };
  const cached = (child) => {
    const killed = field(child, "killed");
    if (typeof killed !== "boolean") throw Error(FAILURE);
    return {
      pid: integer(field(child, "pid"), 1),
      exitCode: code(field(child, "exitCode")),
      signalCode: signal(field(child, "signalCode")),
      killed,
    };
  };
  const event = (child, record, kind, details = {}) =>
    attempt(() => {
      const point = stamp();
      if (record.events.length === maxEvents) {
        truncated = true;
        record.droppedEvents = integer(record.droppedEvents + 1, 1);
        return null;
      }
      const state = attempt(() => cached(child));
      record.events.push({ ...point, kind, cached: state, ...details });
      return point.sequence;
    });
  const streamState = () => ({
    bytes: Buffer.alloc(0),
    observedBytes: 0,
    chunks: 0,
    firstData: null,
    lastData: null,
    recordingFailed: false,
  });
  const render = (stream) => {
    const raw = stream.bytes;
    let text = raw.toString("utf8");
    const redactions = { ownedRoots: false, urls: false, ansi: false, controls: false };
    for (const root of roots) {
      if (text.includes(root)) {
        redactions.ownedRoots = true;
        text = text.split(root).join("[owned-path]");
      }
    }
    const replace = (pattern, replacement, key) => {
      text = text.replace(pattern, () => {
        redactions[key] = true;
        return replacement;
      });
    };
    replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "", "ansi");
    replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "", "ansi");
    replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "", "controls");
    replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[url]", "urls");
    const encoded = Buffer.from(text);
    const textTruncated = encoded.length > maxTailBytes;
    if (textTruncated)
      text = encoded
        .subarray(0, maxTailBytes)
        .toString("utf8")
        .replace(/\ufffd$/, "");
    return {
      observedBytes: stream.observedBytes,
      chunks: stream.chunks,
      retainedBytes: raw.length,
      droppedBytes: stream.observedBytes - raw.length,
      truncated: stream.observedBytes > raw.length,
      recordingFailed: stream.recordingFailed,
      firstData: stream.firstData && { ...stream.firstData },
      lastData: stream.lastData && { ...stream.lastData },
      rawTailSHA256: createHash("sha256").update(raw).digest("hex"),
      text,
      textBytes: Buffer.byteLength(text),
      textTruncated,
      redactions,
      textBoundary:
        "Redacted UTF-8 rendering of bounded fixture log bytes; not a universal secret scrub or raw-byte reproduction",
    };
  };
  const captureTiming = (record) =>
    record.monitor ? attempt(() => projectSnapshotTiming(record.monitor.snapshotTiming)) : null;
  return {
    captured(child) {
      return attempt(() => {
        if (records.has(child)) throw Error(FAILURE);
        if (launches.length === MAX_LAUNCHES) {
          truncated = true;
          throw Error(FAILURE);
        }
        const record = {
          launch: launches.length + 1,
          childPid: integer(field(child, "pid"), 1),
          events: [],
          droppedEvents: 0,
          listenerSetupFailed: false,
          monitor: null,
          failureTimingCaptured: false,
          snapshotTiming: { atFailure: null, settled: null },
          stdout: streamState(),
          stderr: streamState(),
        };
        launches.push(record);
        records.set(child, record);
        const removers = [];
        const listen = (emitter, name, callback) => {
          emitter.on(name, callback);
          removers.push(() => emitter.removeListener(name, callback));
        };
        const observedError = (kind) => (error) => {
          const errorCode = attempt(() => {
            const value = field(error, "code", true);
            if (value === undefined) return null;
            if (typeof value !== "string" || !/^[A-Z0-9_]{1,64}$/.test(value)) throw Error(FAILURE);
            return value;
          });
          event(child, record, kind, { errorCode });
        };
        event(child, record, "captured");
        const setup = attempt(() => {
          listen(child, errorMonitor, observedError("child-error"));
          listen(child, "exit", (exitCode, exitSignal) => {
            attempt(() =>
              event(child, record, "child-exit", {
                code: code(exitCode),
                signal: signal(exitSignal),
              }),
            );
          });
          listen(child, "close", (exitCode, exitSignal) => {
            attempt(() =>
              event(child, record, "child-close", {
                code: code(exitCode),
                signal: signal(exitSignal),
              }),
            );
            for (const remove of removers) attempt(remove);
            removers.length = 0;
          });
          for (const name of ["stdout", "stderr"]) {
            const stream = field(child, name);
            listen(stream, errorMonitor, observedError(`${name}-error`));
            for (const kind of ["end", "close"])
              listen(stream, kind, () => event(child, record, `${name}-${kind}`));
          }
          return true;
        });
        record.listenerSetupFailed = setup !== true;
        return record.launch;
      });
    },
    watchdog(child, monitor) {
      return attempt(() => {
        const record = records.get(child);
        if (
          !record ||
          record.monitor ||
          !monitor ||
          !["object", "function"].includes(typeof monitor)
        )
          throw Error(FAILURE);
        record.monitor = monitor;
        return true;
      });
    },
    failed() {
      for (const record of launches) {
        if (record.failureTimingCaptured) continue;
        record.failureTimingCaptured = true;
        record.snapshotTiming.atFailure = captureTiming(record);
      }
    },
    settled() {
      for (const record of launches) record.snapshotTiming.settled = captureTiming(record);
    },
    appended(child, name, chunk) {
      // Called only after the existing appendFileSync succeeded. Keep a copy,
      // never a subarray retaining an arbitrarily large chunk's backing store.
      const record = records.get(child);
      const stream = record && (name === "stdout" || name === "stderr") && record[name];
      const result = attempt(() => {
        if (!stream || !Buffer.isBuffer(chunk)) throw Error(FAILURE);
        const point = stamp();
        stream.observedBytes = integer(stream.observedBytes + chunk.length);
        stream.chunks = integer(stream.chunks + 1, 1);
        stream.firstData ??= point;
        stream.lastData = point;
        const incoming = chunk.subarray(Math.max(0, chunk.length - maxTailBytes));
        const keep = Math.min(stream.bytes.length, maxTailBytes - incoming.length);
        const next = Buffer.alloc(keep + incoming.length);
        stream.bytes.copy(next, 0, stream.bytes.length - keep);
        incoming.copy(next, keep);
        stream.bytes = next;
        return true;
      });
      if (stream && result !== true) stream.recordingFailed = true;
    },
    cleanupRequested(child) {
      return attempt(() => {
        const record = records.get(child);
        if (!record) throw Error(FAILURE);
        return event(child, record, "sdk-taskkill-suppressed");
      });
    },
    snapshot() {
      const value = attempt(() =>
        launches.map((record) => ({
          launch: record.launch,
          childPid: record.childPid,
          listenerSetupFailed: record.listenerSetupFailed,
          snapshotTiming: {
            atFailure: copyTiming(record.snapshotTiming.atFailure),
            settled: copyTiming(record.snapshotTiming.settled),
          },
          droppedEvents: record.droppedEvents,
          events: record.events.map((item) => ({
            ...item,
            cached: item.cached && { ...item.cached },
          })),
          stdout: render(record.stdout),
          stderr: render(record.stderr),
        })),
      );
      return {
        schemaVersion: 1,
        maxLaunches: MAX_LAUNCHES,
        maxEventsPerLaunch: maxEvents,
        maxTailBytesPerStream: maxTailBytes,
        recordingFailed,
        truncated,
        launches: value,
        boundary:
          "Passive same-child callback order and cached properties, plus successful private-log append tails; not kernel event order, OS liveness, fault causality or cleanup authority",
      };
    },
  };
}
