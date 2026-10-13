import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

// Test-only observation adds small clock/parsing overhead. It never changes
// bytes, callbacks, return values, thrown values, or the production fsync policy.
function installObserver() {
  const home = process.env.HOME;
  const origin = process.env.CODESHELL_COST_SMOKE_ORIGIN;
  const parent = Number(process.env.CODESHELL_PACED_TIMING_PARENT_PID);
  if (
    !home ||
    !origin ||
    !Number.isSafeInteger(parent) ||
    parent < 1 ||
    parent !== process.ppid ||
    globalThis[Symbol.for("codeshell.cost-smoke.network-guard")] !== origin ||
    process.env.USERPROFILE !== home ||
    process.env.CODESHELL_COST_SMOKE_HOME_ID !== createHash("sha256").update(home).digest("hex")
  )
    return;
  const homeStat = fs.lstatSync(home);
  if (
    !homeStat.isDirectory() ||
    homeStat.isSymbolicLink() ||
    homeStat.uid !== process.getuid?.() ||
    (homeStat.mode & 0o777) !== 0o700 ||
    fs.realpathSync(home) !== home
  )
    return;
  const begun = performance.now(),
    wallBegun = Date.now(),
    fsyncRows = [],
    stdoutRows = [];
  let fsyncOverflow = 0,
    stdoutOverflow = 0;
  const ms = (value) => Math.round(value * 1000) / 1000;
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = function (...args) {
    let started;
    try {
      started = performance.now();
    } catch {
      /* Observation must not replace the real operation. */
    }
    let succeeded = false;
    try {
      const result = Reflect.apply(originalFsync, this, args);
      succeeded = true;
      return result;
    } finally {
      try {
        if (started !== undefined) {
          if (fsyncRows.length < 4096)
            fsyncRows.push([
              ms(started - begun),
              ms(performance.now() - started),
              succeeded ? 1 : 0,
            ]);
          else fsyncOverflow = Math.min(Number.MAX_SAFE_INTEGER, fsyncOverflow + 1);
        }
      } catch {
        /* Keep the original return or thrown value. */
      }
    }
  };
  const originalWrite = process.stdout.write;
  process.stdout.write = function (...args) {
    let started, wall;
    try {
      started = performance.now();
      wall = Date.now();
    } catch {
      /* The original write still runs. */
    }
    const result = Reflect.apply(originalWrite, this, args);
    try {
      const finished = performance.now();
      const chunk = args[0];
      if (started === undefined || typeof chunk !== "string" || chunk.length > 64 * 1024)
        return result;
      const message = JSON.parse(chunk);
      if (
        message?.method !== "agent/streamEvent" ||
        message.params?.sessionId !== "paced-output" ||
        message.params.event?.type !== "text_delta" ||
        typeof message.params.event.text !== "string"
      )
        return result;
      for (const line of message.params.event.text.trim().split("\n")) {
        const frame = JSON.parse(line);
        if (
          !Number.isSafeInteger(frame?.index) ||
          frame.index < 0 ||
          frame.index >= 150 ||
          !Number.isSafeInteger(frame.sentAt) ||
          frame.sentAt < 0
        )
          continue;
        if (stdoutRows.length < 150)
          // index, original sentAt wall-age, local mono/wall offsets,
          // actual write call ms, writable, writableLength. No raw text.
          stdoutRows.push([
            frame.index,
            wall - frame.sentAt,
            ms(started - begun),
            wall - wallBegun,
            ms(finished - started),
            result ? 1 : 0,
            process.stdout.writableLength,
          ]);
        else stdoutOverflow = Math.min(Number.MAX_SAFE_INTEGER, stdoutOverflow + 1);
      }
    } catch {
      /* Unknown or malformed output is not a diagnostic input. */
    }
    return result;
  };
  syncBuiltinESMExports();
  process.once("exit", () => {
    try {
      const receipt = JSON.stringify({
        version: 1,
        pid: process.pid,
        ppid: process.ppid,
        fsyncRows,
        fsyncOverflow,
        stdoutRows,
        stdoutOverflow,
      });
      if (Buffer.byteLength(receipt) <= 512 * 1024)
        fs.writeFileSync(join(home, "paced-worker-timing.json"), receipt, {
          flag: "wx",
          mode: 0o600,
        });
    } catch {
      /* Missing receipt means unavailable; never change the worker exit. */
    }
  });
}
try {
  installObserver();
} catch {
  /* A failed observer must not change the worker's behavior or exit code. */
}
