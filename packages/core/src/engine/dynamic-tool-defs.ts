import type { ToolDefinition } from "../types.js";
import type { AgentDefinitionRegistry } from "../agent/agent-definition-registry.js";
import { agentToolDefWithTypes } from "../tool-system/builtin/agent.js";
import { generateImageToolDefFor } from "../tool-system/builtin/generate-image.js";
import { generateVideoToolDefFor } from "../tool-system/builtin/generate-video.js";
import { useCredentialToolDefFor } from "../credentials/use-credential-tool.js";

/**
 * Rewrite a single tool definition with the live, per-engine dynamic bits the
 * static def can't carry (the model only ever sees what we hand it each turn):
 *
 * - Agent: append the available-agent-types listing to the description AND
 *   forward the rebuilt inputSchema. The schema carries the `agent_type` enum
 *   of loaded role names — forwarding ONLY the description (the prior bug) left
 *   agent_type a free optional string, so the model silently omitted it and the
 *   configured roles' model/tools/skills never applied.
 * - GenerateImage / GenerateVideo: name the configured providers in the
 *   description (these defs never rebuild inputSchema, so description-only is
 *   correct and intentional for them).
 *
 * Non-matching tools are returned by identity (no allocation). Pure: it never
 * mutates the input or any shared const.
 */
export function applyDynamicToolDef(
  t: ToolDefinition,
  agentDefinitions: AgentDefinitionRegistry | undefined,
  guardCwd: string,
): ToolDefinition {
  if (t.name === "Agent") {
    const def = agentToolDefWithTypes(agentDefinitions);
    return { ...t, description: def.description, inputSchema: def.inputSchema };
  }
  if (t.name === "GenerateImage") {
    return { ...t, description: generateImageToolDefFor(guardCwd).description };
  }
  if (t.name === "GenerateVideo") {
    return { ...t, description: generateVideoToolDefFor(guardCwd).description };
  }
  if (t.name === "UseCredential") {
    return { ...t, description: useCredentialToolDefFor(guardCwd).description };
  }
  return t;
}
