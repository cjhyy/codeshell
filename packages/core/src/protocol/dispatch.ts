/** Protocol request routing and domain-neutral ingress validation. */
import type { ExtensionQueryHandler } from "../tool-system/capability-module.js";
import type { Transport } from "./transport.js";
import { initializeResult } from "./initialize.js";
import { handleBackgroundWork, handleBackgroundWorkCancel } from "./background-work-rpc.js";
import {
  ErrorCodes,
  Methods,
  createErrorResponse,
  createResponse,
  type InputAttachmentMeta,
  type RpcRequest,
  type RunParams,
} from "./types.js";

export type ProtocolRequestHandler = (request: RpcRequest) => void | Promise<void>;

/** Session/lifecycle owners supply handlers; the dispatcher never owns an Engine. */
export interface ProtocolRequestHandlers {
  [Methods.Run]: ProtocolRequestHandler;
  [Methods.ForkSession]: ProtocolRequestHandler;
  [Methods.Approve]: ProtocolRequestHandler;
  [Methods.Cancel]: ProtocolRequestHandler;
  [Methods.Configure]: ProtocolRequestHandler;
  [Methods.Query]: ProtocolRequestHandler;
  [Methods.Inject]: ProtocolRequestHandler;
  [Methods.Steer]: ProtocolRequestHandler;
  [Methods.Unsteer]: ProtocolRequestHandler;
  [Methods.CloseSession]: ProtocolRequestHandler;
  [Methods.ReleaseWorkspace]: ProtocolRequestHandler;
  [Methods.SetWorkspace]: ProtocolRequestHandler;
  [Methods.MigrateSessionMainRoot]: ProtocolRequestHandler;
  [Methods.CompleteSessionMainRootMigration]: ProtocolRequestHandler;
  [Methods.GoalExtend]: ProtocolRequestHandler;
  [Methods.GoalUpdate]: ProtocolRequestHandler;
  [Methods.GoalDelete]: ProtocolRequestHandler;
  [Methods.GoalClear]: ProtocolRequestHandler;
  [Methods.GoalGet]: ProtocolRequestHandler;
  [Methods.BackgroundShells]: ProtocolRequestHandler;
  [Methods.PluginCommandsList]: ProtocolRequestHandler;
  [Methods.PluginCommandExpand]: ProtocolRequestHandler;
}

/** Build once per connection. Map lookup also keeps Object prototype names off the wire. */
export function createProtocolDispatcher(options: {
  transport: Pick<Transport, "send">;
  handlers: ProtocolRequestHandlers;
  extensionHandlers: ReadonlyMap<string, ExtensionQueryHandler>;
}): ProtocolRequestHandler {
  const { transport, extensionHandlers } = options;
  const routes = new Map<string, ProtocolRequestHandler>(Object.entries(options.handlers));
  routes.set(Methods.Initialize, (req) => {
    transport.send(createResponse(req.id, initializeResult()));
  });
  routes.set(Methods.BackgroundWork, (req) => handleBackgroundWork(req, transport));
  routes.set(Methods.BackgroundWorkCancel, (req) => handleBackgroundWorkCancel(req, transport));

  return (req) => {
    const handler = routes.get(req.method);
    if (handler) return handler(req);
    return dispatchExtensionRequest(req, transport, extensionHandlers);
  };
}

/** Extensions share the legacy agent/query aliases without overriding built-in controls. */
async function dispatchExtensionRequest(
  req: RpcRequest,
  transport: Pick<Transport, "send">,
  extensionHandlers: ReadonlyMap<string, ExtensionQueryHandler>,
): Promise<void> {
  const handler = extensionHandlers.get(req.method);
  if (!handler) {
    transport.send(
      createErrorResponse(req.id, ErrorCodes.MethodNotFound, `Unknown method: ${req.method}`),
    );
    return;
  }
  try {
    const data = await handler((req.params ?? {}) as Readonly<Record<string, unknown>>);
    transport.send(createResponse(req.id, data as Record<string, unknown>));
  } catch (err) {
    transport.send(createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message));
  }
}

function isValidRunAttachment(value: unknown): value is InputAttachmentMeta {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Partial<InputAttachmentMeta>;
  const hasPath = [attachment.path, attachment.relPath, attachment.absPath].some(
    (path) => typeof path === "string" && path.trim().length > 0,
  );
  return (
    typeof attachment.id === "string" &&
    attachment.id.length > 0 &&
    typeof attachment.sessionId === "string" &&
    attachment.sessionId.length > 0 &&
    (attachment.kind === "image" ||
      attachment.kind === "file" ||
      attachment.kind === "directory") &&
    hasPath
  );
}

export function runInputError(params: RunParams): string | null {
  if (typeof params.task !== "string") return "task must be a string";
  if (
    params.sandboxMode !== undefined &&
    !["off", "auto", "seatbelt", "bwrap"].includes(params.sandboxMode)
  )
    return "sandboxMode must be off, auto, seatbelt or bwrap";
  if (
    params.allowBackgroundShells !== undefined &&
    typeof params.allowBackgroundShells !== "boolean"
  )
    return "allowBackgroundShells must be boolean";
  const hasAttachment =
    Array.isArray(params.attachments) && params.attachments.some(isValidRunAttachment);
  if (params.task.trim().length === 0 && !hasAttachment) {
    return "task or a valid attachment is required";
  }
  if (
    params.displayText !== undefined &&
    (typeof params.displayText !== "string" ||
      params.displayText.trim().length === 0 ||
      params.displayText.length > 20_000)
  ) {
    return "displayText must be a non-empty string up to 20000 characters";
  }
  if (params.injected !== undefined && typeof params.injected !== "boolean") {
    return "injected must be a boolean";
  }
  if (
    params.quickChatClaimId !== undefined &&
    (typeof params.quickChatClaimId !== "string" || params.quickChatClaimId.length === 0)
  ) {
    return "quickChatClaimId must be a non-empty string";
  }
  if (params.archiveBeforeCurrentTurn !== undefined) {
    const archive = params.archiveBeforeCurrentTurn;
    if (!archive || typeof archive !== "object" || Array.isArray(archive)) {
      return "archiveBeforeCurrentTurn must be an object";
    }
    if (typeof params.clientMessageId !== "string" || params.clientMessageId.length === 0) {
      return "archiveBeforeCurrentTurn requires clientMessageId";
    }
    for (const [field, value] of [
      ["fromClientMessageId", archive.fromClientMessageId],
      ["segmentId", archive.segmentId],
    ] as const) {
      if (
        value !== undefined &&
        (typeof value !== "string" ||
          value.length === 0 ||
          value.length > 256 ||
          /[\r\n]/.test(value))
      ) {
        return `archiveBeforeCurrentTurn.${field} must be a bounded non-empty string`;
      }
    }
    if (
      archive.summary !== undefined &&
      (typeof archive.summary !== "string" ||
        archive.summary.trim().length === 0 ||
        archive.summary.length > 4_000 ||
        /[\u0000]/u.test(archive.summary))
    ) {
      return "archiveBeforeCurrentTurn.summary must be a non-empty string up to 4000 characters";
    }
  }
  if (
    params.behaviorMode !== undefined &&
    (typeof params.behaviorMode !== "string" || params.behaviorMode.length === 0)
  ) {
    return `invalid behavior mode: ${String(params.behaviorMode)}`;
  }
  if (
    params.preset !== undefined &&
    (typeof params.preset !== "string" ||
      params.preset.length === 0 ||
      params.preset.length > 128 ||
      /[\r\n]/.test(params.preset))
  ) {
    return "preset must be a bounded non-empty string";
  }
  for (const [field, value, maxItems] of [
    ["toolAllowlist", params.toolAllowlist, 32],
    ["skillAllowlist", params.skillAllowlist, 8],
  ] as const) {
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.length > maxItems ||
      value.some(
        (name) =>
          typeof name !== "string" || name.length === 0 || name.length > 128 || /[\r\n]/.test(name),
      )
    ) {
      return `${field} must be an array of at most ${maxItems} bounded names`;
    }
  }
  if (params.ephemeral !== undefined && typeof params.ephemeral !== "boolean") {
    return "ephemeral must be a boolean";
  }
  if (
    params.maxTurns !== undefined &&
    (!Number.isInteger(params.maxTurns) || params.maxTurns < 1 || params.maxTurns > 30)
  ) {
    return "maxTurns must be an integer from 1 to 30";
  }
  if (
    params.maxContextTokens !== undefined &&
    (!Number.isInteger(params.maxContextTokens) ||
      params.maxContextTokens < 4_096 ||
      params.maxContextTokens > 131_072)
  ) {
    return "maxContextTokens must be an integer from 4096 to 131072";
  }
  if (params.kind !== undefined && (typeof params.kind !== "string" || params.kind.length === 0)) {
    return `invalid session kind: ${String(params.kind)}`;
  }
  if (
    params.profileParams !== undefined &&
    (!params.profileParams ||
      typeof params.profileParams !== "object" ||
      Array.isArray(params.profileParams))
  ) {
    return "profileParams must be an object";
  }
  // Domain-specific run-param validation (e.g. behavior-mode vocabularies and
  // extension-owned param shapes) lives in AgentModule protocol.validateRunParams.
  return null;
}

export function goalExtensionInputError(params: Record<string, unknown>): string | null {
  const fields = ["addTurns", "addTokenBudget", "addTimeBudgetMs", "addStopBlocks"] as const;
  let supplied = false;
  for (const field of fields) {
    const value = params[field];
    if (value === undefined) continue;
    supplied = true;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      return `${field} must be a positive safe integer`;
    }
  }
  return supplied ? null : "at least one goal extension is required";
}
