import { describe, it, expect } from "bun:test";
import type { AgentDefinitionRegistry } from "../../agent/agent-definition-registry.js";
import type { AgentDefinition } from "../../agent/agent-definition.js";
import { buildAgentTypesBlock, agentToolDefWithTypes, agentToolDef } from "./agent.js";

/** Minimal registry stub — the helpers only call `.list()`. */
function fakeRegistry(defs: AgentDefinition[]): AgentDefinitionRegistry {
  return { list: () => defs } as unknown as AgentDefinitionRegistry;
}

const RESEARCHER: AgentDefinition = {
  name: "researcher",
  description: "Read-only codebase research",
  tools: ["Read", "Grep", "Glob"],
  systemPrompt: "",
};
const GENERAL: AgentDefinition = {
  name: "general-purpose",
  description: "Full multi-step agent",
  systemPrompt: "",
};

describe("buildAgentTypesBlock", () => {
  it("returns empty string when no roles are defined", () => {
    expect(buildAgentTypesBlock(fakeRegistry([]))).toBe("");
    expect(buildAgentTypesBlock(undefined)).toBe("");
  });

  it("lists each role with its name, description, and tools", () => {
    const block = buildAgentTypesBlock(fakeRegistry([RESEARCHER, GENERAL]));
    expect(block).toContain("Available agent types");
    expect(block).toContain("- researcher: Read-only codebase research (tools: Read, Grep, Glob)");
    // No tools allowlist → inherits parent tools.
    expect(block).toContain("- general-purpose: Full multi-step agent (tools: all parent tools)");
  });
});

describe("agentToolDefWithTypes", () => {
  it("appends the block to the base description without mutating the const", () => {
    const before = agentToolDef.description;
    const def = agentToolDefWithTypes(fakeRegistry([RESEARCHER]));
    expect(def.description).toContain("- researcher:");
    expect(def.description.startsWith(before)).toBe(true);
    // base const untouched
    expect(agentToolDef.description).toBe(before);
    expect(agentToolDef.description).not.toContain("- researcher:");
  });

  it("returns the base def unchanged when no roles exist", () => {
    const def = agentToolDefWithTypes(fakeRegistry([]));
    expect(def.description).toBe(agentToolDef.description);
  });
});
