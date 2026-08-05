import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type {
  ToolContext,
  ToolDefinition,
  ToolVisibilityContext,
} from "@cjhyy/code-shell-core/extension";
import type { PetReportToMimiEvent } from "./protocol.js";
import { hasOnlyDeclaredToolArguments } from "./tool-arguments.js";

export const REPORT_TO_MIMI_TOOL_NAME = "ReportToMimi";
export const REQUEST_MIMI_DELIVERY_TOOL_NAME = "RequestMimiDelivery";

const ATTACHMENT_PATHS_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 4,
  uniqueItems: true,
  items: {
    type: "string",
    minLength: 1,
    maxLength: 4_096,
  },
  description:
    "Optional absolute local artifact paths for Mimi. The host independently decides whether any route may send them.",
};

export const reportToMimiToolDef: ToolDefinition = {
  name: REPORT_TO_MIMI_TOOL_NAME,
  description:
    "Report a result, status update, artifact, or question from the current Session to Mimi. " +
    "This works from any Session; Mimi decides how to present or act on the report. " +
    "This does not request external delivery. When the owner explicitly asks this Session to send " +
    "something to WeChat, use RequestMimiDelivery once instead. Do not search for Mimi's hidden " +
    "Session id and do not provide a channel or recipient here.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      message: {
        type: "string",
        minLength: 1,
        maxLength: 8_000,
        description:
          "Complete concise report for Mimi, including outcome, evidence, and any user decision needed.",
      },
      attachment_paths: ATTACHMENT_PATHS_SCHEMA,
    },
    required: ["message"],
  },
};

export const requestMimiDeliveryToolDef: ToolDefinition = {
  name: REQUEST_MIMI_DELIVERY_TOOL_NAME,
  description:
    "Ask Mimi's trusted host to deliver text and optional existing local artifacts through an " +
    "owner-authorized outbound channel. Use only when the user explicitly asks the current Session " +
    "to send or push something externally. For personal WeChat use channel=wechat. Call this tool " +
    "exactly once; do not search for SendMessage, target ids, or Mimi's Session id. Acceptance means " +
    "Mimi will validate and attempt the request; it is not proof that a platform or device received it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      channel: {
        type: "string",
        enum: ["wechat"],
        description: "Semantic outbound channel requested by the owner; personal WeChat is wechat.",
      },
      text: {
        type: "string",
        minLength: 1,
        maxLength: 8_000,
        description: "Exact concise message the owner asked to deliver.",
      },
      attachment_paths: ATTACHMENT_PATHS_SCHEMA,
    },
    required: ["channel", "text"],
  },
};

export type PetReportToMimiSink = (event: PetReportToMimiEvent) => void;

export function reportToMimiAvailability(ctx: ToolVisibilityContext): boolean {
  return isReportableSessionId(ctx.sessionId);
}

export function requestMimiDeliveryAvailability(ctx: ToolVisibilityContext): boolean {
  return (
    isReportableSessionId(ctx.sessionId) && ctx.isSubAgent !== true && ctx.behaviorProfile !== "pet"
  );
}

export async function reportToMimiTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
  report?: PetReportToMimiSink,
): Promise<string> {
  if (!isReportableSessionId(ctx?.sessionId)) {
    return "Error: ReportToMimi requires a valid current Session.";
  }
  if (!report) return "Error: the Mimi host reporting channel is unavailable.";
  if (!hasOnlyDeclaredToolArguments(args, ["message", "attachment_paths"])) {
    return "Error: ReportToMimi accepts only message and attachment_paths.";
  }
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message || message.length > 8_000) {
    return "Error: ReportToMimi message must be 1 to 8000 characters.";
  }
  const attachmentPaths = parseAttachmentPaths(args.attachment_paths);
  if (attachmentPaths === null) {
    return "Error: attachment_paths must contain 1 to 4 unique absolute paths.";
  }
  const reportId = createHash("sha256")
    .update(
      [ctx.sessionId, ctx.originClientMessageId ?? "", message, ...(attachmentPaths ?? [])].join(
        "\0",
      ),
    )
    .digest("hex")
    .slice(0, 32);
  report({
    reportId,
    sessionId: ctx.sessionId,
    message,
    ...(attachmentPaths ? { attachmentPaths } : {}),
    createdAt: Date.now(),
  });
  return "Report accepted by Mimi's host. Delivery is asynchronous; do not search for Mimi's Session id or claim that an IM message was delivered.";
}

export async function requestMimiDeliveryTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
  report?: PetReportToMimiSink,
): Promise<string> {
  if (!isReportableSessionId(ctx?.sessionId)) {
    return "Error: RequestMimiDelivery requires a valid current Session.";
  }
  if (!report) return "Error: the Mimi host delivery channel is unavailable.";
  if (!hasOnlyDeclaredToolArguments(args, ["channel", "text", "attachment_paths"])) {
    return "Error: RequestMimiDelivery accepts only channel, text, and attachment_paths.";
  }
  const channel = typeof args.channel === "string" ? args.channel.trim().toLowerCase() : "";
  if (channel !== "wechat") {
    return "Error: channel must be one supported semantic channel (currently: wechat).";
  }
  const message = typeof args.text === "string" ? args.text.trim() : "";
  if (!message || message.length > 8_000) {
    return "Error: RequestMimiDelivery text must be 1 to 8000 characters.";
  }
  const attachmentPaths = parseAttachmentPaths(args.attachment_paths);
  if (attachmentPaths === null) {
    return "Error: attachment_paths must contain 1 to 4 unique absolute paths.";
  }
  const reportId = createReportId(
    ctx.sessionId,
    ctx.originClientMessageId,
    message,
    attachmentPaths,
    channel,
  );
  report({
    reportId,
    sessionId: ctx.sessionId,
    message,
    ...(attachmentPaths ? { attachmentPaths } : {}),
    deliveryRequest: { channel },
    createdAt: Date.now(),
  });
  return "Delivery request accepted for Mimi host validation. Stop here: do not search for target ids, retry, or claim that the message was delivered.";
}

function createReportId(
  sessionId: string,
  originClientMessageId: string | undefined,
  message: string,
  attachmentPaths: string[] | undefined,
  channel = "",
): string {
  return createHash("sha256")
    .update(
      [sessionId, originClientMessageId ?? "", channel, message, ...(attachmentPaths ?? [])].join(
        "\0",
      ),
    )
    .digest("hex")
    .slice(0, 32);
}

function parseAttachmentPaths(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 4 ||
    !value.every(
      (path) =>
        typeof path === "string" && path.length > 0 && path.length <= 4_096 && isAbsolute(path),
    ) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return [...value] as string[];
}

function isReportableSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
