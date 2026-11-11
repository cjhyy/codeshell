import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalNetworkGuard } from "../../../../scripts/runtime-cost-smoke-isolation.mjs";
import type { AgentModule } from "../composition/types.js";
import type { ToolCall } from "../types.js";

// Install before importing Core: no fixture can use operator credentials or paid endpoints.
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME)
  throw new Error("Private HOME required");
const originalFetch = globalThis.fetch;
const originalHttp = [http.request, http.get, https.request, https.get];
const guardMarker = Symbol.for("codeshell.cost-smoke.network-guard");
const previousGuardMarker = Object.getOwnPropertyDescriptor(globalThis, guardMarker);
installLocalNetworkGuard("http://127.0.0.1:9");
expect(() => fetch("https://append-only-tools.invalid/")).toThrow("non-fixture");
expect(() => http.get("http://127.0.0.1:8/")).toThrow("non-fixture");
afterAll(() => {
  globalThis.fetch = originalFetch;
  [http.request, http.get, https.request, https.get] = originalHttp;
  if (previousGuardMarker) Object.defineProperty(globalThis, guardMarker, previousGuardMarker);
  else delete (globalThis as any)[guardMarker];
  syncBuiltinESMExports();
});

const { Engine } = await import("./engine.js");
const { EngineRuntime } = await import("./runtime.js");
const { ModelPool } = await import("../llm/model-pool.js");
const { ToolRegistry } = await import("../tool-system/registry.js");
const { MCPManager } = await import("../tool-system/mcp-manager.js");
const { SettingsManager } = await import("../settings/manager.js");
const { CostTracker } = await import("../cost-tracker.js");
const { currentUsageOwner } = await import("../cost-ledger/context.js");
const cleanups: Array<() => Promise<void> | void> = [];
const requests: any[] = [];
const responses: ToolCall[][] = [];
const executed: string[] = [];
let longHistory = false;
const behaviorMode = "native-discovery-fixture";
const args = { target: { id: "测试", labels: ["one", "two"] }, limit: 3 };
const schema = {
  type: "object",
  properties: {
    target: {
      type: "object",
      properties: { id: { type: "string" }, labels: { type: "array", items: { type: "string" } } },
      required: ["id"],
    },
    limit: { type: "integer", minimum: 1 },
  },
  required: ["target"],
};
const module: AgentModule = {
  id: behaviorMode,
  engine: {
    defaultPreset: behaviorMode,
    presets: [
      {
        name: behaviorMode,
        label: "Native discovery fixture",
        description: "Offline Messages contract",
        promptSections: [],
        builtinTools: ["ToolSearch"],
        initialToolNames: ["ToolSearch", "Warmup"],
        defaultPermissionRules: [],
      },
    ],
  },
};

function reply(body: any, calls: ToolCall[], summary = false) {
  const content = calls.length
    ? calls.map((call) => ({
        type: "tool_use",
        id: call.id,
        name: call.toolName,
        input: call.args,
      }))
    : [
        {
          type: "text",
          text: summary
            ? "The local fixture discovered Alpha, Beta and Gamma and completed checks."
            : "Done.",
        },
      ];
  const message = {
    id: "fixture-message",
    type: "message",
    role: "assistant",
    model: body.model,
    content,
    stop_reason: calls.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
  if (!body.stream) return Response.json(message);
  const events: any[] = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
  ];
  for (const [index, block] of content.entries()) {
    const tool = block.type === "tool_use";
    events.push(
      {
        type: "content_block_start",
        index,
        content_block: tool ? { ...block, input: {} } : { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index,
        delta: tool
          ? { type: "input_json_delta", partial_json: JSON.stringify((block as any).input) }
          : { type: "text_delta", text: (block as any).text },
      },
      { type: "content_block_stop", index },
    );
  }
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  );
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

const fixtureFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const chat = request.url === "https://openrouter.ai/api/v1/chat/completions";
  if (!chat && request.url !== "https://openrouter.ai/api/v1/messages")
    throw new Error("Unexpected fixture endpoint");
  const body = await request.json();
  const primary = currentUsageOwner()?.purpose === "main";
  if (chat) {
    if (primary) {
      requests.push(body);
      expect(responses.shift()).toEqual([]);
    } else expect(body.tools ?? []).toEqual([]);
    const completion = {
      id: "chat-fixture",
      object: "chat.completion",
      model: body.model,
      choices: [
        { index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    };
    if (!body.stream) return Response.json(completion);
    const chunks = [
      {
        ...completion,
        object: "chat.completion.chunk",
        choices: [
          { index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null },
        ],
      },
      {
        ...completion,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ];
    return new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  expect(request.headers.get("authorization")).toBe("Bearer synthetic-fixture-key");
  expect(body.thinking).toEqual({ type: "disabled" });
  if (!primary) {
    expect(body.tools ?? []).toEqual([]);
    return reply(body, [], true);
  }
  requests.push(body);
  const calls = responses.shift();
  if (!calls) throw new Error("Native fixture script exhausted");
  return reply(body, calls);
}) as typeof fetch;

function action(engine: InstanceType<typeof Engine>, name: string, revision = "v1") {
  engine.registerCustomTool(
    {
      name,
      description: `Local ${name} ${revision}`,
      inputSchema: schema,
      source: "builtin",
      permissionDefault: "allow",
    },
    async () => {
      executed.push(name);
      return `Executed ${name}${longHistory ? " substantial local context".repeat(160) : ""}`;
    },
  );
}
function engine(root: string, revision = "v1", chat = false) {
  // Hosts own model routing through EngineRuntime; avoid the legacy API-key
  // onboarding path which selects a zero-config default from the endpoint.
  const registry = new ToolRegistry({ builtinTools: ["ToolSearch"] });
  const runtime = new EngineRuntime({
    modelPool: new ModelPool(),
    toolRegistry: registry,
    settings: new SettingsManager(root, "isolated"),
    mcpPool: new MCPManager(registry),
    costTracker: new CostTracker(),
    usageStorageDir: join(root, "usage"),
  });
  cleanups.push(() => runtime.close());
  const value = new Engine({
    runtime,
    llm: {
      provider: chat ? "openai" : "anthropic",
      providerKind: "openrouter",
      model: chat ? "openai/gpt-4o" : "anthropic/claude-sonnet-5",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "synthetic-fixture-key",
      reasoning: { mode: "off" },
    },
    clientDefaults: { fetch: fixtureFetch, retryMaxAttempts: 1 },
    cwd: root,
    sessionStorageDir: join(root, "sessions"),
    settingsScope: "isolated",
    maxTurns: 24,
    headless: false,
    permissionMode: "bypassPermissions",
    customSystemPrompt: "Complete the local fixture.",
    modules: [module],
    behaviorProfiles: [
      {
        id: behaviorMode,
        disableHooks: true,
        disableInstructions: true,
        disableMemoryContext: true,
        disableMemoryPipeline: true,
        disableCapabilityContext: true,
        disableSourcesContext: true,
        disableWorkspaceProfile: true,
        disableMcp: true,
        disableSessionTitle: true,
      },
    ],
  });
  value.getHookRegistry().clear();
  for (const name of ["Warmup", "Alpha", "Beta", "Gamma"]) action(value, name, revision);
  cleanups.push(() => value.dispose());
  return value;
}
function step(name: string, id = name, input = args as Record<string, unknown>) {
  responses.push([{ id, toolName: name, args: input }]);
}
function select(name: string, id = `select-${name}`) {
  step("ToolSearch", id, { query: `select:${name}` });
}
function result(id: string, body = requests.at(-1)) {
  return body.messages
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .find((block: any) => block.type === "tool_result" && block.tool_use_id === id);
}
function withoutMarkers(value: unknown): any {
  return JSON.parse(
    JSON.stringify(value, (key, entry) => (key === "cache_control" ? undefined : entry)),
  );
}
function assertPrefix(batch: any[], baseline = batch[0]) {
  for (let index = 0; index < batch.length; index++) {
    const body = batch[index];
    expect(JSON.stringify(body.tools)).toBe(JSON.stringify(baseline.tools));
    expect(JSON.stringify(body.system)).toBe(JSON.stringify(baseline.system));
    if (index) {
      const prior = withoutMarkers(batch[index - 1].messages);
      const next = withoutMarkers(body.messages);
      expect(next.length).toBeGreaterThan(prior.length);
      expect(JSON.stringify(next.slice(0, prior.length))).toBe(JSON.stringify(prior));
    }
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  requests.length = 0;
  responses.length = 0;
  executed.length = 0;
  longHistory = false;
});

function directory() {
  const root = mkdtempSync(join(tmpdir(), "native-tool-reference-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("real Engine and SDK append three native discoveries, preserve frozen catalogs after restart and fall back for changed or late schemas", async () => {
  const root = directory();
  const sessionId = "native-reference-prefix";
  const first = engine(root);
  step("Alpha", "undiscovered");
  step("Warmup", "warmup");
  for (const name of ["Alpha", "Beta", "Gamma"]) {
    select(name);
    step(name);
  }
  responses.push([]);
  const outcome = await first.run("Perform the local checks", { sessionId, behaviorMode });

  expect(outcome.reason).toBe("completed");
  expect(responses).toHaveLength(0);
  expect(requests).toHaveLength(9);
  assertPrefix(requests);
  expect(executed).toEqual(["Warmup", "Alpha", "Beta", "Gamma"]);
  expect(result("undiscovered").is_error).toBe(true);
  for (const name of ["Alpha", "Beta", "Gamma"]) {
    expect(result(`select-${name}`).content).toContainEqual({
      type: "tool_reference",
      tool_name: name,
    });
    expect(requests[0].tools.find((tool: any) => tool.name === name)).toMatchObject({
      defer_loading: true,
    });
  }
  expect(requests[0].tools.filter((tool: any) => tool.cache_control)).toHaveLength(1);
  expect(requests[0].tools.find((tool: any) => tool.cache_control).defer_loading).toBeUndefined();
  const transcript = readFileSync(join(root, "sessions", sessionId, "transcript.jsonl"), "utf8");
  expect(transcript).toContain('"discoveredTool"');
  expect(transcript).toContain("inputSchema");
  expect(transcript).not.toContain('"type":"tool_reference"');
  const baseline = requests[0];
  const offset = requests.length;
  await first.dispose();
  const restarted = engine(root, "v2");
  action(restarted, "mcp_fixture_late");
  select("Alpha", "select-changed");
  select("mcp_fixture_late");
  step("CallTool", "call-late", { name: "mcp_fixture_late", args });
  responses.push([]);
  expect((await restarted.run("Continue the checks", { sessionId, behaviorMode })).reason).toBe(
    "completed",
  );
  assertPrefix(requests.slice(offset), baseline);
  expect(result("select-Alpha").content).toContainEqual({
    type: "tool_reference",
    tool_name: "Alpha",
  });
  expect(JSON.stringify(result("select-changed").content)).not.toContain('"tool_reference"');
  expect(JSON.stringify(result("select-changed").content)).toContain("Local Alpha v2");
  expect(JSON.stringify(result("select-mcp_fixture_late").content)).toContain("inputSchema");
  expect(requests.at(-1).tools.some((tool: any) => tool.name === "mcp_fixture_late")).toBe(false);
  expect(executed.at(-1)).toBe("mcp_fixture_late");
  expect(
    restarted
      .getSessionManager()
      .readSessionState(sessionId)
      ?.toolSelection?.deferredDefinitions?.map((tool) => tool.name),
  ).toEqual(["Alpha", "Beta", "Gamma"]);
  await restarted.dispose();
  const chat = engine(root, "v3", true);
  responses.push([]);
  expect((await chat.run("Continue on Chat", { sessionId, behaviorMode })).reason).toBe(
    "completed",
  );
  const chatBody = requests.at(-1);
  const originalSelection = chatBody.messages.find(
    (message: any) => message.role === "tool" && message.tool_call_id === "select-Alpha",
  );
  expect(originalSelection.content).toContain("Local Alpha v1");
  expect(originalSelection.content).toContain("inputSchema");
  expect(JSON.stringify(chatBody)).not.toContain('"tool_reference"');
  expect(JSON.stringify(chatBody)).not.toContain('"discoveredTool"');
  expect(JSON.stringify(chatBody)).not.toContain('"defer_loading"');
});

test("manual compaction promotes discoveries and freezes the next native catalog immediately", async () => {
  const value = engine(directory());
  const sessionId = "native-reference-rebase";
  longHistory = true;
  select("Alpha");
  step("Alpha");
  for (let index = 0; index < 8; index++) step("Warmup", `history-${index}`);
  responses.push([]);
  await value.run("Perform checks", { sessionId, behaviorMode });
  const before = requests[0];
  const compacted = await value.forceCompact(sessionId);
  expect(compacted.after).toBeLessThan(compacted.before);
  const offset = requests.length;
  select("Beta");
  step("Beta");
  responses.push([]);
  await value.run("Continue after compaction", { sessionId, behaviorMode });
  const after = requests[offset];
  expect(after.tools.find((tool: any) => tool.name === "Alpha").defer_loading).toBeUndefined();
  expect(after.tools.find((tool: any) => tool.name === "Beta").defer_loading).toBe(true);
  expect(JSON.stringify(after.tools)).not.toBe(JSON.stringify(before.tools));
  assertPrefix(requests.slice(offset));
  expect(value.getSessionManager().readSessionState(sessionId)?.toolSelection?.names).toContain(
    "Alpha",
  );
});
