/** Fixture-only adapter for reviewed Playwright 1.64 Electron launch calls.
 * Reconstruct one known argv; never parse a shell command or execute cmd.exe.
 * Its literal taskkill fallback is permanently replaced by the same captured
 * child's birth-custody monitor, including later close/process-exit cleanup. */
import assert from "node:assert/strict";
import childrenModule from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { isAbsolute, win32 } from "node:path";

const require = createRequire(import.meta.url);
const installedVersion = require("playwright-core/package.json").version;
export const reviewedPlaywrightElectronVersion = "1.64.0";
const registries = new WeakMap();
const absolute = (path) =>
  typeof path === "string" &&
  (isAbsolute(path) || win32.isAbsolute(path)) &&
  !/[\r\n\0]/.test(path);
const quoted = (args) => args.map((arg) => `"${arg.replace(/"/g, '\\"')}"`).join(" ");

export function knownPlaywrightElectronVector({ executable, args, loader }) {
  assert.ok(absolute(executable), "Canonical Electron executable is required");
  assert.ok(
    Array.isArray(args) && args.every((arg) => typeof arg === "string" && !/[\r\n\0]/.test(arg)),
  );
  if (loader !== undefined)
    assert.ok(absolute(loader), "Canonical installed Playwright loader is required");
  const argv = [
    ...(loader ? ["-r", loader] : []),
    "--inspect=0",
    "--remote-debugging-port=0",
    ...args,
  ];
  return { executable, argv, command: quoted([executable, ...argv]) };
}

function defaultFailure(message) {
  console.error(`[windows-electron-direct-transport] ${message}`);
  process.exitCode = 1;
}

function installPermanentKillGuard(children, syncExports) {
  let registry = registries.get(children);
  if (registry) return registry;
  registry = { entries: new Map(), scopes: new Set(), original: children.spawnSync };
  children.spawnSync = function (command, args, options) {
    if (typeof command !== "string" || !/^taskkill(?:\s|$)/i.test(command))
      return registry.original.call(this, command, args, options);
    const entries = [...registry.entries.values()].flat();
    const matching = entries.filter((entry) => command === entry.killCommand);
    const fail = (message) => {
      const contexts = matching.length ? matching : [...entries, ...registry.scopes];
      const seen = new Set();
      for (const entry of contexts) {
        if (seen.has(entry.failures)) continue;
        seen.add(entry.failures);
        entry.failures.push(message);
        entry.reportFailure(message);
      }
      throw Error(message);
    };
    if (matching.length !== 1)
      return fail("Refused unknown or PID-ambiguous Playwright taskkill; no native signal sent");
    const entry = matching[0];
    // This is exactly the installed library's two-argument spawnSync call.
    // Any different vector is rejected, rather than interpreted or executed.
    if (
      options !== undefined ||
      !args ||
      Array.isArray(args) ||
      args.shell !== true ||
      args.windowsHide !== true ||
      Object.keys(args).some((key) => !["shell", "windowsHide"].includes(key))
    )
      return fail("Refused changed Playwright taskkill shape; no native signal sent");
    if (!entry.monitor?.terminate)
      return fail("Refused Playwright cleanup without captured birth custody; HOME retained");
    const fallback =
      "Playwright requested forced cleanup; native taskkill suppressed for owned custody";
    entry.failures.push(fallback);
    entry.reportFailure(fallback);
    const request = {
      method: "taskkill suppressed; captured monitor.terminate requested",
      at: Date.now(),
      settlement: null,
    };
    entry.cleanupRequests.push(request);
    try {
      // terminate starts its fresh-query, per-incarnation cleanup synchronously.
      // spawnSync cannot await it. The fixture still awaits monitor.completed
      // and requires normal Main exit before any pass or HOME removal.
      request.completed = Promise.resolve(entry.monitor.terminate()).then(
        (settlement) => {
          request.settlement = settlement;
          if (settlement?.status !== "cleaned") {
            const message = "Redirected Playwright cleanup settlement is unproven; HOME retained";
            entry.failures.push(message);
            entry.reportFailure(message);
          }
        },
        (error) => {
          request.error = error.message;
          entry.failures.push(error.message);
          entry.reportFailure("Redirected Playwright cleanup failed; HOME retained");
        },
      );
    } catch (error) {
      return fail(`Refused failed Playwright custody cleanup: ${error.message}`);
    }
    // The reviewed library ignores this return. Explicitly report that no
    // native taskkill was run; this object is never an exit/cleanup proof.
    return {
      status: null,
      signal: null,
      error: Error("Native taskkill suppressed; awaiting owned birth settlement"),
    };
  };
  registries.set(children, registry);
  syncExports();
  return registry;
}

export function installWindowsElectronDirectTransport(
  {
    executable,
    args,
    loader,
    home,
    cwd,
    onCapturedSpawn,
    reportFailure = defaultFailure,
    platform = process.platform,
    playwrightVersion = installedVersion,
  },
  { children = childrenModule, syncExports = syncBuiltinESMExports } = {},
) {
  assert.equal(platform, "win32", "Direct transport is only for actual Windows Electron calls");
  assert.equal(
    installedVersion,
    reviewedPlaywrightElectronVersion,
    "Unreviewed installed Playwright Electron transport version",
  );
  assert.equal(
    playwrightVersion,
    installedVersion,
    "Unreviewed Playwright Electron transport version",
  );
  assert.ok(absolute(home) && absolute(cwd), "Canonical owned HOME and cwd are required");
  assert.equal(typeof onCapturedSpawn, "function", "Early birth-custody capture is required");
  const vector = knownPlaywrightElectronVector({ executable, args, loader });
  const registry = installPermanentKillGuard(children, syncExports);
  const originalSpawn = children.spawn;
  let captured,
    entry,
    restored = false;
  const failures = [];
  const scope = { failures, reportFailure };
  registry.scopes.add(scope);
  const fail = (message) => {
    failures.push(message);
    reportFailure(message);
    throw Error(message);
  };
  const wrapped = function (command, incomingArgs, options) {
    if (
      captured ||
      command !== vector.command ||
      !Array.isArray(incomingArgs) ||
      incomingArgs.length !== 0 ||
      options?.shell !== true ||
      options.detached !== false ||
      options.cwd !== cwd ||
      options.env?.HOME !== home ||
      options.env?.USERPROFILE !== home ||
      options.windowsVerbatimArguments === true ||
      !Array.isArray(options.stdio) ||
      options.stdio.join(",") !== "ignore,pipe,pipe,pipe,pipe"
    )
      return fail("Refused non-exact Windows Playwright Electron spawn; no shell fallback");
    const directOptions = { ...options, shell: false, windowsVerbatimArguments: false };
    const child = originalSpawn.call(this, executable, [...vector.argv], directOptions);
    captured = child;
    // A spawn-error child may never receive a library error listener because
    // early custody rejects before returning it. Do not turn that into an
    // unhandled event; no PID implies no signaling authority.
    child.once("error", () => {});
    entry = {
      pid: child.pid,
      killCommand: `taskkill /pid ${child.pid} /T /F`,
      child,
      monitor: undefined,
      reportFailure,
      failures,
      cleanupRequests: [],
    };
    if (Number.isSafeInteger(child.pid) && child.pid > 0) {
      const prior = registry.entries.get(child.pid) ?? [];
      prior.push(entry);
      registry.entries.set(child.pid, prior);
    }
    try {
      entry.monitor = onCapturedSpawn(child);
      assert.ok(
        entry.monitor?.terminate && entry.monitor.completed?.then,
        "Captured Main needs its existing birth-custody monitor",
      );
    } catch (error) {
      failures.push(error.message);
      throw error;
    }
    if ((registry.entries.get(child.pid)?.length ?? 0) > 1)
      return fail("Captured PID was reused; ambiguous library cleanup remains blocked");
    return child;
  };
  children.spawn = wrapped;
  syncExports();
  return {
    restoreSpawn() {
      if (restored) return;
      assert.equal(children.spawn, wrapped, "Another owner changed the scoped Electron spawn hook");
      children.spawn = originalSpawn;
      restored = true;
      registry.scopes.delete(scope);
      syncExports();
      // spawnSync guard intentionally remains for this captured/retired PID's
      // full library lifetime. It never grants authority to a replacement PID.
    },
    receipt() {
      return {
        method: "reviewed exact Windows shell vector converted to direct Electron spawn",
        playwrightVersion,
        directMain: Boolean(Number.isSafeInteger(captured?.pid) && entry?.monitor),
        pid: captured?.pid ?? null,
        failures: [...failures],
        unsafeFallbackDenied: failures.length > 0,
        cleanupRequests: (entry?.cleanupRequests ?? []).map(
          ({ completed: _completed, ...request }) => request,
        ),
        nativeTaskkillExecuted: false,
      };
    },
  };
}
