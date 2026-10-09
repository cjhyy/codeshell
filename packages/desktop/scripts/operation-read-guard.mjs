/* Exact-origin synthetic HTTP confinement, proved before Core in every process. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import http, { request as namedRequest } from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { installLocalNetworkGuard } from "../../../scripts/runtime-cost-smoke-isolation.mjs";
const home = process.env.HOME,
  origin = process.env.CODESHELL_COST_SMOKE_ORIGIN;
assert.ok(home && origin);
assert.equal(realpathSync(home), home);
assert.equal(homedir(), home);
assert.equal(process.env.USERPROFILE, home);
assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
assert.equal(process.env.CODE_SHELL_TEST_HOME, process.env.CODE_SHELL_HOME);
assert.equal(process.env.CODE_SHELL_DATA_ROOT, undefined);
const homeId = createHash("sha256").update(home).digest("hex");
assert.equal(process.env.CODESHELL_COST_SMOKE_HOME_ID, homeId);
installLocalNetworkGuard(origin);
let negativeProbes = 0;
for (const probe of [
  () => fetch("https://example.invalid/blocked"),
  () => fetch(origin, { dispatcher: {} }),
  () => http.request("http://127.0.0.1:1"),
  () => namedRequest("http://127.0.0.1:1"),
  () => http.get("http://127.0.0.1:1"),
  () => https.request("https://example.invalid/blocked"),
  () => https.get("https://example.invalid/blocked"),
  () => http.request(origin, { socketPath: "/unavailable" }),
]) {
  assert.throws(probe, /Cost smoke refused/);
  negativeProbes++;
}
appendFileSync(
  join(home, "operation-read-guard.jsonl"),
  JSON.stringify({
    pid: process.pid,
    ppid: process.ppid,
    origin,
    homeId,
    negativeProbes,
    version: process.version,
    executable: realpathSync(process.execPath),
    executableSha256: createHash("sha256")
      .update(readFileSync(realpathSync(process.execPath)))
      .digest("hex"),
    source: JSON.parse(readFileSync(join(home, "operation-read-source.json"), "utf8")),
  }) + "\n",
  { mode: 0o600 },
);
