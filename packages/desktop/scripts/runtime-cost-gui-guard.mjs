/* Test-only pre-Core HTTP denial, including negative probes in each actual process. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, realpathSync } from "node:fs";
import http, { request as namedRequest } from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { installLocalNetworkGuard } from "../../../scripts/runtime-cost-smoke-isolation.mjs";

const origin = process.env.CODESHELL_COST_SMOKE_ORIGIN;
const home = process.env.HOME;
const homeId = (path) => createHash("sha256").update(path).digest("hex");
assert.ok(home && origin, "GUI fixture requires an explicit private HOME and exact origin");
assert.equal(realpathSync(home), home);
assert.equal(homedir(), home);
assert.equal(process.env.USERPROFILE, home);
assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
assert.equal(process.env.CODE_SHELL_TEST_HOME, process.env.CODE_SHELL_HOME);
assert.equal(process.env.CODESHELL_COST_SMOKE_HOME_ID, homeId(home));
assert.equal(process.env.CODE_SHELL_DATA_ROOT, undefined);
assert.equal(process.env.CODESHELL_COST_GUI_GUARD_LOG, join(home, "cost-gui-guard.jsonl"));
for (const key of Object.keys(process.env))
  assert.ok(!/^(https?_proxy|all_proxy|no_proxy)$/i.test(key), "Proxy environment must be absent");

installLocalNetworkGuard(origin);
// The sentinel origin identifies this fixture. Even it cannot receive model HTTP.
const deny = () => {
  throw new Error("Cost GUI fixture denies every HTTP request");
};
globalThis.fetch = deny;
for (const transport of [http, https]) {
  transport.request = deny;
  transport.get = deny;
}
syncBuiltinESMExports();
let negativeProbes = 0;
for (const probe of [
  () => fetch(`${origin}/negative-probe`),
  () => fetch("https://example.invalid/negative-probe"),
  () => http.request(origin),
  () => namedRequest(new URL(origin)),
  () => http.get(origin),
  () => https.request("https://example.invalid/negative-probe"),
  () => https.get("https://example.invalid/negative-probe"),
]) {
  assert.throws(probe, /denies every HTTP request/);
  negativeProbes++;
}
const receipt = {
  kind: "cost-gui-deny-all",
  pid: process.pid,
  ppid: process.ppid,
  origin,
  homeId: homeId(home),
  userProfileId: homeId(process.env.USERPROFILE),
  codeShellHomeId: homeId(process.env.CODE_SHELL_HOME),
  testHomeId: homeId(process.env.CODE_SHELL_TEST_HOME),
  negativeProbes,
};
appendFileSync(process.env.CODESHELL_COST_GUI_GUARD_LOG, `${JSON.stringify(receipt)}\n`, {
  mode: 0o600,
});
globalThis[Symbol.for("codeshell.cost-gui.guard")] = receipt;
