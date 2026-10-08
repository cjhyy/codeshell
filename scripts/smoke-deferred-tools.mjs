import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { installLocalNetworkGuard } from "./runtime-cost-smoke-isolation.mjs";

// Always invoke through run-isolated-node-smoke.mjs. Guard networking BEFORE
// loading the compiled SDK; only this exact fixture origin can receive IO.
assert.ok(process.env.CODE_SHELL_TEST_HOME, "private Node smoke wrapper required");
const root = mkdtempSync(join(tmpdir(), "codeshell-deferred-sdk-"));
const scenarios = new Map();
const requests = [];
let fixtureFailure;
const server = createServer((req, res) => {
  void respond(req, res).catch((error) => {
    fixtureFailure = error;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "fixture assertion failed" } }));
  });
});
async function respond(req, res) {
  let raw = "";
  for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  assert.equal(req.url, "/v1/chat/completions");
  requests.push(body);
  const scenario = scenarios.get(body.model);
  assert.ok(scenario, "unexpected model request");
  const auxiliary = [
    "Generate a very brief (under 40 chars) summary of what these tools did.",
    "You generate a very short title",
  ].some((prefix) => body.messages[0]?.content?.startsWith(prefix));
  if (!auxiliary) scenario.bodies.push(body);
  if (!auxiliary && scenario.failures > 0) {
    scenario.failures--;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "synthetic SDK retry" } }));
    return;
  }
  const calls = auxiliary ? [] : (scenario.handle(body, ++scenario.steps) ?? []);
  const delta = calls.length
    ? {
        tool_calls: calls.map((call, index) => ({
          index,
          id: `fixture-${scenario.steps}-${index}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        })),
      }
    : { content: "fixture complete" };
  const response = {
    id: `fixture-${scenario.steps}`,
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
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
installLocalNetworkGuard(origin);
const engines = [];
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const names = (body) => (body.tools ?? []).map((tool) => tool.function.name);
try {
  const core = await import("@cjhyy/code-shell-core");
  const host = await import("@cjhyy/code-shell-core/internal");
  const coding = await import("../packages/coding/dist/index.capability.js");
  const pet = await import("../packages/pet/dist/index.js");
  const quiet = {
    id: "fixture",
    disableSessionTitle: true,
    disableHooks: true,
    disableInstructions: true,
    disableMemoryContext: true,
    disableSourcesContext: true,
    disableCapabilityContext: true,
    disableMcp: true,
  };
  function create(label, handle, options = {}) {
    const model = `gpt-4o-fixture-${label}`;
    const scenario = { handle, bodies: [], steps: 0, failures: 0 };
    scenarios.set(model, scenario);
    const cwd = join(root, label);
    mkdirSync(cwd, { recursive: true });
    const engine = new core.Engine({
      llm: { provider: "openai", model, apiKey: "synthetic-fixture-key", baseUrl: `${origin}/v1` },
      cwd,
      sessionStorageDir: join(root, `${label}-sessions`),
      settingsScope: "isolated",
      maxTurns: 8,
      headless: true,
      isSubAgent: true,
      behaviorProfiles: [quiet],
      permissionMode: "default",
      ...options,
    });
    engines.push(engine);
    return {
      engine,
      scenario,
      cwd,
      run: async (extra = {}) => {
        const result = await engine.run("Run the synthetic deferred tool fixture.", {
          sessionId: `s-${label}`,
          behaviorMode: "fixture",
          ...extra,
        });
        if (fixtureFailure) throw fixtureFailure;
        return result;
      },
    };
  }
  function registerAction(engine, counters) {
    engine.registerCustomTool(
      {
        name: "DeferredAction",
        description: "Perform a synthetic fixture action",
        inputSchema: {
          type: "object",
          properties: { selector: { type: "string", enum: ["SCHEMA_SENTINEL"] } },
        },
        source: "builtin",
        permissionDefault: "ask",
        isConcurrencySafe: false,
      },
      async () => {
        counters.executions++;
        return "fixture action done";
      },
    );
    engine.getHookRegistry().clear();
    engine.getHookRegistry().register("pre_tool_use", async ({ data }) => {
      if (data.toolName === "DeferredAction") counters.hooks++;
      return {};
    });
  }
  function approval(counters) {
    return {
      requestApproval: async () => {
        counters.approvals++;
        return { approved: true };
      },
    };
  }
  for (const retry of [false, true]) {
    const counters = { executions: 0, approvals: 0, hooks: 0 };
    const f = create(
      `progressive-${retry}`,
      (body, step) => {
        if (step <= 2) assert.ok(!JSON.stringify(body.messages).includes("SCHEMA_SENTINEL"));
        if (step === 1) {
          assert.ok(names(body).length >= 8 && names(body).length <= 15);
          assert.ok(!names(body).includes("DeferredAction"));
          return [
            { name: "ToolSearch", args: { query: "select:DeferredAction" } },
            { name: "DeferredAction" },
          ];
        }
        assert.ok(names(body).includes("DeferredAction"), JSON.stringify(body.messages.slice(-2)));
        assert.ok(JSON.stringify(body.tools).includes("SCHEMA_SENTINEL"));
        if (step === 2) {
          assert.deepEqual(counters, { executions: 0, approvals: 0, hooks: 0 });
          assert.match(JSON.stringify(body.messages), /next model step/);
          return [{ name: "DeferredAction", args: { selector: "SCHEMA_SENTINEL" } }];
        }
        assert.deepEqual(counters, { executions: 1, approvals: 1, hooks: 1 });
        return [];
      },
      { approvalBackend: approval(counters) },
    );
    registerAction(f.engine, counters);
    if (retry) f.scenario.failures = 1;
    assert.equal((await f.run()).reason, "completed");
    if (fixtureFailure) throw fixtureFailure;
    assert.equal(f.scenario.steps, 3);
    if (retry) assert.deepEqual(f.scenario.bodies[0].tools, f.scenario.bodies[1].tools);
    const events = readFileSync(
      join(root, `progressive-${retry}-sessions`, `s-progressive-${retry}`, "transcript.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const attempts = events.filter((event) => event.type === "model_request_attempt");
    assert.equal(attempts.length, f.scenario.bodies.length);
    assert.deepEqual(
      attempts.map((event) => event.data.toolCatalogDigest).sort(),
      f.scenario.bodies.map((body) => digest(body.tools ?? [])).sort(),
    );
  }
  {
    const counters = { executions: 0, approvals: 0, hooks: 0 };
    const f = create(
      "revoked",
      (body, step) => {
        if (step === 1) return [{ name: "ToolSearch", args: { query: "select:DeferredAction" } }];
        if (step === 2) {
          assert.ok(names(body).includes("DeferredAction"));
          f.engine.getToolRegistry().unregisterTool("DeferredAction");
          return [{ name: "DeferredAction" }];
        }
        assert.ok(!names(body).includes("DeferredAction"));
        assert.deepEqual(counters, { executions: 0, approvals: 0, hooks: 0 });
        assert.match(JSON.stringify(body.messages), /not available/);
        return [];
      },
      { approvalBackend: approval(counters) },
    );
    registerAction(f.engine, counters);
    assert.equal((await f.run()).reason, "completed");
  }
  {
    const f = create(
      "incremental-install",
      (body) => {
        assert.ok(names(body).includes("ToolSearch"));
        assert.ok(!names(body).includes("ReadSource"));
        const catalog = body.messages[0].content.match(
          /# Available Tools\n\n[^\n]+\n([^\n]+)/,
        )?.[1];
        assert.ok(catalog?.includes("ReadSource"));
        assert.ok(catalog?.includes("ToolSearch"));
        console.log(`Incremental ReadSource install eligible catalog: ${catalog}`);
        return [];
      },
      { enabledBuiltinTools: ["ReadSource"] },
    );
    assert.equal((await f.run()).reason, "completed");
  }
  {
    const counters = { executions: 0, approvals: 0, hooks: 0 };
    const f = create("keyword", (body, step) => {
      if (step <= 2) {
        assert.ok(!names(body).includes("DeferredAction"));
        assert.ok(!JSON.stringify(body.messages).includes("SCHEMA_SENTINEL"));
        return [
          {
            name: "ToolSearch",
            args: { query: step === 1 ? "synthetic fixture action" : "select:DeferredAction" },
          },
        ];
      }
      assert.ok(names(body).includes("DeferredAction"));
      return [];
    });
    registerAction(f.engine, counters);
    assert.equal((await f.run()).reason, "completed");
    assert.deepEqual(counters, { executions: 0, approvals: 0, hooks: 0 });
  }
  {
    const f = create(
      "ordinary-coding",
      (body) => {
        assert.ok(names(body).length >= 8 && names(body).length <= 15);
        assert.ok(names(body).includes("ApplyPatch"));
        assert.ok(!names(body).includes("DriveAgent"));
        return [];
      },
      { modules: [coding.createCodingModule()] },
    );
    assert.ok(f.engine.getToolRegistry().hasTool("DriveAgent"));
    assert.equal((await f.run()).reason, "completed");
  }
  {
    const counters = { executions: 0, approvals: 0, hooks: 0 };
    const f = create(
      "explicit",
      (body, step) => {
        assert.deepEqual(names(body), ["DeferredAction"]);
        return step === 1 ? [{ name: "DeferredAction" }] : [];
      },
      { approvalBackend: approval(counters) },
    );
    registerAction(f.engine, counters);
    assert.equal((await f.run({ toolAllowlist: ["DeferredAction"] })).reason, "completed");
    assert.equal(counters.executions, 1);
  }
  for (const declared of [false, true]) {
    const f = create(
      `legacy-${declared}`,
      (body) => {
        assert.ok(names(body).includes("Sleep"));
        return [];
      },
      {
        modules: [
          {
            id: "legacy",
            engine: {
              defaultPreset: "legacy",
              presets: [
                {
                  name: "legacy",
                  label: "Legacy fixture",
                  description: "Legacy fixture",
                  promptSections: [],
                  builtinTools: ["ToolSearch", "Sleep"],
                  defaultPermissionRules: [],
                  ...(declared ? { initialToolNames: [] } : {}),
                },
              ],
            },
          },
        ],
        ...(declared ? { disabledBuiltinTools: ["ToolSearch"] } : {}),
      },
    );
    assert.equal((await f.run()).reason, "completed");
  }
  {
    const f = create(
      "pet",
      (body) => {
        assert.ok(!names(body).includes("ToolSearch"));
        assert.ok(
          names(body).includes(pet.CURRENT_TIME_TOOL_NAME),
          JSON.stringify({ names: names(body), first: body.messages[0] }),
        );
        assert.ok(names(body).every((name) => pet.PET_ALLOWED_TOOL_NAMES.has(name)));
        return [];
      },
      { modules: [pet.createPetModule()], isSubAgent: false },
    );
    assert.equal(
      (await f.run({ behaviorMode: "pet", kind: "pet", ephemeral: true })).reason,
      "completed",
    );
  }
  {
    let boundReads = 0;
    const credential = {
      id: "fixture-connection",
      type: "oauth",
      label: "Synthetic account",
      hasSecret: true,
      oauthStatus: { state: "valid", hasRefreshToken: true },
      meta: {
        linkProvider: "github",
        linkExecutionRuntime: "server",
        linkExecutionBackend: "remote",
        linkRemoteState: "connected",
        linkRemoteGrantId: "fixture-grant",
        linkCapabilityIds: ["github.list_repositories"],
        linkLastVerifiedAt: "2026-10-09T00:00:00Z",
      },
    };
    core.setDefaultCredentialAccess({
      listMasked: () => [credential],
      resolveMeta: () => credential,
      envExposures: () => ({}),
      executeRemoteLinkAction: async () => {
        boundReads++;
        return { value: "bound consumer result" };
      },
    });
    const counters = { approvals: 0 };
    const f = create(
      "bound-source",
      (body, step) => {
        assert.ok(!names(body).includes("LinkAction"));
        if (step === 1) return [{ name: "ToolSearch", args: { query: "select:ReadSource" } }];
        if (step === 2)
          return [
            {
              name: "ReadSource",
              args: {
                source: "fixture-view",
                scope: "github:list_repositories",
                resource: "result",
              },
            },
          ];
        assert.equal(boundReads, 1);
        assert.match(JSON.stringify(body.messages), /bound consumer result/);
        return [];
      },
      { preset: "general", approvalBackend: approval(counters) },
    );
    host.saveSourceDefinition({
      id: "fixture-view",
      kind: "link",
      label: "Synthetic view",
      enabled: true,
      credentialRef: credential.id,
      adapterConfig: { providerId: "github", action: "list_repositories", params: { limit: 5 } },
    });
    host.bindSource(new core.SettingsManager(f.cwd, "isolated"), f.cwd, {
      sourceId: "fixture-view",
      scopes: ["github:list_repositories"],
      readPolicy: "ask",
    });
    assert.equal((await f.run()).reason, "completed");
    assert.equal(boundReads, 1);
    core.setDefaultCredentialAccess(null);
  }
  if (fixtureFailure) throw fixtureFailure;
  console.log(
    `Deferred SDK smoke passed: ${requests.length} exact-origin HTTP requests; frozen provider tools, select, forged-call rejection, retry projections, coding/Pet/legacy/allowlist compatibility and bound source consumer.`,
  );
} finally {
  await Promise.all(engines.map((engine) => engine.dispose()));
  await new Promise((done) => server.close(done));
  rmSync(root, { recursive: true, force: true });
}
