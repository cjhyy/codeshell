import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../../packages/core/src/tool-system/context.js";
import type { MCPServerConfig } from "../../packages/core/src/types.js";
const directory = process.env.CODESHELL_MCP_RELOAD_EVIDENCE!;
const root = process.env.CODESHELL_MCP_RELOAD_ROOT!;
const home = realpathSync(process.env.HOME!);
assert.equal(homedir(), home);
assert.equal(process.env.USERPROFILE, home);
assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
assert.equal(process.env.CODE_SHELL_DATA_ROOT, undefined);
let denied = 0;
const deny = () => {
  denied++;
  throw new Error("reload fixture denies HTTP");
};
globalThis.fetch = deny as typeof fetch;
for (const t of [http, https]) {
  t.request = deny as typeof t.request;
  t.get = deny as typeof t.get;
}
syncBuiltinESMExports();
const namedHttp = await import("node:http"),
  namedHttps = await import("node:https");
for (const probe of [
  () => fetch("https://example.invalid"),
  () => fetch("http://127.0.0.1:9"),
  () => http.request("http://127.0.0.1:9"),
  () => http.get("http://127.0.0.1:9"),
  () => https.request("https://example.invalid"),
  () => https.get("https://example.invalid"),
  () => namedHttp.request("http://127.0.0.1:9"),
  () => namedHttps.get("https://example.invalid"),
])
  assert.throws(probe, /denies HTTP/);
assert.equal(denied, 8);
denied = 0;
const guard = {
  pid: process.pid,
  ppid: process.ppid,
  node: process.versions.node,
  executable: realpathSync(process.execPath),
  homeSha256: createHash("sha256").update(home).digest("hex"),
  negativeProbes: 8,
};
writeFileSync(join(directory, "before-core.json"), JSON.stringify(guard) + "\n");
// Transparent observation: unchanged arguments/result, exactly one actual spawn.
const children: { pid?: number; closed: boolean; code?: number | null; signal?: string | null }[] =
  [];
const originalSpawn = childProcess.spawn;
childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
  const child = originalSpawn(...args);
  const receipt = { pid: child.pid, closed: false } as (typeof children)[number];
  children.push(receipt);
  child.once("close", (code, signal) => {
    Object.assign(receipt, { closed: true, code, signal });
  });
  return child;
}) as typeof originalSpawn;
syncBuiltinESMExports();
const { MCPManager } = await import("../../packages/core/src/tool-system/mcp-manager.js");
const { ToolRegistry } = await import("../../packages/core/src/tool-system/registry.js");
const { connectRunMcp } = await import("../../packages/core/src/engine/run-tooling.js");
const { mcpToolExecute, readMcpResourceTool, listMcpResourcesTool } =
  await import("../../packages/core/src/tool-system/builtin/mcp-tools.js");
const pools = new Set<InstanceType<typeof MCPManager>>();
const engines = new Set<{ dispose(): Promise<void> }>();
const log = join(directory, "servers.jsonl");
const server = join(root, "tests/fixtures/mcp-transport-reload-server.mjs");
let sequence = 0;
const cwd = join(directory, "workspace");
mkdirSync(join(cwd, "sub"), { recursive: true });
function config(version: string, extra: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name: "fixture",
    command: process.execPath,
    args: [server, version, log],
    env: { SYNTHETIC_VERSION: version },
    connectTimeoutMs: 2000,
    connectRetries: 0,
    ...extra,
  };
}
function context(): ToolContext {
  return { cwd } as ToolContext;
}
function pool() {
  const registry = new ToolRegistry({ builtinTools: [] });
  const manager = new MCPManager(registry);
  pools.add(manager);
  return { manager, registry };
}
function detail(value: unknown) {
  return JSON.parse(String(value).split("\n")[1]);
}
async function waitFor(predicate: () => boolean) {
  const until = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < until, "fixture gate was not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function events() {
  return existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
async function cleanup() {
  await Promise.all([...engines].map((engine) => engine.dispose()));
  engines.clear();
  await Promise.all([...pools].map((manager) => manager.disconnectAll()));
  pools.clear();
}
afterEach(async () => {
  await cleanup();
  assert.equal(denied, 0);
  assert.ok(
    children.every((child) => child.closed),
    JSON.stringify(children),
  );
});
let shuttingDown = false;
const shutdown = setInterval(() => {
  if (!shuttingDown && existsSync(join(directory, "shutdown.request"))) {
    shuttingDown = true;
    void cleanup().finally(() => {
      writeFileSync(join(directory, "shutdown.json"), JSON.stringify({ children }) + "\n");
      process.exitCode = 1;
      clearInterval(shutdown);
    });
  }
}, 25);
shutdown.unref();
after(() => {
  clearInterval(shutdown);
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  writeFileSync(
    join(directory, "completion.json"),
    JSON.stringify({ guard, unexpectedNetworkCalls: denied, children }) + "\n",
  );
});

const { Engine } = await import("../../packages/core/src/engine/engine.js");
const { EngineRuntime } = await import("../../packages/core/src/engine/runtime.js");
const { ModelPool } = await import("../../packages/core/src/llm/model-pool.js");
const { CostTracker } = await import("../../packages/core/src/cost-tracker.js");
const { LLMClientBase } = await import("../../packages/core/src/llm/client-base.js");
const { registerProvider } = await import("../../packages/core/src/llm/client-factory.js");
const provider = "mcp-transport-local-only";
let syntheticResponses = 0;
let responsesInRun = 0;
let beforeResponse: (() => void) | undefined;
class SyntheticClient extends LLMClientBase {
  protected initClient() {
    if (this.model === "init-failure") throw new Error("synthetic client initialization failure");
  }
  async createMessage() {
    beforeResponse?.();
    beforeResponse = undefined;
    syntheticResponses++;
    const tool = ++responsesInRun === 1;
    return {
      text: tool ? "" : "done",
      toolCalls: tool
        ? [{ id: `capture-${syntheticResponses}`, toolName: "CaptureMcpContext", args: {} }]
        : [],
      stopReason: tool ? ("tool_use" as const) : ("stop" as const),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}
registerProvider(provider, SyntheticClient);
function engineFixture(model = "local") {
  const registry = new ToolRegistry({ builtinTools: [] }),
    manager = new MCPManager(registry);
  pools.add(manager);
  const runtime = new EngineRuntime({
    modelPool: new ModelPool(),
    costTracker: new CostTracker(),
    toolRegistry: registry,
    mcpPool: manager,
  });
  const engine = new Engine({
    cwd,
    runtime,
    settingsScope: "project",
    projectTrusted: true,
    sessionStorageDir: join(directory, "sessions-" + ++sequence),
    llm: { provider, model, apiKey: "synthetic" } as never,
    permissionMode: "bypassPermissions",
    enabledBuiltinTools: [],
    maxTurns: 4,
    mcpServers: { fixture: config("v1") },
    behaviorProfiles: [
      {
        id: "quiet",
        disableInstructions: true,
        disableMemoryContext: true,
        disableSessionTitle: true,
      },
    ],
  });
  engines.add(engine);
  return { engine, runtime, manager };
}

test("same owner retains old Run configuration across a newer Run and all tool/resource routes", async () => {
  const { manager, registry } = pool(),
    owner = {},
    a = context(),
    b = context();
  await manager.connectAll({ fixture: config("v1") }, owner, undefined, a, true);
  const first = detail(await manager.callTool("fixture", "echo", {}, undefined, a));
  await manager.connectAll({ fixture: config("v2") }, owner, undefined, b, true);
  const second = detail(await manager.callTool("fixture", "echo", {}, undefined, b));
  assert.equal(first.version, "v1");
  assert.equal(second.version, "v2");
  assert.notEqual(first.pid, second.pid);
  assert.equal(detail(await manager.callTool("fixture", "echo", {}, undefined, a)).pid, first.pid);
  for (const [ctx, version] of [
    [a, "v1"],
    [b, "v2"],
  ] as const) {
    const local = new ToolRegistry({ builtinTools: [] });
    manager.syncToolsToRegistry(local, ctx);
    assert.equal(local.getTool("mcp_fixture_echo")?.description, `[fixture] ${version}`);
    assert.ok(local.getTool("mcp_fixture_only_" + version));
    assert.equal(local.getTool("mcp_fixture_only_" + (version === "v1" ? "v2" : "v1")), undefined);
    const registered = await local.executeTool("mcp_fixture_echo", {}, { ctx });
    assert.equal(registered.isError, false);
    assert.equal(detail(registered.result).version, version);
    const generic = await mcpToolExecute({ server: "fixture", tool: "echo" }, ctx);
    assert.ok(typeof generic === "object" && "ok" in generic && generic.ok);
    assert.equal(detail(generic.result).version, version);
    assert.match(
      String(await listMcpResourcesTool({ server: "fixture" }, ctx)),
      new RegExp(version),
    );
    assert.equal(
      JSON.parse(
        String(await readMcpResourceTool({ server: "fixture", uri: "fixture://note" }, ctx)),
      ).version,
      version,
    );
  }
  assert.deepEqual(manager.listServers(), ["fixture"]);
  await assert.rejects(manager.callTool("fixture", "echo", {}), /requires a workspace context/);
  await manager.releaseRun(a);
  assert.throws(() => MCPManager.forContext({ ...a }), /no longer active/);
  assert.ok(children.find((child) => child.pid === first.pid)?.closed);
  assert.equal(children.find((child) => child.pid === second.pid)?.closed, false);
  assert.equal(detail(await manager.callTool("fixture", "echo", {}, undefined, b)).pid, second.pid);
  assert.ok(registry.getTool("mcp_fixture_echo"));
});

test("normalized identical declarations reuse a single concurrent handshake", async () => {
  const { manager } = pool(),
    a = context(),
    b = context(),
    gate = join(directory, `init-${++sequence}`);
  const first = config("same", { env: { A: "1", B: "2", SYNTHETIC_INIT_GATE: gate } });
  const second = { ...first, env: { SYNTHETIC_INIT_GATE: gate, B: "2", A: "1" } };
  const count = children.length;
  const pa = manager.connectAll({ fixture: first }, {}, undefined, a, true);
  const pb = manager.connectAll({ fixture: second }, {}, undefined, b, true);
  await waitFor(
    () => children.length > count && events().some((e) => e.pid === children[count].pid),
  );
  assert.equal(children.length, count + 1);
  writeFileSync(gate, "go");
  await Promise.all([pa, pb]);
  assert.equal(
    detail(await manager.callTool("fixture", "echo", {}, undefined, a)).pid,
    detail(await manager.callTool("fixture", "echo", {}, undefined, b)).pid,
  );
});

test("CD uses each retained Run snapshot and never borrows a sibling version", async () => {
  const { manager } = pool(),
    owner = {},
    a = context(),
    b = context(),
    gate = join(directory, `cd-init-${++sequence}`);
  writeFileSync(gate, "go");
  await manager.connectAll(
    { fixture: config("v1", { env: { SYNTHETIC_INIT_GATE: gate } }) },
    owner,
    undefined,
    a,
    true,
  );
  await manager.connectAll({ fixture: config("v2") }, owner, undefined, b, true);
  const ca = { ...a, cwd: join(cwd, "sub") },
    cb = { ...b, cwd: join(cwd, "sub") };
  rmSync(gate);
  const count = children.length;
  const firstCall = manager.callTool("fixture", "echo", {}, undefined, ca);
  await waitFor(() => children.length > count);
  const secondCall = manager.callTool("fixture", "echo", {}, undefined, ca);
  const pendingCalls = Promise.allSettled([firstCall, secondCall]);
  writeFileSync(gate, "go");
  const results = await pendingCalls;
  assert.ok(
    results.every((result) => result.status === "fulfilled"),
    JSON.stringify(results),
  );
  const va = detail((results[0] as PromiseFulfilledResult<string>).value);
  assert.equal(detail((results[1] as PromiseFulfilledResult<string>).value).pid, va.pid);
  const vb = detail(await manager.callTool("fixture", "echo", {}, undefined, cb));
  assert.equal(va.version, "v1");
  assert.equal(vb.version, "v2");
  assert.equal(va.cwd, ca.cwd);
  assert.equal(vb.cwd, cb.cwd);
  assert.notEqual(va.pid, vb.pid);
  const retryContext = { ...a, cwd: join(cwd, "retry") };
  mkdirSync(retryContext.cwd, { recursive: true });
  rmSync(gate);
  await assert.rejects(
    manager.callTool("fixture", "echo", {}, undefined, retryContext),
    /timed out/i,
  );
  writeFileSync(gate, "go");
  assert.equal(
    detail(await manager.callTool("fixture", "echo", {}, undefined, retryContext)).version,
    "v1",
  );
  await assert.rejects(
    manager.callTool("fixture", "echo", {}, undefined, { ...a, cwd: directory }),
    /outside/,
  );
  await manager.releaseRun(a);
  assert.throws(() => MCPManager.forContext(ca), /no longer active/);
  assert.equal(
    JSON.parse(await manager.readResource("fixture", "fixture://note", undefined, cb)).version,
    "v2",
  );
});

test("cancelling one retained initialization does not abort a coalesced peer", async () => {
  const { manager } = pool(),
    abort = new AbortController(),
    a = { ...context(), signal: abort.signal },
    b = context();
  const gate = join(directory, `init-${++sequence}`),
    cfg = config("wait", { env: { SYNTHETIC_INIT_GATE: gate } });
  const count = children.length;
  const pa = manager.connectAll({ fixture: cfg }, {}, undefined, a, true);
  const pb = manager.connectAll({ fixture: cfg }, {}, undefined, b, true);
  await waitFor(
    () => children.length > count && events().some((e) => e.pid === children[count].pid),
  );
  abort.abort();
  await pa;
  await manager.releaseRun(a);
  assert.equal(children[count].closed, false);
  writeFileSync(gate, "go");
  await pb;
  assert.equal(
    detail(await manager.callTool("fixture", "echo", {}, undefined, b)).pid,
    children[count].pid,
  );
});

test("release settles an in-flight old Run request without closing a newer version", async () => {
  const { manager } = pool(),
    owner = {},
    a = context(),
    b = context();
  await manager.connectAll({ fixture: config("v1") }, owner, undefined, a, true);
  const oldPid = detail(await manager.callTool("fixture", "echo", {}, undefined, a)).pid;
  const gate = join(directory, `request-${++sequence}`);
  const call = manager.callTool("fixture", "echo", { gate }, undefined, a).then(
    () => "unexpected",
    (error) => error,
  );
  await waitFor(
    () => events().filter((e) => e.pid === oldPid && e.method === "tools/call").length === 2,
  );
  await manager.connectAll({ fixture: config("v2") }, owner, undefined, b, true);
  assert.equal(children.find((c) => c.pid === oldPid)?.closed, false);
  await manager.releaseRun(a);
  assert.notEqual(await call, "unexpected");
  assert.ok(children.find((c) => c.pid === oldPid)?.closed);
  assert.equal(detail(await manager.callTool("fixture", "echo", {}, undefined, b)).version, "v2");
});

test("failed newer initialization is released without invalidating the older same-owner Run", async () => {
  const { manager, registry } = pool(),
    owner = {},
    a = context(),
    b = context();
  await manager.connectAll({ fixture: config("v1") }, owner, undefined, a, true);
  let release!: () => Promise<void>;
  const failures = await connectRunMcp({
    mcpServers: { fixture: config("missing", { command: join(directory, "missing-executable") }) },
    mcpDisabled: false,
    getManager: () => manager,
    setManager: () => {},
    runtimePool: manager,
    toolRegistry: registry,
    engineForConnect: owner,
    toolContext: b,
    retainRun: (value) => {
      release = value;
    },
    emitNotificationHook: () => {},
  });
  assert.ok(failures.has("fixture"));
  await release();
  assert.equal(detail(await manager.callTool("fixture", "echo", {}, undefined, a)).version, "v1");
  assert.throws(() => MCPManager.forContext(b), /no longer active/);
});

test("direct SDK replacement selects the new version while an owned Run remains bound", async () => {
  const { manager } = pool(),
    a = context(),
    owner = {};
  await manager.connectAll({ fixture: config("v1") }, owner, undefined, a, true);
  await manager.connect("fixture", config("v2"), { cwd });
  assert.equal(
    detail(await manager.callTool("fixture", "echo", {}, undefined, { cwd })).version,
    "v2",
  );
  assert.equal(detail(await manager.callTool("fixture", "echo", {}, undefined, a)).version, "v1");
  await manager.connect("fixture", config("v3"), { cwd });
  assert.equal(
    detail(await manager.callTool("fixture", "echo", {}, undefined, { cwd })).version,
    "v3",
  );
  await manager.releaseRun(a);
  await manager.connect("sdk", config("standalone"), { cwd });
  assert.equal(
    detail(await manager.callTool("sdk", "echo", {}, undefined, { cwd })).version,
    "standalone",
  );
  await manager.unregisterOwner(owner);
  assert.equal(
    detail(await manager.callTool("fixture", "echo", {}, undefined, { cwd })).version,
    "v3",
  );
  assert.equal(
    detail(await manager.callTool("sdk", "echo", {}, undefined, { cwd })).version,
    "standalone",
  );
  const sdkContext = context();
  await manager.connectAll({ sdk: config("v4") }, undefined, undefined, sdkContext);
  const previous = detail(await manager.callTool("sdk", "echo", {}, undefined, sdkContext));
  await manager.connectAll({ sdk: config("v5") }, undefined, undefined, sdkContext);
  assert.equal(
    detail(await manager.callTool("sdk", "echo", {}, undefined, sdkContext)).version,
    "v5",
  );
  assert.equal(children.find((child) => child.pid === previous.pid)?.closed, true);
  await manager.releaseRun(sdkContext);
  await manager.reconcile({ fixture: config("v3") });
  await assert.rejects(manager.callTool("sdk", "echo", {}, undefined, { cwd }), /not connected/);
});

test("actual Engine keeps the lease through on_agent_end and reloads transport next Run", async () => {
  const { engine, runtime } = engineFixture();
  const contexts: ToolContext[] = [],
    observations: unknown[] = [],
    hookErrors: unknown[] = [];
  engine.registerCustomTool(
    {
      name: "CaptureMcpContext",
      description: "Local acceptance only",
      inputSchema: { type: "object", properties: {} },
      source: "custom",
      permissionDefault: "allow",
      isReadOnly: true,
    },
    async (_args, ctx) => {
      contexts.push(ctx!);
      const data = detail(
        await MCPManager.forContext(ctx).callTool("fixture", "echo", {}, undefined, ctx),
      );
      return JSON.stringify(data);
    },
  );
  engine.getHookRegistry().register("on_agent_end", async () => {
    try {
      const ctx = contexts.at(-1)!;
      const data = detail(
        await MCPManager.forContext(ctx).callTool("fixture", "echo", {}, undefined, ctx),
      );
      assert.equal(children.find((child) => child.pid === data.pid)?.closed, false);
      observations.push(data);
    } catch (error) {
      hookErrors.push(String(error));
    }
    return {};
  });
  beforeResponse = () => engine.refreshRuntimeConfig({ mcpServers: { fixture: config("v2") } }, 1);
  const options = { behaviorMode: "quiet", toolAllowlist: ["CaptureMcpContext"] };
  responsesInRun = 0;
  const first = await engine.run("Only the in-memory local acceptance client.", options);
  assert.equal(first.reason, "completed");
  assert.equal(contexts.length, 1);
  assert.throws(() => MCPManager.forContext(contexts[0]), /no longer active/);
  responsesInRun = 0;
  const second = await engine.run("Only the in-memory local acceptance client.", options);
  assert.equal(second.reason, "completed");
  assert.equal(contexts.length, 2);
  assert.throws(() => MCPManager.forContext(contexts[1]), /no longer active/);
  assert.deepEqual(hookErrors, []);
  assert.deepEqual(
    observations.map((data: any) => data.version),
    ["v1", "v2"],
  );
  assert.ok(children.find((child) => child.pid === (observations[0] as any).pid)?.closed);
  await engine.dispose();
  engines.delete(engine);
  await runtime.close();
});

test("actual Engine initialization failure releases its Run binding before returning", async () => {
  const { engine, runtime, manager } = engineFixture("init-failure");
  const before = syntheticResponses;
  const result = await engine.run("No model request may occur.", { behaviorMode: "quiet" });
  assert.equal(result.reason, "model_error");
  assert.match(result.text, /synthetic client initialization failure/);
  // Read-only observation of the actual context, not replacement of its resolver.
  const ctx = (manager as unknown as { scopeByOwner: Map<unknown, ToolContext> }).scopeByOwner.get(
    engine,
  )!;
  assert.ok(ctx);
  assert.throws(() => MCPManager.forContext(ctx), /no longer active/);
  assert.equal(syntheticResponses, before);
  await engine.dispose();
  engines.delete(engine);
  await runtime.close();
});
