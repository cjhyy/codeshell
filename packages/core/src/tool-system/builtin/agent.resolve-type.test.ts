import { describe, it, expect } from "bun:test";
import { resolveAgentTypeOverrides } from "./agent.js";
import { AgentDefinitionRegistry } from "../../agent/agent-definition-registry.js";

function registryWith(names: string[]): AgentDefinitionRegistry {
  const reg = new AgentDefinitionRegistry();
  for (const name of names) {
    // @ts-expect-error — test helper pokes a definition in directly
    reg.defs.set(name, { name, description: `${name} role`, systemPrompt: "x" });
  }
  return reg;
}

describe("resolveAgentTypeOverrides — must use a configured agent", () => {
  it("throws when registry has agents but no agent_type given (no ephemeral)", () => {
    const reg = registryWith(["researcher", "planner"]);
    expect(() => resolveAgentTypeOverrides(undefined, reg)).toThrow(/agent_type is required/i);
    expect(() => resolveAgentTypeOverrides(undefined, reg)).toThrow(/researcher/);
  });
  it("throws on unknown agent_type and lists available", () => {
    const reg = registryWith(["researcher"]);
    expect(() => resolveAgentTypeOverrides("nope", reg)).toThrow(/unknown agent_type/i);
    expect(() => resolveAgentTypeOverrides("nope", reg)).toThrow(/researcher/);
  });
  it("returns overrides for a valid configured agent_type", () => {
    const reg = registryWith(["researcher"]);
    const ov = resolveAgentTypeOverrides("researcher", reg);
    expect(ov.appendSystemPrompt).toBe("x");
  });
  it("returns {} when registry is empty and no agent_type", () => {
    const reg = registryWith([]);
    expect(resolveAgentTypeOverrides(undefined, reg)).toEqual({});
    expect(resolveAgentTypeOverrides(undefined, undefined)).toEqual({});
  });
});
