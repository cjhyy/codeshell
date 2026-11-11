import { describe, expect, test } from "bun:test";
import type { LLMConfig, SessionToolSelection, ToolDefinition } from "../types.js";
import type { ToolContext } from "../tool-system/context.js";
import { RunToolSurface } from "../tool-system/run-tool-surface.js";
import { toolSearchTool } from "../tool-system/builtin/tool-search.js";
import { initializeRunToolSurface } from "./run-tooling.js";
import {
  isToolCacheCompaction,
  rebaseToolSelection,
  selectionForToolCacheCycle,
  toolCacheIdentity,
} from "./tool-cache-cycle.js";

const config: LLMConfig = {
  provider: "openai",
  providerKind: "openrouter",
  baseUrl: "https://provider.invalid/v1",
  model: "fixture-model",
};

function definition(name: string, description = name): ToolDefinition {
  return { name, description, inputSchema: { type: "object", properties: {} } };
}

function selection(): SessionToolSelection {
  return {
    version: 2,
    names: ["ToolSearch", "CallTool", "Frozen"],
    discovered: ["Deferred", "OtherDeferred"],
    frozenDefinitions: [
      definition("ToolSearch"),
      definition("CallTool"),
      definition("Frozen", "original schema"),
    ],
    cacheIdentity: toolCacheIdentity(config),
  };
}

function catalog(): ToolDefinition[] {
  return [
    definition("ToolSearch"),
    definition("CallTool"),
    definition("Frozen", "updated schema"),
    definition("Deferred"),
    definition("OtherDeferred"),
    definition("LateTool"),
  ];
}

describe("tool-cache cycle identity", () => {
  test("is deterministic across config reconstruction and excludes credential values", () => {
    const identity = toolCacheIdentity(config);
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    expect(toolCacheIdentity(JSON.parse(JSON.stringify(config)))).toBe(identity);
    expect(
      toolCacheIdentity({ ...config, apiKey: "fixture-only-key", authCommand: "fixture" }),
    ).toBe(identity);
    expect(toolCacheIdentity({ ...config, maxTokens: 123, maxContextTokens: 1_000 })).toBe(
      identity,
    );
    expect(toolCacheIdentity(undefined)).toBe(toolCacheIdentity(undefined));
  });

  test.each([
    { provider: "anthropic" },
    { providerKind: "another-route" },
    { baseUrl: "https://another.invalid/v1" },
    { model: "different-model" },
    { modelKey: "another-connection/same-model" },
  ])("changes when the effective route or model changes: %j", (patch) => {
    expect(toolCacheIdentity({ ...config, ...patch })).not.toBe(toolCacheIdentity(config));
  });

  test("same cycle retains discovered state and serialized frozen definitions exactly", () => {
    const previous = selection();
    const bytes = JSON.stringify(previous);
    const next = selectionForToolCacheCycle(
      previous,
      toolCacheIdentity(config),
    ) as SessionToolSelection;
    expect(next).toEqual(previous);
    expect(JSON.stringify(next.frozenDefinitions)).toBe(JSON.stringify(previous.frozenDefinitions));
    expect(JSON.stringify(previous)).toBe(bytes);
  });

  test("model change promotes discoveries once and refreshes definitions at initialization", () => {
    const previous = selection();
    const bytes = JSON.stringify(previous);
    const changed = { ...config, model: "next-model" };
    const identity = toolCacheIdentity(changed);
    const ctx = { cwd: "/repo", llmConfig: changed } as ToolContext;
    const persisted: SessionToolSelection[] = [];
    const definitions = initializeRunToolSurface(ctx, ["LateTool"], catalog, {
      taskText: "different routing intent",
      selection: previous,
      onSelectionChanged: (value) => persisted.push(value),
    });
    expect(definitions.map((tool) => tool.name)).toEqual([
      "ToolSearch",
      "CallTool",
      "Frozen",
      "Deferred",
      "OtherDeferred",
    ]);
    expect(definitions.find((tool) => tool.name === "Frozen")!.description).toBe("updated schema");
    expect(persisted.at(-1)).toMatchObject({ cacheIdentity: identity, discovered: [] });
    expect(JSON.stringify(previous)).toBe(bytes);
    expect(selectionForToolCacheCycle(persisted.at(-1), identity)).toEqual(persisted.at(-1));
  });

  test("manual cold rebase preserves name order and never mutates the previous state", () => {
    const previous = selection();
    previous.discovered.push("Frozen", "Deferred");
    const bytes = JSON.stringify(previous);
    const rebased = rebaseToolSelection(previous)!;
    expect(rebased.names).toEqual([
      "ToolSearch",
      "CallTool",
      "Frozen",
      "Deferred",
      "OtherDeferred",
    ]);
    expect(rebased.discovered).toEqual([]);
    expect(rebased.cacheIdentity).toBe(previous.cacheIdentity);
    const surface = new RunToolSurface(undefined, { selection: rebased });
    surface.updateCatalog(catalog());
    expect(surface.snapshot().find((tool) => tool.name === "Frozen")!.description).toBe(
      "updated schema",
    );
    expect(surface.isCallable("Deferred")).toBe(true);
    expect(JSON.stringify(previous)).toBe(bytes);
  });

  test("first identity assignment does not promote existing discoveries", () => {
    const previous = selection();
    delete previous.cacheIdentity;
    const next = selectionForToolCacheCycle(
      previous,
      toolCacheIdentity(config),
    ) as SessionToolSelection;
    expect(next.names).toEqual(previous.names);
    expect(next.discovered).toEqual(previous.discovered);
    expect(next.frozenDefinitions).toEqual(previous.frozenDefinitions);
    expect(next.cacheIdentity).toBe(toolCacheIdentity(config));
  });
});

describe("tool cache compaction boundaries", () => {
  test.each(["summary", "snip", "window", "emergency", "notes", "range"])(
    "%s honors explicit history replacement and falls back to token progress",
    (strategy) => {
      expect(isToolCacheCompaction({ strategy, before: 1_000, after: 500 })).toBe(true);
      expect(isToolCacheCompaction({ strategy, before: 1_000, after: 1_000 })).toBe(false);
      expect(isToolCacheCompaction({ strategy, before: 1_000, after: 1_100 })).toBe(false);
      expect(
        isToolCacheCompaction({ strategy, before: 1_000, after: 1_000, historyChanged: true }),
      ).toBe(true);
      expect(
        isToolCacheCompaction({ strategy, before: 1_000, after: 1_100, historyChanged: true }),
      ).toBe(true);
      expect(
        isToolCacheCompaction({ strategy, before: 1_000, after: 500, historyChanged: false }),
      ).toBe(false);
    },
  );

  test("microcompaction preserves the current cycle even when it clears ordinary results", () => {
    expect(isToolCacheCompaction({ strategy: "micro", before: 1_000, after: 500 })).toBe(false);
    expect(
      isToolCacheCompaction({ strategy: "micro", before: 1_000, after: 500, historyChanged: true }),
    ).toBe(false);
  });
});

describe("run surface persistence compatibility", () => {
  test.each(["manual compaction", "model change"])(
    "%s cannot insert a returning tool into a saved partial snapshot",
    async (boundary) => {
      const previous = selection();
      const runConfig = boundary === "model change" ? { ...config, model: "next-model" } : config;
      const coldSelection =
        boundary === "manual compaction" ? rebaseToolSelection(previous) : previous;
      const absent = new Set(["Frozen", "Deferred"]);
      const first = { cwd: "/repo", llmConfig: runConfig } as ToolContext;
      const prefix = JSON.stringify(
        initializeRunToolSurface(
          first,
          [],
          () => catalog().filter((tool) => !absent.has(tool.name)),
          { taskText: "cold cycle", selection: coldSelection },
        ),
      );
      const saved = JSON.parse(JSON.stringify(first.runToolSurface!.getSelection()));
      for (const name of absent) expect(saved.names).toContain(name);
      expect(saved.discovered).toEqual([]);
      const resumed = { cwd: "/repo", llmConfig: runConfig } as ToolContext;
      initializeRunToolSurface(resumed, [], catalog, {
        taskText: "tools have returned",
        selection: saved,
      });
      expect(JSON.stringify(resumed.refreshRunTools!())).toBe(prefix);
      for (const name of absent) {
        expect(resumed.runToolSurface!.isEligible(name)).toBe(true);
        expect(resumed.runToolSurface!.isCallable(name)).toBe(false);
      }
      const receipt = await toolSearchTool({ query: "select:Frozen,Deferred" }, resumed);
      expect(receipt).toContain('"name":"Frozen","description":"updated schema"');
      expect(receipt).toContain('"name":"Deferred"');
      expect(receipt).toContain('"inputSchema":{"type":"object","properties":{}}');
      expect(JSON.stringify(resumed.refreshRunTools!())).toBe(prefix);
      for (const name of absent) expect(resumed.runToolSurface!.isCallable(name)).toBe(true);
      expect(resumed.runToolSurface!.getSelection().discovered).toEqual(["Frozen", "Deferred"]);
      resumed.runToolSurface!.rebase();
      expect(resumed.refreshRunTools!().map((tool) => tool.name)).toEqual([
        "ToolSearch",
        "CallTool",
        "Frozen",
        "Deferred",
        "OtherDeferred",
      ]);
    },
  );

  test("resume keeps unavailable top schemas and ignores new initial routing choices", () => {
    const previous = selection();
    const ctx = { cwd: "/repo", llmConfig: config } as ToolContext;
    const definitions = initializeRunToolSurface(
      ctx,
      ["LateTool"],
      () => catalog().filter((tool) => tool.name !== "Frozen"),
      { taskText: "new task keywords", selection: previous },
    );
    expect(JSON.stringify(definitions)).toBe(JSON.stringify(previous.frozenDefinitions));
    expect(ctx.runToolSurface!.isEligible("Frozen")).toBe(false);
    expect(ctx.runToolSurface!.isCallable("Frozen")).toBe(false);
    expect(ctx.runToolSurface!.isCallable("Deferred")).toBe(true);
  });

  test("v1 migration installs CallTool beside ToolSearch exactly once", () => {
    const ctx = { cwd: "/repo", llmConfig: config } as ToolContext;
    let persisted: SessionToolSelection | undefined;
    const definitions = initializeRunToolSurface(ctx, ["LateTool"], catalog, {
      taskText: "new routing keywords",
      selection: { version: 1, names: ["Frozen", "ToolSearch"] },
      onSelectionChanged: (value) => {
        persisted = value;
      },
    });
    expect(definitions.map((tool) => tool.name)).toEqual(["Frozen", "ToolSearch", "CallTool"]);
    expect(persisted).toMatchObject({ version: 2, discovered: [] });
    const resumed = { cwd: "/repo", llmConfig: config } as ToolContext;
    expect(
      initializeRunToolSurface(resumed, ["LateTool"], catalog, {
        taskText: "another run",
        selection: persisted,
      }),
    ).toEqual(definitions);
  });

  test.each([
    { label: "future version", value: { version: 99, names: ["Frozen"], extra: "keep" } },
    { label: "wrong names", value: { version: 2, names: "Frozen", discovered: [] } },
    { label: "missing discovered", value: { version: 2, names: ["Frozen"] } },
    {
      label: "damaged definitions",
      value: { version: 2, names: ["Frozen"], discovered: [], frozenDefinitions: [{}] },
    },
    { label: "null", value: null },
    { label: "string", value: "future serialized state" },
  ])("preserves $label state without throwing or overwriting it", ({ value }) => {
    const bytes = JSON.stringify(value);
    const ctx = { cwd: "/repo", llmConfig: config } as ToolContext;
    const writes: SessionToolSelection[] = [];
    expect(selectionForToolCacheCycle(value, "new-identity")).toBe(value);
    expect(rebaseToolSelection(value)).toBeUndefined();
    expect(() =>
      initializeRunToolSurface(ctx, ["ToolSearch"], catalog, {
        taskText: "work",
        selection: value,
        onSelectionChanged: (next) => writes.push(next),
      }),
    ).not.toThrow();
    ctx.refreshRunTools!();
    ctx.runToolSurface!.select(["Deferred"]);
    ctx.runToolSurface!.rebase();
    ctx.refreshRunTools!();
    expect(writes).toEqual([]);
    expect(JSON.stringify(value)).toBe(bytes);
  });

  test("missing state initializes and persists a fresh cycle", () => {
    const ctx = { cwd: "/repo", llmConfig: config } as ToolContext;
    const writes: SessionToolSelection[] = [];
    initializeRunToolSurface(ctx, ["ToolSearch"], catalog, {
      taskText: "work",
      onSelectionChanged: (value) => writes.push(value),
    });
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.at(-1)).toMatchObject({
      version: 2,
      names: ["ToolSearch", "CallTool"],
      discovered: [],
      cacheIdentity: toolCacheIdentity(config),
    });
  });
});

test("cached summary replacement rebases discovered schemas even when tokens grow", async () => {
  const { ContextManager } = await import("../context/manager.js");
  const { estimateTokens } = await import("../context/compaction.js");
  const messages = [
    { role: "user" as const, content: "Initial request" },
    {
      role: "assistant" as const,
      content: [
        {
          type: "tool_use" as const,
          id: "discover",
          name: "ToolSearch",
          input: { query: "select:Deferred" },
        },
      ],
    },
    {
      role: "user" as const,
      content: [
        {
          type: "tool_result" as const,
          tool_use_id: "discover",
          content: JSON.stringify(definition("Deferred")),
        },
      ],
    },
    { role: "assistant" as const, content: "Earlier context" },
    ...Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      content: "Recent context remains. ".repeat(220),
    })),
  ];
  const manager = new ContextManager({ maxTokens: Math.ceil(estimateTokens(messages) / 0.86) });
  manager.setSummarizeFn(async () => "Cached earlier decisions. ".repeat(40));
  await manager.summarizeRange(
    [{ role: "user", content: "Earlier lengthy history. ".repeat(400) }],
    { start: 0, end: 1 },
  );
  const surface = new RunToolSurface(["ToolSearch", "Frozen"]);
  surface.updateCatalog(catalog());
  surface.select(["Deferred"]);
  const events: Array<{ strategy: string; before: number; after: number }> = [];
  manager.setOnCompact((event) => {
    events.push(event);
    if (isToolCacheCompaction(event)) surface.rebase();
  });
  const managed = manager.manage(messages);
  expect(events.map((event) => event.strategy)).toEqual(["summary"]);
  expect(events[0]!.after).toBeGreaterThan(events[0]!.before);
  expect(JSON.stringify(managed)).not.toContain('"tool_use_id":"discover"');
  expect(surface.snapshot().map((tool) => tool.name)).toContain("Deferred");
  expect(surface.getSelection().discovered).toEqual([]);
});

test.each(["manage", "manageAsync", "forceSummarize"] as const)(
  "%s does not rebase when every destructive tier leaves history intact",
  async (method) => {
    const { ContextManager } = await import("../context/manager.js");
    const manager = new ContextManager({ maxTokens: 10 });
    const messages = [
      { role: "user" as const, content: "An oversized initial request. ".repeat(20) },
      { role: "assistant" as const, content: "A recent answer that must remain. ".repeat(20) },
    ];
    const events: Array<{ historyChanged?: boolean }> = [];
    manager.setOnCompact((event) => {
      events.push(event);
      expect(isToolCacheCompaction(event)).toBe(false);
    });
    expect(await manager[method](messages)).toEqual(messages);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.historyChanged === false)).toBe(true);
  },
);

describe("native discovery cache cycles", () => {
  const native: LLMConfig = {
    provider: "anthropic",
    providerKind: "openrouter",
    model: "anthropic/claude-sonnet-5",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: { mode: "off" },
  };
  test("discovery mode changes the cycle without changing legacy CallTool identities", () => {
    const off = toolCacheIdentity(native);
    const on = toolCacheIdentity({ ...native, reasoning: { mode: "on" } });
    expect(off).not.toBe(on);
    expect(toolCacheIdentity({ ...native, reasoning: undefined })).toBe(on);
    expect(toolCacheIdentity({ ...config, reasoning: { mode: "off" } })).toBe(
      toolCacheIdentity(config),
    );
    expect(toolCacheIdentity({ ...native, apiKey: "rotated-key" })).toBe(off);
  });
  test("switching mode clears both schema snapshots and promotes discoveries once", () => {
    const previous: SessionToolSelection = {
      ...selection(),
      cacheIdentity: toolCacheIdentity(native),
      deferredDefinitions: [definition("Deferred"), definition("OtherDeferred")],
    };
    const result = selectionForToolCacheCycle(
      previous,
      toolCacheIdentity({ ...native, reasoning: { mode: "on" } }),
    ) as SessionToolSelection;
    expect(result).not.toHaveProperty("frozenDefinitions");
    expect(result).not.toHaveProperty("deferredDefinitions");
    expect(result.names).toContain("Deferred");
    expect(result.discovered).toEqual([]);
    expect(previous.deferredDefinitions).toHaveLength(2);
  });
  test("run initialization keeps deferred definitions out of the composer and model eager names", () => {
    const ctx = { cwd: "/repo", llmConfig: native } as ToolContext;
    const eager = initializeRunToolSurface(ctx, ["ToolSearch"], catalog);
    expect(eager.map((tool) => tool.name)).toEqual(["ToolSearch", "CallTool"]);
    const request = ctx.refreshRunTools!();
    expect(request.filter((tool) => tool.deferLoading).map((tool) => tool.name)).toEqual([
      "Frozen",
      "Deferred",
      "OtherDeferred",
      "LateTool",
    ]);
    expect([...ctx.modelToolNames!]).toEqual(["ToolSearch", "CallTool"]);
    expect(ctx.runToolSurface!.isCallable("Deferred")).toBe(false);
    ctx.runToolSurface!.select(["Deferred"]);
    const previous = JSON.stringify(request);
    expect(JSON.stringify(ctx.refreshRunTools!())).toBe(previous);
    ctx.runToolSurface!.rebase();
    const next = ctx.refreshRunTools!();
    expect(next.find((tool) => tool.name === "Deferred")?.deferLoading).toBeUndefined();
    expect(ctx.modelToolNames!.has("Deferred")).toBe(true);
  });
  test("legacy native bootstrap rebases once while an empty deferred snapshot stays authoritative", () => {
    const previous = { ...selection(), cacheIdentity: undefined };
    const legacyCtx = { cwd: "/repo", llmConfig: native } as ToolContext;
    initializeRunToolSurface(legacyCtx, [], catalog, { taskText: "", selection: previous });
    expect(legacyCtx.runToolSurface!.getSelection().names).toContain("Deferred");
    expect(legacyCtx.runToolSurface!.getSelection().discovered).toEqual([]);
    const emptyCtx = { cwd: "/repo", llmConfig: native } as ToolContext;
    initializeRunToolSurface(emptyCtx, [], catalog, {
      taskText: "",
      selection: { ...previous, deferredDefinitions: [] },
    });
    expect(emptyCtx.runToolSurface!.getSelection().discovered).toEqual(previous.discovered);
    expect(emptyCtx.refreshRunTools!().some((tool) => tool.deferLoading)).toBe(false);
  });
  test("an incompatible saved native directory is cold-rebased into portable discoveries", () => {
    const name = "mcp_" + "x".repeat(125);
    const saved: SessionToolSelection = {
      version: 2,
      names: ["ToolSearch", "CallTool", name],
      discovered: [],
      frozenDefinitions: [definition("ToolSearch"), definition("CallTool"), definition(name)],
      deferredDefinitions: [],
      cacheIdentity: toolCacheIdentity(native),
    };
    const ctx = { cwd: "/repo", llmConfig: native } as ToolContext;
    initializeRunToolSurface(ctx, [], () => [...catalog(), definition(name)], {
      taskText: "",
      selection: saved,
    });
    expect(ctx.refreshRunTools!().some((tool) => tool.name === name)).toBe(false);
    expect(ctx.runToolSurface!.isCallable(name)).toBe(true);
    expect(ctx.runToolSurface!.getSelection().discovered).toContain(name);
  });
});
