/** Real compiled Node, synthetic near-bound source and 64 explicitly granted files. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { installLocalNetworkGuard } from "./runtime-cost-smoke-isolation.mjs";
import {
  finiteBoundSettings,
  prepareFiniteHookBoundsFixture,
} from "./fixtures/finite-hook-package.mjs";

const [runtimePath, evidence, contentMode] = process.argv.slice(2);
assert.ok(runtimePath && evidence);
const runtime = JSON.parse(readFileSync(runtimePath, "utf8")),
  home = realpathSync(process.env.HOME);
assert.equal(process.env.CODE_SHELL_TEST_HOME, join(home, ".code-shell"));
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const dockerConfig = join(home, "docker-config");
mkdirSync(dockerConfig);
const docker = (...args) => {
  const result = spawnSync(
    runtime.executable,
    ["--host", runtime.endpoint, "--config", dockerConfig, ...args],
    {
      env: { PATH: "/usr/bin:/bin", HOME: home, DOCKER_CONFIG: dockerConfig },
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};
let providerReads = 0;
const server = http.createServer((_request, response) => {
  providerReads++;
  response.setHeader("content-type", "application/json");
  response.end('{"id":123,"full_name":"fixture/repo"}');
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
installLocalNetworkGuard(origin);
assert.throws(() => fetch("https://example.invalid"), /Cost smoke refused/);
assert.throws(() => http.request("http://127.0.0.1:1"), /Cost smoke refused/);
// The diagnostics are installed before compiled Core captures its fs bindings.
const {
  beginFiniteHookMetrics,
  endFiniteHookMetrics,
  instrumentFiniteSettings,
  instrumentFiniteHookHost,
} = await import("./fixtures/finite-hook-metrics.mjs");
const coreUrl = pathToFileURL(join(process.cwd(), "packages/core/dist/index.js")).href;
await instrumentFiniteSettings(coreUrl);
const { createOperationHookHost } =
  await import("../packages/core/dist/links/operation-hook-host.js");
const { createGithubOperationReader } =
  await import("../packages/core/dist/links/operation-reader.js");
const { setDefaultCredentialAccess } = await import("../packages/core/dist/credentials/access.js");
const cwd = join(home, "project"),
  settingsPath = join(cwd, ".code-shell/settings.json");
mkdirSync(join(cwd, ".code-shell"), { recursive: true });
const settingsBytes = JSON.stringify(finiteBoundSettings());
assert.ok(Buffer.byteLength(settingsBytes) > 4 * 1024 * 1024 - 8192);
assert.ok(Buffer.byteLength(settingsBytes) < 4 * 1024 * 1024);
writeFileSync(settingsPath, settingsBytes);
const installed = await prepareFiniteHookBoundsFixture({
  coreUrl,
  home,
  cwd,
  settingsScope: "project",
  settingsBytes,
  largeResources: contentMode === "--large-resources",
});
assert.equal(installed.plans.length, 1);
assert.equal(installed.plans[0].files.length, 64);
const credential = {
  id: "synthetic",
  type: "oauth",
  label: "Synthetic",
  hasSecret: true,
  oauthStatus: { state: "valid", hasRefreshToken: true, canRefresh: true },
  meta: {
    linkProvider: "github",
    linkAccountId: "42",
    linkExecutionRuntime: "server",
    linkExecutionBackend: "remote",
    linkRemoteState: "connected",
    linkRemoteGrantId: "grant",
    linkLastVerifiedAt: "2026-10-09T00:00:00Z",
    linkCapabilityIds: ["github.get_repository"],
  },
};
setDefaultCredentialAccess({
  listMasked: () => [credential],
  resolveMeta: () => credential,
  envExposures: () => ({}),
  resolveValue: async () => {
    throw new Error("No token access");
  },
  executeRemoteLinkAction: async () => (await fetch(origin)).json(),
});
const results = [];
let host, reader;
try {
  const startup = () => {
    const config = JSON.stringify({
      runtime,
      inlineCommandSha256: [],
      resourcePlans: installed.plans,
    });
    assert.ok(Buffer.byteLength(config) <= 32768);
    return instrumentFiniteHookHost(createOperationHookHost(config));
  };
  const makeReader = (signal) =>
    createGithubOperationReader({
      cwd,
      sessionId: "near-bound",
      settingsScope: "project",
      signal,
      assertAuthorized() {},
      approveRead: async () => true,
      hookProcesses: host.hookProcesses,
    });
  beginFiniteHookMetrics({ sourcePath: settingsPath, resourceRoot: installed.packageRoot });
  host = startup();
  reader = makeReader(new AbortController().signal);
  await reader.read("get_repository", "synthetic", { owner: "fixture", repo: "repo" });
  await reader.close();
  reader = undefined;
  const positive = endFiniteHookMetrics();
  assert.equal(providerReads, 1);
  assert.ok(positive.sourceReadBytes >= Buffer.byteLength(settingsBytes));
  assert.ok(
    positive.resourceReadBytes >=
      installed.plans[0].files.reduce((total, file) => total + file.bytes, 0),
  );
  results.push({
    phase: "64-file-near-4MiB-shared-source-positive",
    metrics: positive,
    providerReads,
  });
  await host.dispose();
  host = undefined;

  const plan = installed.plans[0],
    entry = plan.files.find((file) => file.name === "scripts/entry.mjs");
  const longCode = readFileSync(entry.source, "utf8").replace(
    "process.stdout.write",
    "await new Promise(done=>setTimeout(done,30000));\nprocess.stdout.write",
  );
  writeFileSync(entry.source, longCode);
  entry.bytes = Buffer.byteLength(longCode);
  entry.sha256 = createHash("sha256").update(longCode).digest("hex");
  const baseline = new Set(
    docker("container", "ls", "-aq", "--filter", "label=codeshell.process.scope")
      .stdout.trim()
      .split("\n")
      .filter(Boolean),
  );
  const controller = new AbortController();
  beginFiniteHookMetrics({ sourcePath: settingsPath, resourceRoot: installed.packageRoot });
  host = startup();
  reader = makeReader(controller.signal);
  const outcome = reader
    .read("get_repository", "synthetic", { owner: "fixture", repo: "repo" })
    .then(
      () => ({ accepted: true }),
      (error) => ({ error: String(error) }),
    );
  let running;
  for (let attempt = 0; ; attempt++) {
    const ids = docker("container", "ls", "-q", "--filter", "label=codeshell.process.scope")
      .stdout.trim()
      .split("\n")
      .filter((id) => id && !baseline.has(id));
    if (ids.length) {
      assert.equal(ids.length, 1);
      const inspect = docker("container", "inspect", ids[0]);
      const state = JSON.parse(inspect.stdout)[0].State;
      const top = docker("container", "top", ids[0], "-eo", "pid,ppid,sid,args");
      if (
        state.Running &&
        state.Pid > 0 &&
        top.code === 0 &&
        /\/resources\/scripts\/entry\.mjs/.test(top.stdout)
      ) {
        running = { id: ids[0], inspect, top };
        break;
      }
    }
    if (attempt > 100) throw new Error("Near-bound typed container never ran");
    await new Promise((done) => setTimeout(done, 25));
  }
  const cancelledAt = performance.now();
  controller.abort();
  const result = await outcome;
  await reader.close();
  reader = undefined;
  const cancelToClosedMs = performance.now() - cancelledAt;
  const cancellation = endFiniteHookMetrics();
  assert.ok(result.error);
  assert.equal(providerReads, 1);
  const absent = docker("container", "inspect", running.id);
  assert.notEqual(absent.code, 0);
  assert.match(absent.stderr, /No such container/);
  results.push({
    phase: "64-file-near-4MiB-source-cancel-running-typed-hook",
    result,
    running,
    absent,
    cancelToClosedMs,
    metrics: cancellation,
    extraProviderReads: 0,
  });
  await host.dispose();
  host = undefined;
  writeFileSync(
    join(evidence, "receipt.json"),
    JSON.stringify(
      {
        success: true,
        node: { version: process.version, executable: process.execPath },
        rawSourceBytes: Buffer.byteLength(settingsBytes),
        declaredFiles: 64,
        declaredResourceBytes: installed.plans[0].files.reduce(
          (total, file) => total + file.bytes,
          0,
        ),
        nativeConfigurationBytes: Buffer.byteLength(
          JSON.stringify({ runtime, inlineCommandSha256: [], resourcePlans: installed.plans }),
        ),
        results,
        limitations:
          "One near-bound shared source and small declared files; no claim of arbitrary large-script suitability or hard real-time Main responsiveness.",
      },
      null,
      2,
    ),
  );
  console.log(`Finite Hook near-bound acceptance passed: ${evidence}`);
} finally {
  try {
    await reader?.close();
    await host?.dispose();
  } finally {
    await new Promise((done) => server.close(done));
  }
}
