import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import type { EngineConfig } from "./types.js";
import type { EngineRunOptions, RunBehaviorProfile } from "./run-types.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, ToolCall } from "../types.js";
import type { AgentModule } from "../composition/types.js";
import { BUILTIN_AGENT_PRESETS } from "../preset/index.js";

const provider = "task-routing-engine-fixture";
const scenarios = new Map<string, (request: CreateMessageOptions) => ToolCall[]>();
const fixtures: Array<{ engine: Engine; directory: string }> = [];
let sequence = 0;

class RoutingClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(request: CreateMessageOptions): Promise<LLMResponse> {
    const calls = request.tools?.length ? scenarios.get(this.model)!(request) : [];
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    this.recordUsage(usage, request);
    return {
      text: calls.length ? "" : "fixture complete",
      toolCalls: calls,
      stopReason: calls.length ? "tool_use" : "stop",
      usage,
    };
  }
}

registerProvider(provider, RoutingClient);

const quiet: RunBehaviorProfile = {
  id: "routing-fixture",
  disableSessionTitle: true,
  disableHooks: true,
  disableInstructions: true,
  disableMemoryContext: true,
  disableSourcesContext: true,
  disableCapabilityContext: true,
  disableMcp: true,
};

function names(request: CreateMessageOptions): string[] {
  return (request.tools ?? []).map((tool) => tool.name);
}

function fixture(
  handle: (request: CreateMessageOptions) => ToolCall[] = () => [],
  options: Partial<EngineConfig> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-engine-task-routing-"));
  const model = `task-routing-${++sequence}`;
  const requests: CreateMessageOptions[] = [];
  scenarios.set(model, (request) => {
    requests.push(request);
    return handle(request);
  });
  const engine = new Engine({
    llm: { provider, model, apiKey: "synthetic-fixture" } as never,
    cwd: directory,
    sessionStorageDir: join(directory, "sessions"),
    settingsScope: "isolated",
    preset: "general",
    headless: true,
    isSubAgent: true,
    permissionMode: "default",
    maxTurns: 5,
    behaviorProfiles: [quiet],
    ...options,
  });
  fixtures.push({ engine, directory });
  return {
    engine,
    requests,
    run: (task: string, extra: EngineRunOptions = {}) =>
      engine.run(task, { sessionId: "routing-session", behaviorMode: quiet.id, ...extra }),
  };
}

function customPreset(options: { eager?: boolean; noSearch?: boolean } = {}): AgentModule {
  return {
    id: "routing-legacy-fixture",
    engine: {
      defaultPreset: "routing-legacy-fixture",
      presets: [
        {
          name: "routing-legacy-fixture",
          label: "Legacy fixture",
          description: "A preset that has not opted into task routing",
          promptSections: [],
          builtinTools: ["Read", "Write", "Sleep", ...(options.noSearch ? [] : ["ToolSearch"])],
          ...(options.eager ? {} : { initialToolNames: ["ToolSearch"] }),
          defaultPermissionRules: [],
        },
      ],
    },
  };
}

afterEach(async () => {
  scenarios.clear();
  for (const { engine, directory } of fixtures.splice(0)) {
    try {
      await engine.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("Engine task routing consumer", () => {
  test("routes local files and source reading independently at each Run boundary", async () => {
    const f = fixture();
    expect((await f.run("read file")).reason).toBe("completed");
    expect((await f.run("读取资料集文档")).reason).toBe("completed");
    expect(f.requests).toHaveLength(2);
    const [files, sources] = f.requests.map(names);
    for (const selected of [files, sources]) {
      expect(selected.length).toBeGreaterThanOrEqual(8);
      expect(selected.length).toBeLessThanOrEqual(15);
      expect(selected).toContain("ToolSearch");
    }
    expect(files).toContain("Glob");
    expect(files).toContain("Grep");
    expect(sources).toContain("ReadSource");
    expect(sources).not.toEqual(files);
    // Routing changes schemas, not registry installation or the full prompt catalog.
    expect(f.engine.getToolRegistry().hasTool("ReadSource")).toBe(true);
    expect(f.engine.getToolRegistry().hasTool("MemorySave")).toBe(true);
    expect(f.requests[0]!.systemPrompt).toContain("ReadSource");
    expect(f.requests[1]!.systemPrompt).toContain("Glob");
  }, 15_000);

  test("ToolSearch loads an inactive tool only for the next model step", async () => {
    const counts = { approvals: 0, executions: 0, pre: 0, starts: 0 };
    let step = 0;
    const f = fixture(
      (request) => {
        step++;
        if (step === 1) {
          expect(names(request)).not.toContain("RoutingAction");
          return [
            { id: "select", toolName: "ToolSearch", args: { query: "select:RoutingAction" } },
            { id: "forged-inactive", toolName: "RoutingAction", args: {} },
          ];
        }
        expect(names(request)).toContain("RoutingAction");
        if (step === 2) {
          expect(counts).toEqual({ approvals: 0, executions: 0, pre: 0, starts: 0 });
          expect(JSON.stringify(request.messages)).toContain("next model step");
          return [{ id: "active", toolName: "RoutingAction", args: {} }];
        }
        expect(counts).toEqual({ approvals: 1, executions: 1, pre: 1, starts: 1 });
        return [];
      },
      {
        approvalBackend: {
          async requestApproval() {
            counts.approvals++;
            return { approved: true };
          },
        },
      },
    );
    f.engine.registerCustomTool(
      {
        name: "RoutingAction",
        description: "Synthetic deferred action",
        inputSchema: { type: "object", properties: {} },
        source: "builtin",
        permissionDefault: "ask",
      },
      async () => {
        counts.executions++;
        return "executed";
      },
    );
    f.engine.getHookRegistry().clear();
    f.engine.getHookRegistry().register("pre_tool_use", async ({ data }) => {
      if (data.toolName === "RoutingAction") counts.pre++;
      return {};
    });
    f.engine.getHookRegistry().register("on_tool_start", async ({ data }) => {
      if (data.toolName === "RoutingAction") counts.starts++;
      return {};
    });
    expect((await f.run("read file")).reason).toBe("completed");
    expect(step).toBe(3);
  }, 15_000);

  test("an explicit Run allowlist stays eager and cannot be widened by routing", async () => {
    const f = fixture();
    expect(
      (await f.run("Read the document from the data source.", { toolAllowlist: ["Read", "Sleep"] }))
        .reason,
    ).toBe("completed");
    expect(names(f.requests[0]!)).toEqual(["Read", "Sleep"]);
  }, 15_000);

  test("a behavior allowlist stays eager and dominates task matching", async () => {
    const restricted = {
      ...quiet,
      id: "restricted-routing",
      allowedToolNames: new Set(["Read", "Sleep"]),
    };
    const f = fixture(() => [], { behaviorProfiles: [quiet, restricted] });
    expect(
      (await f.run("Read the document from the data source.", { behaviorMode: restricted.id }))
        .reason,
    ).toBe("completed");
    expect(names(f.requests[0]!)).toEqual(["Read", "Sleep"]);
  }, 15_000);

  test("unmatched tasks retain the preset's existing initial schemas", async () => {
    const f = fixture();
    const { initialToolRouting: _policy, ...baseline } = BUILTIN_AGENT_PRESETS.general;
    const legacy = fixture(() => [], {
      preset: "unrouted-general",
      modules: [
        {
          id: "unrouted-general",
          engine: { presets: [{ ...baseline, name: "unrouted-general" }] },
        },
      ],
    });
    await f.run("zzqv-canary-7319");
    await legacy.run("zzqv-canary-7319");
    expect(names(f.requests[0]!)).toEqual(names(legacy.requests[0]!));
  }, 15_000);

  for (const eager of [false, true]) {
    test(`a custom preset without routing keeps ${eager ? "eager" : "deferred"} compatibility`, async () => {
      const f = fixture(() => [], {
        preset: "routing-legacy-fixture",
        modules: [customPreset({ eager })],
      });
      await f.run("Find files and read data sources.");
      expect(names(f.requests[0]!)).toEqual(
        eager ? ["Read", "Write", "ToolSearch", "Sleep"] : ["ToolSearch"],
      );
    }, 15_000);
  }

  test("a preset without ToolSearch keeps its complete eligible surface", async () => {
    const f = fixture(() => [], {
      preset: "routing-legacy-fixture",
      modules: [customPreset({ noSearch: true })],
    });
    await f.run("Find files and read data sources.");
    expect(names(f.requests[0]!)).toEqual(["Read", "Write", "Sleep"]);
  }, 15_000);
});
