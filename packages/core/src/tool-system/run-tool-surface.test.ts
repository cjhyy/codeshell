import { describe, expect, it } from "bun:test";
import type { SessionToolSelection, ToolDefinition } from "../types.js";
import { callToolDef } from "./builtin/call-tool.js";
import { resolveModelToolCall } from "./resolve-model-tool-call.js";
import { normalizeSessionToolSelection, RunToolSurface } from "./run-tool-surface.js";

function definition(name: string, description = `${name} purpose`): ToolDefinition {
  return { name, description, inputSchema: { type: "object", properties: {} } };
}

const names = (surface: RunToolSurface) => surface.snapshot().map((tool) => tool.name);

describe("RunToolSurface", () => {
  it("keeps discovered schemas out of the frozen provider prefix until rebase", () => {
    const changes: SessionToolSelection[] = [];
    const surface = new RunToolSurface([], {
      onSelectionChanged: (selection) => changes.push(selection),
    });
    surface.updateCatalog([
      definition("ToolSearch"),
      callToolDef,
      definition("Read"),
      definition("Write"),
    ]);
    const before = JSON.stringify(surface.snapshot());
    expect(surface.select(["Write", "Missing", "Read", "Write", "read", "Missing"])).toEqual({
      selected: ["Write", "Read"],
      unavailable: ["Missing", "read"],
    });
    expect(JSON.stringify(surface.snapshot())).toBe(before);
    expect(surface.getSelection().names).toEqual(["ToolSearch", "CallTool"]);
    expect(surface.getSelection().discovered).toEqual(["Write", "Read"]);
    expect(surface.isCallable("Write")).toBe(true);
    expect(surface.isCallable("Missing")).toBe(false);
    surface.select(["Read", "ToolSearch"]);
    expect(changes).toHaveLength(2);
    changes[1].discovered.push("Other");
    expect(surface.getSelection().discovered).toEqual(["Write", "Read"]);
    surface.rebase();
    expect(names(surface)).toEqual(["ToolSearch", "CallTool", "Write", "Read"]);
    expect(surface.getSelection().discovered).toEqual([]);
  });

  it("retains unavailable top schemas across disk resume without restoring eligibility", () => {
    const first = new RunToolSurface(["Write"]);
    first.updateCatalog([definition("ToolSearch"), definition("Write"), definition("Read")]);
    first.select(["Read"]);
    const before = JSON.stringify(first.snapshot());
    first.updateCatalog([definition("ToolSearch"), definition("Read")]);
    expect(JSON.stringify(first.snapshot())).toBe(before);
    expect(first.isCallable("Write")).toBe(false);
    const saved = JSON.parse(JSON.stringify(first.getSelection()));
    const resumed = new RunToolSurface(["NewRoute"], { selection: saved });
    saved.names.push("Unselected");
    resumed.updateCatalog([definition("Read", "fresh read"), definition("ToolSearch")]);
    expect(JSON.stringify(resumed.snapshot())).toBe(before);
    expect(resumed.isCallable("Read")).toBe(true);
    expect(resumed.isCallable("Write")).toBe(false);
    resumed.updateCatalog([
      definition("Read", "fresh read"),
      definition("Write", "fresh write"),
      definition("Unselected"),
      definition("ToolSearch"),
    ]);
    expect(JSON.stringify(resumed.snapshot())).toBe(before);
    expect(resumed.isCallable("Write")).toBe(true);
    expect(resumed.isCallable("Unselected")).toBe(false);
    expect(resumed.getDefinition("Write")?.description).toBe("fresh write");
    resumed.rebase();
    expect(names(resumed)).toEqual(["Write", "ToolSearch", "Read"]);
    expect(resumed.snapshot()[0].description).toBe("fresh write");
  });

  it("requires rediscovery when a tool was unavailable during promotion and returns later", () => {
    const bootstrap = [definition("ToolSearch"), callToolDef];
    const first = new RunToolSurface(["Read"]);
    first.updateCatalog([...bootstrap, definition("Read", "old read schema"), definition("Write")]);
    first.select(["Write"]);
    first.updateCatalog(bootstrap);
    first.rebase();
    const prefix = JSON.stringify(first.snapshot());
    expect(first.snapshot()[0].description).toBe("old read schema");
    expect(first.getSelection().names).toContain("Write");
    expect(first.getSelection().discovered).toEqual([]);

    const returnedCatalog = [
      ...bootstrap,
      definition("Read", "new read schema"),
      definition("Write", "returned schema"),
    ];
    first.updateCatalog(returnedCatalog);
    expect(first.isCallable("Read")).toBe(true);
    expect(first.isEligible("Write")).toBe(true);
    expect(first.isCallable("Write")).toBe(false);
    const resumed = new RunToolSurface([], {
      selection: JSON.parse(JSON.stringify(first.getSelection())),
    });
    resumed.updateCatalog(returnedCatalog);
    expect(JSON.stringify(resumed.snapshot())).toBe(prefix);
    expect(resumed.isCallable("Write")).toBe(false);
    resumed.select(["Write"]);
    expect(resumed.getSelection().discovered).toEqual(["Write"]);
    expect(resumed.isCallable("Write")).toBe(true);
    expect(JSON.stringify(resumed.snapshot())).toBe(prefix);

    const rediscovered = new RunToolSurface([], {
      selection: JSON.parse(JSON.stringify(resumed.getSelection())),
    });
    rediscovered.updateCatalog(returnedCatalog);
    expect(JSON.stringify(rediscovered.snapshot())).toBe(prefix);
    expect(rediscovered.isCallable("Write")).toBe(true);
    rediscovered.rebase();
    expect(rediscovered.snapshot().find((tool) => tool.name === "Write")?.description).toBe(
      "returned schema",
    );
    expect(rediscovered.getSelection().discovered).toEqual([]);
  });

  it("preserves an explicitly empty snapshot when retained tools return", () => {
    const surface = new RunToolSurface(undefined, {
      selection: { version: 2, names: ["Read"], discovered: [], frozenDefinitions: [] },
    });
    surface.updateCatalog([definition("Read")]);
    expect(surface.snapshot()).toEqual([]);
    expect(surface.isEligible("Read")).toBe(true);
    expect(surface.isCallable("Read")).toBe(false);
    surface.select(["Read"]);
    expect(surface.isCallable("Read")).toBe(true);
    expect(surface.snapshot()).toEqual([]);
    surface.rebase();
    expect(names(surface)).toEqual(["Read"]);
  });

  it("upgrades v1 loading order and gives it the static CallTool wrapper", () => {
    expect(normalizeSessionToolSelection({ version: 1, names: ["Read", "Read"] })).toEqual({
      version: 2,
      names: ["Read"],
      discovered: [],
    });
    const surface = new RunToolSurface(["Write"], {
      selection: { version: 1, names: ["Read", "ToolSearch"] },
    });
    surface.updateCatalog([
      definition("ToolSearch"),
      callToolDef,
      definition("Write"),
      definition("Read"),
    ]);
    expect(names(surface)).toEqual(["Read", "ToolSearch", "CallTool"]);
    expect(surface.isCallable("Write")).toBe(false);
    expect(callToolDef.inputSchema.properties).toEqual({
      name: { type: "string", description: "Exact tool name from ToolSearch." },
      args: { type: "object", description: "Arguments matching the tool's schema." },
    });
  });

  it("does not add a newly eligible wrapper to an existing v2 cache cycle", () => {
    const original = new RunToolSurface([]);
    original.updateCatalog([definition("ToolSearch"), definition("Read")]);
    const saved = original.getSelection();
    const resumed = new RunToolSurface([], { selection: saved });
    resumed.updateCatalog([definition("ToolSearch"), callToolDef, definition("Read")]);
    expect(resumed.snapshot()).toEqual(original.snapshot());
    expect(resumed.isCallable("CallTool")).toBe(false);
  });

  it("normalizes malformed state without throwing or mutating the supplied state", () => {
    const circular: any[] = [];
    circular.push(circular);
    for (const selection of [
      null,
      { version: 2, names: ["Read"] },
      { version: 1, names: [" Read"] },
      { version: 1, names: ["bad\nname"] },
      { version: 1, names: [7] },
      { version: 1, names: Array(4097).fill("Read") },
      { version: 3, names: [] },
      { version: 2, names: [], discovered: [false] },
      { version: 2, names: [], discovered: [], frozenDefinitions: [definition("Hidden")] },
      { version: 2, names: ["Read"], discovered: [], frozenDefinitions: [{ name: "Read" }] },
      {
        version: 2,
        names: ["Read"],
        discovered: [],
        frozenDefinitions: [definition("Read"), definition("Read")],
      },
      {
        version: 2,
        names: ["Read"],
        discovered: [],
        frozenDefinitions: [{ ...definition("Read"), inputSchema: { circular } }],
      },
    ]) {
      expect(normalizeSessionToolSelection(selection)).toBeUndefined();
    }
    const valid = {
      version: 2,
      names: ["Read", "Read"],
      discovered: ["Write", "Write"],
      cacheIdentity: "model-route",
    };
    const before = JSON.stringify(valid);
    const normalized = normalizeSessionToolSelection(valid)!;
    expect(normalized).toEqual({
      version: 2,
      names: ["Read"],
      discovered: ["Write"],
      cacheIdentity: "model-route",
    });
    expect(JSON.stringify(valid)).toBe(before);
    const restored = new RunToolSurface([], { selection: valid });
    restored.updateCatalog([definition("Read"), definition("Write")]);
    expect(restored.getSelection().cacheIdentity).toBe("model-route");
  });

  it("freezes only the first eager catalog and does not absorb later additions", () => {
    const surface = new RunToolSurface();
    surface.updateCatalog([definition("Read"), definition("ToolSearch")]);
    expect(names(surface)).toEqual(["Read", "ToolSearch"]);
    surface.updateCatalog([definition("Late"), definition("ToolSearch"), definition("Read")]);
    expect(names(surface)).toEqual(["Read", "ToolSearch"]);
    expect(surface.isEligible("Late")).toBe(true);
    expect(surface.isCallable("Late")).toBe(false);
  });

  it("freezes copied initial names and registers CallTool only alongside ToolSearch", () => {
    const initial = ["Write", "Read", "Late"];
    const surface = new RunToolSurface(initial);
    initial.push("Other");
    surface.updateCatalog([
      definition("Read"),
      definition("Write"),
      definition("Other"),
      definition("ToolSearch"),
      callToolDef,
    ]);
    expect(names(surface)).toEqual(["Write", "Read", "ToolSearch", "CallTool"]);
    surface.updateCatalog([
      definition("ToolSearch"),
      callToolDef,
      definition("Late"),
      definition("Read"),
      definition("Write"),
    ]);
    expect(names(surface)).toEqual(["Write", "Read", "ToolSearch", "CallTool"]);
    expect(surface.isCallable("Late")).toBe(false);
    const eager = new RunToolSurface([]);
    eager.updateCatalog([definition("Read"), callToolDef]);
    expect(names(eager)).toEqual(["Read"]);
  });

  it("does not grow the prefix when discovery is revoked or appears late", () => {
    const surface = new RunToolSurface([]);
    surface.updateCatalog([definition("Read")]);
    surface.updateCatalog([
      definition("Read"),
      definition("ToolSearch"),
      callToolDef,
      definition("Late"),
    ]);
    expect(names(surface)).toEqual(["Read"]);
    expect(surface.isCallable("ToolSearch")).toBe(false);
    const deferred = new RunToolSurface([]);
    deferred.updateCatalog([definition("ToolSearch"), callToolDef, definition("Read")]);
    deferred.select(["Read"]);
    const before = JSON.stringify(deferred.snapshot());
    deferred.updateCatalog([definition("Read"), definition("Late")]);
    expect(JSON.stringify(deferred.snapshot())).toBe(before);
    expect(deferred.isCallable("ToolSearch")).toBe(false);
    expect(deferred.isCallable("Read")).toBe(true);
    expect(deferred.isCallable("Late")).toBe(false);
  });

  it("does not remember unavailable selections when that tool appears later", () => {
    const surface = new RunToolSurface([]);
    surface.updateCatalog([definition("ToolSearch")]);
    expect(surface.select(["Late"])).toEqual({ selected: [], unavailable: ["Late"] });
    surface.updateCatalog([definition("Late"), definition("ToolSearch")]);
    expect(surface.isEligible("Late")).toBe(true);
    expect(surface.isCallable("Late")).toBe(false);
    expect(names(surface)).toEqual(["ToolSearch"]);
  });

  it("freezes independent catalog and provider copies without losing nested schema data", () => {
    const tool: ToolDefinition = {
      name: "Dynamic",
      description: "authorized destination",
      sensitiveResult: true,
      inputSchema: {
        type: "object",
        required: ["target"],
        additionalProperties: false,
        $defs: { target: { enum: ["opaque-1", null], default: null } },
        properties: { target: { $ref: "#/$defs/target" } },
      },
    };
    const expected = structuredClone(tool);
    const surface = new RunToolSurface(["Dynamic"]);
    surface.updateCatalog([tool]);
    const catalog = surface.getCatalog();
    const snapshot = surface.snapshot();
    expect(snapshot).toEqual([expected]);
    expect(snapshot).not.toBe(catalog);
    expect(snapshot[0]).not.toBe(catalog[0]);
    expect(snapshot[0].inputSchema).not.toBe(catalog[0].inputSchema);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0].inputSchema.$defs)).toBe(true);
    expect(Reflect.set(snapshot[0].inputSchema, "additionalProperties", true)).toBe(false);
    tool.description = "mutated source";
    (tool.inputSchema.required as string[]).push("mutated");
    expect(surface.snapshot()).toEqual([expected]);
    expect(surface.getCatalog()).toEqual([expected]);
    surface.updateCatalog([{ ...tool, description: "changed schema" }]);
    expect(surface.snapshot()).toEqual([expected]);
    surface.rebase();
    expect(surface.snapshot()[0].description).toBe("changed schema");
  });

  it("keeps discovery independent between runs sharing a catalog", () => {
    const catalog = [definition("ToolSearch"), definition("Read")];
    const first = new RunToolSurface([]);
    const second = new RunToolSurface([]);
    first.updateCatalog(catalog);
    second.updateCatalog(catalog);
    first.select(["Read"]);
    expect(names(first)).toEqual(["ToolSearch"]);
    expect(names(second)).toEqual(["ToolSearch"]);
    expect(first.isCallable("Read")).toBe(true);
    expect(second.isCallable("Read")).toBe(false);
  });
});

describe("RunToolSurface native references", () => {
  const bootstrap = [definition("ToolSearch"), callToolDef];
  const native = (selection?: unknown) =>
    new RunToolSurface(["Read"], { toolDiscovery: "tool-reference", selection });

  it("keeps transport-incompatible discovery callable through rebase and restart", () => {
    const fallback = ["x".repeat(129), "命名工具", "extension:read", "NonObject"];
    // The transport owns compatibility; the surface only consumes its decision.
    const canExposeDefinition = (tool: ToolDefinition) => !fallback.includes(tool.name);
    const catalog = [
      ...bootstrap,
      definition("Read"),
      definition("Deferred"),
      ...fallback.map((name) => definition(name)),
    ];
    const surface = new RunToolSurface(["Read"], {
      toolDiscovery: "tool-reference",
      canExposeDefinition,
    });
    surface.updateCatalog(catalog);
    const before = JSON.stringify(surface.requestSnapshot());
    expect(surface.getSelection().deferredDefinitions).toEqual([definition("Deferred")]);
    for (const name of fallback) {
      expect(surface.isEligible(name)).toBe(true);
      expect(surface.isCallable(name)).toBe(false);
    }
    surface.select(fallback);
    expect(JSON.stringify(surface.requestSnapshot())).toBe(before);
    surface.rebase();
    expect(surface.getSelection().discovered).toEqual(fallback);
    expect(JSON.stringify(surface.requestSnapshot())).toBe(before);
    const resumed = new RunToolSurface([], {
      toolDiscovery: "tool-reference",
      canExposeDefinition,
      selection: JSON.parse(JSON.stringify(surface.getSelection())),
    });
    resumed.updateCatalog([...catalog, definition("Late")]);
    expect(JSON.stringify(resumed.requestSnapshot())).toBe(before);
    for (const name of fallback) {
      expect(resumed.isCallable(name)).toBe(true);
      expect(
        resolveModelToolCall(
          { id: "fallback", toolName: "CallTool", args: { name, args: {} } },
          resumed,
        ),
      ).toMatchObject({ call: { toolName: name, wireToolName: "CallTool" } });
    }
    resumed.updateCatalog(bootstrap);
    for (const name of fallback) expect(resumed.isCallable(name)).toBe(false);
  });

  it("preserves cold initial grants through fallback without discovering absent definitions", () => {
    const surface = new RunToolSurface([], {
      toolDiscovery: "tool-reference",
      canExposeDefinition: (tool) => tool.name !== "extension:read",
      selection: {
        version: 2,
        names: ["ToolSearch", "extension:read", "Absent"],
        discovered: [],
      },
    });
    surface.updateCatalog([...bootstrap, definition("extension:read")]);
    expect(names(surface)).toEqual(["ToolSearch", "CallTool"]);
    expect(surface.getSelection().names).toEqual(["ToolSearch", "Absent", "CallTool"]);
    expect(surface.getSelection().discovered).toEqual(["extension:read"]);
    expect(surface.isCallable("extension:read")).toBe(true);
    expect(surface.isCallable("Absent")).toBe(false);
    surface.updateCatalog([...bootstrap, definition("extension:read"), definition("Absent")]);
    expect(surface.isCallable("Absent")).toBe(false);
  });

  it("demotes an incompatible eager definition only at a cold boundary", () => {
    const canExposeDefinition = (tool: ToolDefinition) => tool.inputSchema.type === "object";
    const surface = new RunToolSurface(["Read"], {
      toolDiscovery: "tool-reference",
      canExposeDefinition,
    });
    surface.updateCatalog([...bootstrap, definition("Read")]);
    const before = JSON.stringify(surface.requestSnapshot());
    const changed = { ...definition("Read"), inputSchema: { type: "array" } };
    surface.updateCatalog([...bootstrap, changed]);
    expect(JSON.stringify(surface.requestSnapshot())).toBe(before);
    surface.rebase();
    expect(names(surface)).toEqual(["ToolSearch", "CallTool"]);
    expect(surface.getSelection().deferredDefinitions).toEqual([]);
    expect(surface.getSelection().discovered).toEqual(["Read"]);
    expect(surface.getDefinition("Read")).toEqual(changed);
    expect(surface.isCallable("Read")).toBe(true);
  });

  it("freezes the full request catalog without granting deferred tools execution", () => {
    const surface = native();
    const write = {
      ...definition("Write"),
      inputSchema: { type: "object", properties: { z: {}, a: {} } },
    };
    surface.updateCatalog([...bootstrap, { ...definition("Read"), deferLoading: true }, write]);
    expect(surface.toolDiscovery).toBe("tool-reference");
    expect(names(surface)).toEqual(["Read", "ToolSearch", "CallTool"]);
    expect(surface.snapshot().every((tool) => tool.deferLoading === undefined)).toBe(true);
    const request = surface.requestSnapshot();
    expect(request.at(-1)).toEqual({ ...write, deferLoading: true });
    expect(Object.isFrozen(request.at(-1)?.inputSchema.properties)).toBe(true);
    expect(surface.isEligible("Write")).toBe(true);
    expect(surface.isCallable("Write")).toBe(false);
    const before = JSON.stringify(request);
    surface.select(["Write"]);
    expect(surface.isCallable("Write")).toBe(true);
    expect(JSON.stringify(surface.requestSnapshot())).toBe(before);
    expect(surface.getSelection().deferredDefinitions).toEqual([write]);
  });

  it("preserves unavailable and changed deferred schemas over catalog refresh and disk resume", () => {
    const first = native();
    first.updateCatalog([...bootstrap, definition("Read"), definition("Write", "original")]);
    const before = JSON.stringify(first.requestSnapshot());
    first.select(["Write"]);
    first.updateCatalog(bootstrap);
    expect(first.isCallable("Write")).toBe(false);
    expect(JSON.stringify(first.requestSnapshot())).toBe(before);
    const saved = JSON.parse(JSON.stringify(first.getSelection()));
    const resumed = native(saved);
    saved.deferredDefinitions[0].description = "mutated caller";
    resumed.updateCatalog([...bootstrap, definition("Write", "changed"), definition("Late")]);
    expect(JSON.stringify(resumed.requestSnapshot())).toBe(before);
    expect(resumed.getDefinition("Write")?.description).toBe("changed");
    expect(resumed.isCallable("Write")).toBe(true);
    expect(resumed.isCallable("Late")).toBe(false);
    resumed.select(["Late"]);
    expect(resumed.isCallable("Late")).toBe(true);
    expect(JSON.stringify(resumed.requestSnapshot())).toBe(before);
  });

  it("treats an explicit empty deferred snapshot as authoritative", () => {
    const first = native();
    first.updateCatalog(bootstrap);
    expect(first.getSelection().deferredDefinitions).toEqual([]);
    const saved = JSON.parse(JSON.stringify(first.getSelection()));
    const resumed = native(saved);
    resumed.updateCatalog([...bootstrap, definition("Read"), definition("Late")]);
    expect(resumed.requestSnapshot()).toEqual(first.requestSnapshot());
    expect(resumed.isCallable("Read")).toBe(false);
    expect(resumed.isCallable("Late")).toBe(false);
    resumed.updateCatalog([...bootstrap, definition("Another")]);
    expect(resumed.getSelection().deferredDefinitions).toEqual([]);
  });

  it("rebuilds deferred schemas immediately on rebase, then freezes them over restart", () => {
    const surface = native();
    surface.updateCatalog([
      ...bootstrap,
      definition("Read"),
      definition("Write"),
      definition("Other", "old"),
    ]);
    surface.select(["Write"]);
    surface.updateCatalog([
      ...bootstrap,
      definition("Read"),
      definition("Other", "new"),
      definition("Late"),
    ]);
    surface.rebase();
    expect(surface.getSelection().names).toContain("Write");
    expect(surface.getSelection().discovered).toEqual([]);
    expect(surface.requestSnapshot().find((tool) => tool.name === "Write")).toBeUndefined();
    expect(surface.getSelection().deferredDefinitions).toEqual([
      definition("Other", "new"),
      definition("Late"),
    ]);
    const before = JSON.stringify(surface.requestSnapshot());
    const resumed = native(JSON.parse(JSON.stringify(surface.getSelection())));
    resumed.updateCatalog([
      ...bootstrap,
      definition("Write"),
      definition("Other", "newest"),
      definition("New"),
    ]);
    expect(JSON.stringify(resumed.requestSnapshot())).toBe(before);
    expect(resumed.isCallable("Write")).toBe(false);
    resumed.select(["Write"]);
    expect(resumed.isCallable("Write")).toBe(true);
    expect(JSON.stringify(resumed.requestSnapshot())).toBe(before);
    resumed.rebase();
    expect(resumed.snapshot().find((tool) => tool.name === "Write")).toBeDefined();
    expect(resumed.getSelection().deferredDefinitions).toEqual([
      definition("Other", "newest"),
      definition("New"),
    ]);
  });

  it("does not defer without ToolSearch and does not expose deferred hints in portable mode", () => {
    const surface = native();
    surface.updateCatalog([definition("Read"), definition("Write")]);
    expect(surface.requestSnapshot()).toEqual(surface.snapshot());
    expect(surface.getSelection().deferredDefinitions).toEqual([]);
    const portable = new RunToolSurface([], {
      selection: {
        version: 2,
        names: ["ToolSearch"],
        discovered: [],
        frozenDefinitions: [{ ...definition("ToolSearch"), deferLoading: true }],
        deferredDefinitions: [definition("Write")],
      },
    });
    portable.updateCatalog([...bootstrap, definition("Write")]);
    expect(portable.requestSnapshot()).toEqual([definition("ToolSearch")]);
    expect(portable.isCallable("Write")).toBe(false);
  });

  it("pairs CallTool only at a native cold boundary, never as a deferred schema", () => {
    const state = { version: 2, names: ["ToolSearch"], discovered: [] };
    const cold = native(state);
    cold.updateCatalog([...bootstrap, definition("Write")]);
    expect(names(cold)).toEqual(["ToolSearch", "CallTool"]);
    expect(cold.getSelection().deferredDefinitions?.map((tool) => tool.name)).toEqual(["Write"]);
    const warm = native({ ...state, frozenDefinitions: [definition("ToolSearch")] });
    warm.updateCatalog([...bootstrap, definition("Write")]);
    expect(names(warm)).toEqual(["ToolSearch"]);
    expect(warm.requestSnapshot().some((tool) => tool.name === "CallTool")).toBe(false);
  });

  it("rejects damaged, duplicated, overlapping and oversized combined saved snapshots", () => {
    const base = {
      version: 2,
      names: ["ToolSearch"],
      discovered: [],
      frozenDefinitions: [definition("ToolSearch")],
    };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const deferredDefinitions of [
      null,
      {},
      [null],
      [definition("bad\nname")],
      [definition("ToolSearch")],
      [definition("Write"), definition("Write")],
      [{ ...definition("Write"), inputSchema: [] }],
      [{ ...definition("Write"), inputSchema: circular }],
      Array.from({ length: 4096 }, (_, index) => definition("Tool" + index)),
    ])
      expect(normalizeSessionToolSelection({ ...base, deferredDefinitions })).toBeUndefined();
    const big = "界".repeat(3_000_000);
    expect(
      normalizeSessionToolSelection({
        ...base,
        frozenDefinitions: [definition("ToolSearch", big)],
        deferredDefinitions: [definition("Write", big)],
      }),
    ).toBeUndefined();
    expect(
      normalizeSessionToolSelection({ ...base, deferredDefinitions: [] })?.deferredDefinitions,
    ).toEqual([]);
  });
});
