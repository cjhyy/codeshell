import { describe, expect, test } from "bun:test";
import { EXTERNAL_GOAL_TOOL_CATALOG } from "./external-runtime-goal-tools.js";
import { EXTERNAL_GOAL_TOOLS, isExternalGoalToolName } from "./external-runtime-goals.js";

const definition = (name: string) =>
  EXTERNAL_GOAL_TOOL_CATALOG.find((tool) => tool.definition.name === name)!.definition;

describe("external Goal tool contracts", () => {
  test("every Goal controller tool is declared once", () => {
    expect(EXTERNAL_GOAL_TOOL_CATALOG.map((tool) => tool.definition.name)).toEqual([
      ...EXTERNAL_GOAL_TOOLS,
    ]);
    expect(EXTERNAL_GOAL_TOOLS).toContain("wait_for_background");
  });

  test("wait_for_user is structured and tells the model not to repeat the question", () => {
    const tool = definition("wait_for_user");
    expect(tool.description).not.toContain("Ask the same question in your reply");
    expect(tool.description).toContain("do not repeat it in your reply text");
    expect(tool.description).toContain("At most one call per turn");
    const schema = tool.inputSchema as {
      properties: Record<string, { enum?: string[]; maxLength?: number; maxItems?: number }>;
      required: string[];
    };
    // Old callers that send only a question stay valid.
    expect(schema.required).toEqual(["goalId", "revision", "question"]);
    expect(schema.properties.question!.maxLength).toBe(600);
    expect(schema.properties.options!.maxItems).toBe(6);
    expect(schema.properties.level!.enum).toEqual(["preference", "consent"]);
    expect(schema.properties.default).toBeDefined();
  });

  test("wait_for_background needs only the goal identity", () => {
    const tool = definition("wait_for_background");
    expect(tool.description).toContain("never poll");
    expect((tool.inputSchema as { required: string[] }).required).toEqual(["goalId", "revision"]);
    expect(tool.isReadOnly).toBe(false);
  });

  test("provider-prefixed names are recognized as Goal controls", () => {
    expect(isExternalGoalToolName("wait_for_background")).toBe(true);
    expect(isExternalGoalToolName("mcp__codeshell_tools__wait_for_user")).toBe(true);
    expect(isExternalGoalToolName("mcp__codeshell_tools__Bash")).toBe(false);
    expect(isExternalGoalToolName("Bash")).toBe(false);
  });
});
