import type { ToolContext, ToolDefinition } from "@cjhyy/code-shell-core/extension";
import { hostActionAvailability, hostActionService } from "./host-actions.js";

export const MOBILE_REMOTE_TOOL_NAME = "MobileRemote";

export type PetMobileRemoteAction = "open" | "close";

/** Structured request produced only by a successful MobileRemote tool call. */
export interface PetMobileRemoteRequest {
  action: PetMobileRemoteAction;
}

export interface PetMobileRemoteDecision {
  ok: boolean;
  error?: string;
}

export const mobileRemoteToolDef: ToolDefinition = {
  name: MOBILE_REMOTE_TOOL_NAME,
  description:
    "Request the host to open or close the phone remote-control public tunnel. " +
    "Use action=open when the user asks for the mobile remote, its address, link, or QR code. " +
    "The host performs the operation after this turn and delivers the address (and a QR image " +
    "on IM channels) to the user; never invent or predict the tunnel URL yourself.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["open", "close"],
        description: "open starts the tunnel and delivers a pairing entry; close stops it.",
      },
    },
    required: ["action"],
  },
};

export const mobileRemoteAvailability = hostActionAvailability("mobileRemote");

export async function mobileRemoteTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const request = hostActionService(ctx);
  if (!request) return "Error: MobileRemote is available only in a Mimi manager turn.";
  const action = args.action;
  if (action !== "open" && action !== "close") {
    return `Error: unknown action ${JSON.stringify(action)}. Use "open" or "close".`;
  }
  const decision = request({ kind: "mobileRemote", payload: { action } });
  if (!decision.ok) return `Error: ${decision.error ?? "mobile-remote request was rejected"}`;
  return action === "open"
    ? "Mobile-remote open request accepted. The host will start the tunnel after this turn and " +
        "deliver the address and pairing entry to the user; a passcode set on the desktop is " +
        "still required. Do not state the URL yourself."
    : "Mobile-remote close request accepted. The host will stop the tunnel after this turn.";
}
