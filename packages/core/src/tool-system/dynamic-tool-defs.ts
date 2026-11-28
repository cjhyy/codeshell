import type { ToolDefinition } from "../types.js";
import type { AgentDefinitionRegistry } from "../agent/agent-definition-registry.js";
import { agentToolDefWithTypes } from "./builtin/agent.js";
import { generateImageToolDefFor } from "./builtin/generate-image.js";
import { generateVideoToolDefFor } from "./builtin/generate-video.js";
import { useCredentialToolDefFor } from "../credentials/use-credential-tool.js";
import { fullSettingsInputs } from "../settings/manager.js";
import { userCatalogPath } from "../model-catalog/index.js";
import { StampedMemo } from "../utils/file-stamp-memo.js";

// Provider descriptions re-run a full settings load plus the user model catalog
// read. Eligibility is refreshed before every tool call, so reuse the text while
// none of those files changed.
const generationDescriptions = new StampedMemo<string>(16);

function generationDescription(name: string, cwd: string, build: () => string): string {
  return generationDescriptions.get(
    `${name}\0${cwd}`,
    [...fullSettingsInputs(cwd), userCatalogPath()],
    build,
  );
}

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
 *
 * Run-scoped rewrites (e.g. DelegateWork's closed workspace enum) do NOT live
 * here — a builtin owns those via its exposure.rewriteDefinition hook, applied
 * by Engine.run() before this function.
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
    const description = generationDescription(
      t.name,
      guardCwd,
      () => generateImageToolDefFor(guardCwd).description,
    );
    return { ...t, description };
  }
  if (t.name === "GenerateVideo") {
    const description = generationDescription(
      t.name,
      guardCwd,
      () => generateVideoToolDefFor(guardCwd).description,
    );
    return { ...t, description };
  }
  if (t.name === "UseCredential") {
    return { ...t, description: useCredentialToolDefFor(guardCwd).description };
  }
  return t;
}
