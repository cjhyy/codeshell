/**
 * Cross-Session head stability: a new Session's first request must be able to
 * read the head (tool table, system prompt, first user context) cached by an
 * earlier Session of the same preset in the same workspace. Task-text routing
 * may only add tools after the head, and the provider cache key follows the
 * head rather than the Session.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import type { EngineConfig } from "./types.js";
import type { AgentModule } from "../composition/types.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import { resolvePromptCachePolicy } from "../llm/prompt-cache.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, ToolCall } from "../types.js";

const provider = "cross-session-head-fixture";
const requests: CreateMessageOptions[] = [];
const script: ToolCall[][] = [];
const executed: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

class Client extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const { signal: _signal, onChunk: _onChunk, ...captured } = options;
    // Main-loop requests only; side calls (titles) carry no tools.
    if (options.tools?.length) requests.push(structuredClone(captured));
    const toolCalls = options.tools?.length ? (script.shift() ?? []) : [];
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    this.recordUsage(usage, options);
    return {
      text: toolCalls.length ? "" : "done",
      toolCalls,
      stopReason: toolCalls.length ? "tool_use" : "stop",
      usage,
    };
  }
}
registerProvider(provider, Client);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  requests.length = 0;
  script.length = 0;
  executed.length = 0;
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "cross-session-head-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  // Instructions make the first user-context message part of the compared head.
  writeFileSync(join(root, "CODESHELL.md"), "# Project\nUse bun.\n");
  return root;
}

function engine(root: string, config: Partial<EngineConfig> = {}): Engine {
  const value = new Engine({
    llm: { provider, providerKind: "openai", model: "gpt-6-sol", apiKey: "fixture" } as never,
    cwd: root,
    sessionStorageDir: join(root, "sessions"),
    settingsScope: "isolated",
    preset: "general",
    headless: true,
    permissionMode: "bypassPermissions",
    maxTurns: 4,
    ...config,
  });
  cleanups.push(() => value.dispose());
  return value;
}

/** The provider key this request would carry on an openai-hybrid route. */
function cacheKey(request: CreateMessageOptions): string | undefined {
  return resolvePromptCachePolicy({
    provider: "openrouter",
    providerKind: "openai",
    model: "openai/gpt-6-sol",
    request: request.promptCache,
  }).cacheKey;
}

function head(request: CreateMessageOptions) {
  return {
    tools: JSON.stringify(request.tools),
    systemPrompt: request.systemPrompt,
    userContext: JSON.stringify(request.messages[0]),
    cacheKey: cacheKey(request),
  };
}

function text(request: CreateMessageOptions): string {
  return JSON.stringify(request.messages);
}

test("new Sessions of one preset send an identical head and cache key whatever their task text", async () => {
  const root = workspace();
  const value = engine(root);
  const tasks = [
    "hello there",
    "Read the file and edit the folder", // files route
    "Research the web for cache pricing", // research route
    "Schedule a cron reminder from the uploaded dataset", // automation + sources routes
  ];
  for (const [index, task] of tasks.entries()) {
    expect((await value.run(task, { sessionId: `session-${index}` })).reason).toBe("completed");
  }
  expect(requests).toHaveLength(tasks.length);
  const [baseline, ...others] = requests.map(head);
  expect(baseline!.userContext).toContain("Use bun.");
  expect(baseline!.cacheKey).toMatch(/^cs:[0-9a-f]{48}$/u);
  for (const other of others) expect(other).toEqual(baseline!);

  // Each Session still gets its own scope for boundary bookkeeping.
  expect(new Set(requests.map((request) => request.promptCache?.scopeId)).size).toBe(tasks.length);
  // Routed tools ride after the head instead of reshaping it.
  expect(text(requests[0]!)).not.toContain("Tools loaded for this task");
  expect(text(requests[2]!)).toContain("Tools loaded for this task");
  expect(text(requests[2]!)).toContain("### WebFetch");
  expect(JSON.parse(baseline!.tools).map((tool: { name: string }) => tool.name)).not.toContain(
    "WebFetch",
  );
  for (const index of [1, 2, 3]) {
    const discovered = value.getSessionManager().readSessionState(`session-${index}`)!
      .toolSelection!.discovered;
    expect(discovered.length).toBeGreaterThan(0);
  }
}, 30_000);

test("a different head gets a different cache key", async () => {
  const root = workspace();
  await engine(root).run("hello", { sessionId: "general" });
  await engine(root, { preset: "harness-min" }).run("hello", { sessionId: "minimal" });
  await engine(workspace()).run("hello", { sessionId: "elsewhere" });
  expect(requests).toHaveLength(3);
  const keys = requests.map(cacheKey);
  expect(new Set(keys).size).toBe(3);
}, 30_000);

const routedModule: AgentModule = {
  id: "cross-session-routed-fixture",
  engine: {
    defaultPreset: "cross-session-routed-fixture",
    presets: [
      {
        name: "cross-session-routed-fixture",
        label: "Routed fixture",
        description: "Offline routed-tool preload contract",
        promptSections: [],
        builtinTools: ["ToolSearch", "AskUserQuestion", "TodoWrite"],
        initialToolNames: ["ToolSearch", "AskUserQuestion", "TodoWrite", "Warmup"],
        defaultPermissionRules: [],
        initialToolRouting: {
          managedToolNames: ["ToolSearch", "AskUserQuestion", "TodoWrite", "Warmup", "Routed"],
          coreToolNames: ["ToolSearch", "AskUserQuestion", "TodoWrite"],
          rules: [{ id: "catalog", terms: ["catalog"], toolNames: ["Routed"] }],
        },
      },
    ],
  },
};

function routedEngine(root: string): Engine {
  const value = engine(root, {
    preset: "cross-session-routed-fixture",
    modules: [routedModule],
    composition: undefined,
  });
  for (const name of ["Warmup", "Routed"]) {
    value.registerCustomTool(
      {
        name,
        description: `Local ${name} action`,
        inputSchema: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
        },
        source: "builtin",
        permissionDefault: "allow",
      },
      async () => {
        executed.push(name);
        return `Executed ${name}`;
      },
    );
  }
  return value;
}

test("a routed tool is loaded after the head, callable at once and told only once", async () => {
  const root = workspace();
  const value = routedEngine(root);
  script.push([
    { id: "routed", toolName: "CallTool", args: { name: "Routed", args: { target: "x" } } },
  ]);
  expect((await value.run("Show the catalog", { sessionId: "routed" })).reason).toBe("completed");
  expect(executed).toEqual(["Routed"]);
  const [first, second] = requests;
  const names = first!.tools!.map((tool) => tool.name);
  expect(names).toEqual(["ToolSearch", "AskUserQuestion", "TodoWrite", "Warmup", "CallTool"]);
  expect(text(first!)).toContain("Tools loaded for this task");
  expect(text(first!)).toContain("Local Routed action");
  // The schema sits after the head and the user's message.
  const loadedAt = first!.messages.findIndex((message) =>
    JSON.stringify(message).includes("Tools loaded for this task"),
  );
  expect(loadedAt).toBeGreaterThan(1);
  expect(JSON.stringify(second!.messages)).toContain("Executed Routed");
  expect(JSON.stringify(second!.messages)).not.toContain('"is_error":true');
  expect(value.getSessionManager().readSessionState("routed")!.toolSelection).toMatchObject({
    discovered: ["Routed"],
  });

  // A later run of the same Session keeps the head and does not resend the schema.
  const offset = requests.length;
  await value.run("Show the catalog again", { sessionId: "routed" });
  const later = requests[offset]!;
  expect(JSON.stringify(later.tools)).toBe(JSON.stringify(first!.tools));
  expect(later.systemPrompt).toBe(first!.systemPrompt);
  expect(cacheKey(later)).toBe(cacheKey(first!));
  expect(text(later).split("Tools loaded for this task")).toHaveLength(2);

  // Another Session with an unrouted task shares the same head and key.
  const other = requests.length;
  await value.run("hello", { sessionId: "unrouted" });
  expect(head(requests[other]!)).toEqual(head(first!));
}, 30_000);
