import { describe, test, expect } from "bun:test";
import { makeUpdateAutomationMemoryTool } from "./update-automation-memory.js";
import type { BuiltinToolReturn } from "./index.js";

function asText(r: BuiltinToolReturn): string {
  if (typeof r === "string") return r;
  if ("result" in r) return r.result ?? "";
  return "error" in r && typeof r.error === "string" ? r.error : "";
}

describe("UpdateAutomationMemory", () => {
  test("has the expected definition shape", () => {
    const tool = makeUpdateAutomationMemoryTool(() => {});
    expect(tool.definition.name).toBe("UpdateAutomationMemory");
    expect(typeof tool.definition.description).toBe("string");
    expect(tool.definition.description.length).toBeGreaterThan(0);
    const schema = tool.definition.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.properties.summary).toBeDefined();
    expect(schema.required).toEqual(["summary"]);
  });

  test("calls the injected sink with the trimmed summary and reports success", async () => {
    const writes: string[] = [];
    const tool = makeUpdateAutomationMemoryTool((s) => writes.push(s));
    const res = await tool.execute({ summary: "  today: 3 items  " });
    expect(writes).toEqual(["today: 3 items"]);
    // success contract: returns a non-error string
    expect(asText(res).startsWith("Error:")).toBe(false);
    expect(asText(res).toLowerCase()).toContain("saved");
  });

  test("rejects empty/whitespace summary without calling the sink", async () => {
    const writes: string[] = [];
    const tool = makeUpdateAutomationMemoryTool((s) => writes.push(s));
    const res = await tool.execute({ summary: "   " });
    expect(writes).toEqual([]);
    // error contract: returns a string prefixed with "Error:"
    expect(asText(res).startsWith("Error:")).toBe(true);
  });

  test("rejects a missing summary without calling the sink", async () => {
    const writes: string[] = [];
    const tool = makeUpdateAutomationMemoryTool((s) => writes.push(s));
    const res = await tool.execute({});
    expect(writes).toEqual([]);
    expect(asText(res).startsWith("Error:")).toBe(true);
  });
});
