// Bundled as a private synchronous CJS --require. Never written into the app.
/* global require */
import children from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import threads from "node:worker_threads";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { installLocalNetworkGuard } from "../../../scripts/runtime-cost-smoke-isolation.mjs";
import { installPackagedChromiumGuard } from "./packaged-chromium-guard.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const root = realpathSync(process.env.CODESHELL_OFFICIAL_FIXTURE_ROOT);
const home = realpathSync(process.env.HOME);
const within = relative(root, home);
if (!within || within.startsWith("..") || isAbsolute(within))
  throw Error("packaged fixture HOME escaped private root");
if (
  process.env.USERPROFILE !== home ||
  process.env.CODE_SHELL_HOME !== join(home, ".code-shell") ||
  process.env.CODE_SHELL_TEST_HOME !== process.env.CODE_SHELL_HOME ||
  process.env.CODE_SHELL_DATA_ROOT !== undefined
)
  throw Error("packaged fixture Host storage identity mismatch");
const origin = process.env.CODESHELL_COST_SMOKE_ORIGIN;
installLocalNetworkGuard(origin);
const probes = [
  () => fetch("https://packaged-pet-negative.invalid/"),
  () => http.request("http://packaged-pet-negative.invalid/"),
  () => http.get("http://packaged-pet-negative.invalid/"),
  () => https.request("https://packaged-pet-negative.invalid/"),
  () => https.get("https://packaged-pet-negative.invalid/"),
  () =>
    http.request(origin, {
      createConnection() {
        throw Error("unexpected transport");
      },
    }),
  () => fetch(origin, { dispatcher: {} }),
];
for (const probe of probes) {
  let rejected = false;
  try {
    probe();
  } catch (error) {
    rejected = /Cost smoke refused/.test(String(error));
  }
  if (!rejected) throw Error("packaged fixture preimport network probe was allowed");
}
const role = process.argv.some((argument) => argument.includes("agent-server-stdio"))
  ? "worker"
  : process.type === "utility"
    ? "Host"
    : process.versions.electron
      ? "Main"
      : "auxiliary";
if (
  role === "worker" &&
  (realpathSync(process.execPath) !== process.env.CODESHELL_OFFICIAL_WORKER_EXECUTABLE ||
    process.env.ELECTRON_RUN_AS_NODE !== "1" ||
    (process.env.CODESHELL_OFFICIAL_WORKER_ELECTRON_VERSION &&
      process.versions.electron !== process.env.CODESHELL_OFFICIAL_WORKER_ELECTRON_VERSION))
)
  throw Error("packaged worker did not use the approved official Node-mode executable");
appendFileSync(
  process.env.CODESHELL_COST_SMOKE_GUARD_LOG,
  JSON.stringify({
    schemaVersion: 1,
    role,
    pid: process.pid,
    ppid: process.ppid,
    homeId: hash(home),
    origin,
    negativeProbes: probes.length,
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    executable: realpathSync(process.execPath),
    guardScope: "synchronous preimport fetch/http/https and HOME checks",
  }) + "\n",
  { mode: 0o600 },
);

const legacyMainWorker = process.env.CODESHELL_OFFICIAL_011_MAIN_WORKER === "1";
let workerSpawnCount = 0;
if (role === "Main") {
  // The actual supplied Electron executable loads its own packaged entry.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- This source is bundled as a synchronous CJS preload, also tested under plain Node.
  const { app, safeStorage, utilityProcess } = require("electron");
  if (legacyMainWorker && !app.getVersion().startsWith("0.11."))
    throw Error("Expected the 0.11 direct worker parent");
  // Only Main is intentionally paused for guard installation. A worker that
  // inherits --inspect-brk waits forever for a second debugger, including
  // while quit waits for the transcript cache to flush.
  const Worker = threads.Worker;
  threads.Worker = class extends Worker {
    constructor(entry, options = {}) {
      super(entry, {
        ...options,
        execArgv: (options.execArgv ?? process.execArgv).filter(
          (flag) => !/^--inspect(?:-brk|-wait)?(?:=|$)/.test(flag),
        ),
      });
    }
  };
  syncBuiltinESMExports();
  const fork = utilityProcess.fork;
  let hostSpawnCount = 0;
  utilityProcess.fork = function (entry, args, options) {
    if (entry !== join(app.getAppPath(), "out", "main", "desktop-host.mjs"))
      return fork.call(this, entry, args, options);
    const host = fork.call(this, process.env.CODESHELL_OFFICIAL_HOST_WRAPPER, args, {
      ...options,
      env: {
        ...process.env,
        ...options?.env,
        CODESHELL_OFFICIAL_HOST_ENTRY: entry,
        CODESHELL_OFFICIAL_MAIN_PID: String(process.pid),
      },
    });
    host.once("spawn", () => {
      hostSpawnCount++;
      appendFileSync(
        join(home, "spawned-hosts.jsonl"),
        JSON.stringify({ pid: host.pid, ppid: process.pid }) + "\n",
        { mode: 0o600 },
      );
    });
    return host;
  };
  process.once("exit", (code) =>
    appendFileSync(
      join(home, "main-exits.jsonl"),
      JSON.stringify({
        pid: process.pid,
        code,
        hostSpawnCount,
        workerSpawnCount,
      }) + "\n",
      { mode: 0o600 },
    ),
  );
  if (process.env.CODESHELL_OFFICIAL_MOCK_KEYCHAIN === "1") {
    // The cold-start benchmark and its private profile never bind the operator's Keychain.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Install before the first app instruction.
    require(join(home, "packaged-mock-keychain.cjs"));
  } else {
    app.setName("code-shell");
    app.commandLine.removeSwitch("password-store");
    app.commandLine.removeSwitch("use-mock-keychain");
    if (process.platform === "linux")
      app.commandLine.appendSwitch("password-store", "gnome-libsecret");
  }
  app.commandLine.appendSwitch("disable-background-networking");
  app.setPath("userData", process.env.CODESHELL_OFFICIAL_USER_DATA);
  installPackagedChromiumGuard(app, origin);
  for (const name of ["isEncryptionAvailable", "encryptString", "decryptString"]) {
    const original = safeStorage[name];
    safeStorage[name] = (...args) => {
      appendFileSync(
        join(home, "native-storage.jsonl"),
        JSON.stringify({ pid: process.pid, name, phase: "enter" }) + "\n",
      );
      try {
        const result = original(...args);
        appendFileSync(
          join(home, "native-storage.jsonl"),
          JSON.stringify({ pid: process.pid, name, phase: "return" }) + "\n",
        );
        return result;
      } catch (error) {
        appendFileSync(
          join(home, "native-storage.jsonl"),
          JSON.stringify({ pid: process.pid, name, phase: "throw" }) + "\n",
        );
        throw error;
      }
    };
  }
}
if (role === "Host" || (legacyMainWorker && role === "Main")) {
  const spawn = children.spawn;
  if (role === "Host")
    process.once("exit", (code) => {
      appendFileSync(
        join(home, "host-exits.jsonl"),
        JSON.stringify({ pid: process.pid, ppid: process.ppid, code, workerSpawnCount }) + "\n",
        { mode: 0o600 },
      );
    });
  children.spawn = function (command, args, options) {
    const worker = args?.some((argument) => argument.includes("agent-server-stdio"));
    if (worker) {
      if (
        realpathSync(command) !== process.env.CODESHELL_OFFICIAL_WORKER_EXECUTABLE ||
        options?.env?.ELECTRON_RUN_AS_NODE !== "1" ||
        options?.env?.HOME !== home
      )
        throw Error(
          "packaged worker launch escaped its official Node-mode executable/private HOME",
        );
      args = ["--require", process.env.CODESHELL_OFFICIAL_BOOTSTRAP, ...args];
      options = {
        ...options,
        env: {
          ...options.env,
          CODESHELL_OFFICIAL_WORKER_ELECTRON_VERSION: process.versions.electron,
          NODE_OPTIONS: `--require ${process.env.CODESHELL_OFFICIAL_BOOTSTRAP}`,
        },
      };
    }
    const child = spawn.call(this, command, args, options);
    if (worker && child.pid) {
      workerSpawnCount++;
      child.stdin.cork();
      const timer = setInterval(() => {
        if (existsSync(join(home, `worker-${child.pid}.permit`))) {
          clearInterval(timer);
          child.stdin.uncork();
        }
      }, 10);
      timer.unref();
      child.once("exit", (code, signal) => {
        clearInterval(timer);
        appendFileSync(
          join(home, "worker-exits.jsonl"),
          JSON.stringify({ pid: child.pid, code, signal }) + "\n",
          { mode: 0o600 },
        );
      });
      appendFileSync(
        join(home, "spawned-workers.jsonl"),
        JSON.stringify({
          pid: child.pid,
          ppid: process.pid,
          mainPid: legacyMainWorker ? process.pid : Number(process.env.CODESHELL_OFFICIAL_MAIN_PID),
          command: realpathSync(command),
          args: args.filter((argument) => argument.includes("agent-server-stdio")),
        }) + "\n",
        { mode: 0o600 },
      );
    }
    return child;
  };
  syncBuiltinESMExports();
}
