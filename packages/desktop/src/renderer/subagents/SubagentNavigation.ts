import { createContext, useContext } from "react";
import type { AgentMessage, ToolMessage } from "../types";
import { parsedArgs } from "../tool-cards/utils";

export type SubagentSummary = Pick<AgentMessage, "id" | "description" | "done">;

export interface SubagentSelection {
  agentId?: string;
  parentSessionId?: string | null;
  label?: string;
  running?: boolean;
}

export const SubagentNavigationContext = createContext<{
  sessionId?: string | null;
  agents: readonly SubagentSummary[];
  onView: (selection: SubagentSelection) => void;
} | null>(null);

export function useSubagentNavigation() {
  return useContext(SubagentNavigationContext);
}

/** Background launch results and follow-up tools carry the child's persisted ID.
 * Foreground launches also have an agent_start card; use it only when the task
 * description identifies a single child, otherwise let the user select one. */
export function subagentIdForTool(
  message: ToolMessage,
  agents: readonly SubagentSummary[] = [],
): string | undefined {
  const args = parsedArgs(message);
  if (typeof args.agent_id === "string" && args.agent_id.trim()) return args.agent_id.trim();
  const resultId = message.result?.match(/^agent_id:\s*([A-Za-z0-9_-]+)\b/m)?.[1];
  if (resultId) return resultId;
  if (typeof args.description !== "string") return undefined;
  const matches = agents.filter((agent) => agent.description === args.description);
  return matches.length === 1 ? matches[0].id : undefined;
}
