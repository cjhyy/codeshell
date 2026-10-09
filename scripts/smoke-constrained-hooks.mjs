/** Opt-in actual local Docker proof. No pull/install, provider or operator HOME.
 * Run through run-isolated-node-smoke.mjs; config and evidence paths are explicit.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { installLocalNetworkGuard } from "./runtime-cost-smoke-isolation.mjs";

const [configPath, evidence] = process.argv.slice(2);
assert.ok(configPath && evidence, "explicit runtime JSON and evidence directory required");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const home = realpathSync(process.env.HOME);
assert.equal(homedir(), home);
assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
assert.equal(process.env.CODE_SHELL_TEST_HOME, process.env.CODE_SHELL_HOME);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
chmodSync(evidence, 0o700);
const privateConfig = join(home, "docker-config");
mkdirSync(privateConfig, { mode: 0o700 });
const docker = (...args) => {
  const result = spawnSync(
    config.executable,
    ["--host", config.endpoint, "--config", privateConfig, ...args],
    {
      env: { PATH: "/usr/bin:/bin", HOME: home, DOCKER_CONFIG: privateConfig },
      cwd: home,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};
const calls = [];
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  calls.push({
    method: request.method,
    action: url.pathname.slice(1),
    params: JSON.parse(url.searchParams.get("params") || "{}"),
  });
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ id: 123, full_name: "fixture/repo" }));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
installLocalNetworkGuard(origin);
const namedHttp = await import("node:http"),
  namedHttps = await import("node:https");
let guards = 0;
for (const probe of [
  () => fetch("https://example.invalid"),
  () => fetch(origin, { dispatcher: {} }),
  () => http.request("http://127.0.0.1:1"),
  () => namedHttp.request("http://127.0.0.1:1"),
  () => namedHttp.get("http://127.0.0.1:1"),
  () => https.request("https://example.invalid"),
  () => namedHttps.get("https://example.invalid"),
  () => http.request(origin, { socketPath: "/unavailable" }),
]) {
  assert.throws(probe, /Cost smoke refused/);
  guards++;
}
// These guards are installed and exercised before every Core import below.
const { createConstrainedDockerProcessHost } =
  await import("../packages/core/dist/runtime/constrained-process/docker.js");
const { createOperationHookHost } =
  await import("../packages/core/dist/links/operation-hook-host.js");
const { createGithubOperationReader } =
  await import("../packages/core/dist/links/operation-reader.js");
const { setDefaultCredentialAccess } = await import("../packages/core/dist/credentials/access.js");
const { inspectPluginHooks } = await import("../packages/core/dist/plugins/pluginHookIntegrity.js");
const results = [];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const literal = (value) => `printf '%s' '${JSON.stringify(value)}'`;
let stage = "runtime";

async function runtimeCase(
  name,
  {
    command = "printf 'HOOK_EXECUTED'",
    runtime = config,
    resources,
    timeoutMs = 5000,
    revokeAtCreate = false,
    action,
    negative = false,
  } = {},
) {
  stage = name;
  const events = [],
    controller = new AbortController();
  let authorized = true,
    liveTop,
    topTimer,
    actionPromise;
  const host = createConstrainedDockerProcessHost(runtime, {
    onLifecycle(event) {
      const row = { ...event };
      if (event.stage === "created") {
        if (revokeAtCreate) authorized = false;
        if (action || name === "normal-descendants" || name === "timeout-descendants") {
          topTimer = setInterval(() => {
            const top = docker("container", "top", event.containerId, "-eo", "pid,ppid,sid,args");
            const rows = top.stdout.split("\n").flatMap((line) => {
              const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
              return match
                ? [
                    {
                      pid: Number(match[1]),
                      ppid: Number(match[2]),
                      sid: Number(match[3]),
                      args: match[4],
                    },
                  ]
                : [];
            });
            const leader = rows.find((row) => row.args.startsWith(config.nodeExecutable));
            const detached = rows.find(
              (row) =>
                row.pid !== leader?.pid &&
                row.sid !== leader?.sid &&
                row.pid === row.sid &&
                row.args.startsWith("/bin/sh -c trap"),
            );
            if (top.code === 0 && leader && detached) {
              liveTop = top;
              clearInterval(topTimer);
              if (action === "abort") controller.abort();
              if (action === "dispose") actionPromise = host.dispose();
              if (action === "authority") authorized = false;
              if (typeof action === "function") action();
            }
          }, 50);
        }
      }
      if (event.stage === "quiescent") {
        row.logs = docker("container", "logs", event.containerId);
        row.inspect = docker("container", "inspect", event.containerId);
        row.top = docker("container", "top", event.containerId);
        const state = JSON.parse(row.inspect.stdout)[0].State;
        assert.equal(state.Running, false);
        assert.equal(state.Pid, 0);
        assert.notEqual(row.top.code, 0);
      }
      if (event.stage === "removed") {
        row.absent = docker("container", "inspect", event.containerId);
        assert.notEqual(row.absent.code, 0);
        assert.match(row.absent.stderr, /No such container/);
      }
      events.push(row);
    },
  });
  const authority = {
    signal: controller.signal,
    assertAuthorized() {
      if (!authorized) throw new Error("Synthetic authority revoked");
    },
  };
  const { scope, issue } = host.createScope(authority);
  let output, error;
  try {
    const captured = resources?.(host);
    const permit = issue({ command, timeoutMs, event: "pre_tool_use", resources: captured });
    try {
      output = await scope.run(permit, "{}");
    } catch (caught) {
      error = String(caught);
    }
  } finally {
    clearInterval(topTimer);
    await scope.terminateAndWait();
    await actionPromise;
    await host.dispose();
  }
  assert.equal(Boolean(error), negative, `${name}: ${error}`);
  assert.equal(events.filter((row) => row.stage === "created").length, 1);
  assert.equal(events.filter((row) => row.stage === "removed").length, 1);
  if (["normal-descendants", "timeout-descendants"].includes(name) || action)
    assert.ok(liveTop, "actual live descendants must be observed");
  const row = { name, output, error, events, liveTop };
  results.push(row);
  writeFileSync(join(evidence, `${name}.json`), JSON.stringify(row, null, 2), { mode: 0o600 });
  return row;
}

try {
  const good = await runtimeCase("identity-control");
  assert.equal(good.output.stdout, "HOOK_EXECUTED");
  const wrong = await runtimeCase("identity-reject-before-hook", {
    runtime: { ...config, nodeExecutableSha256: "0".repeat(64) },
    negative: true,
  });
  assert.equal(wrong.events.find((row) => row.stage === "quiescent").exitCode, 125);
  assert.doesNotMatch(
    wrong.events.find((row) => row.stage === "quiescent").logs.stdout,
    /HOOK_EXECUTED/,
  );
  const before = await runtimeCase("prestart-authority-revoked", {
    revokeAtCreate: true,
    negative: true,
  });
  assert.doesNotMatch(
    before.events.find((row) => row.stage === "quiescent").logs.stdout,
    /HOOK_EXECUTED/,
  );
  const descendant = "setsid /bin/sh -c 'trap \"\" TERM; while :; do sleep 1; done' & ";
  await runtimeCase("normal-descendants", {
    command: descendant + "sleep 1; printf 'LEADER_EXIT'",
  });
  await runtimeCase("abort-descendants", {
    command: descendant + "while :; do sleep 1; done",
    action: "abort",
    negative: true,
  });
  await runtimeCase("timeout-descendants", {
    command: descendant + "trap '' TERM; while :; do sleep 1; done",
    timeoutMs: 2000,
    negative: true,
  });
  await runtimeCase("dispose-descendants", {
    command: descendant + "while :; do sleep 1; done",
    action: "dispose",
    negative: true,
  });
  stage = "OS-negative-probe";
  const canary = join(home, "unmounted-host-canary.txt");
  writeFileSync(canary, "private synthetic canary", { mode: 0o600 });
  const probeSource = readFileSync(
    new URL("./fixtures/constrained-hook-probe.mjs", import.meta.url),
    "utf8",
  ).replaceAll("HOST_CANARY_PATH", JSON.stringify(canary));
  const probePath = join(home, "kernel-probe.mjs");
  writeFileSync(probePath, probeSource, { mode: 0o600 });
  const inputPath = join(home, "approved.txt");
  writeFileSync(inputPath, "synthetic approved hook input", { mode: 0o600 });
  const os = await runtimeCase("OS-negative-probe", {
    command: "node /resources/probe.mjs",
    resources: (host) =>
      host.capture([
        {
          path: realpathSync(probePath),
          name: "probe.mjs",
          assertReadable() {
            assert.equal(readFileSync(probePath, "utf8"), probeSource);
          },
        },
        {
          path: realpathSync(inputPath),
          name: "inputs/approved.txt",
          assertReadable() {
            assert.equal(readFileSync(inputPath, "utf8"), "synthetic approved hook input");
          },
        },
      ]),
  });
  const kernel = JSON.parse(os.output.stdout.trim().split("\n").at(-1));
  assert.deepEqual(kernel.failed, []);
  assert.equal(kernel.checks.capturedChild.error, "EPERM");
  assert.equal(kernel.checks.inheritedChild.success, true);
  assert.equal(readFileSync(canary, "utf8"), "private synthetic canary");
  await runtimeCase("owner-revoked-during-child", {
    command: descendant + "while :; do sleep 1; done",
    action: "authority",
    negative: true,
  });
  const resourcePath = join(home, "revocable-resource.txt");
  const resetResource = () =>
    writeFileSync(resourcePath, "original authorized bytes", { mode: 0o600 });
  resetResource();
  let resourceAuthorized = true;
  await runtimeCase("resource-authority-revoked-during-child", {
    command: descendant + "while :; do sleep 1; done",
    resources: (host) =>
      host.capture([
        {
          path: realpathSync(resourcePath),
          name: "input.txt",
          assertReadable() {
            if (!resourceAuthorized) throw new Error("Synthetic file authority revoked");
          },
        },
      ]),
    action: () => {
      resourceAuthorized = false;
    },
    negative: true,
  });
  resetResource();
  await runtimeCase("resource-bytes-changed-during-child", {
    command: descendant + "while :; do sleep 1; done",
    resources: (host) =>
      host.capture([{ path: realpathSync(resourcePath), name: "input.txt", assertReadable() {} }]),
    action: () => writeFileSync(resourcePath, "changed unauthorized bytes"),
    negative: true,
  });
  stage = "opaque-permits";
  const hostA = createConstrainedDockerProcessHost(config),
    hostB = createConstrainedDockerProcessHost(config);
  const authority = { signal: new AbortController().signal, assertAuthorized() {} };
  const first = hostA.createScope(authority),
    second = hostA.createScope(authority),
    foreign = hostB.createScope(authority);
  try {
    const permit = first.issue({ command: ":", timeoutMs: 1000, event: "pre_tool_use" });
    await assert.rejects(second.scope.run(permit, "{}"), /Invalid constrained process permit/);
    await assert.rejects(foreign.scope.run(permit, "{}"), /Invalid constrained process permit/);
    await assert.rejects(
      first.scope.run(JSON.parse(JSON.stringify(permit)), "{}"),
      /Invalid constrained process permit/,
    );
    const resources = hostA.capture([
      { path: realpathSync(resourcePath), name: "input.txt", assertReadable() {} },
    ]);
    assert.throws(
      () => foreign.issue({ command: ":", timeoutMs: 1000, event: "pre_tool_use", resources }),
      /Foreign constrained resource/,
    );
    results.push({
      name: "opaque-permits",
      forged: "rejected",
      foreignScope: "rejected",
      foreignHost: "rejected",
      foreignResource: "rejected",
    });
  } finally {
    await first.scope.terminateAndWait();
    await second.scope.terminateAndWait();
    await foreign.scope.terminateAndWait();
    await hostA.dispose();
    await hostB.dispose();
  }
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
    executeRemoteLinkAction: async ({ action, params }) =>
      (
        await fetch(`${origin}/${action}?params=${encodeURIComponent(JSON.stringify(params))}`)
      ).json(),
  });
  const cwd = join(home, "project");
  mkdirSync(join(cwd, ".code-shell"), { recursive: true });
  const settings = join(cwd, ".code-shell/settings.json");
  const events = [
    "pre_tool_use",
    "on_permission_check",
    "on_tool_start",
    "on_tool_end",
    "post_tool_use",
  ];
  async function readerCase(
    name,
    hooks,
    { reject, expectedReads = 0, plugin, mutateAtCreate, revokeOwner = false } = {},
  ) {
    stage = name;
    const commands = hooks.map((hook) => hook.command);
    if (plugin) commands.push(plugin);
    const startup = createOperationHookHost(
      JSON.stringify({ runtime: config, inlineCommandSha256: commands.map(hash) }),
    );
    let ownerCurrent = true,
      observed;
    if (mutateAtCreate || revokeOwner) {
      observed = createConstrainedDockerProcessHost(config, {
        onLifecycle(event) {
          if (event.stage === "created") {
            if (revokeOwner) ownerCurrent = false;
            mutateAtCreate?.();
          }
        },
      });
      startup.hookProcesses.host = observed;
    }
    // Transparent Host diagnostics; permits and every execution still belong to
    // the actual opaque runtime. This does not substitute process responses.
    const trace = [],
      createScope = startup.hookProcesses.host.createScope;
    startup.hookProcesses.host.createScope = (authority) => {
      const own = createScope(authority),
        specs = new WeakMap();
      return {
        issue(spec) {
          const permit = own.issue(spec);
          specs.set(permit, spec);
          return permit;
        },
        scope: {
          run(permit, input) {
            trace.push(specs.get(permit));
            return own.scope.run(permit, input);
          },
          terminateAndWait: () => own.scope.terminateAndWait(),
        },
      };
    };
    writeFileSync(settings, JSON.stringify({ hooks }), { mode: 0o600 });
    const reader = createGithubOperationReader({
      cwd,
      sessionId: "synthetic",
      settingsScope: "project",
      assertAuthorized() {
        if (!ownerCurrent) throw new Error("Synthetic original owner changed");
      },
      approveRead: async () => true,
      signal: new AbortController().signal,
      hookProcesses: startup.hookProcesses,
    });
    const count = calls.length;
    let value, error;
    try {
      try {
        value = await reader.read("get_repository", credential.id, {
          owner: "fixture",
          repo: "repo",
        });
      } catch (caught) {
        error = caught.result || String(caught);
      }
    } finally {
      await reader.close();
      await observed?.dispose();
      await startup.dispose();
    }
    if (reject) assert.equal(error, reject);
    else {
      assert.equal(error, undefined);
      assert.equal(value.id, 123);
    }
    assert.equal(calls.length - count, expectedReads);
    if (name === "all-five-settings-events")
      assert.deepEqual(
        trace.map((spec) => spec.event),
        events,
      );
    if (name.startsWith("falsy-args-"))
      assert.equal(trace.length, 1, "second actual Hook must never execute");
    if (name === "actual-approved-installed-plugin") {
      // Existing HookRegistry runs higher priorities first: approved plugin80
      // denies before settings50. The deny must prevent later execution.
      assert.equal(trace.length, 1);
      assert.equal(trace[0].plugin, true);
    }
    results.push({ name, value, error, reads: calls.length - count, trace });
  }
  await readerCase(
    "all-five-settings-events",
    events.map((event) => ({ event, command: literal({}) })),
    { expectedReads: 1 },
  );
  for (const event of events)
    await readerCase(`deny-${event}`, [{ event, command: literal({ decision: "deny" }) }], {
      reject: "permission_denied",
      expectedReads: ["on_tool_end", "post_tool_use"].includes(event) ? 1 : 0,
    });
  for (const args of [null, false, 0, ""])
    await readerCase(
      `falsy-args-${JSON.stringify(args)}`,
      [
        { event: "pre_tool_use", command: literal({ data: { args } }) },
        { event: "pre_tool_use", command: literal({ decision: "allow" }) },
      ],
      { reject: "permission_denied" },
    );
  await readerCase(
    "actual-config-replaced-before-start",
    [{ event: "pre_tool_use", command: literal({}) }],
    {
      reject: "Error: Operation read policy changed",
      mutateAtCreate() {
        const bytes = readFileSync(settings);
        writeFileSync(settings, bytes);
      },
    },
  );
  await readerCase(
    "actual-owner-revoked-before-start",
    [{ event: "pre_tool_use", command: literal({}) }],
    {
      reject: "Error: Synthetic original owner changed",
      revokeOwner: true,
    },
  );
  const pluginRoot = join(home, "approved-plugin");
  mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
  const plugin = literal({ decision: "deny" });
  writeFileSync(
    join(pluginRoot, "hooks/hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "^LinkAction$", hooks: [{ type: "command", command: plugin }] }],
      },
    }),
  );
  const inspected = inspectPluginHooks(pluginRoot);
  const registry = join(home, ".code-shell/plugins");
  mkdirSync(registry, { recursive: true });
  const entry = {
    scope: "user",
    installPath: pluginRoot,
    version: "1",
    installedAt: "fixture",
    lastUpdated: "fixture",
    hookDigest: inspected.digest,
    approvedHookDigest: inspected.digest,
  };
  assert.ok(inspected.digest);
  writeFileSync(
    join(registry, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "synthetic@fixture": [entry] } }),
  );
  await readerCase(
    "actual-approved-installed-plugin",
    [{ event: "pre_tool_use", command: literal({ decision: "allow" }) }],
    { plugin, reject: "permission_denied" },
  );
  writeFileSync(
    join(evidence, "receipt.json"),
    JSON.stringify(
      {
        success: true,
        node: process.version,
        executable: realpathSync(process.execPath),
        home,
        guards,
        beforeCoreImport: true,
        origin,
        config,
        results,
        calls,
        limitation:
          "Actual Linux Docker backend and compiled Node reader; synthetic account and HTTP only. Native macOS backend and arbitrary plugin resource authority remain unsupported.",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`Constrained Hook actual Node proof passed: ${evidence}`);
} catch (error) {
  writeFileSync(
    join(evidence, "failure.json"),
    JSON.stringify({ stage, error: String(error), results, calls }, null, 2),
    { mode: 0o600 },
  );
  throw error;
} finally {
  setDefaultCredentialAccess(null);
  server.close();
}
