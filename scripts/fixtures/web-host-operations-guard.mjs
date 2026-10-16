/** Test-only pre-Core confinement and controlled faults on this owned Host. */
import assert from "node:assert/strict";
import { appendFileSync, realpathSync } from "node:fs";
import http, { request as namedRequest } from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { installLocalNetworkGuard } from "../runtime-cost-smoke-isolation.mjs";

const home = process.env.HOME;
const origin = process.env.CODESHELL_COST_SMOKE_ORIGIN;
assert.equal(realpathSync(home), home);
assert.equal(homedir(), home);
assert.equal(process.env.USERPROFILE, home);
assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
assert.equal(process.env.CODE_SHELL_TEST_HOME, process.env.CODE_SHELL_HOME);
const log = process.env.CODESHELL_WEB_HOST_RECEIPTS;
const inside = relative(home, log);
assert(inside && !inside.startsWith("..") && !isAbsolute(inside));
installLocalNetworkGuard(origin);
let negativeProbes = 0;
for (const probe of [
  () => fetch("https://example.invalid/denied"),
  () => fetch("http://127.0.0.1:9/denied"),
  () => http.request("http://localhost:9/denied"),
  () => namedRequest("https://example.invalid/denied"),
  () => http.get("http://127.0.0.1:9/denied"),
  () => https.request("https://example.invalid/denied"),
  () => https.get("https://example.invalid/denied"),
]) {
  assert.throws(probe, /refused a non-fixture request/);
  negativeProbes++;
}
const receipt = (value) =>
  appendFileSync(log, JSON.stringify({ pid: process.pid, ppid: process.ppid, ...value }) + "\n", {
    mode: 0o600,
  });
receipt({ kind: "pre-core-network-guard", origin, negativeProbes, entry: process.argv[1] });

// Only the native Host has this private parent IPC channel. Its stdio Worker
// inherits the same network guard, but never receives transport fault commands.
if (process.send) {
  const sockets = new Set();
  let holdUpload = false;
  let blockReconnect = false;
  const held = [];
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, ...args) {
    if (event === "upgrade" && new URL(args[0].url, "http://owned.invalid").pathname === "/ws") {
      const socket = args[1];
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      if (blockReconnect) {
        socket.destroy();
        return true;
      }
      receipt({ kind: "owned-websocket-upgrade" });
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  const end = http.ServerResponse.prototype.end;
  http.ServerResponse.prototype.end = function (...args) {
    if (
      holdUpload &&
      this.statusCode === 201 &&
      /^\/api\/v1\/uploads\//.test(this.req?.url ?? "")
    ) {
      holdUpload = false;
      held.push(() => Reflect.apply(end, this, args));
      receipt({ kind: "actual-upload-response-held", status: this.statusCode });
      process.send({ kind: "upload-held" });
      return this;
    }
    return Reflect.apply(end, this, args);
  };
  syncBuiltinESMExports();
  process.on("message", (message) => {
    if (message?.nonce !== process.env.CODESHELL_WEB_HOST_CONTROL) return;
    const { id, action } = message;
    if (action === "shutdown-host") {
      if (!process.emit("SIGTERM")) process.exit(0);
      return;
    }
    if (action === "hold-next-upload") holdUpload = true;
    else if (action === "release-upload") for (const release of held.splice(0)) release();
    else if (action === "drop-websockets") {
      blockReconnect = true;
      const count = sockets.size;
      for (const socket of sockets) socket.destroy();
      receipt({ kind: "owned-websockets-dropped", count });
      process.send({ id, result: { count } });
      return;
    } else if (action === "allow-reconnect") blockReconnect = false;
    else throw new Error("Unknown owned Host control action");
    process.send({ id, result: { ok: true } });
  });
}
