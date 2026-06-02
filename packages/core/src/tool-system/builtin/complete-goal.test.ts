import { describe, test, expect } from "bun:test";
import { completeGoalToolDef, completeGoalTool } from "./complete-goal.js";

describe("complete_goal tool", () => {
  test("def has the expected name and an inputSchema with optional summary", () => {
    expect(completeGoalToolDef.name).toBe("complete_goal");
    // inputSchema is the JSON-schema-ish object the model calls with.
    const schema = completeGoalToolDef.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.properties.summary).toBeDefined();
    // summary is OPTIONAL — must not be in required.
    expect(schema.required ?? []).not.toContain("summary");
  });

  test("handler returns a confirmation string echoing the summary", async () => {
    const res = await completeGoalTool({ summary: "all done" });
    expect(typeof res).toBe("string");
    expect(res.toLowerCase()).toContain("complete");
    expect(res).toContain("all done");
  });

  test("handler works with no summary", async () => {
    const res = await completeGoalTool({});
    expect(typeof res).toBe("string");
    expect(res.toLowerCase()).toContain("complete");
  });

  test("handler trims whitespace-only summary to nothing", async () => {
    const res = await completeGoalTool({ summary: "   " });
    expect(res.toLowerCase()).toContain("complete");
    // No dangling "Summary:" label for an empty summary.
    expect(res).not.toContain("Summary:");
  });
});
