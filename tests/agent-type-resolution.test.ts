import { describe, it, expect } from "bun:test";
import { resolveAgentTypeOverrides } from "../packages/core/src/tool-system/builtin/agent.ts";
import { AgentDefinitionRegistry } from "../packages/core/src/agent/agent-definition-registry.ts";
import type { AgentDefinition } from "../packages/core/src/agent/agent-definition.ts";

function regWith(def: AgentDefinition): AgentDefinitionRegistry {
  // The registry's only public constructor is loadFromDir; for a focused unit
  // test we seed the private map directly via a cast test seam.
  const reg = new AgentDefinitionRegistry();
  (reg as unknown as { defs: Map<string, AgentDefinition> }).defs.set(def.name, def);
  return reg;
}

describe("resolveAgentTypeOverrides", () => {
  it("returns empty overrides when agent_type is omitted", () => {
    const out = resolveAgentTypeOverrides(undefined, undefined);
    expect(out).toEqual({});
  });

  it("pulls model/tools/maxTurns/appendPrompt from the matching definition", () => {
    const reg = regWith({
      name: "researcher",
      description: "r",
      model: "flash",
      maxTurns: 8,
      tools: ["Read", "Grep"],
      systemPrompt: "Be a researcher.",
    });
    const out = resolveAgentTypeOverrides("researcher", reg);
    expect(out.model).toBe("flash");
    expect(out.maxTurns).toBe(8);
    expect(out.toolAllowlist).toEqual(["Read", "Grep"]);
    expect(out.appendSystemPrompt).toBe("Be a researcher.");
  });

  it("throws a clear error when agent_type is unknown", () => {
    const reg = regWith({ name: "researcher", description: "r", systemPrompt: "x" });
    expect(() => resolveAgentTypeOverrides("ghost", reg)).toThrow(/unknown agent_type 'ghost'/i);
  });
});
