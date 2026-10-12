// Bundled as a private synchronous CJS --require. Never written into the app.
/* global require */
import children from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { installLocalNetworkGuard } from "../../../scripts/runtime-cost-smoke-isolation.mjs";

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

if (role === "Main") {
  // The actual signed Electron executable loads its own packaged entry.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- This source is bundled as a synchronous CJS preload, also tested under plain Node.
  const { app, safeStorage } = require("electron");
  app.setName("code-shell");
  app.commandLine.removeSwitch("password-store");
  app.commandLine.removeSwitch("use-mock-keychain");
  app.commandLine.appendSwitch("disable-background-networking");
  app.setPath("userData", process.env.CODESHELL_OFFICIAL_USER_DATA);
  const seenSessions = new WeakSet();
  app.on("web-contents-created", (_event, contents) => {
    const session = contents.session;
    if (seenSessions.has(session)) return;
    seenSessions.add(session);
    session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      const url = new URL(details.url);
      const allowed =
        ["file:", "data:", "blob:", "devtools:"].includes(url.protocol) ||
        url.protocol === "codeshell-panel:" ||
        url.origin === origin;
      callback({ cancel: !allowed });
    });
  });
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
  const spawn = children.spawn;
  children.spawn = function (command, args, options) {
    const worker = args?.some((argument) => argument.includes("agent-server-stdio"));
    if (worker) {
      if (
        realpathSync(command) !== realpathSync(process.execPath) ||
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
