import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type {
  ToolContext,
  ToolDefinition,
  ToolVisibilityContext,
} from "@cjhyy/code-shell-core/extension";
import type { PetReportToMimiEvent } from "./protocol.js";

export const REPORT_TO_MIMI_TOOL_NAME = "ReportToMimi";

export const reportToMimiToolDef: ToolDefinition = {
  name: REPORT_TO_MIMI_TOOL_NAME,
  description:
    "Report a result, status update, artifact, or question from the current Session to Mimi. " +
    "This works from any Session; Mimi decides how to present or act on the report. " +
    "Do not search for Mimi's hidden Session id and do not provide a channel or recipient.",
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
      attachment_paths: {
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
      },
    },
    required: ["message"],
  },
};

export type PetReportToMimiSink = (event: PetReportToMimiEvent) => void;

export function reportToMimiAvailability(ctx: ToolVisibilityContext): boolean {
  return isReportableSessionId(ctx.sessionId);
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
  if (Object.keys(args).some((key) => key !== "message" && key !== "attachment_paths")) {
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
