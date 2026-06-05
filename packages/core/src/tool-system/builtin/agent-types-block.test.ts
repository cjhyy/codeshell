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
    // No enum constraint when there are no roles — agent_type stays free-form
    // so an empty-registry project can still run ephemeral agents.
    const props = def.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.agent_type.enum).toBeUndefined();
  });

  // TODO §4.2 — agent_type must become a dynamic enum of loaded kind names so
  // the model can't invent a nonexistent role (which would throw and waste a
  // turn). The enum is injected per-engine; the base const stays free-form.
  it("constrains agent_type to an enum of loaded kind names", () => {
    const def = agentToolDefWithTypes(fakeRegistry([RESEARCHER, GENERAL]));
    const props = def.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.agent_type.enum).toEqual(["researcher", "general-purpose"]);
    // Description of the property is preserved alongside the new enum.
    expect(typeof props.agent_type.description).toBe("string");
    // Base const is never mutated.
    const baseProps = agentToolDef.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(baseProps.agent_type.enum).toBeUndefined();
  });

  it("shows the skill set only for roles that restrict skills", () => {
    const LOCKED: AgentDefinition = {
      name: "director",
      description: "orchestrates",
      skills: ["brainstorming"],
      systemPrompt: "",
    };
    const block = buildAgentTypesBlock(fakeRegistry([LOCKED, GENERAL]));
    expect(block).toContain("skills: brainstorming");
    // general-purpose has no skills restriction → no skills note for it.
    expect(block).toContain("- general-purpose: Full multi-step agent (tools: all parent tools)");
  });
});
