import { isAbsolute } from "node:path";
import type {
  ToolContext,
  ToolDefinition,
  ToolVisibilityContext,
} from "@cjhyy/code-shell-core/extension";
import { hostActionAvailability, hostActionService } from "./host-actions.js";
import { hasOnlyDeclaredToolArguments } from "./tool-arguments.js";

const OUTBOUND_CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export const SEND_MESSAGE_TOOL_NAME = "SendMessage";

export interface PetOutboundTargetOption {
  id: string;
  channel: string;
  label: string;
  maxTextLength: number;
  attachments: readonly ("image" | "file" | "audio" | "video")[];
  maxAttachments: number;
  maxAttachmentBytes: number;
}

export const sendMessageToolDef: ToolDefinition = {
  name: SEND_MESSAGE_TOOL_NAME,
  description:
    "Proactively send text and optional existing local attachments to one host-authorized owner " +
    "destination. This is distinct " +
    "from GatewayReply, which only replies to the current inbound conversation. target_id must be " +
    "copied from the host-provided destination list; raw channel/user ids are never accepted. " +
    "Tool acceptance only records a request and is never proof of delivery. After calling it, do " +
    "not say or imply that the message was sent; the host replaces your reply with an authoritative " +
    "platform-acceptance or failure receipt, which still is not recipient-device delivery proof.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      target_id: { type: "string", minLength: 1, maxLength: 128 },
      text: { type: "string", minLength: 1, maxLength: 8_000 },
      attachment_paths: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 4_096 },
        description:
          "Optional exact absolute local paths already supplied by the user or trusted runtime context.",
      },
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
  const properties = sendMessageToolDef.inputSchema.properties as Record<string, unknown>;
  const { attachment_paths: attachmentPaths, ...textProperties } = properties;
  const attachmentTargets = targets.filter((target) => target.attachments.length > 0);
  return {
    ...def,
    description:
      `${sendMessageToolDef.description}\n\nAuthorized destinations:\n` +
      targets
        .map((target) => {
          const media = target.attachments.length
            ? `; attachments=${target.attachments.join("/")} max=${target.maxAttachments}x${target.maxAttachmentBytes}B`
            : "; text only";
          return `- ${JSON.stringify(target.id)}: ${target.label} (${target.channel}${media})`;
        })
        .join("\n"),
    inputSchema: {
      ...sendMessageToolDef.inputSchema,
      properties: {
        ...textProperties,
        target_id: {
          type: "string",
          enum: targets.map((target) => target.id),
        },
        ...(attachmentTargets.length > 0 && attachmentPaths
          ? {
              attachment_paths: {
                ...(attachmentPaths as Record<string, unknown>),
                maxItems: Math.max(...attachmentTargets.map((target) => target.maxAttachments)),
              },
            }
          : {}),
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
  if (!hasOnlyDeclaredToolArguments(args, ["target_id", "text", "attachment_paths"])) {
    return "Error: SendMessage received an unsupported argument.";
  }
  const rawTargetId = typeof args.target_id === "string" ? args.target_id : "";
  const targetId = rawTargetId.trim();
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!targetId || rawTargetId !== targetId) {
    return "Error: target_id must be one exact authorized destination id.";
  }
  const target = targets.find((candidate) => candidate.id === targetId);
  if (!target) return "Error: unknown target_id. Copy one exact authorized destination id.";
  if (!text || text.length > target.maxTextLength || OUTBOUND_CONTROL_CHARACTER_RE.test(text)) {
    return `Error: message text must be 1 to ${target.maxTextLength} characters.`;
  }
  const attachmentPaths = args.attachment_paths;
  if (
    attachmentPaths !== undefined &&
    (!Array.isArray(attachmentPaths) ||
      attachmentPaths.length < 1 ||
      attachmentPaths.length > target.maxAttachments ||
      target.attachments.length === 0 ||
      !attachmentPaths.every(
        (path) =>
          typeof path === "string" &&
          path.length <= 4_096 &&
          path === path.trim() &&
          isAbsolute(path),
      ) ||
      new Set(attachmentPaths).size !== attachmentPaths.length)
  ) {
    return target.attachments.length === 0
      ? "Error: the selected destination does not support attachments."
      : `Error: attachment_paths must contain 1 to ${target.maxAttachments} unique absolute trusted paths.`;
  }
  const decision = request({
    kind: "outboundMessage",
    payload: {
      targetId,
      text,
      ...(Array.isArray(attachmentPaths) ? { attachmentPaths } : {}),
    },
  });
  if (!decision.ok) return `Error: ${decision.error ?? "outbound message was rejected"}`;
  return "REQUEST_RECORDED_NOT_DELIVERED: End the turn without claiming success. The host will provide the authoritative platform-acceptance or failure result.";
}
