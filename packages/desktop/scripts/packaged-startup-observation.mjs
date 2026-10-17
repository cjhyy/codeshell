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
