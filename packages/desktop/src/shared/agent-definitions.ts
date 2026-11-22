import type { AgentDefinitionInput, AgentSummary } from "../preload/types";
import type { RendererConfigurationTarget } from "./renderer-configuration.js";

type Target = { target: RendererConfigurationTarget | null };
export interface AgentDefinitionReads {
  "agents/list": { params: Target; result: AgentSummary[] };
  "agents/body": { params: Target & { filePath: string }; result: string };
}
export interface AgentDefinitionChanges {
  "agents/save": { input: Target & { definition: AgentDefinitionInput }; result: AgentSummary };
  "agents/delete": { input: Target & { name: string }; result: void };
}
