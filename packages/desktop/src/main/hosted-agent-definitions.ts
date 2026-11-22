import type { AgentDefinitionChanges, AgentDefinitionReads } from "../shared/agent-definitions.js";
import { claimBusinessCommit } from "../host/composition/business-calls.js";
import { deleteAgent, listAgents, readAgentBody, saveAgent } from "./agents-service.js";
import {
  rendererOptionalConfigurationCwd,
  rendererConfigurationCwd,
  requireRendererListedAgentPath,
} from "./renderer-configuration-helpers.js";

export async function readAgentDefinitions(
  method: keyof AgentDefinitionReads,
  input: AgentDefinitionReads[keyof AgentDefinitionReads]["params"],
) {
  if (method === "agents/list")
    return listAgents(await rendererOptionalConfigurationCwd(input.target, ""));
  if (!("filePath" in input)) throw Error("Agent file path required");
  return readAgentBody(await requireRendererListedAgentPath(input.target, input.filePath));
}

export interface AgentDefinitionWork {
  input: AgentDefinitionChanges[keyof AgentDefinitionChanges]["input"];
  permit: Int32Array;
}
export async function changeAgentDefinition(
  method: keyof AgentDefinitionChanges,
  { input, permit }: AgentDefinitionWork,
) {
  if (Atomics.load(permit, 0) !== 0) throw Error("Document write was revoked");
  const target = input.target;
  const cwd = target === null ? undefined : await rendererConfigurationCwd(target);
  const options = { scope: target === null ? ("user" as const) : ("project" as const), cwd };
  const commit = async () => {
    if (target && (await rendererConfigurationCwd(target)) !== cwd)
      throw Error("Agent definition project root changed");
    claimBusinessCommit(permit);
  };
  if (method === "agents/save" && "definition" in input)
    return { result: await saveAgent(input.definition, options, commit) };
  if (method === "agents/delete" && "name" in input)
    return { result: await deleteAgent(input.name, options, commit) };
  throw Error("Invalid agent definition change");
}
