import { describe, expect, test } from "bun:test";
import type { LLMConfig, SessionToolSelection, ToolDefinition } from "../types.js";
import type { ToolContext } from "../tool-system/context.js";
import { RunToolSurface } from "../tool-system/run-tool-surface.js";
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
    "%s starts a new cycle only after context actually shrinks",
    (strategy) => {
      expect(isToolCacheCompaction({ strategy, before: 1_000, after: 500 })).toBe(true);
      expect(isToolCacheCompaction({ strategy, before: 1_000, after: 1_000 })).toBe(false);
      expect(isToolCacheCompaction({ strategy, before: 1_000, after: 1_100 })).toBe(false);
    },
  );

  test("microcompaction preserves the current cycle even when it clears ordinary results", () => {
    expect(isToolCacheCompaction({ strategy: "micro", before: 1_000, after: 500 })).toBe(false);
  });
});

describe("run surface persistence compatibility", () => {
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
