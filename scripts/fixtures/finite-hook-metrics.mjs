/** Synthetic-fixture diagnostics only; every intercepted operation forwards unchanged. */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import { Session } from "node:inspector";

let current, timer, lastTick;
let profiler;
const descriptors = new Map();
const open = fs.openSync,
  close = fs.closeSync,
  read = fs.readSync,
  readFile = fs.readFileSync;
const kindFor = (path) =>
  String(path) === current.sourcePath
    ? "source"
    : String(path) === current.runtimeExecutable
      ? "runtime"
      : String(path).startsWith(current.resourceRoot + "/")
        ? "resource"
        : "other";
fs.openSync = function (path, ...args) {
  if (current) {
    const kind = kindFor(path);
    current[kind + "OpenCalls"]++;
  }
  const descriptor = open.call(this, path, ...args);
  descriptors.set(descriptor, String(path));
  return descriptor;
};
fs.closeSync = function (descriptor, ...args) {
  descriptors.delete(descriptor);
  return close.call(this, descriptor, ...args);
};
fs.readSync = function (descriptor, ...args) {
  const bytes = read.call(this, descriptor, ...args);
  if (current) {
    const path = descriptors.get(descriptor);
    const kind = kindFor(path);
    current[kind + "ReadCalls"]++;
    current[kind + "ReadBytes"] += bytes;
  }
  return bytes;
};
fs.readFileSync = function (path, ...args) {
  return current && String(path) === current.runtimeExecutable
    ? measureFiniteHookSlice("runtimeBinaryRead", () => readFile.call(this, path, ...args))
    : readFile.call(this, path, ...args);
};
syncBuiltinESMExports();

export function beginFiniteHookMetrics({ sourcePath, resourceRoot, runtimeExecutable }) {
  if (current) throw new Error("Finite fixture measurement already active");
  current = {
    sourcePath,
    resourceRoot,
    runtimeExecutable,
    sourceReadCalls: 0,
    sourceOpenCalls: 0,
    sourceReadBytes: 0,
    resourceReadCalls: 0,
    resourceOpenCalls: 0,
    resourceReadBytes: 0,
    runtimeOpenCalls: 0,
    runtimeReadCalls: 0,
    runtimeReadBytes: 0,
    otherReadCalls: 0,
    otherOpenCalls: 0,
    otherReadBytes: 0,
    maxTimerGapMs: 0,
    started: performance.now(),
    usage: process.resourceUsage(),
  };
  lastTick = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    current.maxTimerGapMs = Math.max(current.maxTimerGapMs, now - lastTick);
    lastTick = now;
  }, 10);
}
export function endFiniteHookMetrics() {
  if (!current) throw new Error("Finite fixture measurement is inactive");
  clearInterval(timer);
  const value = current,
    usage = process.resourceUsage(),
    now = performance.now();
  current = undefined;
  return {
    ...value,
    elapsedMs: now - value.started,
    maxTimerGapMs: Math.max(value.maxTimerGapMs, now - lastTick),
    kernelFsReadBlocks: usage.fsRead - value.usage.fsRead,
    userCpuMicros: usage.userCPUTime - value.usage.userCPUTime,
    systemCpuMicros: usage.systemCPUTime - value.usage.systemCPUTime,
    note: "Forwarding descriptor readSync bytes plus kernel fsRead blocks (page cache can make blocks zero); 10ms timer and synchronous-call diagnostics add measurement overhead. The positive interval has no synchronous Docker observer. Cancellation intervals separately include the fixture's synchronous inspect/top observer. No OS latency guarantee.",
  };
}

/** Time actual synchronous production calls without replacing their results. */
export function measureFiniteHookSlice(kind, call) {
  const started = performance.now();
  try {
    return call();
  } finally {
    if (current) {
      const key = kind + "Slices";
      current[key] ??= { calls: 0, totalMs: 0, maxMs: 0 };
      const duration = performance.now() - started;
      current[key].calls++;
      current[key].totalMs += duration;
      current[key].maxMs = Math.max(current[key].maxMs, duration);
    }
  }
}

export function instrumentFiniteHookHost(host) {
  for (const method of ["capture", "assertResourcesCurrent"]) {
    const original = host.hookProcesses.host[method];
    host.hookProcesses.host[method] = (...args) =>
      measureFiniteHookSlice(method, () => original(...args));
  }
  return host;
}

export async function instrumentFiniteSettings(coreUrl) {
  const { SettingsManager } = await import(coreUrl);
  const original = SettingsManager.prototype.load;
  SettingsManager.prototype.load = function (...args) {
    return measureFiniteHookSlice("settingsLoad", () => original.apply(this, args));
  };
}

export function startFiniteHookProfile() {
  profiler = new Session();
  profiler.connect();
  profiler.post("Profiler.enable");
  profiler.post("Profiler.start");
}
export async function finishFiniteHookProfile() {
  const session = profiler;
  profiler = undefined;
  try {
    return await new Promise((done, reject) =>
      session.post("Profiler.stop", (error, result) =>
        error ? reject(error) : done(result.profile),
      ),
    );
  } finally {
    session.disconnect();
  }
}
