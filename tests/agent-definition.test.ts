import { describe, it, expect } from "bun:test";
import { parseAgentDefinition } from "../packages/core/src/agent/agent-definition.ts";

describe("parseAgentDefinition", () => {
  it("parses frontmatter fields and uses body as systemPrompt", () => {
    const md = [
      "---",
      "name: researcher",
      "description: Read-only codebase research",
      "model: flash",
      "maxTurns: 8",
      "tools:",
      "  - Read",
      "  - Grep",
      "  - Glob",
      "---",
      "You are a research agent. Investigate and report; never edit files.",
    ].join("\n");

    const def = parseAgentDefinition(md, "researcher.md");

    expect(def.name).toBe("researcher");
    expect(def.description).toBe("Read-only codebase research");
    expect(def.model).toBe("flash");
    expect(def.maxTurns).toBe(8);
    expect(def.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(def.systemPrompt).toBe(
      "You are a research agent. Investigate and report; never edit files.",
    );
  });

  it("defaults optional fields when omitted", () => {
    const md = ["---", "name: planner", "description: Make a plan", "---", "Plan the work."].join("\n");
    const def = parseAgentDefinition(md, "planner.md");
    expect(def.model).toBeUndefined();
    expect(def.maxTurns).toBeUndefined();
    expect(def.tools).toBeUndefined();
    expect(def.systemPrompt).toBe("Plan the work.");
  });

  it("throws a clear error when name is missing", () => {
    const md = ["---", "description: no name here", "---", "body"].join("\n");
    expect(() => parseAgentDefinition(md, "broken.md")).toThrow(/broken\.md.*name/i);
  });

  it("throws when frontmatter delimiters are absent", () => {
    expect(() => parseAgentDefinition("just a body, no frontmatter", "x.md")).toThrow(/x\.md.*frontmatter/i);
  });

  it("supports inline-array tools syntax", () => {
    const md = ["---", "name: r", "description: d", "tools: [Read, Grep, Glob]", "---", "Body."].join("\n");
    const def = parseAgentDefinition(md, "r.md");
    expect(def.tools).toEqual(["Read", "Grep", "Glob"]);
  });
});
