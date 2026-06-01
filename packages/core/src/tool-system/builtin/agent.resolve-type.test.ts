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

describe("resolveAgentTypeOverrides — falls back to a configured agent", () => {
  it("falls back to general-purpose when omitted and that role exists", () => {
    const reg = registryWith(["researcher", "general-purpose", "planner"]);
    // @ts-expect-error — poke a distinct prompt so we can tell which role won
    reg.defs.get("general-purpose")!.systemPrompt = "gp-prompt";
    const ov = resolveAgentTypeOverrides(undefined, reg);
    expect(ov.appendSystemPrompt).toBe("gp-prompt");
  });
  it("falls back to the first available role when general-purpose is absent", () => {
    const reg = registryWith(["researcher", "planner"]);
    // @ts-expect-error — mark the first role
    reg.defs.get("researcher")!.systemPrompt = "research-prompt";
    const ov = resolveAgentTypeOverrides(undefined, reg);
    expect(ov.appendSystemPrompt).toBe("research-prompt");
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
