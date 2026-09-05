import type { ToolDefinition } from "../../types.js";
import type { SessionMessageTarget } from "../../session/session-message.js";
import type { ToolContext, ToolVisibilityContext } from "../context.js";

export const SEND_MESSAGE_TO_SESSION_TOOL_NAME = "SendMessageToSession";

export const sendMessageToSessionToolDef: ToolDefinition = {
  name: SEND_MESSAGE_TO_SESSION_TOOL_NAME,
  description:
    "Send a message to another host-authorized Session in the current project. " +
    "Use this exactly like a person sending a message in that Session: the message becomes the target Session's next user turn and queues or starts its work. " +
    "The result reports whether this turn is queued, started, or already completed. " +
    "For queued or started turns, that turn's answer or failure is returned to this Session automatically; do not poll by sending the task again. " +
    "When you have later additions, call this tool again with another message. This does not subscribe to unrelated future target turns.",
  inputSchema: {
    type: "object",
    properties: {
      target_session_id: {
        type: "string",
        description: "One target Session id from the host-authorized closed list.",
      },
      message: {
        type: "string",
        minLength: 1,
        maxLength: 48_000,
        description:
          "The complete message to send as the target Session's user turn: task, relevant context, constraints, and artifact paths.",
      },
    },
    required: ["target_session_id", "message"],
  },
};

export function rewriteSendMessageToSessionToolDefinition(
  def: ToolDefinition,
  ctx: ToolVisibilityContext,
): ToolDefinition {
  const targets = ctx.sessionMessageTargets ?? [];
  return {
    ...def,
    description: `${def.description}\n\nAvailable target Sessions:\n${targets
      .map((target) => formatTarget(target))
      .join("\n")}`,
    inputSchema: {
      ...def.inputSchema,
      properties: {
        ...((def.inputSchema.properties as Record<string, unknown> | undefined) ?? {}),
        target_session_id: {
          type: "string",
          enum: targets.map((target) => target.sessionId),
          description: "Select exactly one host-authorized target Session listed below.",
        },
      },
    },
  };
}

export async function sendMessageToSessionTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const service = ctx?.sessionMessages;
  if (!service) return "Error: cross-Session messaging is not available in this run.";
  const targetSessionId =
    typeof args.target_session_id === "string" ? args.target_session_id.trim() : "";
  const message = typeof args.message === "string" ? args.message : "";
  if (!targetSessionId) return "Error: target_session_id is required.";
  if (!message.trim()) return "Error: message is required.";
  if (message.length > 48_000) return "Error: message exceeds 48000 characters.";
  try {
    const target = await service.send({
      targetSessionId,
      message,
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });
    const receipt = target.receipt;
    const label = `"${target.title}" (${target.sessionId})`;
    if (!receipt) {
      // Compatibility with custom hosts that implement the original router.
      return `Message accepted by ${label}. This host did not provide execution status or automatic reply delivery.`;
    }
    if (receipt.status === "completed") {
      return `Message ${receipt.messageId} completed in ${label}.\n\n${receipt.result?.text ?? ""}`;
    }
    const status = receipt.status === "started" ? "started" : "queued (not yet confirmed started)";
    return `Message ${receipt.messageId} accepted by ${label}; status: ${status}. This turn's answer or failure will be returned to this Session automatically.`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function formatTarget(target: SessionMessageTarget): string {
  const profile = target.workspaceProfile ? `; digital human: ${target.workspaceProfile}` : "";
  return `- ${target.sessionId}: ${target.title}${profile}`;
}
