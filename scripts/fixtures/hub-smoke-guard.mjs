/** Install the same exact-origin guard in the native Hub and every Node worker. */
import assert from "node:assert/strict";
import { appendFileSync, realpathSync } from "node:fs";
import http, { request } from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { installLocalNetworkGuard } from "../runtime-cost-smoke-isolation.mjs";

const origin = process.env.CODESHELL_COST_SMOKE_ORIGIN;
const home = process.env.HOME;
assert.equal(realpathSync(home), home);
assert.equal(homedir(), home);
assert.equal(process.env.USERPROFILE, home);
assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
assert.equal(process.env.CODE_SHELL_TEST_HOME, process.env.CODE_SHELL_HOME);
installLocalNetworkGuard(origin);
for (const probe of [
  () => fetch("https://example.invalid/denied"),
  () => fetch("http://127.0.0.1:9/denied"),
  () => http.request("http://localhost:9/denied"),
  () => request("https://example.invalid/denied"),
  () => https.get("https://example.invalid/denied"),
]) {
  assert.throws(probe, /refused a non-fixture request/);
}
appendFileSync(
  join(home, "hub-smoke-guards.jsonl"),
  JSON.stringify({ pid: process.pid, ppid: process.ppid, origin, entry: process.argv[1] }) + "\n",
  { mode: 0o600 },
);

// Windows cannot deliver POSIX SIGTERM. Exercise the CLI's registered handler
// over the owned IPC channel there; ordinary Unix runs send the actual signal.
if (process.platform === "win32" && process.send) {
  process.on("message", (message) => {
    if (
      message?.action === "hub-smoke-shutdown" &&
      message.nonce === process.env.CODESHELL_HUB_SMOKE_CONTROL
    ) {
      assert.equal(process.emit("SIGTERM"), true, "CLI shutdown handler must be installed");
    }
  });
}
