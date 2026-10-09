import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, mock, test } from "bun:test";
import { installLocalNetworkGuard } from "../../scripts/runtime-cost-smoke-isolation.mjs";
import type { CreateMessageOptions } from "../../packages/core/src/llm/types.js";
import type { LLMResponse } from "../../packages/core/src/types.js";

// Run only through run-bun-test-shard: do not load Core against operator state.
const home = process.env.HOME!;
assert.equal(realpathSync(home), home);
assert.equal(homedir(), home);
assert.equal(process.env.USERPROFILE, home);
assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
assert.equal(process.env.CODE_SHELL_TEST_HOME, process.env.CODE_SHELL_HOME);
assert.equal(process.env.CODE_SHELL_DATA_ROOT, undefined);
for (const key of Object.keys(process.env)) {
  assert.ok(!/^(https?_proxy|all_proxy|no_proxy)$/i.test(key));
  assert.ok(!/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PROVIDER_KEY)$/i.test(key));
}
const origin = "http://127.0.0.1:9"; // Identifies the fixture; no HTTP service is started.
installLocalNetworkGuard(origin);
let deniedRequests = 0;
const deny = () => {
  deniedRequests++;
  throw new Error("MCP-profile fixture denies every HTTP request");
};
globalThis.fetch = deny as typeof fetch;
for (const transport of [http, https]) {
  transport.request = deny as typeof transport.request;
  transport.get = deny as typeof transport.get;
}
syncBuiltinESMExports();
// Bun snapshots built-in named exports before syncBuiltinESMExports. Ensure later
// Core imports receive the same deny-all boundary as default/CJS HTTP imports.
mock.module("node:http", () => ({ ...http, default: http, request: deny, get: deny }));
mock.module("node:https", () => ({ ...https, default: https, request: deny, get: deny }));
const { request: namedRequest } = await import("node:http");
const { get: namedHttpsGet } = await import("node:https");
assert.equal(namedRequest, deny);
assert.equal(namedHttpsGet, deny);
const probes = [
  () => fetch(origin),
  () => fetch("https://example.invalid/negative-probe"),
  () => http.request(origin),
  () => namedRequest(new URL(origin)),
  () => http.get(origin),
  () => https.request("https://example.invalid/negative-probe"),
  () => https.get("https://example.invalid/negative-probe"),
  () => namedHttpsGet("https://example.invalid/negative-probe"),
];
for (const probe of probes) assert.throws(probe, /denies every HTTP request/);
assert.equal(deniedRequests, probes.length);
deniedRequests = 0;
const guard = {
  pid: process.pid,
  ppid: process.ppid,
  runtime: process.versions,
  homeId: createHash("sha256").update(home).digest("hex"),
  origin,
  negativeProbes: probes.length,
  privateHome: {
    actualHomeMatches: homedir() === home && realpathSync(home) === home,
    userProfileMatches: process.env.USERPROFILE === home,
    stateRootMatches: process.env.CODE_SHELL_HOME === join(home, ".code-shell"),
    testStateRootMatches: process.env.CODE_SHELL_TEST_HOME === process.env.CODE_SHELL_HOME,
    customDataRootAbsent: process.env.CODE_SHELL_DATA_ROOT === undefined,
  },
};
const evidenceDir = mkdtempSync(join(tmpdir(), "codeshell-mcp-profile-evidence-"));
const preimportReceipt = join(evidenceDir, "preimport-guard.json");
writeFileSync(preimportReceipt, JSON.stringify({ phase: "before-Core-import", guard }) + "\n", {
  mode: 0o600,
});
console.log(`MCP-profile preimport evidence: ${preimportReceipt}`);

// Core is imported only after all eight deny-all probes and real HOME checks.
const { Engine } = await import("../../packages/core/src/engine/engine.js");
const { EngineRuntime } = await import("../../packages/core/src/engine/runtime.js");
const { ModelPool } = await import("../../packages/core/src/llm/model-pool.js");
const { CostTracker } = await import("../../packages/core/src/cost-tracker.js");
const { SettingsManager } = await import("../../packages/core/src/settings/manager.js");
const { ToolRegistry } = await import("../../packages/core/src/tool-system/registry.js");
const { MCPManager } = await import("../../packages/core/src/tool-system/mcp-manager.js");
const { LLMClientBase } = await import("../../packages/core/src/llm/client-base.js");
const { registerProvider } = await import("../../packages/core/src/llm/client-factory.js");
const { saveWorkspaceProfile } = await import("../../packages/core/src/profile/store.js");
const { saveSourceDefinition } = await import("../../packages/core/src/sources/catalog.js");
const { bindSource } = await import("../../packages/core/src/sources/binding.js");
const { defaultMcpResourceAdapter } =
  await import("../../packages/core/src/sources/adapters/mcp-resource.js");
const { snapshotRunMcpServers } = await import("../../packages/core/src/engine/run-tooling.js");

type Control = {
  tools: string[][];
  calls: number;
  actions: { toolName: string; args: Record<string, unknown> }[];
  messages: string[];
  results: unknown[];
  before?: () => Promise<void>;
};
const provider = "profile-mcp-local-fixture";
const controls = new Map<string, Control>();
let toolCallSequence = 0;
const tools = ["MCPTool", "ListMcpResources", "ReadMcpResource", "ReadSource", "ListSources"];
class LocalClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const c = controls.get(this.model)!;
    assert.ok(c, "No real provider fallback is permitted");
    c.tools.push(options.tools?.map((tool) => tool.name) ?? []);
    c.messages.push(JSON.stringify(options.messages));
    if (c.calls++ === 0 && c.before) await c.before();
    const actions = c.actions.splice(0);
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    this.recordUsage(usage, options);
    return {
      text: actions.length ? "" : "done",
      toolCalls: actions.map((call, i) => ({ ...call, id: `local-${++toolCallSequence}-${i}` })),
      stopReason: actions.length ? "tool_use" : "stop",
      usage,
    };
  }
}
registerProvider(provider, LocalClient);
const evidence: unknown[] = [];
const owners: InstanceType<typeof Engine>[] = [];
const runtimes: InstanceType<typeof EngineRuntime>[] = [];
const fixture = join(evidenceDir, "mcp-server.mjs");
const childLog = join(evidenceDir, "mcp-children.jsonl");
writeFileSync(
  fixture,
  String.raw`
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
const deny = () => { throw new Error("Local stdio fixture denies HTTP"); };
globalThis.fetch = deny;
for (const t of [http, https]) { t.request = deny; t.get = deny; }
for (const probe of [() => fetch("https://example.invalid"), () => http.get("http://127.0.0.1:9")]) {
  try { probe(); throw new Error("probe escaped"); } catch (e) { if (!String(e).includes("denies HTTP")) throw e; }
}
const log = (data) => appendFileSync(process.argv[2], JSON.stringify(data) + "\n");
log({ phase: "started", pid: process.pid, ppid: process.ppid, homeId: createHash("sha256").update(process.env.HOME).digest("hex"), negativeProbes: 2 });
process.on("exit", () => log({ phase: "exit", pid: process.pid }));
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  log({ phase: "request", pid: process.pid, method: request.method });
  let result;
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "local-profile", version: "1" } };
  else if (request.method === "tools/list") result = { tools: [{ name: "echo", description: "Local fixture", inputSchema: { type: "object", properties: {} } }] };
  else if (request.method === "tools/call") result = { content: [{ type: "text", text: "LOCAL_MCP_ECHO" }] };
  else if (request.method === "resources/list") result = { resources: [{ uri: "fixture://note", name: "fixture-note" }] };
  else if (request.method === "resources/read") result = { contents: [{ uri: "fixture://note", text: "LOCAL_MCP_RESOURCE" }] };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
`,
  { mode: 0o600 },
);
const logEntries = () =>
  existsSync(childLog)
    ? readFileSync(childLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
function settings(cwd: string, value: object, local = false) {
  mkdirSync(join(cwd, ".code-shell"), { recursive: true });
  writeFileSync(
    join(cwd, ".code-shell", local ? "settings.local.json" : "settings.json"),
    JSON.stringify(value),
  );
}
let counter = 0;
function makeEngine(name: string, enabled = true, runtime?: InstanceType<typeof EngineRuntime>) {
  const cwd = join(home, name);
  mkdirSync(cwd, { recursive: true });
  const model = `local-${++counter}`;
  const baseline = {
    fixture: { name: "fixture", command: process.execPath, args: [fixture, childLog], enabled },
  };
  const engine = new Engine({
    cwd,
    runtime,
    settingsScope: "project",
    projectTrusted: true,
    sessionStorageDir: join(cwd, "sessions"),
    llm: { provider, model, apiKey: "synthetic-local" } as never,
    permissionMode: "bypassPermissions",
    enabledBuiltinTools: tools,
    maxTurns: 4,
    mcpServers: baseline,
    behaviorProfiles: [
      {
        id: "quiet",
        disableHooks: true,
        disableInstructions: true,
        disableMemoryContext: true,
        disableSessionTitle: true,
      },
    ],
  });
  owners.push(engine);
  let version = 0;
  let previousResultCount = 0;
  return {
    engine,
    cwd,
    baseline,
    reload: (next = baseline) => engine.refreshRuntimeConfig({ mcpServers: next }, ++version),
    async run(
      actions: Control["actions"] = [],
      options: Record<string, unknown> = {},
      before?: Control["before"],
    ) {
      const c: Control = {
        tools: [],
        messages: [],
        results: [],
        actions: [...actions],
        calls: 0,
        before,
      };
      controls.set(model, c);
      const result = await engine.run("Use only the synthetic local fixture.", {
        sessionId: name,
        behaviorMode: "quiet",
        toolAllowlist: [...tools, "mcp_fixture_echo"],
        ...options,
      });
      const results = engine.getSessionManager().resume(name).transcript.getEvents("tool_result");
      c.results = results.slice(previousResultCount);
      previousResultCount = results.length;
      evidence.push({ name, reason: result.reason, tools: c.tools, results: c.results });
      expect(result.reason).toBe("completed");
      return c;
    },
  };
}
const echo = { toolName: "MCPTool", args: { server: "fixture", tool: "echo" } };
const resource = {
  toolName: "ReadMcpResource",
  args: { server: "fixture", uri: "fixture://note" },
};
const source = {
  toolName: "ReadSource",
  args: { source: "mcp-fixture", scope: "resources", resource: "fixture://note" },
};
const hasTool = (c: Control) => c.tools.some((names) => names.includes("mcp_fixture_echo"));
const output = (c: Control) => JSON.stringify(c.results);

saveWorkspaceProfile({ name: "mcp-on", label: "MCP on", basePreset: "general", mcp: ["fixture"] });
saveSourceDefinition({
  id: "mcp-fixture",
  label: "MCP fixture",
  kind: "mcp-resource",
  adapterConfig: { server: "fixture" },
  enabled: true,
});

test("project off blocks actual connections, generic tools and MCP source reads", async () => {
  const e = makeEngine("project-off");
  settings(e.cwd, { capabilityOverrides: { mcp: { fixture: "off", absent: "on" } } });
  bindSource(new SettingsManager(e.cwd, "project"), e.cwd, {
    sourceId: "mcp-fixture",
    scopes: ["resources"],
    readPolicy: "ask",
  });
  const before = logEntries().length;
  const c = await e.run([echo, resource, source]);
  expect(hasTool(c)).toBe(false);
  expect(logEntries().length).toBe(before);
  expect(output(c)).not.toContain("LOCAL_MCP_RESOURCE");
  expect(output(c)).not.toContain("LOCAL_MCP_ECHO");
});

test("enabled MCP source uses actual bound Run metadata and content reads", async () => {
  const e = makeEngine("source-on");
  bindSource(new SettingsManager(e.cwd, "project"), e.cwd, {
    sourceId: "mcp-fixture",
    scopes: ["resources"],
    readPolicy: "ask",
  });
  const before = logEntries().filter((e) => e.method === "resources/read").length;
  const c = await e.run([source, { toolName: "ListSources", args: {} }]);
  expect(output(c)).toContain("LOCAL_MCP_RESOURCE");
  expect(output(c)).toContain("fixture-note");
  expect(logEntries().filter((e) => e.method === "resources/read").length).toBe(before + 1);
});

test("project on then inherit restores disabled baseline, and off then inherit restores enabled", async () => {
  for (const enabled of [false, true]) {
    const e = makeEngine(`restore-${enabled}`, enabled);
    settings(e.cwd, { capabilityOverrides: { mcp: { fixture: enabled ? "off" : "on" } } });
    const actions = [echo, resource, { toolName: "mcp_fixture_echo", args: {} }];
    const overridden = await e.run(actions);
    expect(hasTool(overridden)).toBe(!enabled);
    expect(output(overridden).includes("LOCAL_MCP_ECHO")).toBe(!enabled);
    settings(e.cwd, { capabilityOverrides: { mcp: { fixture: "inherit" } } });
    e.reload();
    const inherited = await e.run(actions);
    expect(hasTool(inherited)).toBe(enabled);
    expect(output(inherited).includes("LOCAL_MCP_ECHO")).toBe(enabled);
    expect(e.baseline.fixture.enabled).toBe(enabled);
    await e.engine.dispose();
  }
});

test("Session Profile wins default snapshot, direct project wins Profile, and local wins project", async () => {
  const e = makeEngine("precedence", false);
  settings(e.cwd, { profile: { active: "mcp-on", overrides: { mcp: { fixture: "off" } } } });
  expect(hasTool(await e.run())).toBe(false);
  expect(hasTool(await e.run([], { workspaceProfile: "mcp-on" }))).toBe(true);
  settings(e.cwd, { capabilityOverrides: { mcp: { fixture: "off" } } });
  e.reload();
  expect(hasTool(await e.run())).toBe(false);
  settings(e.cwd, { capabilityOverrides: { mcp: { fixture: "on" } } }, true);
  e.reload();
  expect(hasTool(await e.run())).toBe(true);
});

test("hot reload keeps current Run snapshot and applies removal at the next Run", async () => {
  const e = makeEngine("frozen-run");
  const c = await e.run([echo, resource], {}, async () => {
    e.reload({} as typeof e.baseline);
  });
  expect(hasTool(c)).toBe(true);
  expect(output(c)).toContain("LOCAL_MCP_ECHO");
  expect(output(c)).toContain("LOCAL_MCP_RESOURCE");
  expect(hasTool(await e.run([echo, resource]))).toBe(false);
  expect((e.engine as any).mcpManager.listServers()).toEqual([]);
});

test("shared pool retains sibling scope and off owner cannot use Source singleton fallback", async () => {
  const root = join(home, "shared");
  mkdirSync(root, { recursive: true });
  const registry = new ToolRegistry({ builtinTools: tools });
  const pool = new MCPManager(registry);
  const runtime = new EngineRuntime({
    modelPool: new ModelPool(),
    toolRegistry: registry,
    settings: new SettingsManager(root, "project"),
    mcpPool: pool,
    costTracker: new CostTracker(),
  });
  runtimes.push(runtime);
  const first = makeEngine("shared-a", true, runtime);
  const second = makeEngine("shared-b", true, runtime);
  expect(output(await first.run([echo]))).toContain("LOCAL_MCP_ECHO");
  settings(second.cwd, { capabilityOverrides: { mcp: { fixture: "off" } } });
  bindSource(new SettingsManager(second.cwd, "project"), second.cwd, {
    sourceId: "mcp-fixture",
    scopes: ["resources"],
    readPolicy: "ask",
  });
  const before = logEntries().filter((e) => e.method === "resources/read").length;
  const c = await second.run([echo, resource, source, { toolName: "ListMcpResources", args: {} }]);
  expect(hasTool(c)).toBe(false);
  expect(output(c)).not.toContain("LOCAL_MCP_RESOURCE");
  expect(logEntries().filter((e) => e.method === "resources/read").length).toBe(before);
  expect(pool.listServers()).toEqual(["fixture"]);
  await second.engine.dispose();
  expect(output(await first.run([echo]))).toContain("LOCAL_MCP_ECHO");
  await first.engine.dispose();
  expect(pool.listServers()).toEqual([]);
});

test("default MCP source fails closed without native Run binding", async () => {
  const adapter = defaultMcpResourceAdapter();
  const definition = {
    id: "mcp-fixture",
    label: "MCP fixture",
    kind: "mcp-resource" as const,
    adapterConfig: { server: "fixture" },
    enabled: true,
  };
  await expect(adapter.listResources(definition, "resources")).rejects.toThrow("owning Run");
  await expect(adapter.read(definition, "fixture://note", { maxBytes: 100 })).rejects.toThrow(
    "owning Run",
  );
});

test("snapshot never creates unknown servers or mutates baseline transport fields", () => {
  const baseline = {
    fixture: {
      name: "fixture",
      command: "local",
      args: ["one"],
      env: { TEST: "one" },
      enabled: false,
    },
  };
  const snapshot = snapshotRunMcpServers(baseline, { fixture: "on", absent: "on" });
  baseline.fixture.args[0] = "two";
  baseline.fixture.env.TEST = "two";
  expect(Object.keys(snapshot)).toEqual(["fixture"]);
  expect(snapshot.fixture).toEqual({
    name: "fixture",
    command: "local",
    args: ["one"],
    env: { TEST: "one" },
    enabled: true,
  });
  expect(snapshotRunMcpServers(baseline, { fixture: "inherit" }).fixture.enabled).toBe(false);
});

afterAll(async () => {
  for (const engine of owners) await engine.dispose();
  for (const runtime of runtimes) await runtime.close();
  expect(deniedRequests).toBe(0);
  const children = logEntries().filter((e) => e.phase === "started");
  expect(children.length).toBeGreaterThan(0);
  const deadline = Date.now() + 1_000;
  while (
    logEntries().filter((e) => e.phase === "exit").length < children.length &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(
    logEntries()
      .filter((e) => e.phase === "exit")
      .map((e) => e.pid)
      .sort(),
  ).toEqual(children.map((e) => e.pid).sort());
  for (const child of children) {
    expect(child.homeId).toBe(guard.homeId);
    expect(child.negativeProbes).toBe(2);
  }
  writeFileSync(
    join(evidenceDir, "result.json"),
    JSON.stringify({ guard, deniedRequests, children: logEntries(), cases: evidence }, null, 2),
  );
  console.log(`MCP-profile actual evidence: ${evidenceDir}`);
});
