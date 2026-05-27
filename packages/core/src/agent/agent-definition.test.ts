import { describe, it, expect } from "bun:test";
import {
  parseAgentDefinition,
  serializeAgentDefinition,
  type AgentDefinition,
} from "./agent-definition.js";

describe("serializeAgentDefinition", () => {
  it("round-trips a full definition", () => {
    const def: AgentDefinition = {
      name: "researcher",
      description: "Read-only research",
      model: "flash",
      maxTurns: 10,
      tools: ["Read", "Grep"],
      systemPrompt: "You research.\nReport findings.",
    };
    const text = serializeAgentDefinition(def);
    const back = parseAgentDefinition(text, "researcher.md");
    expect(back).toEqual(def);
  });

  it("omits unset optional fields (no model/maxTurns/tools lines)", () => {
    const def: AgentDefinition = {
      name: "min",
      description: "minimal",
      systemPrompt: "Body.",
    };
    const text = serializeAgentDefinition(def);
    expect(text).not.toMatch(/^model:/m);
    expect(text).not.toMatch(/^maxTurns:/m);
    expect(text).not.toMatch(/^tools:/m);
    const back = parseAgentDefinition(text, "min.md");
    expect(back).toEqual(def);
  });
});
