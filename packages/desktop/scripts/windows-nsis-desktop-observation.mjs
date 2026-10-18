/** One advisory desktop image in a fresh hosted Windows VM. Never a Setup
 * authority source. Its independent CIM custody calls can block this Node
 * event loop; unchanged timer values do not imply unchanged wall timing. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as files from "node:fs/promises";
import { win32 } from "node:path";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";

export const DESKTOP_OBSERVATION_LIMITS = Object.freeze({
  triggerMs: 170_000,
  captureMs: 8_000,
  settleSoftMs: 20_000,
  width: 4096,
  height: 2160,
  pixels: 4096 * 2160,
  pngBytes: 8 * 1024 * 1024,
  jsonBytes: 256 * 1024,
});
const BIRTH = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function desktopPngCrc32(bytes) {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
/** Bounded PNG container validation; pixel/deflate data is not decoded. */
export function validateDesktopPng(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > DESKTOP_OBSERVATION_LIMITS.pngBytes ||
    bytes.length < 57 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw Error("Invalid desktop PNG");
  let offset = 8,
    chunks = 0,
    width,
    height,
    dataBytes = 0,
    seenData = false,
    afterData = false,
    palette = false;
  while (offset < bytes.length) {
    if (++chunks > 4096 || offset + 12 > bytes.length) throw Error("PNG chunk limit");
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) throw Error("Truncated PNG chunk");
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (
      !typeBytes.every((value) => (value >= 65 && value <= 90) || (value >= 97 && value <= 122)) ||
      (typeBytes[2] & 32) !== 0 ||
      desktopPngCrc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      throw Error("PNG chunk CRC/type");
    if (chunks === 1 && kind !== "IHDR") throw Error("Missing PNG IHDR");
    if (kind === "IHDR") {
      if (chunks !== 1 || length !== 13) throw Error("Invalid PNG IHDR");
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      if (
        !width ||
        !height ||
        width > DESKTOP_OBSERVATION_LIMITS.width ||
        height > DESKTOP_OBSERVATION_LIMITS.height ||
        width * height > DESKTOP_OBSERVATION_LIMITS.pixels ||
        bytes[offset + 16] !== 8 ||
        ![2, 6].includes(bytes[offset + 17]) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20] !== 0
      )
        throw Error("Unsupported desktop PNG header");
    } else if (kind === "IDAT") {
      if (afterData) throw Error("Noncontiguous PNG IDAT");
      seenData = true;
      dataBytes += length;
    } else if (kind === "IEND") {
      if (length !== 0 || !dataBytes || end !== bytes.length) throw Error("Invalid PNG IEND");
      return {
        width,
        height,
        chunks,
        validation: "PNG container lengths/CRC/IHDR/IDAT/IEND; pixel data not decoded",
      };
    } else {
      if (seenData) afterData = true;
      if (kind === "PLTE") {
        if (palette || seenData || length < 3 || length > 768 || length % 3)
          throw Error("Invalid PNG palette");
        palette = true;
      } else if (kind[0] === kind[0].toUpperCase()) throw Error("Unknown critical PNG chunk");
    }
    offset = end;
  }
  throw Error("Missing PNG IEND");
}
const same = (a, b) => a?.pid === b?.pid && a?.ppid === b?.ppid && a?.birth === b?.birth;
const identity = (row) => {
  if (
    !row ||
    !Number.isSafeInteger(row.pid) ||
    row.pid <= 0 ||
    !Number.isSafeInteger(row.ppid) ||
    row.ppid < 0 ||
    !BIRTH.test(row.birth ?? "")
  )
    throw Error("Invalid observation identity");
  return { pid: row.pid, ppid: row.ppid, birth: row.birth };
};
function canonical(path) {
  if (
    typeof path !== "string" ||
    !/^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/.test(path) ||
    win32.normalize(path) !== path ||
    path.length >= 180 ||
    path
      .slice(3)
      .split("\\")
      .some(
        (part) =>
          !part ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw Error("Noncanonical observation path");
  return path;
}
async function plainParents(io, path) {
  let current = path;
  for (let depth = 0; depth < 40; depth += 1) {
    const info = await io.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Nonplain observation parent");
    const next = win32.dirname(current);
    if (next === current) return;
    current = next;
  }
  throw Error("Observation parent limit");
}
async function plainFile(io, path, limit) {
  const before = await io.lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > limit)
    throw Error("Nonplain observation file");
  const bytes = await io.readFile(path);
  const after = await io.lstat(path);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    bytes.length !== before.size
  )
    throw Error("Observation file changed");
  return { bytes, size: bytes.length, sha256: hash(bytes) };
}
function queryEnvironment(root, base) {
  const home = win32.join(root, "private-build", "home");
  const temporary = win32.join(root, "private-build", "tmp");
  const expected = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: win32.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: win32.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: win32.join(home, ".config"),
    XDG_DATA_HOME: win32.join(home, ".local", "share"),
    XDG_CACHE_HOME: win32.join(home, ".cache"),
    XDG_STATE_HOME: win32.join(home, ".local", "state"),
    XDG_RUNTIME_DIR: win32.join(home, ".run"),
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
  };
  for (const [key, value] of Object.entries(expected))
    if (base[key] !== value || canonical(base[key]) !== value)
      throw Error("Foreign observation HOME");
  const system = canonical(base.SystemRoot ?? base.SYSTEMROOT);
  return { ...expected, SystemRoot: system, WINDIR: system, PATH: win32.join(system, "System32") };
}

/** runProcess is the existing runNsisOwnedProcess, passed by the runner to
 * avoid a circular import. Fakes replace every IO/transport in pure contracts. */
export function createNsisDesktopObservation({
  root,
  script,
  ci,
  environment,
  runProcess,
  platform = process.platform,
  arch = process.arch,
  io = files,
  spawnProcess = spawn,
  watchProcess = watchElectronTestProcess,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  // The runner supplies ci from assertHostedWindowsNsis before any new IO.
  if (
    platform !== "win32" ||
    arch !== "x64" ||
    ci?.runner !== "github-hosted/windows-2022/x64" ||
    !/^[1-9]\d{0,19}$/.test(ci?.run ?? "") ||
    !/^[a-f0-9]{40}$/.test(ci?.source ?? "")
  )
    throw Error("Unadmitted observation host");
  const receipt = {
    status: "not-triggered",
    reason: "no-eligible-watching-sample",
    scope: "whole-primary-desktop-including-OS-and-other-visible-UI",
    boundary:
      "One asynchronous advisory image, not an owned-window image or waitsite proof. " +
      "Independent custody queries and capture consume resources and may delay Node timers. " +
      "No input, activation, dismissal, text API, Setup authority or deadline change.",
    limits: DESKTOP_OBSERVATION_LIMITS,
    trigger: null,
    collector: null,
    png: null,
    source: null,
    custodyUnproven: false,
  };
  let started = false,
    closing = false,
    done = false,
    monitor,
    work,
    finishing,
    collectorChild;
  const processReport = { processes: [] };
  const reasons = [];
  const unknown = (reason) => {
    if (!done) {
      receipt.status = "unknown";
      receipt.reason = reason;
    }
  };
  const safeReason = (reason) => {
    if (reasons.length < 8 && !reasons.includes(reason)) reasons.push(reason);
  };
  const closeInput = (child) => {
    const input = child?.stdin;
    try {
      if (input && !input.writableEnded && !input.destroyed) input.end();
    } catch {
      safeReason("stdin-close-failed");
    }
    try {
      if (input && !input.destroyed) input.destroy();
    } catch {
      safeReason("stdin-close-failed");
    }
  };
  const directory = win32.join(root, "replacement-desktop-observation");
  const output = win32.join(directory, "desktop.png");
  const reportFile = win32.join(root, "replacement-desktop-observation.json");
  async function collect() {
    try {
      canonical(root);
      canonical(directory);
      canonical(output);
      if (win32.basename(script) !== "windows-nsis-desktop-observation.ps1")
        throw Error("Unadmitted observation script");
      const env = queryEnvironment(root, environment);
      await plainParents(io, root);
      const source = await plainFile(io, script, 16 * 1024);
      if (closing || done) {
        unknown("setup-already-settled");
        return;
      }
      receipt.source = { ci, scriptSHA256: source.sha256, scriptBytes: source.size };
      await io.mkdir(directory, { mode: 0o700 }); // Exclusive: no recursive/open-existing fallback.
      await plainParents(io, directory);
      if (closing) {
        unknown("setup-already-settled");
        return;
      }
      const executable = win32.join(
        win32.parse(env.SystemRoot).root,
        "Program Files",
        "PowerShell",
        "7",
        "pwsh.exe",
      );
      const operation = await runProcess({
        label: "desktop-capture",
        executable,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-OutputPath", output],
        environment: env,
        cwd: directory,
        timeoutMs: DESKTOP_OBSERVATION_LIMITS.captureMs,
        report: processReport,
        checkpoint: () => {}, // Never writes a Setup event or its first-error record.
        spawnProcess: (file, args, options) => {
          collectorChild = spawnProcess(file, args, {
            ...options,
            stdio: ["pipe", "pipe", "pipe"],
          });
          collectorChild.stdin?.on("error", () => safeReason("stdin-failed"));
          return collectorChild;
        },
        watch: (child, options) => {
          let candidate;
          try {
            candidate = watchProcess(child, options);
          } catch (error) {
            processReport.unprovenProcess = true;
            safeReason("watch-unproven");
            closeInput(child);
            throw error; // Existing helper still has no authority and must not signal.
          }
          monitor = candidate;
          const captured = processReport.processes.at(-1)?.child;
          let admitted = false;
          try {
            identity(captured);
            if (captured.pid !== child.pid || typeof candidate?.terminate !== "function")
              throw Error("Unproven collector gate");
            admitted = true;
            if (closing) closeInput(child);
            else
              child.stdin.end("CAPTURE1\n", (error) => {
                if (error) safeReason("stdin-failed");
              });
          } catch {
            safeReason(admitted ? "stdin-failed" : "stdin-unproven");
            if (!admitted) processReport.unprovenProcess = true;
            closeInput(child);
          }
          return candidate;
        },
      });
      if (closing || done) return;
      if (operation.status !== "passed" || processReport.unprovenProcess || reasons.length)
        throw Error("Collector incomplete");
      const after = await plainFile(io, script, 16 * 1024);
      if (after.sha256 !== source.sha256) throw Error("Observation script changed");
      const log = await plainFile(io, win32.join(directory, "desktop-capture.stdout.log"), 2048);
      const value = JSON.parse(log.bytes.toString("utf8").replace(/^\uFEFF/, ""));
      if (
        Object.keys(value).sort().join(",") !== "bytes,height,scope,status,width" ||
        value.status !== "observed" ||
        value.scope !== "primary-desktop" ||
        !Number.isInteger(value.width) ||
        value.width < 1 ||
        value.width > DESKTOP_OBSERVATION_LIMITS.width ||
        !Number.isInteger(value.height) ||
        value.height < 1 ||
        value.height > DESKTOP_OBSERVATION_LIMITS.height ||
        value.width * value.height > DESKTOP_OBSERVATION_LIMITS.pixels
      )
        throw Error("Unknown desktop capture");
      await plainParents(io, directory);
      const png = await plainFile(io, output, DESKTOP_OBSERVATION_LIMITS.pngBytes);
      const container = validateDesktopPng(png.bytes);
      if (
        container.width !== value.width ||
        container.height !== value.height ||
        value.bytes !== png.size ||
        reasons.length
      )
        throw Error("Unknown desktop PNG");
      if (closing || done) return;
      receipt.png = { size: png.size, sha256: png.sha256, ...container };
      receipt.status = "observed";
      receipt.reason = null;
    } catch {
      unknown("collector-failed-or-incomplete");
    } finally {
      closeInput(collectorChild);
    }
  }
  function observe({ phase, ownedCurrent, sample, child }) {
    if (started || closing) return;
    try {
      if (
        phase !== "watching" ||
        !Number.isFinite(sample?.sampledElapsedMs) ||
        sample.sampledElapsedMs < DESKTOP_OBSERVATION_LIMITS.triggerMs
      )
        return;
      const pinned = identity(child);
      if (
        !Number.isSafeInteger(sample.querySequence) ||
        sample.querySequence < 1 ||
        sample.samplePhase !== phase ||
        !ownedCurrent.some((row) => same(identity(row), pinned)) ||
        !sample.rows.some((row) => same(identity(row), pinned))
      )
        return;
      started = true; // Sticky before any await, including a failed first attempt.
      receipt.status = "pending";
      receipt.reason = "collector-pending";
      receipt.trigger = {
        ...pinned,
        querySequence: sample.querySequence,
        sampledElapsedMs: sample.sampledElapsedMs,
      };
      work = collect(); // Never awaited by Setup observation/timeout/signal handling.
    } catch {
      safeReason("trigger-invalid");
    }
  }
  async function finishOnce() {
    if (done) return receipt;
    closing = true; // Called only after original Setup helper/outer first-error handling.
    let timer;
    try {
      if (work) {
        try {
          Promise.resolve(monitor?.terminate()).catch(() => safeReason("collector-stop-failed"));
        } catch {
          safeReason("collector-stop-failed");
        }
        const outcome = await Promise.race([
          work.then(() => "settled"),
          new Promise((resolve) => {
            timer = schedule(
              () => resolve("soft-timeout"),
              DESKTOP_OBSERVATION_LIMITS.settleSoftMs,
            );
          }),
        ]);
        if (outcome !== "settled") {
          unknown("collector-settlement-unproven");
          receipt.custodyUnproven = true;
        }
      }
      receipt.custodyUnproven ||=
        processReport.unprovenProcess === true ||
        processReport.processes.some((operation) => operation.settlement?.status !== "cleaned");
      receipt.collector = JSON.parse(JSON.stringify(processReport));
      receipt.reasons = [...reasons];
      if (reasons.length && receipt.status === "observed") unknown("collector-input-error");
      if (receipt.status === "pending") unknown("collector-finished-without-image");
      done = true;
      const text = JSON.stringify(receipt, null, 2) + "\n";
      if (Buffer.byteLength(text) > DESKTOP_OBSERVATION_LIMITS.jsonBytes)
        throw Error("Observation JSON cap");
      await plainParents(io, root);
      await io.writeFile(reportFile, text, { flag: "wx", mode: 0o600 });
    } catch {
      receipt.status = "unknown";
      receipt.reason = "observation-recording-failed";
      receipt.recordingFailed = true;
    } finally {
      cancel(timer);
    }
    return receipt;
  }
  const finish = () => (finishing ??= finishOnce());
  return {
    observe,
    finish,
    receipt,
    get completed() {
      return work ?? Promise.resolve();
    },
  };
}
