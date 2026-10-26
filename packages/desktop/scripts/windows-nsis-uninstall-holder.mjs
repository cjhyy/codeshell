/** A START gate preserves the existing watchdog's initial holder identity.
 * Target identity/exit come only from the holder's retained CreateProcess handle. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";
import { snapshotElectronTestProcesses } from "./electron-test-process-snapshot.mjs";
import { windowsBirthToFileTime } from "./windows-nsis-crash-evidence.mjs";

export const NSIS_UNINSTALL_HOLDER_SCRIPT = fileURLToPath(
  new URL("./windows-nsis-uninstall-holder.ps1", import.meta.url),
);
const MAX_OUTPUT = 16 * 1024;
const MAX_LINE = 1024;
const STOP_WAIT = 15_000;
const NONCE = /^[a-f0-9]{32}$/;
const pid = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff;
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const protocolError = () => Error("Invalid NSIS uninstall holder protocol");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Cross-check a WMI microsecond observation against a retained 100ns handle
 * identity. Only the handle time is projected; this never grants signal authority
 * or changes either stored identity or the watchdog's same-source comparisons. */
export function wmiRowMatchesNsisHolderTarget(row, target) {
  if (
    !pid(row?.pid) ||
    !pid(row?.ppid) ||
    row.pid !== target?.pid ||
    row.ppid !== target?.ppid ||
    typeof row.birth !== "string" ||
    !row.birth.endsWith("0Z")
  )
    return false;
  try {
    const rowFiletime = BigInt(windowsBirthToFileTime(row.birth));
    const handleFiletime = BigInt(windowsBirthToFileTime(target.birth));
    return rowFiletime === (handleFiletime / 10n) * 10n;
  } catch {
    return false;
  }
}

/** Prefix parsing is useful while the pipe is open; complete requires a terminal
 * event. Flat keys are literal and unique, including before JSON.parse collapses them. */
export function parseHolderProtocol(output, { nonce, holderPid, complete = false } = {}) {
  if (
    typeof output !== "string" ||
    Buffer.byteLength(output) > MAX_OUTPUT ||
    !NONCE.test(nonce ?? "") ||
    !pid(holderPid)
  )
    throw protocolError();
  const events = [];
  let target = null,
    targetExit = null,
    stopped = null,
    terminal = false;
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const raw of lines) {
    if (Buffer.byteLength(raw) > MAX_LINE || !raw || events.length >= 6 || terminal)
      throw protocolError();
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw protocolError();
    }
    const keys = [...line.slice(1, -1).matchAll(/(?:^|,)\s*"([A-Za-z]+)"\s*:/g)].map((m) => m[1]);
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      keys.length !== Object.keys(row).length ||
      new Set(keys).size !== keys.length ||
      row.v !== 1 ||
      row.nonce !== nonce
    )
      throw protocolError();
    const common = ["v", "event", "nonce"];
    if (row.event === "ready") {
      if (events.length || !exact(row, [...common, "pid"]) || row.pid !== holderPid)
        throw protocolError();
    } else {
      if (events[0]?.event !== "ready") throw protocolError();
      switch (row.event) {
        case "target":
          if (
            !exact(row, [...common, "pid", "ppid", "birth"]) ||
            target ||
            stopped ||
            !pid(row.pid) ||
            row.pid === holderPid ||
            row.ppid !== holderPid
          )
            throw protocolError();
          try {
            windowsBirthToFileTime(row.birth);
          } catch {
            throw protocolError();
          }
          target = { pid: row.pid, ppid: row.ppid, birth: row.birth, source: "holder-handle" };
          break;
        case "exit":
          if (
            !exact(row, [...common, "code"]) ||
            !target ||
            stopped ||
            !Number.isInteger(row.code) ||
            row.code < -0x8000_0000 ||
            row.code > 0x7fff_ffff
          )
            throw protocolError();
          targetExit = { code: row.code };
          terminal = true;
          break;
        case "stopped":
          if (
            !exact(row, [...common, "reason", "targetExited"]) ||
            stopped ||
            !["stop", "eof", "protocol", "error"].includes(row.reason) ||
            typeof row.targetExited !== "boolean"
          )
            throw protocolError();
          stopped = { reason: row.reason, targetExited: row.targetExited };
          break;
        case "error":
          if (
            !exact(row, [...common, "code"]) ||
            !["target-missing", "start-failed", "handle-failed", "protocol"].includes(row.code)
          )
            throw protocolError();
          terminal = true;
          break;
        case "aborted":
          if (!exact(row, common) || target || stopped) throw protocolError();
          terminal = true;
          break;
        default:
          throw protocolError();
      }
    }
    events.push(row);
  }
  if (complete && !terminal && !stopped) throw protocolError();
  return { events, target, targetExit, stopped };
}

function fixedExecutable(path) {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    realpathSync.native(path).toLowerCase() !== path.toLowerCase()
  )
    throw Error("Fixed holder executable unavailable");
}
export function readNsisHolderScriptPin() {
  const info = lstatSync(NSIS_UNINSTALL_HOLDER_SCRIPT);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 1 ||
    info.size > 16 * 1024 ||
    realpathSync.native(NSIS_UNINSTALL_HOLDER_SCRIPT) !== NSIS_UNINSTALL_HOLDER_SCRIPT
  )
    throw Error("Fixed holder script unavailable");
  const bytes = readFileSync(NSIS_UNINSTALL_HOLDER_SCRIPT);
  if (bytes.length !== info.size) throw Error("Holder script changed");
  return { path: NSIS_UNINSTALL_HOLDER_SCRIPT, sha256: sha(bytes) };
}
function ownedPath(path, root) {
  assert.ok(typeof path === "string" && /^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/.test(path));
  assert.equal(win32.normalize(path), path);
  assert.ok(path.length < 180);
  const relative = win32.relative(root, path);
  assert.ok(
    relative && relative !== ".." && !relative.startsWith("..\\") && !win32.isAbsolute(relative),
  );
  for (const part of path.slice(3).split("\\"))
    assert.ok(
      part && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    );
}

/** runProcess is the unchanged runNsisOwnedProcess, supplied to avoid importing
 * its native driver. Every effect has an injectable adapter for pure contracts. */
export async function runNsisGatedUninstall(
  { target, installDir, root, environment, timeoutMs, report, checkpoint, runProcess },
  {
    platform = process.platform,
    parentPid = process.pid,
    spawnProcess = spawn,
    watch = watchElectronTestProcess,
    takeSnapshot = snapshotElectronTestProcesses,
    verifyExecutable = fixedExecutable,
    makeNonce = () => randomBytes(16).toString("hex"),
    schedule = setTimeout,
    cancel = clearTimeout,
  } = {},
) {
  assert.ok(
    Number.isInteger(timeoutMs) && timeoutMs > 20_000 && timeoutMs <= 2_147_483_647,
    "NSIS uninstall holder timeout must leave 20 seconds for STOP and custody cleanup",
  );
  assert.equal(platform, "win32");
  ownedPath(target, root);
  ownedPath(installDir, root);
  const systemRoot = environment?.SystemRoot ?? environment?.SYSTEMROOT;
  assert.ok(
    typeof systemRoot === "string" &&
      /^[a-z]:\\/i.test(systemRoot) &&
      win32.normalize(systemRoot) === systemRoot &&
      !/[\0\r\n]/.test(systemRoot),
  );
  const executable = win32.join(
    win32.parse(systemRoot).root,
    "Program Files",
    "PowerShell",
    "7",
    "pwsh.exe",
  );
  verifyExecutable(executable);
  const nonce = makeNonce();
  assert.match(nonce, NONCE);
  const holder = {
    schemaVersion: 1,
    script: readNsisHolderScriptPin(),
    nonce,
    events: [],
    target: null,
    targetExit: null,
    stopped: null,
  };
  let child,
    monitor,
    operation,
    terminateWork,
    initialFailure,
    initialFailed = false,
    admitted = false,
    startSent = false,
    stopSent = false,
    firstError,
    timeout,
    stopTimer,
    stopWork,
    failureResolve,
    stopResolve,
    outputBytes = 0,
    pending = Buffer.alloc(0),
    dropping = false,
    accepted = "";
  const failure = new Promise((resolve) => (failureResolve = resolve));
  const stopped = new Promise((resolve) => (stopResolve = resolve));
  const closeInput = () => {
    try {
      if (child?.stdin && !child.stdin.writableEnded) child.stdin.end();
    } catch {
      /* EOF only. */
    }
  };
  const fail = (error) => {
    if (!firstError) {
      firstError = error;
      failureResolve(error);
    }
  };
  const write = (command) => {
    try {
      if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded)
        throw protocolError();
      child.stdin.write(`${command} ${nonce}\n`, (error) => {
        if (error) fail(protocolError());
      });
    } catch {
      fail(protocolError());
      closeInput();
    }
  };
  const maybeStart = () => {
    if (admitted && !firstError && !startSent && holder.events[0]?.event === "ready") {
      startSent = true;
      write("START");
    }
  };
  const consumeLine = (bytes) => {
    try {
      const line = bytes.toString("utf8") + "\n";
      const parsed = parseHolderProtocol(accepted + line, { nonce, holderPid: child.pid });
      const event = parsed.events.at(-1);
      if (event.event === "target" && (!startSent || event.pid === parentPid))
        throw protocolError();
      // After a malformed line, only a matching STOP acknowledgement may be
      // recovered. The sticky first error still forbids acceptance.
      if (firstError && !(stopSent && ((parsed.stopped && !holder.stopped) || parsed.targetExit)))
        return;
      accepted += line;
      Object.assign(holder, parsed);
      if (holder.stopped || holder.targetExit) stopResolve();
      if (event.event === "exit" && event.code !== 0)
        fail(Error(`NSIS uninstall target exited with code ${event.code}`));
      if (event.event === "stopped") fail(Error("NSIS uninstall holder stopped"));
      if (event.event === "error") fail(Error(`NSIS uninstall holder error: ${event.code}`));
      if (event.event === "aborted") fail(Error("NSIS uninstall holder aborted"));
      maybeStart();
    } catch {
      fail(protocolError());
    }
  };
  const consume = (chunk) => {
    const bytes = Buffer.from(chunk);
    outputBytes += bytes.length;
    if (outputBytes > MAX_OUTPUT) fail(protocolError());
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline;
      const part = bytes.subarray(offset, end);
      if (pending.length + part.length > MAX_LINE) {
        dropping = true;
        pending = Buffer.alloc(0);
        fail(protocolError());
      }
      if (!dropping) pending = Buffer.concat([pending, part]);
      if (newline < 0) break;
      const line = pending;
      pending = Buffer.alloc(0);
      const skipped = dropping;
      dropping = false;
      offset = newline + 1;
      if (!skipped) consumeLine(line);
    }
  };
  const stopTarget = () => {
    if (stopWork) return stopWork;
    stopWork = (async () => {
      if (
        !startSent ||
        holder.targetExit ||
        holder.stopped ||
        child?.exitCode != null ||
        child?.signalCode != null
      ) {
        closeInput();
        return;
      }
      stopSent = true;
      write("STOP");
      try {
        await Promise.race([
          stopped,
          new Promise((resolve) => {
            stopTimer = schedule(resolve, STOP_WAIT);
          }),
        ]);
      } finally {
        cancel(stopTimer);
        closeInput();
      }
    })();
    return stopWork;
  };
  try {
    operation = await runProcess({
      executable,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        holder.script.path,
        "-Nonce",
        nonce,
        "-Target",
        target,
        "-InstallDir",
        installDir,
      ],
      cwd: root,
      environment,
      label: "uninstall",
      timeoutMs,
      report,
      checkpoint,
      takeSnapshot,
      spawnProcess: (file, args, options) => {
        operation = report.processes.at(-1);
        operation.holder = holder;
        child = spawnProcess(file, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
        child.stdin?.on("error", () => fail(protocolError()));
        child.stdout?.on("data", consume);
        child.stdout?.on("error", () => fail(protocolError()));
        child.stdout?.on("end", () => {
          if (pending.length || dropping) fail(protocolError());
          try {
            parseHolderProtocol(accepted, { nonce, holderPid: child.pid, complete: true });
          } catch {
            fail(protocolError());
          }
        });
        child.once("close", () => stopResolve());
        return child;
      },
      watch: (actual, options) => {
        let candidate;
        try {
          candidate = watch(actual, options);
          const identity = operation.child;
          assert.ok(
            typeof candidate === "function" &&
              candidate.completed?.then &&
              typeof candidate.terminate === "function" &&
              identity?.pid === actual.pid &&
              identity.ppid === parentPid &&
              pid(identity.pid),
          );
          windowsBirthToFileTime(identity.birth);
        } catch (error) {
          initialFailed = true;
          initialFailure = error;
          try {
            if (typeof candidate === "function") candidate();
          } catch {
            /* Disarm only. */
          }
          closeInput();
          throw error;
        }
        monitor = candidate;
        admitted = true;
        const terminate = () => {
          terminateWork ??= (async () => {
            await stopTarget();
            return candidate.terminate();
          })();
          return terminateWork;
        };
        const completed = Promise.race([
          candidate.completed,
          failure.then(async (error) => {
            await terminate();
            throw error;
          }),
        ]);
        // completed can reject during synchronous fake START delivery as well.
        completed.catch(() => {});
        timeout = schedule(() => fail(Error("NSIS uninstall holder timeout")), timeoutMs - 20_000);
        maybeStart();
        return Object.assign(() => candidate(), { completed, terminate });
      },
    });
    if (firstError) throw firstError;
    const parsed = parseHolderProtocol(accepted, { nonce, holderPid: child.pid, complete: true });
    assert.deepEqual(
      parsed.events.map((row) => row.event),
      ["ready", "target", "exit"],
    );
    assert.deepEqual(holder.targetExit, { code: 0 });
    for (const row of operation.settlement.owned)
      if (row.pid === holder.target.pid && !wmiRowMatchesNsisHolderTarget(row, holder.target))
        throw Error("NSIS uninstall target identity mismatch");
    assert.deepEqual(readNsisHolderScriptPin(), holder.script, "Holder script changed");
    return operation;
  } catch (error) {
    const original = initialFailed ? initialFailure : (firstError ?? error);
    if (admitted) {
      try {
        terminateWork ??= (async () => {
          await stopTarget();
          return monitor.terminate();
        })();
        await terminateWork;
      } catch {
        /* Preserve original. */
      }
    } else closeInput();
    if (operation) {
      operation.status = "failed";
      try {
        operation.failure = {
          name: typeof original?.name === "string" ? original.name : "Error",
          message: String(original?.message ?? original ?? "Unknown caught value").slice(0, 2048),
        };
      } catch {
        operation.failure = { name: "Error", message: "Caught value could not be described" };
      }
    }
    throw original;
  } finally {
    cancel(timeout);
    cancel(stopTimer);
    closeInput();
    // Even Start() throwing can occur after native creation but before .NET has
    // associated its handle. Error/aborted alone never prove a started target dead.
    if (startSent && !holder.targetExit && holder.stopped?.targetExited !== true)
      report.unprovenProcess = true;
  }
}
