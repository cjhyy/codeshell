import { describe, expect, it } from "bun:test";
import type { SessionToolSelection, ToolDefinition } from "../types.js";
import { callToolDef } from "./builtin/call-tool.js";
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
