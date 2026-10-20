/** Pure coordinator/fake child/FS/scheduler contracts. No PS, screenshot, query,
 * native process or signal is executed, including before the dynamic import. */
import assert from "node:assert/strict";
import * as children from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { win32 } from "node:path";
import { test } from "node:test";

const native = createRequire(import.meta.url)("node:child_process");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
  native[name] = () => {
    throw Error(`Native transport denied: ${name}`);
  };
process.kill = () => {
  throw Error("Native signal denied");
};
syncBuiltinESMExports();
const {
  createNsisDesktopObservation,
  DESKTOP_OBSERVATION_LIMITS,
  desktopPngCrc32,
  validateDesktopPng,
} = await import("./windows-nsis-desktop-observation.mjs");

const root = "D:\\owned\\nsis";
const script = "D:\\repo\\windows-nsis-desktop-observation.ps1";
const directory = win32.join(root, "replacement-desktop-observation");
const pngPath = win32.join(directory, "desktop.png");
const reportPath = win32.join(root, "replacement-desktop-observation.json");
const birth = "2026-10-18T01:02:03.0000001Z";
const setup = { pid: 42, ppid: 99, birth };
const collector = { pid: 700, ppid: 99, birth };
const home = win32.join(root, "private-build", "home");
const temp = win32.join(root, "tmp");
const environment = {
  SystemRoot: "C:\\Windows",
  HOME: home,
  USERPROFILE: home,
  APPDATA: win32.join(home, "AppData", "Roaming"),
  LOCALAPPDATA: win32.join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: win32.join(home, ".config"),
  XDG_DATA_HOME: win32.join(home, ".local", "share"),
  XDG_CACHE_HOME: win32.join(home, ".cache"),
  XDG_STATE_HOME: win32.join(home, ".local", "state"),
  XDG_RUNTIME_DIR: win32.join(home, ".run"),
  TEMP: temp,
  TMP: temp,
  TMPDIR: temp,
  SECRET_TOKEN: "must-not-pass",
  CODE_SHELL_HOME: "must-not-pass",
  NODE_OPTIONS: "must-not-pass",
};
// Independent nibble-table fixture CRC, rather than calling the production CRC.
function fixtureCrc(bytes) {
  const table = [
    0, 0x1db71064, 0x3b6e20c8, 0x26d930ac, 0x76dc4190, 0x6b6b51f4, 0x4db26158, 0x5005713c,
    0xedb88320, 0xf00f9344, 0xd6d6a3e8, 0xcb61b38c, 0x9b64c2b0, 0x86d3d2d4, 0xa00ae278, 0xbdbdf21c,
  ];
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    crc = (crc >>> 4) ^ table[crc & 15];
    crc = (crc >>> 4) ^ table[crc & 15];
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4);
  data.copy(bytes, 8);
  bytes.writeUInt32BE(fixtureCrc(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
function png(width = 1, height = 1) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  // One transparent RGBA pixel: stored DEFLATE block (five zero scanline bytes),
  // LEN/NLEN and Adler32=0x00050001. Never invokes a codec or screenshot API.
  const data = Buffer.from([0x78, 1, 1, 5, 0, 0xfa, 0xff, 0, 0, 0, 0, 0, 0, 5, 0, 1]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", data),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(overrides = {}) {
  const events = [],
    calls = [],
    timers = [],
    writes = [],
    files = new Map();
  const started = deferred();
  files.set(script, Buffer.from("inert source bytes; never evaluated"));
  files.set(pngPath, png());
  files.set(
    win32.join(directory, "desktop-capture.stdout.log"),
    Buffer.from(
      JSON.stringify({
        status: "observed",
        scope: "primary-desktop",
        width: 1,
        height: 1,
        bytes: png().length,
      }),
    ),
  );
  let watchReady = false;
  const input = new EventEmitter();
  input.end = (value, callback) => {
    if (value) assert.equal(watchReady, true);
    events.push(["stdin", value]);
    if (overrides.stdinFails && value) throw Error("inert stdin failure");
    input.writableEnded = true;
    if (overrides.stdinEmitsError && value) input.emit("error", Error("inert EPIPE"));
    callback?.();
  };
  input.destroy = () => {
    input.destroyed = true;
    events.push(["stdin-destroy"]);
  };
  const child = { pid: 700, stdin: input };
  const monitor = Object.assign(() => {}, {
    completed: Promise.resolve({ status: "cleaned" }),
    terminate: () => {
      events.push(["terminate"]);
      return Promise.resolve();
    },
  });
  const io = {
    lstat: async (path) => ({
      dev: 1,
      ino: 2,
      size: files.get(path)?.length ?? 0,
      isFile: () => files.has(path),
      isDirectory: () => !files.has(path),
      isSymbolicLink: () => false,
    }),
    readFile: async (path) => {
      assert.ok(files.has(path), path);
      return files.get(path);
    },
    mkdir: async (path, options) => {
      calls.push(["mkdir", path, options]);
    },
    writeFile: async (path, text, options) => {
      writes.push({ path, text, options });
    },
    ...overrides.io,
  };
  const baseRun = async (options) => {
    calls.push(["run", options]);
    const operation = {
      label: "desktop-capture",
      status: "passed",
      child: { pid: 700, ppid: 99 },
      result: { code: 0, signal: null },
      settlement: {
        status: "cleaned",
        owned: [collector],
        remaining: [],
        ownedCount: 1,
        remainingCount: 0,
        queryFailed: false,
        evidenceTruncated: false,
      },
      signalRequests: [],
    };
    options.report.processes.push(operation);
    const spawned = options.spawnProcess(options.executable, options.args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(spawned, child);
    options.watch(child, {
      snapshotProcesses: () => {
        operation.child.birth = birth;
        return [collector];
      },
    });
    started.resolve();
    return overrides.run ? overrides.run(options, operation) : operation;
  };
  const options = {
    root,
    script,
    environment,
    platform: "win32",
    arch: "x64",
    ci: { runner: "github-hosted/windows-2022/x64", run: "39076696510", source: "a".repeat(40) },
    io,
    runProcess: baseRun,
    spawnProcess: (file, args, value) => {
      calls.push(["spawn", file, args, value]);
      return child;
    },
    watchProcess: (value, options) => {
      assert.equal(value, child);
      events.push(["watch"]);
      options.snapshotProcesses();
      watchReady = true;
      return monitor;
    },
    schedule: (callback, ms) => {
      const timer = { callback, ms };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      events.push(["cancel", timer]);
    },
    ...overrides.options,
  };
  const observer = createNsisDesktopObservation(options);
  const observe = (extra = {}) =>
    observer.observe({
      phase: "watching",
      child: setup,
      ownedCurrent: [setup],
      sample: {
        querySequence: 170,
        samplePhase: "watching",
        sampledElapsedMs: 170_000,
        rows: [{ ...setup, role: "setup-path-match" }],
      },
      ...extra,
    });
  return {
    observer,
    observe,
    events,
    calls,
    timers,
    writes,
    files,
    options,
    monitor,
    started,
    input,
  };
}

test("native transports and signals are denied before the actual coordinator import", () => {
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    assert.throws(() => children[name]("not-run"), /Native transport denied/);
  assert.throws(() => process.kill(42, "SIGTERM"), /Native signal denied/);
});
test("host admission precedes every new IO and transport", () => {
  assert.throws(() => fixture({ options: { platform: "darwin" } }), /Unadmitted/);
  assert.throws(() => fixture({ options: { ci: { runner: "self-hosted" } } }), /Unadmitted/);
});
test("below-threshold, cleaning and a different incarnation never launch a collector", async () => {
  const f = fixture();
  f.observe({ phase: "cleaning" });
  f.observe({ sample: { sampledElapsedMs: 169_999 } });
  f.observe({ ownedCurrent: [{ ...setup, birth: "2026-10-18T01:02:03.0000002Z" }] });
  await f.observer.finish();
  assert.equal(f.calls.length, 0);
  assert.equal(f.observer.receipt.status, "not-triggered");
  assert.equal(f.writes[0].path, reportPath);
  assert.equal(f.writes[0].options.flag, "wx");
});
test("one actual coordinator flow gates GO on full-birth custody, isolates report and validates PNG", async () => {
  const f = fixture();
  f.observe();
  f.observe();
  await f.observer.completed;
  assert.equal(f.calls.filter(([kind]) => kind === "run").length, 1);
  assert.deepEqual(f.events.slice(0, 2), [["watch"], ["stdin", "CAPTURE1\n"]]);
  const args = f.calls.find(([kind]) => kind === "run")[1];
  assert.equal(args.timeoutMs, 8000);
  assert.equal(args.report.processes.length, 1);
  assert.equal(args.label, "desktop-capture");
  assert.equal(args.replacementRoles, undefined);
  assert.deepEqual(f.calls.find(([kind]) => kind === "spawn")[3].stdio, ["pipe", "pipe", "pipe"]);
  for (const name of ["SECRET_TOKEN", "NODE_OPTIONS", "CODE_SHELL_HOME"])
    assert.equal(args.environment[name], undefined);
  await f.observer.finish();
  assert.equal(f.observer.receipt.status, "observed");
  assert.equal(f.observer.receipt.png.size, png().length);
  assert.equal(f.observer.receipt.custodyUnproven, false);
  assert.equal(JSON.parse(f.writes[0].text).collector.processes[0].child.birth, birth);
});
test("an exclusive directory fault is sticky and never retries or starts a process", async () => {
  const f = fixture({
    io: {
      mkdir: async () => {
        throw Error("exists");
      },
    },
  });
  f.observe();
  await f.observer.completed;
  f.observe();
  await f.observer.finish();
  assert.equal(f.calls.filter(([kind]) => kind === "run").length, 0);
  assert.equal(f.observer.receipt.status, "unknown");
});
test("a failed GO write records unknown without bypassing the already established collector watcher", async () => {
  const f = fixture({ stdinFails: true });
  f.observe();
  await f.observer.completed;
  await f.observer.finish();
  assert.equal(f.events[0][0], "watch");
  assert.equal(f.observer.receipt.status, "unknown");
  assert.ok(f.observer.receipt.reasons.includes("stdin-failed"));
  assert.equal(f.observer.receipt.custodyUnproven, false);
});
test("early stream EPIPE is handled and becomes unknown, never an uncaught controller error", async () => {
  const f = fixture({ stdinEmitsError: true });
  f.observe();
  await f.observer.completed;
  await f.observer.finish();
  assert.equal(f.input.listenerCount("error"), 1);
  assert.equal(f.input.destroyed, true);
  assert.equal(f.observer.receipt.status, "unknown");
  assert.ok(f.observer.receipt.reasons.includes("stdin-failed"));
});
test("initial watch failure closes the local gate without GO or any unowned signal", async () => {
  const f = fixture({
    options: {
      watchProcess: () => {
        throw Error("inert snapshot failure");
      },
    },
  });
  f.observe();
  await f.observer.completed;
  await f.observer.finish();
  assert.equal(f.input.writableEnded, true);
  assert.equal(f.input.destroyed, true);
  assert.equal(
    f.events.some(([kind, value]) => kind === "stdin" && value === "CAPTURE1\n"),
    false,
  );
  assert.equal(f.observer.receipt.custodyUnproven, true);
  assert.equal(f.observer.receipt.status, "unknown");
});
test("foreign isolated HOME or the old deep TEMP fails before any native transport", async () => {
  for (const override of [
    { HOME: "D:\\foreign" },
    { TEMP: win32.join(root, "private-build", "tmp") },
    { TMP: win32.join(root, "private-build", "tmp") },
    { TMPDIR: win32.join(root, "private-build", "tmp") },
  ]) {
    const f = fixture({ options: { environment: { ...environment, ...override } } });
    f.observe();
    await f.observer.completed;
    await f.observer.finish();
    assert.equal(f.calls.length, 0);
    assert.equal(f.observer.receipt.status, "unknown");
  }
});
test("source replacement or a malformed/over-cap image never becomes observed", async () => {
  for (const mode of ["source", "width", "bytes"]) {
    const f = fixture({
      run: (_options, operation) => {
        if (mode === "source") f.files.set(script, Buffer.from("different source"));
        if (mode === "width") f.files.set(pngPath, png(2, 1));
        if (mode === "bytes")
          f.files.set(pngPath, Buffer.alloc(DESKTOP_OBSERVATION_LIMITS.pngBytes + 1));
        return operation;
      },
    });
    f.observe();
    await f.observer.completed;
    await f.observer.finish();
    assert.equal(f.observer.receipt.status, "unknown", mode);
    assert.equal(f.observer.receipt.png, null);
  }
});
test("PNG CRC known vector and a complete tiny PNG use independent fixture construction", () => {
  assert.equal(desktopPngCrc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(fixtureCrc(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(png().readUInt32BE(29), 0x1f15c489);
  assert.deepEqual(validateDesktopPng(png()), {
    width: 1,
    height: 1,
    chunks: 3,
    validation: "PNG container lengths/CRC/IHDR/IDAT/IEND; pixel data not decoded",
  });
});
test("PNG malformed lengths/CRC/missing data/end/trailing/critical chunks remain unknown", async () => {
  const good = png(),
    brokenCrc = Buffer.from(good);
  brokenCrc[29] ^= 1;
  const malformed = [
    good.subarray(0, 33),
    good.subarray(0, -1),
    Buffer.concat([good, Buffer.from([0])]),
    brokenCrc,
    Buffer.concat([good.subarray(0, 33), good.subarray(-12)]),
    good.subarray(0, -12),
    Buffer.concat([good.subarray(0, 33), good.subarray(8)]),
    Buffer.concat([good.subarray(0, -12), chunk("ABCD", Buffer.alloc(0)), good.subarray(-12)]),
    Buffer.concat([good.subarray(0, 33), chunk("IDAT", Buffer.alloc(0)), good.subarray(-12)]),
  ];
  for (const bytes of malformed) {
    assert.throws(() => validateDesktopPng(bytes), /PNG/);
    const f = fixture();
    f.files.set(pngPath, bytes);
    f.observe();
    await f.observer.completed;
    await f.observer.finish();
    assert.equal(f.observer.receipt.status, "unknown");
    assert.equal(f.observer.receipt.png, null);
  }
});
test("normal collector exit with an unknown capture outcome proves no absent dialog", async () => {
  const f = fixture();
  f.files.set(
    win32.join(directory, "desktop-capture.stdout.log"),
    Buffer.from('{"status":"unknown","reason":"capture-failed"}'),
  );
  f.observe();
  await f.observer.completed;
  await f.observer.finish();
  assert.equal(f.observer.receipt.status, "unknown");
  assert.equal(f.observer.receipt.custodyUnproven, false);
});
test("failed collector custody stays independent and disqualifies diagnostic cleanliness", async () => {
  const f = fixture({
    run: (options, operation) => {
      operation.status = "failed";
      operation.settlement = { status: "unproven" };
      options.report.unprovenProcess = true;
      throw Error("collector failure");
    },
  });
  f.observe();
  await f.observer.completed;
  await f.observer.finish();
  assert.equal(f.observer.receipt.custodyUnproven, true);
  assert.equal(f.observer.receipt.status, "unknown");
  assert.equal(f.observer.receipt.collector.processes.length, 1);
});
test("finish requests collector-only cleanup after Setup's caller returns, with a soft settle cap", async () => {
  const waiting = deferred();
  const f = fixture({
    run: async (_options, operation) => {
      await waiting.promise;
      return operation;
    },
  });
  f.observe();
  await f.started.promise;
  const finishing = f.observer.finish();
  assert.equal(
    f.events.some(([kind]) => kind === "terminate"),
    true,
  );
  assert.equal(f.timers[0].ms, 20_000);
  f.timers[0].callback();
  await finishing;
  assert.equal(f.observer.receipt.custodyUnproven, true);
  const frozen = JSON.stringify(f.observer.receipt);
  waiting.resolve();
  await f.observer.completed;
  assert.equal(JSON.stringify(f.observer.receipt), frozen);
});
test("recording failure is explicit and never replaces Setup's error or retries a write", async () => {
  let writes = 0;
  const f = fixture({
    io: {
      writeFile: async () => {
        writes += 1;
        throw Error("exists");
      },
    },
  });
  await f.observer.finish();
  await f.observer.finish();
  assert.equal(writes, 1);
  assert.equal(f.observer.receipt.recordingFailed, true);
  assert.equal(f.observer.receipt.reason, "observation-recording-failed");
});
test("finishing before asynchronous preparation ends prevents a late native launch", async () => {
  const f = fixture();
  f.observe();
  await f.observer.finish();
  await f.observer.completed;
  assert.equal(f.calls.filter(([kind]) => kind === "run").length, 0);
  assert.equal(f.observer.receipt.status, "unknown");
});
