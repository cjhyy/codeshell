/* Exact-origin synthetic HTTP confinement, proved before Core in every process. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import http, { request as namedRequest } from "node:http";
import https from "node:https";
import children from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
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
// This is a test Host child-launch allowlist, not a claim that JavaScript
// guards provide OS isolation. It prevents first-run git/provider CLI network
// from bypassing the exact HTTP guards before Main or its worker imports Core.
const runtime = process.env.CODESHELL_OPERATION_HOOK_HOST
  ? JSON.parse(process.env.CODESHELL_OPERATION_HOOK_HOST).runtime
  : undefined;
const allowedChildren = new Set([
  realpathSync(process.execPath),
  "/usr/bin/security",
  ...(runtime ? [runtime.executable] : []),
]);
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const original = children[name];
  children[name] = function (command, ...args) {
    const query = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
    if (
      (command === "git" || command === "/usr/bin/git") &&
      JSON.stringify(args[0]) === JSON.stringify(query) &&
      typeof args[1]?.cwd === "string" &&
      args[1].cwd.startsWith(home + "/")
    ) {
      // The real Main owner authority asks this fixed local non-network query.
      // Use a fixed system executable and private, non-interactive Git config.
      return original.call(
        this,
        "/usr/bin/git",
        args[0],
        {
          ...args[1],
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0",
          },
        },
        ...args.slice(2),
      );
    }
    if (!allowedChildren.has(command)) {
      appendFileSync(
        join(home, "operation-read-child-denied.jsonl"),
        JSON.stringify({ pid: process.pid, api: name, command }) + "\n",
        { mode: 0o600 },
      );
      throw new Error("Operation read fixture refused external child");
    }
    return original.call(this, command, ...args);
  };
}
for (const name of ["exec", "execSync"])
  children[name] = function () {
    throw new Error("Operation read fixture refused shell child");
  };
syncBuiltinESMExports();
for (const probe of [
  () => children.spawn("git", ["clone", "https://example.invalid/blocked"]),
  () => children.execFile("curl", ["https://example.invalid/blocked"]),
  () => children.exec("curl https://example.invalid/blocked"),
])
  assert.throws(probe, /Operation read fixture refused/);
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
    childLaunchAllowlist: [...allowedChildren],
    childNegativeProbes: 3,
    version: process.version,
    executable: realpathSync(process.execPath),
    executableSha256: createHash("sha256")
      .update(readFileSync(realpathSync(process.execPath)))
      .digest("hex"),
    source: JSON.parse(readFileSync(join(home, "operation-read-source.json"), "utf8")),
  }) + "\n",
  { mode: 0o600 },
);
