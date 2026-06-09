import { describe, it, expect } from "bun:test";
import type { AgentDefinitionRegistry } from "../agent/agent-definition-registry.js";
import type { AgentDefinition } from "../agent/agent-definition.js";
import type { ToolDefinition } from "../types.js";
import { applyDynamicToolDef } from "./dynamic-tool-defs.js";
import { agentToolDef } from "../tool-system/builtin/agent.js";

function fakeRegistry(defs: AgentDefinition[]): AgentDefinitionRegistry {
  return { list: () => defs } as unknown as AgentDefinitionRegistry;
}

const ART: AgentDefinition = {
  name: "art-designer",
  description: "服化道 Agent",
  tools: ["Read", "Write", "Edit", "Glob"],
  systemPrompt: "",
};
const DIRECTOR: AgentDefinition = {
  name: "director",
  description: "导演 Agent",
  tools: ["Read", "Glob", "Grep"],
  systemPrompt: "",
};

describe("applyDynamicToolDef — Agent", () => {
  // Regression: engine.ts forwarded only `.description` from
  // agentToolDefWithTypes, dropping the rebuilt `.inputSchema`. That stripped
  // the agent_type enum before the model ever saw it, so the model treated
  // agent_type as a free optional string and silently omitted it — the
  // configured roles' model/tools/skills never applied (seedance-project
  // s-mq0xsmes incident). The forwarded def MUST carry the enum too.
  it("forwards the dynamic agent_type enum, not just the description", () => {
    const base: ToolDefinition = { ...agentToolDef };
    const out = applyDynamicToolDef(base, fakeRegistry([ART, DIRECTOR]), "/tmp/proj");
    const props = out.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.agent_type.enum).toEqual(["art-designer", "director"]);
    // description is still augmented with the listing
    expect(out.description).toContain("- art-designer:");
  });

  it("leaves non-Agent tools untouched", () => {
    const tool: ToolDefinition = {
      name: "SomethingElse",
      description: "x",
      inputSchema: { type: "object", properties: {} },
    } as ToolDefinition;
    const out = applyDynamicToolDef(tool, fakeRegistry([ART]), "/tmp/proj");
    expect(out).toBe(tool);
  });

  it("returns the base Agent def unchanged when no roles are configured", () => {
    const base: ToolDefinition = { ...agentToolDef };
    const out = applyDynamicToolDef(base, fakeRegistry([]), "/tmp/proj");
    const props = out.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.agent_type.enum).toBeUndefined();
  });
});
