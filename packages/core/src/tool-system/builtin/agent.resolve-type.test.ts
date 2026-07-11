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
    // @ts-expect-error — test helper augments the in-memory role directly
    Object.assign(reg.defs.get("researcher")!, {
      sandbox: "auto",
      mcp: ["github"],
    });
    const ov = resolveAgentTypeOverrides("researcher", reg);
    expect(ov.appendSystemPrompt).toBe("x");
    expect(ov.sandboxMode).toBe("auto");
    expect(ov.mcpAllowlist).toEqual(["github"]);
  });
  it("returns {} when registry is empty and no agent_type", () => {
    const reg = registryWith([]);
    expect(resolveAgentTypeOverrides(undefined, reg)).toEqual({});
    expect(resolveAgentTypeOverrides(undefined, undefined)).toEqual({});
  });
});

// A plugin-bundled agent's frontmatter references its own skills by BARE name
// (CC convention: `skills: director-skill`), but the scanner registers plugin
// skills under their namespaced name (`mimi-video:director-skill`). Without
// namespacing the allowlist here, the bare name never matches and the
// sub-agent reports the skill "not found". So for a plugin-source agent we
// rewrite each bare skill name to `<pluginName>:<skill>`.
describe("resolveAgentTypeOverrides — plugin skill allowlist namespacing", () => {
  function pluginRole(skills: string[]): AgentDefinitionRegistry {
    const reg = new AgentDefinitionRegistry();
    // @ts-expect-error — test helper pokes a plugin-source definition in
    reg.defs.set("director", {
      name: "director",
      description: "director role",
      systemPrompt: "x",
      source: "plugin",
      pluginName: "mimi-video",
      skills,
    });
    return reg;
  }

  it("namespaces bare skill names for a plugin-source agent", () => {
    const ov = resolveAgentTypeOverrides(
      "director",
      pluginRole(["director-skill", "compliance-review-skill"]),
    );
    expect(ov.skillAllowlist).toEqual([
      "mimi-video:director-skill",
      "mimi-video:compliance-review-skill",
    ]);
  });

  it("leaves an already-namespaced skill name untouched", () => {
    const ov = resolveAgentTypeOverrides("director", pluginRole(["mimi-video:director-skill"]));
    expect(ov.skillAllowlist).toEqual(["mimi-video:director-skill"]);
  });

  it("preserves an empty allowlist (no skills, not inherit-all)", () => {
    const ov = resolveAgentTypeOverrides("director", pluginRole([]));
    expect(ov.skillAllowlist).toEqual([]);
  });

  it("does NOT namespace skills for a non-plugin (project/user) agent", () => {
    const reg = new AgentDefinitionRegistry();
    // @ts-expect-error — project-source agent, bare skills must stay bare
    reg.defs.set("director", {
      name: "director",
      description: "d",
      systemPrompt: "x",
      source: "project",
      skills: ["director-skill"],
    });
    const ov = resolveAgentTypeOverrides("director", reg);
    expect(ov.skillAllowlist).toEqual(["director-skill"]);
  });

  it("leaves skills undefined (inherit full pool) untouched", () => {
    const reg = new AgentDefinitionRegistry();
    // @ts-expect-error — plugin agent with no skills field
    reg.defs.set("director", {
      name: "director",
      description: "d",
      systemPrompt: "x",
      source: "plugin",
      pluginName: "mimi-video",
    });
    const ov = resolveAgentTypeOverrides("director", reg);
    expect(ov.skillAllowlist).toBeUndefined();
  });
});
