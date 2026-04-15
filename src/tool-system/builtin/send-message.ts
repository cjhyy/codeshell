/**
 * SendMessage tool — send messages between named agents.
 */

import type { ToolDefinition } from "../../types.js";
import { agentCoordinator } from "../../agent/coordinator.js";

export const sendMessageToolDef: ToolDefinition = {
  name: "SendMessage",
  description:
    "Send a message to another named agent. The target agent must have been " +
    "spawned with a 'name' parameter via the Agent tool. " +
    "Use this for coordinating work between multiple agents.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "The name of the target agent",
      },
      content: {
        type: "string",
        description: "The message content to send",
      },
    },
    required: ["to", "content"],
  },
};

export async function sendMessageTool(args: Record<string, unknown>): Promise<string> {
  const to = args.to as string;
  const content = args.content as string;
  const from = (args.__agentName as string) ?? "main";

  if (!to) return "Error: 'to' is required";
  if (!content) return "Error: 'content' is required";

  const target = agentCoordinator.get(to);
  if (!target) {
    const active = agentCoordinator.listActive();
    const names = active.map((a) => a.name).join(", ");
    return `Error: No agent named "${to}". Active agents: ${names || "none"}`;
  }

  if (target.status !== "running") {
    return `Agent "${to}" is not running (status: ${target.status}).`;
  }

  const sent = agentCoordinator.send(from, to, content);
  if (!sent) {
    return `Failed to send message to "${to}".`;
  }

  return `Message sent to "${to}".`;
}
