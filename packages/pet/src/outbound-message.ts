import type {
  ToolContext,
  ToolDefinition,
  ToolVisibilityContext,
} from "@cjhyy/code-shell-core/extension";
import { hostActionAvailability, hostActionService } from "./host-actions.js";

export const SEND_MESSAGE_TOOL_NAME = "SendMessage";

export interface PetOutboundTargetOption {
  id: string;
  channel: string;
  label: string;
  maxTextLength: number;
}

export const sendMessageToolDef: ToolDefinition = {
  name: SEND_MESSAGE_TOOL_NAME,
  description:
    "Proactively send a text message to one host-authorized owner destination. This is distinct " +
    "from GatewayReply, which only replies to the current inbound conversation. target_id must be " +
    "copied from the host-provided destination list; raw channel/user ids are never accepted.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      target_id: { type: "string", minLength: 1, maxLength: 128 },
      text: { type: "string", minLength: 1, maxLength: 8_000 },
    },
    required: ["target_id", "text"],
  },
};

function targetsFromVisibility(ctx: ToolVisibilityContext): readonly PetOutboundTargetOption[] {
  const targets = ctx.profileMeta?.petOutboundTargets;
  return Array.isArray(targets) ? (targets as readonly PetOutboundTargetOption[]) : [];
}

function targetsFromContext(ctx?: ToolContext): readonly PetOutboundTargetOption[] {
  const targets = (
    ctx?.runScopedServices as
      | { petOutboundTargets?: readonly PetOutboundTargetOption[] }
      | undefined
  )?.petOutboundTargets;
  return Array.isArray(targets) ? targets : [];
}

export function sendMessageAvailability(ctx: ToolVisibilityContext): boolean {
  return hostActionAvailability("outboundMessage")(ctx) && targetsFromVisibility(ctx).length > 0;
}

export function rewriteSendMessageDef(
  def: ToolDefinition,
  ctx: ToolVisibilityContext,
): ToolDefinition {
  const targets = targetsFromVisibility(ctx);
  return {
    ...def,
    description:
      `${sendMessageToolDef.description}\n\nAuthorized destinations:\n` +
      targets
        .map((target) => `- ${JSON.stringify(target.id)}: ${target.label} (${target.channel})`)
        .join("\n"),
    inputSchema: {
      ...sendMessageToolDef.inputSchema,
      properties: {
        ...(sendMessageToolDef.inputSchema.properties as Record<string, unknown>),
        target_id: {
          type: "string",
          enum: targets.map((target) => target.id),
        },
      },
    },
  };
}

export async function sendMessageTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const request = hostActionService(ctx);
  const targets = targetsFromContext(ctx);
  if (!request || targets.length === 0) {
    return "Error: SendMessage is available only with host-authorized owner destinations.";
  }
  const targetId = typeof args.target_id === "string" ? args.target_id.trim() : "";
  const text = typeof args.text === "string" ? args.text.trim() : "";
  const target = targets.find((candidate) => candidate.id === targetId);
  if (!target) return "Error: unknown target_id. Copy one exact authorized destination id.";
  if (!text || text.length > target.maxTextLength) {
    return `Error: message text must be 1 to ${target.maxTextLength} characters.`;
  }
  const decision = request({
    kind: "outboundMessage",
    payload: { targetId, text },
  });
  if (!decision.ok) return `Error: ${decision.error ?? "outbound message was rejected"}`;
  return "Message request accepted. The host will append the real delivery result after this turn.";
}
