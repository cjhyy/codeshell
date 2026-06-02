import { describe, it, expect } from "bun:test";
import { agentTool } from "../packages/core/src/tool-system/builtin/agent.ts";
import { AgentDefinitionRegistry } from "../packages/core/src/agent/agent-definition-registry.ts";
import type { AgentDefinition } from "../packages/core/src/agent/agent-definition.ts";
import type { ToolContext, SubAgentSpawnRequest, SubAgentSpawner } from "../packages/core/src/tool-system/context.ts";

function regWith(...defs: AgentDefinition[]): AgentDefinitionRegistry {
  const reg = new AgentDefinitionRegistry();
  const map = (reg as unknown as { defs: Map<string, AgentDefinition> }).defs;
  for (const d of defs) map.set(d.name, d);
  return reg;
}

/** A spawner that records the request it received and returns canned text. */
function capturingSpawner(): { spawner: SubAgentSpawner; captured: SubAgentSpawnRequest[] } {
  const captured: SubAgentSpawnRequest[] = [];
  const spawner: SubAgentSpawner = {
    parentStream: undefined,
    describe: () => ({ cwd: "/tmp", permissionMode: "acceptEdits" }),
    spawn: async (req) => {
      captured.push(req);
      return `ran ${req.agentId}`;
    },
  };
  return { spawner, captured };
}

const researcher: AgentDefinition = {
  name: "researcher",
  description: "read-only research",
  model: "deepseek-v4-flash",
  maxTurns: 9,
  tools: ["Read", "Grep", "Glob"],
  systemPrompt: "Be a focused researcher.",
};

describe("Agent tool agent_type — end to end", () => {
  it("forwards the role's model/tools/maxTurns/prompt into the spawn request", async () => {
    const { spawner, captured } = capturingSpawner();
    const ctx = {
      subAgentSpawner: spawner,
      agentDefinitions: regWith(researcher),
    } as unknown as ToolContext;

    const out = await agentTool(
      { agent_type: "researcher", description: "find X", prompt: "where is X defined?" },
      ctx,
    );

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.model).toBe("deepseek-v4-flash");
    expect(req.toolAllowlist).toEqual(["Read", "Grep", "Glob"]);
    expect(req.appendSystemPrompt).toBe("Be a focused researcher.");
    expect(req.maxTurns).toBe(9);
    expect(req.prompt).toBe("where is X defined?");
    expect(out).toContain("ran ");
  });

  it("explicit max_turns arg overrides the role's maxTurns", async () => {
    const { spawner, captured } = capturingSpawner();
    const ctx = { subAgentSpawner: spawner, agentDefinitions: regWith(researcher) } as unknown as ToolContext;

    await agentTool(
      { agent_type: "researcher", description: "d", prompt: "p", max_turns: 3 },
      ctx,
    );
    expect(captured[0].maxTurns).toBe(3);
  });

  it("ephemeral mode (no agent_type) leaves role fields unset", async () => {
    const { spawner, captured } = capturingSpawner();
    const ctx = { subAgentSpawner: spawner, agentDefinitions: regWith() } as unknown as ToolContext;

    await agentTool({ description: "d", prompt: "p" }, ctx);

    const req = captured[0];
    expect(req.model).toBeUndefined();
    expect(req.toolAllowlist).toBeUndefined();
    expect(req.appendSystemPrompt).toBeUndefined();
    expect(req.maxTurns).toBe(15);
  });

  it("unknown agent_type returns a clear error and never spawns", async () => {
    const { spawner, captured } = capturingSpawner();
    const ctx = { subAgentSpawner: spawner, agentDefinitions: regWith(researcher) } as unknown as ToolContext;

    const out = await agentTool({ agent_type: "ghost", description: "d", prompt: "p" }, ctx);

    expect(out).toMatch(/unknown agent_type 'ghost'/i);
    expect(out).toContain("researcher");
    expect(captured).toHaveLength(0);
  });
});
