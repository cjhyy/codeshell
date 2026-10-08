import { describe, expect, it } from "bun:test";
import type { ToolDefinition } from "../types.js";
import { RunToolSurface } from "./run-tool-surface.js";

function definition(name: string, description = `${name} purpose`): ToolDefinition {
  return { name, description, inputSchema: { type: "object", properties: {} } };
}

const names = (surface: RunToolSurface) => surface.snapshot().map((tool) => tool.name);

describe("RunToolSurface", () => {
  it("keeps an omitted initial list eager, including late catalog additions", () => {
    const surface = new RunToolSurface();
    surface.updateCatalog([definition("Read"), definition("ToolSearch")]);
    expect(names(surface)).toEqual(["Read", "ToolSearch"]);
    surface.updateCatalog([definition("Late"), definition("ToolSearch"), definition("Read")]);
    expect(names(surface)).toEqual(["Read", "ToolSearch", "Late"]);
  });

  it("loads only ToolSearch for an explicitly empty initial list", () => {
    const surface = new RunToolSurface([]);
    surface.updateCatalog([definition("Read"), definition("ToolSearch")]);
    expect(names(surface)).toEqual(["ToolSearch"]);
    expect(surface.getCatalog().map((tool) => tool.name)).toEqual(["Read", "ToolSearch"]);
    expect(surface.isEligible("Read")).toBe(true);
    expect(surface.isSelected("Read")).toBe(false);
    surface.updateCatalog([definition("Late"), definition("ToolSearch"), definition("Read")]);
    expect(names(surface)).toEqual(["ToolSearch"]);
  });

  it("copies configured initial names and loads them only when eligible", () => {
    const initial = ["Write", "Read", "Late"];
    const surface = new RunToolSurface(initial);
    initial.push("Other");
    surface.updateCatalog([
      definition("Read"),
      definition("Write"),
      definition("Other"),
      definition("ToolSearch"),
    ]);
    expect(names(surface)).toEqual(["Write", "Read", "ToolSearch"]);
    expect(surface.isSelected("Late")).toBe(false);
    surface.updateCatalog([
      definition("ToolSearch"),
      definition("Late"),
      definition("Read"),
      definition("Write"),
      definition("Other"),
    ]);
    expect(names(surface)).toEqual(["Write", "Read", "ToolSearch", "Late"]);
  });

  it("retains the eager fallback when ToolSearch appears late", () => {
    const surface = new RunToolSurface([]);
    surface.updateCatalog([definition("Read")]);
    expect(names(surface)).toEqual(["Read"]);
    expect(surface.isEligible("ToolSearch")).toBe(false);
    surface.updateCatalog([definition("Read"), definition("ToolSearch"), definition("Late")]);
    expect(names(surface)).toEqual(["Read", "ToolSearch"]);
    expect(surface.isSelected("Read")).toBe(true);
    expect(surface.isSelected("Late")).toBe(false);
    surface.select(["Read"]);
    surface.updateCatalog([definition("Read"), definition("Late")]);
    expect(names(surface)).toEqual(["Read", "Late"]);
    surface.updateCatalog([definition("Late"), definition("Read"), definition("ToolSearch")]);
    expect(names(surface)).toEqual(["Read", "ToolSearch", "Late"]);
  });

  it("falls back to eager loading when ToolSearch is revoked and keeps that selection on restore", () => {
    const surface = new RunToolSurface([]);
    surface.updateCatalog([definition("ToolSearch"), definition("Read"), definition("Write")]);
    surface.select(["Read"]);
    surface.updateCatalog([definition("Write"), definition("Read"), definition("Late")]);
    expect(names(surface)).toEqual(["Read", "Write", "Late"]);
    expect(surface.isSelected("ToolSearch")).toBe(false);
    surface.updateCatalog([
      definition("Late"),
      definition("Write"),
      definition("ToolSearch"),
      definition("Read"),
    ]);
    expect(names(surface)).toEqual(["ToolSearch", "Read", "Write", "Late"]);
  });

  it("does not remember unavailable selections when that tool appears later", () => {
    const surface = new RunToolSurface([]);
    surface.updateCatalog([definition("ToolSearch")]);
    expect(surface.select(["Late"])).toEqual({ selected: [], unavailable: ["Late"] });
    surface.updateCatalog([definition("Late"), definition("ToolSearch")]);
    expect(surface.isEligible("Late")).toBe(true);
    expect(surface.isSelected("Late")).toBe(false);
    expect(names(surface)).toEqual(["ToolSearch"]);
  });

  it("selects exact eligible names once and appends schemas in selection order", () => {
    const surface = new RunToolSurface([]);
    surface.updateCatalog([definition("ToolSearch"), definition("Read"), definition("Write")]);
    expect(surface.select(["Write", "Missing", "Read", "Write", "read", "Missing"])).toEqual({
      selected: ["Write", "Read"],
      unavailable: ["Missing", "read"],
    });
    expect(names(surface)).toEqual(["ToolSearch", "Write", "Read"]);
    expect(surface.isSelected("Write")).toBe(true);
    expect(surface.isEligible("Missing")).toBe(false);
    surface.select(["Read", "ToolSearch"]);
    expect(names(surface)).toEqual(["ToolSearch", "Write", "Read"]);
  });

  it("shrinks revoked eligibility and restores selected history with rewritten definitions", () => {
    const surface = new RunToolSurface([]);
    surface.updateCatalog([definition("Read"), definition("Write"), definition("ToolSearch")]);
    surface.select(["Write", "Read"]);
    const previous = surface.snapshot();
    surface.updateCatalog([definition("ToolSearch"), definition("Read", "rewritten read")]);
    expect(names(surface)).toEqual(["ToolSearch", "Read"]);
    expect(surface.isEligible("Write")).toBe(false);
    expect(surface.isSelected("Write")).toBe(false);
    expect(surface.select(["Write"])).toEqual({ selected: [], unavailable: ["Write"] });
    surface.updateCatalog([
      definition("Read", "rewritten read"),
      definition("Write", "rewritten write"),
      definition("ToolSearch"),
    ]);
    expect(names(surface)).toEqual(["ToolSearch", "Write", "Read"]);
    expect(surface.snapshot()[1].description).toBe("rewritten write");
    expect(previous[1].description).toBe("Write purpose");
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
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(Object.isFrozen(snapshot[0].inputSchema)).toBe(true);
    expect(Object.isFrozen(snapshot[0].inputSchema.required)).toBe(true);
    expect(Object.isFrozen(snapshot[0].inputSchema.$defs)).toBe(true);
    const schema = snapshot[0].inputSchema;
    expect(Reflect.set(schema, "additionalProperties", true)).toBe(false);
    expect(Reflect.set(schema.required as string[], 0, "mutated")).toBe(false);
    tool.description = "mutated source";
    (tool.inputSchema.required as string[]).push("mutated");
    expect(surface.snapshot()).toEqual([expected]);
    expect(surface.getCatalog()).toEqual([expected]);
  });

  it("restores the latest authorized schema without changing any previous snapshots", () => {
    const surface = new RunToolSurface([]);
    const original = {
      ...definition("Dynamic"),
      inputSchema: { type: "object", properties: { target: { enum: ["original-target"] } } },
    };
    const rewritten = {
      ...definition("Dynamic", "new authorized destination"),
      sensitiveResult: true,
      inputSchema: { type: "object", properties: { target: { enum: ["new-target"] } } },
    };
    surface.updateCatalog([definition("ToolSearch"), original]);
    surface.select(["Dynamic"]);
    const beforeRevocation = surface.snapshot();
    surface.updateCatalog([definition("ToolSearch")]);
    const revoked = surface.snapshot();
    surface.updateCatalog([rewritten, definition("ToolSearch")]);
    const restored = surface.snapshot();
    expect(restored.map((tool) => tool.name)).toEqual(["ToolSearch", "Dynamic"]);
    expect(restored[1]).toEqual(rewritten);
    expect(beforeRevocation[1]).toEqual(original);
    expect(revoked.map((tool) => tool.name)).toEqual(["ToolSearch"]);
    expect(Object.isFrozen(restored[1].inputSchema.properties)).toBe(true);
  });

  it("keeps selection and snapshots independent between runs sharing a catalog", () => {
    const catalog = [definition("ToolSearch"), definition("Read")];
    const first = new RunToolSurface([]);
    const second = new RunToolSurface([]);
    first.updateCatalog(catalog);
    second.updateCatalog(catalog);
    const previous = first.snapshot();
    first.select(["Read"]);
    expect(names(first)).toEqual(["ToolSearch", "Read"]);
    expect(names(second)).toEqual(["ToolSearch"]);
    expect(previous.map((tool) => tool.name)).toEqual(["ToolSearch"]);
  });
});
