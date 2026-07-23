/**
 * Generic "host action" envelope: a Mimi tool records a validated structured
 * request during her turn, and the host executes it only after the turn ends,
 * folding the real outcome back into the reply. One convention shared by every
 * atomic CodeShell capability exposed to Mimi (mobile remote, long-task
 * control, memory, ...), so adding a capability means one tool + one host
 * executor instead of a bespoke wire per feature.
 */
import type {
  ToolContext,
  ToolDefinition,
  ToolVisibilityContext,
} from "@cjhyy/code-shell-core/extension";
import { isAbsolute } from "node:path";

export const PET_HOST_ACTION_KINDS = [
  "mobileRemote",
  "longTaskControl",
  "memory",
  "gatewayReply",
] as const;
export type PetHostActionKind = (typeof PET_HOST_ACTION_KINDS)[number];

export function isPetHostActionKind(value: unknown): value is PetHostActionKind {
  return (PET_HOST_ACTION_KINDS as readonly unknown[]).includes(value);
}

export interface PetHostActionRequest {
  kind: PetHostActionKind;
  payload: Record<string, unknown>;
}

export interface PetHostActionDecision {
  ok: boolean;
  error?: string;
}

export type PetHostActionService = (request: PetHostActionRequest) => PetHostActionDecision;

const MAX_MEMORY_TEXT_LENGTH = 2_000;
const MAX_HOST_ACTION_ID_LENGTH = 128;
const MAX_GATEWAY_REPLY_TEXT_LENGTH = 8_000;
const MAX_GATEWAY_BUTTON_TEXT_LENGTH = 80;
const MAX_GATEWAY_BUTTON_URL_LENGTH = 2_048;
const MAX_GATEWAY_ATTACHMENT_PATH_LENGTH = 4_096;
const MAX_GATEWAY_ATTACHMENTS = 4;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/u;

export type PetGatewayReplyAttachmentKind = "image" | "file" | "audio" | "video";

/** Trusted per-route limits used to rewrite and execute the GatewayReply tool. */
export interface PetGatewayReplyCapability {
  button: "native" | "link";
  attachments: readonly PetGatewayReplyAttachmentKind[];
  maxTextLength: number;
  maxAttachments: number;
  maxAttachmentBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_HOST_ACTION_ID_LENGTH &&
    value === value.trim() &&
    !CONTROL_CHARACTER_RE.test(value)
  );
}

function isGatewayAttachmentPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    value.length > 0 &&
    value.length <= MAX_GATEWAY_ATTACHMENT_PATH_LENGTH &&
    value === value.trim() &&
    !CONTROL_CHARACTER_RE.test(value)
  );
}

function isGatewayButton(value: unknown): value is { text: string; url: string } {
  if (!isRecord(value) || !hasExactKeys(value, ["text", "url"])) return false;
  if (
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > MAX_GATEWAY_BUTTON_TEXT_LENGTH ||
    CONTROL_CHARACTER_RE.test(value.text) ||
    typeof value.url !== "string" ||
    value.url.length > MAX_GATEWAY_BUTTON_URL_LENGTH ||
    value.url !== value.url.trim() ||
    CONTROL_CHARACTER_RE.test(value.url)
  ) {
    return false;
  }
  try {
    const url = new URL(value.url);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isGatewayReplyPayload(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (
    keys.length < 1 ||
    keys.some((key) => key !== "text" && key !== "button" && key !== "attachmentPaths") ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > MAX_GATEWAY_REPLY_TEXT_LENGTH ||
    CONTROL_CHARACTER_RE.test(value.text.replaceAll("\n", "").replaceAll("\t", "")) ||
    (value.button !== undefined && !isGatewayButton(value.button))
  ) {
    return false;
  }
  if (value.attachmentPaths === undefined) return true;
  return (
    Array.isArray(value.attachmentPaths) &&
    value.attachmentPaths.length > 0 &&
    value.attachmentPaths.length <= MAX_GATEWAY_ATTACHMENTS &&
    value.attachmentPaths.every(isGatewayAttachmentPath) &&
    new Set(value.attachmentPaths).size === value.attachmentPaths.length
  );
}

/**
 * Validate the full worker-to-host envelope, including each kind's payload.
 * Tool input schemas are not a trust boundary: the worker response still
 * crosses a process boundary and must fail closed before a host side effect.
 */
export function isPetHostActionRequest(value: unknown): value is PetHostActionRequest {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "payload"])) return false;
  if (!isPetHostActionKind(value.kind) || !isRecord(value.payload)) return false;
  const payload = value.payload;
  if (value.kind === "mobileRemote") {
    return (
      hasExactKeys(payload, ["action"]) && (payload.action === "open" || payload.action === "close")
    );
  }
  if (value.kind === "longTaskControl") {
    return (
      hasExactKeys(payload, ["taskId", "action"]) &&
      isOpaqueId(payload.taskId) &&
      (LONG_TASK_ACTIONS as readonly unknown[]).includes(payload.action)
    );
  }
  if (value.kind === "gatewayReply") return isGatewayReplyPayload(payload);
  if (payload.action === "remember") {
    return (
      hasExactKeys(payload, ["action", "text"]) &&
      typeof payload.text === "string" &&
      payload.text.trim().length > 0 &&
      payload.text.length <= MAX_MEMORY_TEXT_LENGTH
    );
  }
  if (payload.action === "update") {
    return (
      hasExactKeys(payload, ["action", "memoryId", "text"]) &&
      isOpaqueId(payload.memoryId) &&
      typeof payload.text === "string" &&
      payload.text.trim().length > 0 &&
      payload.text.length <= MAX_MEMORY_TEXT_LENGTH
    );
  }
  return (
    payload.action === "forget" &&
    hasExactKeys(payload, ["action", "memoryId"]) &&
    isOpaqueId(payload.memoryId)
  );
}

export function hostActionAvailability(kind: PetHostActionKind) {
  return (ctx: ToolVisibilityContext): boolean => {
    const kinds = ctx.profileMeta?.petHostActionKinds;
    return ctx.behaviorProfile === "pet" && Array.isArray(kinds) && kinds.includes(kind);
  };
}

export function hostActionService(ctx?: ToolContext): PetHostActionService | undefined {
  const services = ctx?.runScopedServices as
    | { requestPetHostAction?: PetHostActionService }
    | undefined;
  return typeof services?.requestPetHostAction === "function"
    ? services.requestPetHostAction
    : undefined;
}

// ---------------------------------------------------------------------------
// GatewayReply
// ---------------------------------------------------------------------------

export const GATEWAY_REPLY_TOOL_NAME = "GatewayReply";

export const gatewayReplyToolDef: ToolDefinition = {
  name: GATEWAY_REPLY_TOOL_NAME,
  description:
    "Deliver the current reply through the originating Chat Gateway route. This is the only tool " +
    "that owns IM reply text, optional URL buttons, and optional existing local image/file/audio/video " +
    "attachments. The host and Gateway validate the exact route capability after the turn. " +
    "Use only attachment paths supplied by the user or trusted runtime context; never invent one. " +
    "Tool acceptance is pending, not delivery, so do not repeat the reply in assistant text or " +
    "claim that it was sent.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: {
        type: "string",
        minLength: 1,
        maxLength: MAX_GATEWAY_REPLY_TEXT_LENGTH,
        description: "The complete user-facing reply to deliver to the current IM conversation.",
      },
      button: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", minLength: 1, maxLength: MAX_GATEWAY_BUTTON_TEXT_LENGTH },
          url: {
            type: "string",
            minLength: 1,
            maxLength: MAX_GATEWAY_BUTTON_URL_LENGTH,
            description: "An absolute http(s) URL.",
          },
        },
        required: ["text", "url"],
      },
      attachment_paths: {
        type: "array",
        minItems: 1,
        maxItems: MAX_GATEWAY_ATTACHMENTS,
        uniqueItems: true,
        items: {
          type: "string",
          minLength: 1,
          maxLength: MAX_GATEWAY_ATTACHMENT_PATH_LENGTH,
          description: "Exact absolute local path from trusted context or the user's message.",
        },
      },
    },
    required: ["text"],
  },
};

export const gatewayReplyAvailability = hostActionAvailability("gatewayReply");

function gatewayReplyCapability(ctx?: ToolContext): PetGatewayReplyCapability | undefined {
  const services = ctx?.runScopedServices as
    | { petGatewayReply?: PetGatewayReplyCapability }
    | undefined;
  return services?.petGatewayReply;
}

function gatewayReplyCapabilityFromVisibility(
  ctx: ToolVisibilityContext,
): PetGatewayReplyCapability | undefined {
  const value = ctx.profileMeta?.petGatewayReply;
  if (!isRecord(value)) return undefined;
  return value as unknown as PetGatewayReplyCapability;
}

export function rewriteGatewayReplyDef(
  def: ToolDefinition,
  ctx: ToolVisibilityContext,
): ToolDefinition {
  const capability = gatewayReplyCapabilityFromVisibility(ctx);
  if (!capability) return def;
  const properties = gatewayReplyToolDef.inputSchema.properties as Record<string, unknown>;
  const { attachment_paths: attachmentPaths, ...textAndButton } = properties;
  const textProperty = textAndButton.text as Record<string, unknown>;
  const attachmentDescription = capability.attachments.length
    ? ` This route also accepts ${capability.attachments.join("/")} attachments (maximum ${capability.maxAttachments}, ${capability.maxAttachmentBytes} bytes each).`
    : " This route does not accept outgoing attachments.";
  return {
    ...def,
    description:
      `${gatewayReplyToolDef.description} The button is rendered as a ${capability.button === "native" ? "native channel button" : "labelled text link"}.` +
      attachmentDescription,
    inputSchema: {
      ...gatewayReplyToolDef.inputSchema,
      properties: {
        ...textAndButton,
        text: { ...textProperty, maxLength: capability.maxTextLength },
        ...(capability.attachments.length > 0 && attachmentPaths
          ? {
              attachment_paths: {
                ...(attachmentPaths as Record<string, unknown>),
                maxItems: capability.maxAttachments,
              },
            }
          : {}),
      },
    },
  };
}

export async function gatewayReplyTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const request = hostActionService(ctx);
  const capability = gatewayReplyCapability(ctx);
  if (!request || !capability) {
    return "Error: GatewayReply is available only in a Mimi turn originating from Chat Gateway.";
  }
  const text = typeof args.text === "string" ? args.text.trim() : "";
  const button = args.button;
  const attachmentPaths = args.attachment_paths;
  const payload: Record<string, unknown> = {
    text,
    ...(button === undefined ? {} : { button }),
    ...(attachmentPaths === undefined ? {} : { attachmentPaths }),
  };
  if (!isGatewayReplyPayload(payload)) {
    return "Error: GatewayReply requires bounded text, an optional valid http(s) button, and optional unique absolute attachment_paths.";
  }
  if (text.length > capability.maxTextLength) {
    return `Error: the current Gateway route accepts at most ${capability.maxTextLength} text characters.`;
  }
  if (Array.isArray(attachmentPaths)) {
    if (capability.attachments.length === 0) {
      return "Error: the current Gateway route cannot send attachments.";
    }
    if (attachmentPaths.length > capability.maxAttachments) {
      return `Error: the current Gateway route accepts at most ${capability.maxAttachments} attachments.`;
    }
  }
  const decision = request({ kind: "gatewayReply", payload });
  if (!decision.ok) return `Error: ${decision.error ?? "Gateway reply was rejected"}`;
  return (
    "ACCEPTED EXACTLY ONCE — NOT SENT YET. The Gateway reply was recorded for host validation " +
    "after this turn. End the turn now with only a short internal acknowledgement; do not call " +
    "GatewayReply again, repeat the user-facing reply, or claim sent, attached, or delivered."
  );
}

// ---------------------------------------------------------------------------
// ControlLongTask
// ---------------------------------------------------------------------------

export const CONTROL_LONG_TASK_TOOL_NAME = "ControlLongTask";

const LONG_TASK_ACTIONS = ["pause", "resume", "retry", "cancel"] as const;

export const controlLongTaskToolDef: ToolDefinition = {
  name: CONTROL_LONG_TASK_TOOL_NAME,
  description:
    "Request the host to pause, resume, retry, or cancel one long-running task from the " +
    "longTasks ledger in the runtime context. task_id must be copied exactly from that ledger. " +
    "The host performs the operation after this turn and appends the real outcome to your " +
    "reply; acceptance is not success.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      task_id: {
        type: "string",
        description: "Exact taskId from the longTasks ledger in the runtime context.",
      },
      action: {
        type: "string",
        enum: [...LONG_TASK_ACTIONS],
        description: "Lifecycle operation the host should apply to the task.",
      },
    },
    required: ["task_id", "action"],
  },
};

export const controlLongTaskAvailability = hostActionAvailability("longTaskControl");

export async function controlLongTaskTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const request = hostActionService(ctx);
  if (!request) return "Error: ControlLongTask is available only in a Mimi manager turn.";
  const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
  const action = args.action;
  if (!taskId) return "Error: task_id is required; copy it exactly from the longTasks ledger.";
  if (!(LONG_TASK_ACTIONS as readonly unknown[]).includes(action)) {
    return `Error: unknown action ${JSON.stringify(action)}. Use ${LONG_TASK_ACTIONS.map((entry) =>
      JSON.stringify(entry),
    ).join(", ")}.`;
  }
  const decision = request({ kind: "longTaskControl", payload: { taskId, action } });
  if (!decision.ok) return `Error: ${decision.error ?? "long-task control was rejected"}`;
  return (
    `Long-task ${String(action)} request accepted. The host will apply it after this turn and ` +
    "append the real outcome to your reply; do not claim the task state changed yet."
  );
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const MEMORY_TOOL_NAME = "Memory";

const MEMORY_ACTIONS = ["remember", "update", "forget"] as const;

export const memoryToolDef: ToolDefinition = {
  name: MEMORY_TOOL_NAME,
  description:
    "Maintain Mimi's durable memory of the user: stable preferences, facts, and standing " +
    "instructions worth keeping across conversations. The newest bounded memory window appears " +
    "in runtime context with ids; memoryWindow reports whether older entries are omitted. " +
    "remember adds a new entry; update rewrites one visible existing entry by " +
    "memory_id; forget removes one entry by memory_id. Never store secrets, passwords, or " +
    "one-off conversational details. Do not invent an id for an omitted older entry; ask the user " +
    "to manage it in Memory settings. The host applies the change after this turn.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: [...MEMORY_ACTIONS],
        description: "remember adds; update rewrites by memory_id; forget removes by memory_id.",
      },
      memory_id: {
        type: "string",
        description:
          "Exact id from the visible memories window in runtime context (update/forget).",
      },
      text: {
        type: "string",
        description:
          "Full replacement text of the memory, at most 2000 characters (remember/update).",
      },
    },
    required: ["action"],
  },
};

export const memoryAvailability = hostActionAvailability("memory");

export async function memoryTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const request = hostActionService(ctx);
  if (!request) return "Error: Memory is available only in a Mimi manager turn.";
  const action = args.action;
  if (!(MEMORY_ACTIONS as readonly unknown[]).includes(action)) {
    return `Error: unknown action ${JSON.stringify(action)}. Use ${MEMORY_ACTIONS.map((entry) =>
      JSON.stringify(entry),
    ).join(", ")}.`;
  }
  const memoryId = typeof args.memory_id === "string" ? args.memory_id.trim() : "";
  const text = typeof args.text === "string" ? args.text.replace(/\s+/gu, " ").trim() : "";
  if ((action === "remember" || action === "update") && !text) {
    return "Error: text is required for remember/update.";
  }
  if (text.length > MAX_MEMORY_TEXT_LENGTH) {
    return `Error: text is too long (maximum ${MAX_MEMORY_TEXT_LENGTH} characters).`;
  }
  if ((action === "update" || action === "forget") && !memoryId) {
    return "Error: memory_id is required for update/forget; copy it from the memories list.";
  }
  const payload: Record<string, unknown> = {
    action,
    ...(action === "update" || action === "forget" ? { memoryId } : {}),
    ...(action === "remember" || action === "update" ? { text } : {}),
  };
  const decision = request({ kind: "memory", payload });
  if (!decision.ok) return `Error: ${decision.error ?? "memory change was rejected"}`;
  return (
    "Memory change request accepted. The host will apply it after this turn; " +
    "do not claim it is stored until the host confirms."
  );
}
