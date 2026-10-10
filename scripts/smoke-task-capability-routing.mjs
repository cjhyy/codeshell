import assert from "node:assert/strict";
import { createServer } from "node:http";
import https from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { installLocalNetworkGuard } from "./runtime-cost-smoke-isolation.mjs";

// The outer wrapper supplies a fresh HOME before any compiled Core import.
// This synthetic HTTP provider is the only permitted origin; no paid model or
// account participates. Provider schemas are observed at the actual SDK wire.
assert.ok(process.env.CODE_SHELL_TEST_HOME, "run-isolated-node-smoke.mjs is required");
const root = mkdtempSync(join(tmpdir(), "codeshell-task-routing-"));
const scenarios = new Map();
const engines = [];
const results = [];
let fixtureFailure;
let requestCount = 0;
let auxiliaryRequests = 0;
let report;
const canary = "ROUTING_PROMPT_CANARY_9a7c";
const server = createServer((req, res) => {
  void respond(req, res).catch((error) => {
    fixtureFailure ??= error;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "synthetic fixture failed" } }));
  });
});
async function respond(req, res) {
  let raw = "";
  for await (const part of req) {
    raw += part;
    assert.ok(raw.length < 2 * 1024 * 1024, "bounded fixture request");
  }
  assert.equal(req.url, "/v1/chat/completions");
  const body = JSON.parse(raw);
  const scenario = scenarios.get(body.model);
  assert.ok(scenario, "unexpected model");
  requestCount++;
  // All main fixture steps require at least one schema. Auxiliary calls can
  // finish after a Run, so prompt-prefix matching alone is insufficient.
  const auxiliary =
    !body.tools?.length ||
    [
      "Generate a very brief (under 40 chars) summary of what these tools did.",
      "You generate a very short title",
    ].some((prefix) => body.messages[0]?.content?.startsWith(prefix));
  if (auxiliary) auxiliaryRequests++;
  if (!auxiliary) scenario.bodies.push(body);
  if (!auxiliary && scenario.failures > 0) {
    scenario.failures--;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "synthetic retry" } }));
    return;
  }
  const calls = auxiliary ? [] : scenario.handle(body, ++scenario.steps);
  const delta = calls.length
    ? {
        tool_calls: calls.map((call, index) => ({
          index,
          id: `routing-${scenario.steps}-${index}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        })),
      }
    : { content: "fixture complete" };
  const response = {
    id: `routing-${scenario.steps}`,
    object: body.stream ? "chat.completion.chunk" : "chat.completion",
    created: 1,
    model: body.model,
    choices: [
      {
        index: 0,
        ...(body.stream ? { delta } : { message: { role: "assistant", ...delta } }),
        finish_reason: calls.length ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  };
  res.setHeader("content-type", body.stream ? "text/event-stream" : "application/json");
  res.end(
    body.stream
      ? `data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`
      : JSON.stringify(response),
  );
}
const names = (body) => (body.tools ?? []).map((tool) => tool.function.name);
const bounded = (body) => {
  assert.ok(names(body).length >= 8 && names(body).length <= 15);
  assert.ok(names(body).includes("ToolSearch"));
};
const catalog = (body) => body.messages[0].content;
const catalogNames = (body) => {
  const listing = catalog(body).match(/# Available Tools\n\n[^\n]+\n([^\n]+)/)?.[1];
  assert.ok(listing, "the full eligible catalog is present");
  return new Set(listing.split(", "));
};
try {
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      done();
    });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  installLocalNetworkGuard(origin);
  assert.throws(() => fetch("https://guard.invalid/"), /non-fixture/);
  assert.throws(() => https.request("https://guard.invalid/"), /non-fixture/);
  // These are compiled package boundaries, never flattened source fixtures.
  const core = await import("@cjhyy/code-shell-core");
  const host = await import("@cjhyy/code-shell-core/internal");
  const coding = await import("../packages/coding/dist/index.capability.js");
  const quiet = {
    id: "routing-fixture",
    disableSessionTitle: true,
    disableHooks: true,
    disableInstructions: true,
    disableMemoryContext: true,
    disableSourcesContext: true,
    disableCapabilityContext: true,
    disableMcp: true,
  };
  const restricted = {
    ...quiet,
    id: "routing-restricted",
    allowedToolNames: new Set(["Read", "Sleep"]),
  };
  function create(label, options = {}) {
    const scenario = { bodies: [], steps: 0, failures: 0, handle: () => [] };
    const model = `gpt-4o-routing-${label}`;
    scenarios.set(model, scenario);
    const cwd = join(root, label);
    mkdirSync(cwd);
    const engine = new core.Engine({
      llm: { provider: "openai", model, apiKey: "synthetic-fixture", baseUrl: `${origin}/v1` },
      cwd,
      sessionStorageDir: join(root, `${label}-sessions`),
      preset: "general",
      settingsScope: "isolated",
      headless: true,
      isSubAgent: true,
      maxTurns: 5,
      behaviorProfiles: [quiet, restricted],
      permissionMode: "default",
      approvalBackend: { requestApproval: async () => ({ approved: true }) },
      ...options,
    });
    engines.push(engine);
    return {
      engine,
      cwd,
      scenario,
      async run(task, handle = () => [], extra = {}) {
        scenario.bodies = [];
        scenario.steps = 0;
        scenario.handle = handle;
        const result = await engine.run(`${task}\n${canary}`, {
          sessionId: `s-${label}`,
          behaviorMode: quiet.id,
          ...extra,
        });
        if (fixtureFailure) throw fixtureFailure;
        assert.equal(result.reason, "completed");
        assert.ok(scenario.bodies.length > 0, "each Run reaches its actual primary schema request");
        return scenario.bodies;
      },
    };
  }

  const general = create("general");
  const file = join(general.cwd, "notes.txt");
  writeFileSync(file, "LOCAL_FILE_RESULT_319\n");
  const fileBodies = await general.run("read file", (body, step) => {
    if (step === 1) {
      bounded(body);
      assert.ok(
        names(body).includes("Read") &&
          names(body).includes("Glob") &&
          names(body).includes("Grep"),
      );
      assert.ok(!names(body).includes("ReadSource"));
      assert.ok(catalog(body).includes("ReadSource"), "complete eligible catalog");
      return [{ name: "Read", args: { file_path: file } }];
    }
    assert.match(JSON.stringify(body.messages), /LOCAL_FILE_RESULT_319/);
    return [];
  });
  results.push({ case: "local-file-consumer", initialTools: names(fileBodies[0]) });

  const document = join(general.cwd, "reference.txt");
  writeFileSync(document, "LOCAL_COLLECTION_RESULT_821\n");
  host.saveSourceDefinition({
    id: "routing-library",
    kind: "collection",
    label: "Synthetic local documents",
    enabled: true,
    adapterConfig: {
      version: 1,
      revision: randomUUID(),
      entries: [host.captureCollectionLocalFile(document, "reference")],
    },
  });
  host.bindSource(new core.SettingsManager(general.cwd, "isolated"), general.cwd, {
    sourceId: "routing-library",
    scopes: ["reference"],
    readPolicy: "ask",
  });
  const sourceBodies = await general.run("读取资料集文档", (body, step) => {
    if (step === 1) {
      bounded(body);
      assert.ok(names(body).includes("ListSources") && names(body).includes("ReadSource"));
      assert.notDeepEqual(names(body), names(fileBodies[0]), "new Run changes its initial route");
      assert.ok(catalog(body).includes("Glob"), "file tools remain discoverable");
      return [
        {
          name: "ReadSource",
          args: { source: "routing-library", scope: "reference", resource: "reference" },
        },
      ];
    }
    assert.match(JSON.stringify(body.messages), /LOCAL_COLLECTION_RESULT_821/);
    return [];
  });
  results.push({ case: "local-collection-consumer", initialTools: names(sourceBodies[0]) });
  assert.deepEqual(catalogNames(fileBodies[0]), catalogNames(sourceBodies[0]));

  const code = create("coding", {
    modules: [coding.createCodingModule()],
    preset: "terminal-coding",
  });
  const target = join(code.cwd, "fixture.txt");
  writeFileSync(target, "before\n");
  const codeBodies = await code.run("修复代码并测试", (body, step) => {
    if (step === 1) {
      bounded(body);
      assert.ok(names(body).includes("ApplyPatch"));
      assert.ok(!names(body).includes("Write"));
      return [
        {
          name: "ApplyPatch",
          args: {
            patch:
              "*** Begin Patch\n*** Update File: fixture.txt\n@@\n-before\n+after\n*** End Patch",
          },
        },
      ];
    }
    assert.equal(readFileSync(target, "utf8"), "after\n");
    return [];
  });
  const codeFileBodies = await code.run("read file", (body) => {
    bounded(body);
    assert.ok(!names(body).includes("ApplyPatch"));
    assert.ok(catalog(body).includes("ApplyPatch"));
    return [];
  });
  assert.notDeepEqual(names(codeBodies[0]), names(codeFileBodies[0]));
  assert.deepEqual(catalogNames(codeBodies[0]), catalogNames(codeFileBodies[0]));
  assert.ok(code.engine.getToolRegistry().hasTool("DriveAgent"));
  results.push({ case: "coding-owned-patch-consumer", initialTools: names(codeBodies[0]) });

  const counters = { executions: 0, approvals: 0, pre: 0, starts: 0 };
  const deferred = create("deferred", {
    approvalBackend: {
      requestApproval: async () => {
        counters.approvals++;
        return { approved: true };
      },
    },
  });
  deferred.engine.registerCustomTool(
    {
      name: "RoutingAction",
      description: "Synthetic routed deferred action",
      inputSchema: { type: "object", properties: { marker: { const: "ROUTING_SCHEMA_4" } } },
      source: "builtin",
      permissionDefault: "ask",
    },
    async () => {
      counters.executions++;
      return "action complete";
    },
  );
  deferred.engine.getHookRegistry().clear();
  for (const [hook, field] of [
    ["pre_tool_use", "pre"],
    ["on_tool_start", "starts"],
  ]) {
    deferred.engine.getHookRegistry().register(hook, async ({ data }) => {
      if (data.toolName === "RoutingAction") counters[field]++;
      return {};
    });
  }
  deferred.scenario.failures = 1;
  const progressive = await deferred.run("read file", (body, step) => {
    if (step === 1) {
      bounded(body);
      assert.ok(!names(body).includes("RoutingAction"));
      assert.ok(!JSON.stringify(body.tools).includes("ROUTING_SCHEMA_4"));
      return [
        { name: "ToolSearch", args: { query: "select:RoutingAction" } },
        { name: "RoutingAction" },
      ];
    }
    assert.ok(names(body).includes("RoutingAction"));
    assert.ok(JSON.stringify(body.tools).includes("ROUTING_SCHEMA_4"));
    if (step === 2) {
      assert.deepEqual(counters, { executions: 0, approvals: 0, pre: 0, starts: 0 });
      assert.match(JSON.stringify(body.messages), /next model step/);
      return [{ name: "RoutingAction", args: { marker: "ROUTING_SCHEMA_4" } }];
    }
    assert.deepEqual(counters, { executions: 1, approvals: 1, pre: 1, starts: 1 });
    return [];
  });
  assert.equal(progressive.length, 4, "one SDK retry and three model steps");
  assert.deepEqual(
    progressive[0].tools,
    progressive[1].tools,
    "retry uses the identical schema snapshot",
  );
  assert.deepEqual(catalogNames(progressive[0]), catalogNames(progressive.at(-1)));
  await deferred.run("读取资料集文档", (body) => {
    assert.ok(!names(body).includes("RoutingAction"), "selection does not leak into another Run");
    assert.ok(names(body).includes("ReadSource"), JSON.stringify({ initialTools: names(body) }));
    return [];
  });
  results.push({
    case: "discovery-next-step-retry-and-run-reset",
    initialTools: names(progressive[0]),
  });

  for (const extra of [{ toolAllowlist: ["Read", "Sleep"] }, { behaviorMode: restricted.id }]) {
    await general.run(
      "读取资料集文档",
      (body) => {
        assert.deepEqual(new Set(names(body)), new Set(["Read", "Sleep"]));
        return [];
      },
      extra,
    );
  }
  results.push({ case: "run-and-behavior-allowlists" });
  for (const discovery of [true, false]) {
    const legacy = create(`legacy-${discovery}`, {
      preset: "legacy-fixture",
      modules: [
        {
          id: "legacy-fixture",
          engine: {
            presets: [
              {
                name: "legacy-fixture",
                label: "Legacy",
                description: "No routing policy",
                promptSections: [],
                builtinTools: ["Read", "Sleep", ...(discovery ? ["ToolSearch"] : [])],
                initialToolNames: ["ToolSearch"],
                defaultPermissionRules: [],
              },
            ],
          },
        },
      ],
    });
    await legacy.run("read file", (body) => {
      assert.deepEqual(
        new Set(names(body)),
        new Set(discovery ? ["ToolSearch"] : ["Read", "Sleep"]),
      );
      return [];
    });
  }
  results.push({ case: "custom-and-no-discovery-compatibility" });

  // Only the new routing diagnostics are in scope; existing Engine task logs
  // have their own policy. No assertion or output serializes the task canary.
  const logs = join(process.env.HOME, ".code-shell", "logs");
  const routingEntries = readdirSync(logs)
    .filter((name) => name.endsWith(".log"))
    .flatMap((name) =>
      readFileSync(join(logs, name), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    )
    .filter((entry) => entry.msg === "tool.surface.routed");
  assert.ok(routingEntries.length >= 6, "actual routing diagnostics exist");
  for (const entry of routingEntries) {
    assert.ok(!JSON.stringify(entry).includes(canary));
    assert.deepEqual(
      Object.keys(entry.d).sort(),
      ["cat", "eligibleCount", "initialCount", "initialTools", "reason", "ruleIds"].sort(),
    );
  }
  if (fixtureFailure) throw fixtureFailure;
  report = {
    valid: true,
    pid: process.pid,
    cases: results,
    exactOriginRequests: requestCount,
    auxiliaryRequests,
    guardDenials: 2,
    routingEvents: routingEntries.length,
  };
} finally {
  try {
    await Promise.all(engines.map((engine) => engine.dispose()));
  } finally {
    if (server.listening)
      await new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    rmSync(root, { recursive: true, force: true });
  }
}
report.cleanup = {
  enginesDisposed: engines.length,
  serverClosed: !server.listening,
  fixtureRemoved: true,
};
console.log(JSON.stringify(report));
