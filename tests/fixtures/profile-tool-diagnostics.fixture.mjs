import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = realpathSync(process.env.CODESHELL_PROFILE_TOOL_EVIDENCE);
const root = realpathSync(process.env.CODESHELL_PROFILE_TOOL_ROOT);
const home = realpathSync(process.env.HOME);
const homeSha256 = createHash("sha256").update(home).digest("hex");
const persist = (name, value) =>
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
assert.equal(process.versions.bun, undefined);
const [major, minor] = process.versions.node.split(".").map(Number);
assert.ok(major > 20 || (major === 20 && minor >= 10));
assert.equal(realpathSync(process.execPath), process.env.CODESHELL_PROFILE_TOOL_NODE);
assert.equal(homedir(), home);
assert.equal(process.env.USERPROFILE, home);
assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
assert.equal(process.env.CODE_SHELL_TEST_HOME, join(home, ".code-shell"));
assert.equal(process.env.CODE_SHELL_DATA_ROOT, undefined);
assert.equal(process.env.PATH, join(directory, "bin"));
assert.equal(process.env.NODE_ENV, "test");
assert.ok(home.startsWith(directory + "/"));
assert.equal(
  Object.keys(process.env).some((name) =>
    /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PROVIDER_KEY|^(?:HTTPS?|ALL)_PROXY$)/i.test(name),
  ),
  false,
);

// JS HTTP surfaces only; this is not raw-net or OS process confinement.
let denied = 0;
const deny = () => {
  denied++;
  throw new Error("Profile tool fixture denies all HTTP");
};
globalThis.fetch = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;

// Observe the exact production call once, returning its unchanged result or
// rethrowing the unchanged error. No timeout, arguments, or process result is
// injected by this observer.
const actualSpawnSync = childProcess.spawnSync;
const physicalProbes = [];
childProcess.spawnSync = function (...args) {
  const started = performance.now();
  const receipt = { command: args[0], args: args[1], timeout: args[2]?.timeout };
  try {
    const result = Reflect.apply(actualSpawnSync, this, args);
    Object.assign(receipt, {
      pid: result.pid,
      status: result.status,
      signal: result.signal,
      errorCode: result.error?.code ?? null,
      elapsedMs: performance.now() - started,
      outputSha256: createHash("sha256")
        .update(String(result.stdout ?? "") + String(result.stderr ?? ""))
        .digest("hex"),
    });
    physicalProbes.push(receipt);
    return result;
  } catch (error) {
    physicalProbes.push({
      ...receipt,
      elapsedMs: performance.now() - started,
      thrown: { name: error.name, code: error.code ?? null },
    });
    throw error;
  }
};
syncBuiltinESMExports();
const { request: namedHttpRequest } = await import("node:http");
const { get: namedHttpsGet } = await import("node:https");
assert.equal(namedHttpRequest, deny);
assert.equal(namedHttpsGet, deny);
for (const probe of [
  () => fetch("http://127.0.0.1:9/probe"),
  () => fetch("https://127.0.0.1:9/probe"),
  () => http.request("http://127.0.0.1:9/probe"),
  () => namedHttpRequest("http://127.0.0.1:9/probe"),
  () => http.get("http://127.0.0.1:9/probe"),
  () => https.request("https://127.0.0.1:9/probe"),
  () => https.get("https://127.0.0.1:9/probe"),
  () => namedHttpsGet("https://127.0.0.1:9/probe"),
]) {
  assert.throws(probe, /denies all HTTP/);
}
assert.equal(denied, 8);
persist("before-core.json", {
  phase: "before-first-Core-import",
  pid: process.pid,
  ppid: process.ppid,
  node: process.versions.node,
  execPath: realpathSync(process.execPath),
  homeSha256,
  negativeProbes: denied,
  privateHome: true,
  credentialsAbsent: true,
  guardScope: "fetch and Node http/https request/get; no raw-net or OS sandbox claim",
});
denied = 0;
const coreEntries = ["@cjhyy/code-shell-core", "@cjhyy/code-shell-core/internal"].map(
  (specifier) => {
    const path = realpathSync(fileURLToPath(import.meta.resolve(specifier)));
    const expected = join(
      root,
      "packages/core/dist",
      specifier.endsWith("/internal") ? "index.internal.js" : "index.js",
    );
    assert.equal(path, realpathSync(expected));
    return {
      specifier,
      path,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  },
);
persist("resolved-core.json", coreEntries);
const { previewProfileRequirements, saveProfile } = await import(
  pathToFileURL(process.env.CODESHELL_PROFILE_TOOL_BUNDLE).href
);
assert.equal(physicalProbes.length, 0);
const receipts = [];
function register(index, name, script, inspect, mode = 0o755) {
  test(name, { timeout: 20_000 }, () => {
    const bin = "profile-probe-" + index;
    const cwd = join(home, "workspace-" + index);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "bin", bin), ["#!/bin/sh", script, ""].join("\n"), { mode });
    const profileName = "probe-profile-" + index;
    saveProfile({
      name: profileName,
      label: "Synthetic local probe",
      basePreset: "general",
      plugins: [],
      skills: [],
      mcp: [],
      agents: [],
      portableMemory: false,
      requires: {
        skills: [],
        tools: [{ bin, minVersion: "22", hint: "Check the local CLI installation" }],
      },
    });
    const before = physicalProbes.length;
    const receipt = { name, pid: process.pid, homeSha256, outcome: "failed" };
    try {
      const preview = previewProfileRequirements(profileName, cwd);
      const probes = physicalProbes.slice(before);
      Object.assign(receipt, { preview, probes });
      assert.equal(probes.length, 1);
      assert.equal(probes[0].command, bin);
      assert.deepEqual(probes[0].args, ["--version"]);
      assert.equal(probes[0].timeout, 10_000);
      assert.equal(preview.needsInstall, false);
      assert.deepEqual(preview.willRun, []);
      inspect(preview, probes[0]);
      assert.equal(denied, 0);
      receipt.outcome = "passed";
    } catch (error) {
      receipt.error = { name: error.name, message: error.message };
      throw error;
    } finally {
      receipt.unexpectedDenials = denied;
      receipts.push(receipt);
      persist("case-" + index + ".json", receipt);
    }
  });
}

function assertFailedProbe(preview) {
  assert.equal(preview.blockers.length, 1);
  assert.match(preview.blockers[0], /探测失败/);
  assert.match(preview.blockers[0], /Check the local CLI installation/);
  assert.doesNotMatch(preview.blockers[0], /99\.0\.0|版本过低/);
}
register(
  0,
  "does not treat a failed CLI's high-version stderr as satisfying the minimum",
  "printf '%s' 'requires version 99.0.0' >&2\nexit 7",
  (preview, probe) => {
    assert.equal(probe.status, 7);
    assert.equal(probe.errorCode, null);
    assert.ok(probe.pid > 0);
    assertFailedProbe(preview);
  },
);
register(
  1,
  "reports successful CLI output without a version as unconfirmed",
  "printf '%s' 'development build'",
  (preview, probe) => {
    assert.equal(probe.status, 0);
    assert.ok(probe.pid > 0);
    assert.equal(preview.blockers.length, 1);
    assert.match(preview.blockers[0], /无法确认/);
    assert.match(preview.blockers[0], /≥22/);
    assert.doesNotMatch(preview.blockers[0], /版本过低/);
  },
);
register(
  2,
  "preserves low-version diagnostics from a successful CLI",
  "printf '%s' 'v20.1.0'",
  (preview, probe) => {
    assert.equal(probe.status, 0);
    assert.ok(probe.pid > 0);
    assert.equal(preview.blockers.length, 1);
    assert.match(preview.blockers[0], /版本过低/);
    assert.match(preview.blockers[0], /20\.1\.0/);
    assert.match(preview.blockers[0], /≥22/);
  },
);
register(
  3,
  "accepts a successful CLI that meets the minimum",
  "printf '%s' 'v25.8.1'",
  (preview, probe) => {
    assert.equal(probe.status, 0);
    assert.ok(probe.pid > 0);
    assert.deepEqual(preview.blockers, []);
  },
);
register(
  4,
  "reports an actual startup failure rather than a missing command",
  "printf '%s' 'v99.0.0'",
  (preview, probe) => {
    assert.equal(probe.errorCode, "EACCES");
    assertFailedProbe(preview);
    assert.doesNotMatch(preview.blockers[0], /缺少外部命令/);
  },
  0o600,
);
register(
  5,
  "reports the real ten-second probe timeout without trusting earlier output",
  // exec replaces this exact owned probe PID; no sleep descendant survives.
  "printf '%s' 'v99.0.0'\nexec /bin/sleep 30",
  (preview, probe) => {
    assert.equal(probe.errorCode, "ETIMEDOUT");
    assert.ok(probe.pid > 0);
    assert.ok(probe.elapsedMs >= 9_000);
    assertFailedProbe(preview);
  },
);
after(() => {
  persist("completion.json", {
    pid: process.pid,
    ppid: process.ppid,
    node: process.versions.node,
    homeSha256,
    tests: receipts.length,
    passed: receipts.filter((receipt) => receipt.outcome === "passed").length,
    failed: receipts.filter((receipt) => receipt.outcome !== "passed").length,
    names: receipts.map((receipt) => receipt.name),
    unexpectedDenials: denied,
  });
});
