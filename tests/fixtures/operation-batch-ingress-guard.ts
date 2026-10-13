import { afterAll, mock } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.HOME!;
assert.equal(realpathSync(home), home);
assert.equal(homedir(), home);
assert.equal(process.env.USERPROFILE, home);
assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
assert.equal(process.env.CODE_SHELL_TEST_HOME, process.env.CODE_SHELL_HOME);
assert.equal(process.env.CODE_SHELL_DATA_ROOT, undefined);
const file = join(home, "batch-ingress-guard.json");
let probing = true;
let probes = 0;
let unexpected = 0;
const deny = () => {
  if (probing) probes++;
  else unexpected++;
  throw new Error("Batch ingress denied network transport");
};
const originals = [{ ...(await import("node:http")) }, { ...(await import("node:https")) }];
globalThis.fetch = deny as typeof fetch;
for (const module of [http, https]) {
  module.request = deny as typeof module.request;
  module.get = deny as typeof module.get;
}
mock.module("node:http", () => ({
  ...originals[0],
  default: http,
  request: http.request,
  get: http.get,
}));
mock.module("node:https", () => ({
  ...originals[1],
  default: https,
  request: https.request,
  get: https.get,
}));
const namedHttp = await import("node:http");
const namedHttps = await import("node:https");
for (const probe of [
  () => fetch("https://example.invalid"),
  () => http.request("http://127.0.0.1:1"),
  () => http.get("http://127.0.0.1:1"),
  () => https.request("https://example.invalid"),
  () => namedHttp.request("http://127.0.0.1:1"),
  () => namedHttp.get("http://127.0.0.1:1"),
  () => namedHttps.request("https://example.invalid"),
  () => namedHttps.get("https://example.invalid"),
])
  assert.throws(probe, /Batch ingress denied/);
probing = false;
const receipt = {
  phase: "before-Core-import",
  pid: process.pid,
  ppid: process.ppid,
  runtime: process.versions,
  homeId: createHash("sha256").update(home).digest("hex"),
  privateHome: true,
  probes,
  unexpected,
  scope:
    "JavaScript fetch and HTTP(S) request/get, including actual dynamic named exports; no raw-net or OS confinement",
};
writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
console.log(`Batch ingress preimport receipt: ${file}`);
afterAll(() => {
  writeFileSync(
    join(home, "batch-ingress-guard-final.json"),
    JSON.stringify({ ...receipt, phase: "after-tests", unexpected }),
    { mode: 0o600 },
  );
  assert.equal(unexpected, 0);
});
