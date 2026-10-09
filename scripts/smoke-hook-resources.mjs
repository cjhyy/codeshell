/** Actual finite resources → compiled Core reader. Explicit local Docker only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installLocalNetworkGuard } from "./runtime-cost-smoke-isolation.mjs";
import { finiteSettingsHooks, prepareFiniteHookFixture } from "./fixtures/finite-hook-package.mjs";

const [configuration, evidence] = process.argv.slice(2);
assert.ok(configuration && evidence);
const runtime = JSON.parse(readFileSync(configuration, "utf8"));
const home = realpathSync(process.env.HOME);
assert.equal(process.env.CODE_SHELL_TEST_HOME, join(home, ".code-shell"));
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const privateDockerConfig = join(home, "docker-config");
mkdirSync(privateDockerConfig);
const dockerEnvironment = { PATH: "/usr/bin:/bin", HOME: home, DOCKER_CONFIG: privateDockerConfig };
const docker = (...args) => {
  const result = spawnSync(
    runtime.executable,
    ["--host", runtime.endpoint, "--config", privateDockerConfig, ...args],
    { env: dockerEnvironment, encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
  );
  assert.equal(result.error, undefined);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};
const calls = [];
const server = http.createServer((request, response) => {
  calls.push({ method: request.method, url: request.url });
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ id: 123, full_name: "fixture/repo" }));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
installLocalNetworkGuard(origin);
assert.throws(() => fetch("https://example.invalid"), /Cost smoke refused/);
assert.throws(() => http.request("http://127.0.0.1:1"), /Cost smoke refused/);
// Exact guards precede every Core import, including installer and file readers.
const coreUrl = pathToFileURL(join(process.cwd(), "packages/core/dist/index.js")).href;
const { createOperationHookHost } =
  await import("../packages/core/dist/links/operation-hook-host.js");
const { createGithubOperationReader } =
  await import("../packages/core/dist/links/operation-reader.js");
const { setDefaultCredentialAccess } = await import("../packages/core/dist/credentials/access.js");
const { revokePluginHooks } = await import("../packages/core/dist/plugins/pluginHookApproval.js");
const { createConstrainedDockerProcessHost } =
  await import("../packages/core/dist/runtime/constrained-process/docker.js");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const cwd = join(home, "project");
mkdirSync(join(cwd, ".code-shell"), { recursive: true });
const settingsPath = join(cwd, ".code-shell/settings.json");
const hooks = finiteSettingsHooks();
const settingsBytes = JSON.stringify({
  permissions: { rules: [{ tool: "LinkAction", decision: "allow" }] },
  hooks,
});
writeFileSync(settingsPath, settingsBytes);
const installed = await prepareFiniteHookFixture({
  coreUrl,
  home,
  cwd,
  settingsScope: "project",
  settingsBytes,
  settingsHooks: hooks,
});
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
  executeRemoteLinkAction: async () => (await fetch(`${origin}/get_repository`)).json(),
});
const dockerEvents = [],
  eventErrors = [];
const eventChild = spawn(
  runtime.executable,
  [
    "--host",
    runtime.endpoint,
    "--config",
    privateDockerConfig,
    "events",
    "--filter",
    "label=codeshell.process.scope",
    "--format",
    "{{json .}}",
  ],
  { env: dockerEnvironment, stdio: ["ignore", "pipe", "pipe"] },
);
const eventClosed = new Promise((done) => eventChild.once("close", done));
let pendingEvents = "";
eventChild.stdout.on("data", (bytes) => {
  pendingEvents += bytes.toString();
  const lines = pendingEvents.split("\n");
  pendingEvents = lines.pop();
  for (const line of lines) if (line) dockerEvents.push(JSON.parse(line));
});
eventChild.stderr.on("data", (bytes) => eventErrors.push(bytes.toString()));
const results = [];
const writeReceipt = () =>
  writeFileSync(
    join(evidence, "receipt.json"),
    JSON.stringify(
      {
        success: false,
        node: { version: process.version, executable: process.execPath },
        runtime,
        origin,
        results,
        dockerEvents,
        eventErrors,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
const startup = (plans = installed.plans, overrides = {}, nativeOptions = {}) =>
  createOperationHookHost(
    JSON.stringify({ runtime, inlineCommandSha256: [], resourcePlans: plans, ...overrides }),
    nativeOptions,
  );
function traced(host) {
  const trace = [],
    capture = host.hookProcesses.host.capture,
    createScope = host.hookProcesses.host.createScope;
  let captures = 0;
  host.hookProcesses.host.capture = (...args) => {
    captures++;
    return capture(...args);
  };
  host.hookProcesses.host.createScope = (authority) => {
    const own = createScope(authority),
      permits = new WeakMap();
    return {
      issue(spec) {
        const permit = own.issue(spec);
        permits.set(permit, spec);
        return permit;
      },
      scope: {
        async run(permit, input) {
          const spec = permits.get(permit),
            row = {
              event: spec.event,
              plugin: spec.plugin,
              launch: spec.launch,
              input: JSON.parse(input),
            };
          trace.push(row);
          try {
            const output = await own.scope.run(permit, input);
            row.receipt = output.receipt;
            row.stdout = output.stdout;
            return output;
          } catch (error) {
            row.error = String(error);
            throw error;
          }
        },
        terminateAndWait: () => own.scope.terminateAndWait(),
      },
    };
  };
  return { trace, captures: () => captures };
}
async function review(
  name,
  host,
  {
    controller = new AbortController(),
    assertOwner = () => {},
    beforeRead = () => {},
    expectedReads = 1,
    reject = false,
  } = {},
) {
  const before = calls.length;
  let reader, value, error;
  try {
    reader = createGithubOperationReader({
      cwd,
      sessionId: `fixture-${name}`,
      settingsScope: "project",
      signal: controller.signal,
      assertAuthorized: assertOwner,
      approveRead: async () => true,
      hookProcesses: host.hookProcesses,
    });
    await beforeRead();
    value = await reader.read("get_repository", "synthetic", { owner: "fixture", repo: "repo" });
  } catch (caught) {
    error = String(caught);
  } finally {
    await reader?.close();
  }
  assert.equal(Boolean(error), reject, `${name}: ${error}`);
  assert.equal(calls.length - before, expectedReads, `${name} provider reads`);
  const row = { name, value, error, providerReads: calls.length - before };
  results.push(row);
  writeReceipt();
  return row;
}
let active;
try {
  active = startup();
  const first = traced(active);
  await review("all-five-node-sh-and-approved-plugin", active);
  assert.deepEqual(
    first.trace.map((row) => [row.event, row.plugin]),
    [
      ["pre_tool_use", true],
      ["pre_tool_use", false],
      ["on_permission_check", false],
      ["on_tool_start", false],
      ["on_tool_end", false],
      ["post_tool_use", true],
      ["post_tool_use", false],
    ],
  );
  assert.ok(
    first.trace.every(
      (row) => row.receipt?.removed && row.receipt.planSha256 && row.launch.cwd === "empty",
    ),
  );
  for (const row of first.trace) {
    const absent = docker("container", "inspect", row.receipt.containerId);
    assert.notEqual(absent.code, 0);
    assert.match(absent.stderr, /No such container/);
    row.absent = absent;
  }
  results.at(-1).trace = first.trace;
  await active.dispose();
  active = undefined;

  active = startup();
  const cached = traced(active),
    cancelled = new AbortController();
  const capture = active.hookProcesses.host.capture;
  active.hookProcesses.host.capture = (...args) => {
    const token = capture(...args);
    cancelled.abort();
    return token;
  };
  await review("first-cancelled-after-finite-capture", active, {
    controller: cancelled,
    reject: true,
    expectedReads: 0,
  });
  active.hookProcesses.host.capture = capture;
  await review("second-independent-review-reuses-valid-cache", active);
  assert.equal(
    cached.captures(),
    7,
    "each exact plan captured once, cancelled review donated no callback",
  );
  let ownerCurrent = true;
  const scopes = active.hookProcesses.host.createScope;
  active.hookProcesses.host.createScope = (authority) => {
    const own = scopes(authority);
    return {
      issue: own.issue,
      scope: {
        run(permit, input) {
          ownerCurrent = false;
          return own.scope.run(permit, input);
        },
        terminateAndWait: () => own.scope.terminateAndWait(),
      },
    };
  };
  await review("second-owner-independent-revocation", active, {
    reject: true,
    expectedReads: 0,
    assertOwner() {
      if (!ownerCurrent) throw new Error("owner revoked");
    },
  });
  active.hookProcesses.host.createScope = scopes;
  await review("third-owner-not-poisoned-by-second-revocation", active);
  await active.dispose();
  active = undefined;

  active = startup();
  traced(active);
  await review("sticky-file-control", active);
  const entry = join(installed.packageRoot, "scripts/entry.mjs"),
    originalEntry = readFileSync(entry);
  writeFileSync(entry, "changed");
  await review("changed-declared-file", active, { reject: true, expectedReads: 0 });
  writeFileSync(entry, originalEntry);
  await review("restored-file-remains-invalid", active, { reject: true, expectedReads: 0 });
  await active.dispose();
  active = undefined;

  active = startup();
  await review("sticky-source-control", active);
  const replacement = join(cwd, ".code-shell/replacement.json");
  writeFileSync(replacement, settingsBytes);
  renameSync(replacement, settingsPath);
  await review("same-byte-source-replacement", active, { reject: true, expectedReads: 0 });
  writeFileSync(settingsPath, settingsBytes);
  await review("restored-source-remains-invalid", active, { reject: true, expectedReads: 0 });
  await active.dispose();
  active = undefined;

  for (const [name, mutate] of [
    [
      "missing-native-file-grant",
      (plans) =>
        plans.filter((plan) => !(plan.source.kind === "settings" && plan.event === "pre_tool_use")),
    ],
    [
      "scope-mismatch",
      (plans) =>
        plans.map((plan) => ({ ...plan, context: { ...plan.context, profileName: "other" } })),
    ],
    [
      "wrong-expected-file-hash",
      (plans) =>
        plans.map((plan) => ({
          ...plan,
          files: plan.files.map((file) => ({ ...file, sha256: "0".repeat(64) })),
        })),
    ],
    [
      "undeclared-node-import",
      (plans) =>
        plans.map((plan) => ({
          ...plan,
          files: plan.files.filter((file) => file.name !== "scripts/helper.mjs"),
        })),
    ],
  ]) {
    active = startup(mutate(structuredClone(installed.plans)));
    await review(name, active, { reject: true, expectedReads: 0 });
    await active.dispose();
    active = undefined;
  }
  active = startup(installed.plans, {
    runtime: { ...runtime, nodeExecutableSha256: "0".repeat(64) },
  });
  await review("runtime-identity-before-typed-code", active, { reject: true, expectedReads: 0 });
  await active.dispose();
  active = undefined;

  const { beginFiniteHookMetrics, endFiniteHookMetrics } =
    await import("./fixtures/finite-hook-metrics.mjs");
  const nativeState = join(home, "native-custom-state"),
    realTemp = join(home, "native-real-tmp"),
    realNativeHome = join(home, "native-real-home"),
    realSensitive = join(home, "native-real-user-data");
  for (const path of [nativeState, realTemp, realNativeHome, realSensitive]) mkdirSync(path);
  const tempAlias = join(home, "native-tmp-alias"),
    homeAlias = join(home, "native-home-alias"),
    stateAlias = join(home, "native-state-alias"),
    sensitiveAlias = join(home, "native-sensitive-alias");
  for (const [actual, alias] of [
    [realTemp, tempAlias],
    [realNativeHome, homeAlias],
    [nativeState, stateAlias],
    [realSensitive, sensitiveAlias],
  ])
    symlinkSync(actual, alias);
  const priorTmp = process.env.TMPDIR;
  try {
    process.env.TMPDIR = tempAlias;
    for (const [name, path, nativeOptions] of [
      [
        "actual-state-override-runtime-secret-before-open",
        join(nativeState, "serve/project-runtime-secrets/fixture/runtime.json"),
        { stateRoot: stateAlias },
      ],
      [
        "actual-state-override-registry-before-open",
        join(nativeState, "serve/project-control/registry.json"),
        { stateRoot: stateAlias },
      ],
      [
        "canonical-native-temp-cookie-lease-before-open",
        join(realTemp, "codeshell-cookie-leases/fixture/cookies.json"),
        {},
      ],
      [
        "canonical-native-home-credential-before-open",
        join(realNativeHome, ".aws/fixture-data"),
        { nativeHome: homeAlias },
      ],
      [
        "canonical-native-user-data-before-open",
        join(realSensitive, "fixture-data"),
        { sensitiveRoots: [sensitiveAlias] },
      ],
    ]) {
      mkdirSync(join(path, ".."), { recursive: true });
      const bytes = Buffer.from("synthetic credential-container exclusion fixture");
      writeFileSync(path, bytes);
      const plans = structuredClone(installed.plans),
        selected = plans.find(
          (plan) => plan.source.kind === "settings" && plan.event === "pre_tool_use",
        );
      selected.files[0] = {
        ...selected.files[0],
        source: realpathSync(path),
        bytes: bytes.length,
        sha256: hash(bytes),
      };
      active = startup(plans, {}, nativeOptions);
      const trace = traced(active);
      beginFiniteHookMetrics({ sourcePath: realpathSync(path), resourceRoot: join(path, "..") });
      await review(name, active, { reject: true, expectedReads: 0 });
      const metrics = endFiniteHookMetrics();
      assert.equal(metrics.sourceOpenCalls, 0);
      assert.equal(metrics.sourceReadBytes, 0);
      assert.equal(trace.captures(), 0);
      results.at(-1).beforeOpen = { metrics, captures: trace.captures() };
      await active.dispose();
      active = undefined;
    }
  } finally {
    if (priorTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmp;
  }

  active = startup();
  await review("plugin-approval-control", active);
  await review("plugin-approval-revoked-within-current-review", active, {
    beforeRead: () => revokePluginHooks(installed.pluginKey),
    reject: true,
    expectedReads: 0,
  });
  await active.dispose();
  active = undefined;

  // Direct generic typed permits prove actual RO cwd and child heap setting,
  // independent of configured policy, while retaining real lifecycle evidence.
  const lifecycle = [],
    generic = createConstrainedDockerProcessHost(runtime, {
      onLifecycle(event) {
        const row = { ...event };
        if (event.stage === "quiescent") {
          row.inspect = docker("container", "inspect", event.containerId);
          row.top = docker("container", "top", event.containerId);
          const state = JSON.parse(row.inspect.stdout)[0].State;
          assert.equal(state.Running, false);
          assert.equal(state.Pid, 0);
          assert.notEqual(row.top.code, 0);
        }
        if (event.stage === "removed")
          row.absent = docker("container", "inspect", event.containerId);
        lifecycle.push(row);
      },
    });
  const resourcePlan = installed.plans[0];
  const resources = generic.capture(
    resourcePlan.files.map((file) => ({
      path: file.source,
      name: file.name,
      expectedBytes: file.bytes,
      expectedSha256: file.sha256,
      assertReadable() {},
    })),
    { directories: resourcePlan.directories },
  );
  const own = generic.createScope({ signal: new AbortController().signal, assertAuthorized() {} });
  try {
    const output = await own.scope.run(
      own.issue({
        command: "opaque original",
        event: "pre_tool_use",
        timeoutMs: 5000,
        resources,
        launch: { ...resourcePlan.launch, planSha256: hash("generic typed finite plan") },
      }),
      JSON.stringify({ eventName: "pre_tool_use", data: { toolName: "LinkAction" } }),
    );
    assert.equal(output.receipt.exitCode, 0);
    results.push({ name: "generic-node-literal-argv-heap-empty-readonly-cwd", output, lifecycle });
  } finally {
    await own.scope.terminateAndWait();
    await generic.dispose();
  }
  assert.ok(lifecycle.find((row) => row.stage === "quiescent")?.inspect);
  writeReceipt();
  await new Promise((done) => setTimeout(done, 100));
  const ids = [
    ...new Set(
      dockerEvents
        .filter((event) => event.Type === "container" && event.Action === "create")
        .map((event) => event.Actor.ID),
    ),
  ];
  const absence = ids.map((id) => ({ id, result: docker("container", "inspect", id) }));
  assert.ok(ids.length > 0);
  assert.ok(
    absence.every(
      (row) => row.result.code !== 0 && row.result.stderr.includes("No such container"),
    ),
  );
  writeFileSync(
    join(evidence, "receipt.json"),
    JSON.stringify(
      {
        success: true,
        node: { version: process.version, executable: process.execPath },
        runtime,
        guards:
          "exact fixture HTTP origin before Core imports; real Docker backend enforces OS boundary",
        installed: {
          installPath: installed.installPath,
          approval: installed.approval,
          plans: installed.plans,
        },
        results,
        calls,
        dockerEvents,
        absence,
        eventErrors,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`Finite Hook resources actual acceptance passed: ${evidence}`);
} catch (error) {
  writeReceipt();
  throw error;
} finally {
  try {
    await active?.dispose();
  } finally {
    eventChild.kill("SIGTERM");
    await eventClosed;
    await new Promise((done) => server.close(done));
  }
}
