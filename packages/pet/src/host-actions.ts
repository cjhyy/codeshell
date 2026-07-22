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

export const PET_HOST_ACTION_KINDS = [
  "mobileRemote",
  "longTaskControl",
  "memory",
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
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/u;

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
  }  if (payload.action === "remember") {
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
    "instructions worth keeping across conversations. Stored memories appear in the runtime " +
    "context with their ids. remember adds a new entry; update rewrites one existing entry by " +
    "memory_id; forget removes one entry by memory_id. Never store secrets, passwords, or " +
    "one-off conversational details. The host applies the change after this turn.",
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
        description: "Exact id from the memories list in the runtime context (update/forget).",
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
