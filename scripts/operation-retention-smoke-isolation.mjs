import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { appendFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { installLocalNetworkGuard } from "./runtime-cost-smoke-isolation.mjs";

export function installRetentionGuard(origin, receipts) {
  installLocalNetworkGuard(origin);
  let negativeProbes = 0;
  for (const probe of [
    () => fetch("https://provider.invalid/"),
    () => http.get("http://127.0.0.1:1/"),
    () => https.get("https://provider.invalid/"),
  ]) {
    assert.throws(probe, /refused a non-fixture request/);
    negativeProbes++;
  }
  assert.equal(process.env.HOME, process.env.USERPROFILE);
  assert.equal(realpathSync(process.env.HOME), process.env.HOME);
  assert.ok(process.env.CODE_SHELL_HOME.startsWith(`${process.env.HOME}/`));
  assert.equal(process.env.CODE_SHELL_TEST_HOME, process.env.CODE_SHELL_HOME);
  appendFileSync(
    receipts,
    JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      version: process.version,
      homeHash: createHash("sha256").update(process.env.HOME).digest("hex"),
      negativeProbes,
      beforeCore: true,
      origin,
      scope: "fetch/http/https exact origin; JS guard, not OS network sandbox",
    }) + "\n",
    { mode: 0o600 },
  );
}

if (process.env.CODESHELL_RETENTION_ORIGIN) {
  installRetentionGuard(
    process.env.CODESHELL_RETENTION_ORIGIN,
    process.env.CODESHELL_RETENTION_GUARD_LOG,
  );
}
