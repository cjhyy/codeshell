import assert from "node:assert/strict";
import http, { request } from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  installLocalNetworkGuard,
  confinedWorkerEnvironment,
} from "./runtime-cost-smoke-isolation.mjs";

const fixtureUserHome = mkdtempSync(join(tmpdir(), "codeshell-cost-isolation-only-"));
let allowedCalls = 0,
  deniedCalls = 0;
const denied = http.createServer((_req, res) => {
  deniedCalls++;
  res.end("must not arrive");
});
await new Promise((resolve) => denied.listen(0, "127.0.0.1", resolve));
const deniedOrigin = `http://127.0.0.1:${denied.address().port}`;
const allowed = http.createServer((req, res) => {
  allowedCalls++;
  if (req.url === "/redirect") {
    res.writeHead(302, { location: deniedOrigin });
    res.end();
  } else res.end("fixture");
});
await new Promise((resolve) => allowed.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${allowed.address().port}`;
const preload = new URL("./runtime-cost-smoke-isolation.mjs", import.meta.url).href;
const environment = confinedWorkerEnvironment(
  { ...process.env, HTTPS_PROXY: deniedOrigin },
  fixtureUserHome,
  origin,
  preload,
);
environment.CODESHELL_COST_SMOKE_GUARD_LOG = join(fixtureUserHome, "guard-receipts.jsonl");
const nestedCode = `
import assert from "node:assert/strict";
import http, { request } from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
const origin = process.env.CODESHELL_COST_SMOKE_ORIGIN;
const denied = ${JSON.stringify(deniedOrigin)};
assert.equal(globalThis[Symbol.for("codeshell.cost-smoke.network-guard")], origin);
assert.equal(existsSync(join(process.env.HOME, ".code-shell", "settings.json")), false);
assert.equal(process.env.HTTPS_PROXY, undefined);
assert.equal(await (await fetch(origin)).text(), "fixture");
assert.throws(() => fetch(denied), /non-fixture/);
assert.throws(() => http.request(denied), /non-fixture/);
assert.throws(() => request(new URL(denied)), /non-fixture/);
assert.throws(() => https.get("https://127.0.0.1:443"), /non-fixture/);
assert.throws(() => http.request(origin, {hostname:"localhost"}), /non-fixture/);
await assert.rejects(fetch(origin + "/redirect"));
if (process.argv[1] !== "grandchild") {
 const child = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify("PLACEHOLDER")}, "grandchild"], {env:process.env, stdio:["pipe","pipe","pipe"]});
 let output="", errors=""; child.stdout.on("data", v=>output+=v); child.stderr.on("data", v=>errors+=v); child.stdin.end("inherited guard probe\\n");
 const [code] = await once(child,"exit"); assert.equal(code,0,errors); assert.match(output,/grandchild guard active/);
} else console.log("grandchild guard active");
console.log("stdio child guard active");
`;
// Embed the non-recursive branch as a separate grandchild program.
const grandchildCode = nestedCode.replace(
  /if \(process.argv\[1\] !== "grandchild"\) \{[\s\S]*?\} else console.log\("grandchild guard active"\);/,
  'console.log("grandchild guard active");',
);
const childCode = nestedCode.replace(JSON.stringify("PLACEHOLDER"), JSON.stringify(grandchildCode));
try {
  assert.equal(existsSync(join(fixtureUserHome, ".code-shell", "settings.json")), false);
  installLocalNetworkGuard(origin);
  assert.equal(await (await fetch(origin)).text(), "fixture");
  assert.throws(() => fetch(deniedOrigin), /non-fixture/);
  assert.throws(() => request(deniedOrigin), /non-fixture/);
  assert.throws(() => https.request("https://127.0.0.1:443"), /non-fixture/);
  await assert.rejects(fetch(origin + "/redirect"));
  await new Promise((resolve, reject) =>
    request(origin, (res) => {
      res.resume();
      res.on("end", resolve);
    })
      .on("error", reject)
      .end(),
  );
  const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "",
    errors = "";
  child.stdout.on("data", (v) => (output += v));
  child.stderr.on("data", (v) => (errors += v));
  child.stdin.end("stdio guard probe\n");
  const [code] = await once(child, "exit");
  assert.equal(code, 0, errors);
  assert.match(output, /stdio child guard active/);
  const guardReceipts = readFileSync(environment.CODESHELL_COST_SMOKE_GUARD_LOG, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(guardReceipts.length, 2);
  assert.equal(new Set(guardReceipts.map((receipt) => receipt.homeId)).size, 1);
  assert.equal(guardReceipts[1].ppid, guardReceipts[0].pid);
  assert.equal(deniedCalls, 0);
  assert.equal(allowedCalls, 7);
  console.log(
    JSON.stringify({
      fetch: "confined; redirects rejected",
      http: "confined including named imports",
      https: "rejected",
      nestedStdio: "child and grandchild preload active",
      childHome: "fresh, no real settings",
      proxies: "removed",
      deniedServerRequests: deniedCalls,
      allowedServerRequests: allowedCalls,
    }),
  );
} finally {
  await Promise.all([
    new Promise((resolve) => allowed.close(resolve)),
    new Promise((resolve) => denied.close(resolve)),
  ]);
  rmSync(fixtureUserHome, { recursive: true, force: true });
}
