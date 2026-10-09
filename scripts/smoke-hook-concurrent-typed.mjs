/** Real shared native resources, independent review scopes, and typed descendants. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { installLocalNetworkGuard } from "./runtime-cost-smoke-isolation.mjs";
import { finiteSettingsHooks, prepareFiniteHookFixture } from "./fixtures/finite-hook-package.mjs";

const [runtimePath, evidence] = process.argv.slice(2);
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
const coreUrl = pathToFileURL(join(process.cwd(), "packages/core/dist/index.js")).href;
const { createOperationHookHost } =
  await import("../packages/core/dist/links/operation-hook-host.js");
const { createGithubOperationReader } =
  await import("../packages/core/dist/links/operation-reader.js");
const { setDefaultCredentialAccess } = await import("../packages/core/dist/credentials/access.js");
const { createConstrainedDockerProcessHost } =
  await import("../packages/core/dist/runtime/constrained-process/docker.js");
const cwd = join(home, "project"),
  settingsPath = join(cwd, ".code-shell/settings.json");
mkdirSync(join(cwd, ".code-shell"), { recursive: true });
const hooks = [{ ...finiteSettingsHooks()[0], timeout_ms: 10000 }];
const settingsBytes = JSON.stringify({
  permissions: { rules: [{ tool: "LinkAction", decision: "allow" }] },
  disabledPlugins: ["finite-hook-fixture"],
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
const plan = installed.plans.find((item) => item.source.kind === "settings");
const entry = plan.files.find((file) => file.name === "scripts/entry.mjs");
const longCode = `import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
const envelope=JSON.parse(readFileSync(0,'utf8'));
const key=envelope.data.toolCallId||'generic';
process.title='finite-parent-'+key;
process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,['--max-old-space-size=64','-e',"process.title='finite-child-'+process.argv[1];process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",key],{stdio:'inherit',detached:true});
if(!child.pid)throw new Error('No actual descendant');
child.unref();
await new Promise(done=>setTimeout(done,4000));
process.stdout.write(JSON.stringify({decision:'allow'}));
`;
writeFileSync(entry.source, longCode);
entry.bytes = Buffer.byteLength(longCode);
entry.sha256 = createHash("sha256").update(longCode).digest("hex");
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
const results = [],
  activeReaders = new Set(),
  genericScopes = new Set(),
  genericHosts = new Set();
let native;
const persist = (success = false) =>
  writeFileSync(
    join(evidence, "receipt.json"),
    JSON.stringify(
      {
        success,
        node: { version: process.version, executable: process.execPath },
        runtime,
        providerReads,
        results,
      },
      null,
      2,
    ),
  );
function processes(top, key) {
  assert.equal(top.code, 0);
  const values = top.stdout
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [pid, ppid, sid, ...args] = line.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), sid: Number(sid), args: args.join(" ") };
    });
  const parent = values.find((row) => row.args.startsWith("finite-parent-" + key));
  const child = values.find((row) => row.args.startsWith("finite-child-" + key));
  if (!parent || !child) return undefined;
  assert.equal(child.ppid, parent.pid);
  assert.notEqual(child.sid, parent.sid);
  return { parent, child, all: values };
}
async function runningFor(key, knownId) {
  for (let attempt = 0; ; attempt++) {
    const ids = knownId
      ? [knownId]
      : docker("container", "ls", "-q", "--filter", "label=codeshell.process.scope")
          .stdout.trim()
          .split("\n")
          .filter(Boolean);
    for (const id of ids) {
      const top = docker("container", "top", id, "-eo", "pid,ppid,sid,args");
      if (top.code !== 0) continue;
      const tree = processes(top, key);
      if (tree) {
        const inspect = docker("container", "inspect", id);
        const state = JSON.parse(inspect.stdout)[0].State;
        assert.equal(state.Running, true);
        assert.ok(state.Pid > 0);
        return { id, top, inspect, tree };
      }
    }
    if (attempt > 100) throw new Error("Actual typed descendant missing: " + key);
    await new Promise((done) => setTimeout(done, 20));
  }
}
function absent(id) {
  const result = docker("container", "inspect", id);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /No such container/);
  return result;
}
try {
  native = createOperationHookHost(
    JSON.stringify({ runtime, inlineCommandSha256: [], resourcePlans: [plan] }),
  );
  let captures = 0;
  const capture = native.hookProcesses.host.capture,
    createScope = native.hookProcesses.host.createScope,
    runs = [];
  native.hookProcesses.host.capture = (...args) => {
    captures++;
    return capture(...args);
  };
  native.hookProcesses.host.createScope = (authority) => {
    const own = createScope(authority);
    return {
      issue: own.issue,
      scope: {
        async run(permit, input) {
          const row = { toolCallId: JSON.parse(input).data.toolCallId };
          runs.push(row);
          try {
            const value = await own.scope.run(permit, input);
            row.receipt = value.receipt;
            return value;
          } catch (error) {
            row.error = String(error);
            throw error;
          }
        },
        terminateAndWait: () => own.scope.terminateAndWait(),
      },
    };
  };
  const first = new AbortController(),
    second = new AbortController();
  const review = (signal, name) => {
    const reader = createGithubOperationReader({
      cwd,
      sessionId: name,
      settingsScope: "project",
      signal,
      assertAuthorized() {},
      approveRead: async () => true,
      hookProcesses: native.hookProcesses,
    });
    activeReaders.add(reader);
    return reader
      .read("get_repository", "synthetic", { owner: "fixture", repo: "repo" })
      .then(
        (value) => ({ value }),
        (error) => ({ error: String(error) }),
      )
      .finally(async () => {
        await reader.close();
        activeReaders.delete(reader);
      });
  };
  const a = review(first.signal, "review-a"),
    b = review(second.signal, "review-b");
  while (runs.length < 2) await new Promise((done) => setTimeout(done, 10));
  const liveA = await runningFor(runs[0].toolCallId),
    liveB = await runningFor(runs[1].toolCallId);
  assert.notEqual(liveA.id, liveB.id);
  assert.equal(captures, 1);
  const cancelledAt = performance.now();
  first.abort();
  const resultA = await a,
    cancellationMs = performance.now() - cancelledAt;
  assert.ok(resultA.error);
  const absentA = absent(liveA.id),
    bAfterCancellation = docker("container", "inspect", liveB.id);
  assert.equal(JSON.parse(bAfterCancellation.stdout)[0].State.Running, true);
  const resultB = await b;
  assert.ok(resultB.value);
  assert.equal(providerReads, 1);
  assert.equal(captures, 1);
  results.push({
    phase: "concurrent-current-review-scopes-share-one-native-capture",
    liveA,
    liveB,
    resultA,
    resultB,
    cancellationMs,
    absentA,
    bAfterCancellation,
    absentB: absent(liveB.id),
    captures,
    runs,
    providerReads,
  });
  persist();
  await native.dispose();
  native = undefined;

  for (const mode of [
    "normal",
    "revoke",
    "timeout",
    "observer-rejects-cleanup-evidence",
    "lost-container-custody",
  ]) {
    const lifecycle = [];
    let cid,
      authorized = true;
    const host = createConstrainedDockerProcessHost(runtime, {
      onLifecycle(event) {
        const row = { ...event };
        lifecycle.push(row);
        if (event.stage === "created") cid = event.containerId;
        if (event.stage === "quiescent") {
          row.inspect = docker("container", "inspect", event.containerId);
          row.top = docker("container", "top", event.containerId);
          const state = JSON.parse(row.inspect.stdout)[0].State;
          assert.equal(state.Running, false);
          assert.equal(state.Pid, 0);
          assert.notEqual(row.top.code, 0);
          if (mode === "observer-rejects-cleanup-evidence")
            throw new Error("Synthetic Host observer cannot accept cleanup evidence");
        }
        if (event.stage === "removed") row.absent = absent(event.containerId);
      },
    });
    genericHosts.add(host);
    const resources = host.capture(
      plan.files.map((file) => ({
        path: file.source,
        name: file.name,
        expectedBytes: file.bytes,
        expectedSha256: file.sha256,
        assertReadable() {},
      })),
      { directories: plan.directories },
    );
    const scope = host.createScope({
      signal: new AbortController().signal,
      assertAuthorized() {
        if (!authorized) throw new Error("Current owner revoked");
      },
    });
    genericScopes.add(scope.scope);
    const key = "generic-" + mode;
    const output = scope.scope
      .run(
        scope.issue({
          command: "opaque original",
          event: "pre_tool_use",
          timeoutMs: mode === "timeout" ? 1200 : 10000,
          resources,
          launch: { ...plan.launch, planSha256: createHash("sha256").update(mode).digest("hex") },
        }),
        JSON.stringify({
          eventName: "pre_tool_use",
          data: { toolName: "LinkAction", toolCallId: key },
        }),
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error: String(error) }),
      );
    while (!cid) await new Promise((done) => setTimeout(done, 10));
    const live = await runningFor(key, cid),
      revokedAt = performance.now();
    if (mode === "revoke") authorized = false;
    let externallyRemoved;
    if (mode === "lost-container-custody") {
      // Only this fixture's exact, already-observed owned CID is removed.
      // The Host must reject unknown custody despite its external absence.
      externallyRemoved = docker("container", "rm", "--force", cid);
      assert.equal(externallyRemoved.code, 0);
    }
    const result = await output;
    const terminalMs = performance.now() - revokedAt;
    if (mode === "normal") assert.ok(result.value?.receipt.removed);
    else assert.ok(result.error);
    let closeError, disposeError;
    try {
      await scope.scope.terminateAndWait();
    } catch (error) {
      closeError = String(error);
    }
    genericScopes.delete(scope.scope);
    try {
      await host.dispose();
    } catch (error) {
      disposeError = String(error);
    }
    genericHosts.delete(host);
    if (mode === "lost-container-custody") assert.ok(closeError || disposeError);
    else {
      assert.equal(closeError, undefined);
      assert.equal(disposeError, undefined);
    }
    if (mode !== "lost-container-custody")
      assert.ok(lifecycle.find((row) => row.stage === "quiescent")?.inspect);
    results.push({
      phase: "typed-different-SID-descendant-" + mode,
      live,
      result,
      terminalMs,
      closeError,
      disposeError,
      externallyRemoved,
      lifecycle,
      absent: absent(cid),
    });
    persist();
  }
  persist(true);
  console.log(`Concurrent typed Hook acceptance passed: ${evidence}`);
} finally {
  try {
    await Promise.allSettled([...activeReaders].map((reader) => reader.close()));
    await native?.dispose();
    await Promise.allSettled([...genericScopes].map((scope) => scope.terminateAndWait()));
    await Promise.allSettled([...genericHosts].map((host) => host.dispose()));
  } finally {
    await new Promise((done) => server.close(done));
  }
}
