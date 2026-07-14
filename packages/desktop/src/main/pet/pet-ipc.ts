import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
  PetNavigationRequest,
  PetNavigationResult,
} from "./pet-state-aggregator.js";
import type { PetDispatchCommand, PetDispatchResult } from "./pet-dispatch-service.js";
import type { PetAttentionEvent, PetAttentionSnapshot } from "./pet-attention-policy.js";
import { randomUUID } from "node:crypto";

export const PET_SNAPSHOT_CHANNEL = "pet:get-snapshot";
export const PET_EVENT_CHANNEL = "pet:projection-event";
export const PET_OPEN_SESSION_CHANNEL = "pet:open-session";
export const PET_DISPATCH_CHANNEL = "pet:dispatch";
export const PET_ATTENTION_SNAPSHOT_CHANNEL = "pet:get-attention";
export const PET_ATTENTION_EVENT_CHANNEL = "pet:attention-event";
export const PET_ACTIVE_SESSION_CHANNEL = "pet:set-active-session";
export const PET_ATTENTION_RECEIPT_CHANNEL = "pet:attention-receipt";
export const PET_CHAT_EVENT_CHANNEL = "pet:chat-event";

export interface PetIpcAggregator {
  getSnapshot(): DesktopPetProjectionSnapshot;
  subscribe(listener: (event: DesktopPetProjectionEvent) => void): () => void;
  resolveNavigation(request: PetNavigationRequest): Promise<PetNavigationResult>;
}

export interface PetIpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
  removeHandler(channel: string): unknown;
}

export interface PetIpcWindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}

export interface PetIpcDispatcher {
  dispatch(command: PetDispatchCommand): Promise<PetDispatchResult>;
}

export interface PetIpcAttention {
  getSnapshot(): PetAttentionSnapshot;
  subscribe(listener: (event: PetAttentionEvent) => void): () => void;
  setActiveSession(sessionId: string | null): void;
  markReceipts(keys: readonly string[], state: "seen" | "dismissed"): void;
}

function afterReady<T>(ready: Promise<void> | undefined, callback: () => T): T | Promise<T> {
  return ready ? ready.then(callback) : callback();
}

function parseNavigationRequest(value: unknown): PetNavigationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid navigation request");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "agentSessionId",
    "snapshotVersion",
    "generation",
    "requestId",
    "routeGeneration",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("invalid navigation request");
  }
  if (
    typeof record.agentSessionId !== "string" ||
    !record.agentSessionId ||
    typeof record.snapshotVersion !== "number" ||
    !Number.isSafeInteger(record.snapshotVersion) ||
    typeof record.generation !== "number" ||
    !Number.isSafeInteger(record.generation) ||
    (record.requestId !== undefined && typeof record.requestId !== "string") ||
    (record.routeGeneration !== undefined &&
      (typeof record.routeGeneration !== "number" || !Number.isSafeInteger(record.routeGeneration)))
  ) {
    throw new Error("invalid navigation request");
  }
  return record as unknown as PetNavigationRequest;
}

function parseDispatchCommand(value: unknown): PetDispatchCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid pet command");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string") throw new Error("invalid pet command");
  switch (record.type) {
    case "get_global_status":
    case "list_pending":
      if (Object.keys(record).length !== 1) throw new Error("invalid pet command");
      return { type: record.type };
    case "chat":
      if (
        Object.keys(record).some(
          (key) =>
            key !== "type" &&
            key !== "message" &&
            key !== "clientMessageId" &&
            key !== "preferredProjectPath",
        ) ||
        typeof record.message !== "string" ||
        !record.message.trim() ||
        (record.clientMessageId !== undefined &&
          (typeof record.clientMessageId !== "string" || !record.clientMessageId.trim())) ||
        (record.preferredProjectPath !== undefined &&
          (typeof record.preferredProjectPath !== "string" ||
            !record.preferredProjectPath.trim() ||
            record.preferredProjectPath.length > 4_096))
      ) {
        throw new Error("invalid pet command");
      }
      return {
        type: "chat",
        message: record.message,
        ...(typeof record.clientMessageId === "string"
          ? { clientMessageId: record.clientMessageId }
          : {}),
        ...(typeof record.preferredProjectPath === "string"
          ? { preferredProjectPath: record.preferredProjectPath }
          : {}),
      };
    case "open_session":
      if (Object.keys(record).some((key) => key !== "type" && key !== "target")) {
        throw new Error("invalid pet command");
      }
      return { type: "open_session", target: parseNavigationRequest(record.target) };
    default:
      if (Object.keys(record).length !== 1) throw new Error("invalid pet command");
      return { type: record.type } as PetDispatchCommand;
  }
}

export function registerPetIpc(options: {
  ipcMain: PetIpcMainLike;
  aggregator: PetIpcAggregator;
  windows: () => readonly PetIpcWindowLike[];
  /** The single app surface allowed to materialize a delegated Work Session. */
  delegationWindows?: () => readonly PetIpcWindowLike[];
  dispatcher?: PetIpcDispatcher;
  attention?: PetIpcAttention;
  /** Register handlers immediately while their backing indexes hydrate. */
  ready?: Promise<void>;
}): () => void {
  const emittedDelegations = new Set<string>();

  options.ipcMain.handle(PET_SNAPSHOT_CHANNEL, (_event, ...args) => {
    if (args.length > 0) throw new Error("pet:getSnapshot does not accept arguments");
    return afterReady(options.ready, () => options.aggregator.getSnapshot());
  });
  options.ipcMain.handle(PET_OPEN_SESSION_CHANNEL, (_event, ...args) => {
    if (args.length !== 1) throw new Error("invalid navigation request");
    const request = parseNavigationRequest(args[0]);
    return afterReady(options.ready, () => options.aggregator.resolveNavigation(request));
  });
  if (options.dispatcher) {
    options.ipcMain.handle(PET_DISPATCH_CHANNEL, (_event, ...args) => {
      if (args.length !== 1) throw new Error("invalid pet command");
      const parsed = parseDispatchCommand(args[0]);
      return afterReady(options.ready, async () => {
        if (parsed.type !== "chat") return options.dispatcher!.dispatch(parsed);
        const command = {
          ...parsed,
          clientMessageId: parsed.clientMessageId ?? `pet-${randomUUID()}`,
        };
        const event = {
          kind: "user-submitted" as const,
          clientMessageId: command.clientMessageId,
          message: command.message.trim(),
          createdAt: Date.now(),
        };
        for (const window of options.windows()) {
          if (!window.isDestroyed()) window.webContents.send(PET_CHAT_EVENT_CHANNEL, event);
        }
        const result = await options.dispatcher!.dispatch(command);
        if (
          result.ok &&
          result.type === "chat" &&
          result.delegation &&
          !emittedDelegations.has(result.delegation.clientMessageId)
        ) {
          emittedDelegations.add(result.delegation.clientMessageId);
          if (emittedDelegations.size > 500) {
            const oldest = emittedDelegations.values().next().value;
            if (oldest) emittedDelegations.delete(oldest);
          }
          const delegationEvent = {
            kind: "delegation-requested" as const,
            ...result.delegation,
            createdAt: Date.now(),
          };
          for (const window of (options.delegationWindows ?? options.windows)()) {
            if (!window.isDestroyed()) {
              window.webContents.send(PET_CHAT_EVENT_CHANNEL, delegationEvent);
            }
          }
        }
        return result;
      });
    });
  }
  if (options.attention) {
    options.ipcMain.handle(PET_ATTENTION_SNAPSHOT_CHANNEL, (_event, ...args) => {
      if (args.length !== 0) throw new Error("pet attention snapshot does not accept arguments");
      return afterReady(options.ready, () => options.attention!.getSnapshot());
    });
    options.ipcMain.handle(PET_ACTIVE_SESSION_CHANNEL, (_event, ...args) => {
      if (args.length !== 1 || (args[0] !== null && typeof args[0] !== "string")) {
        throw new Error("invalid active session");
      }
      const sessionId = args[0] as string | null;
      return afterReady(options.ready, () => {
        options.attention!.setActiveSession(sessionId);
        return { ok: true };
      });
    });
    options.ipcMain.handle(PET_ATTENTION_RECEIPT_CHANNEL, (_event, ...args) => {
      const payload = args[0] as { keys?: unknown; state?: unknown } | undefined;
      if (
        args.length !== 1 ||
        !payload ||
        !Array.isArray(payload.keys) ||
        payload.keys.some((key) => typeof key !== "string") ||
        (payload.state !== "seen" && payload.state !== "dismissed")
      ) {
        throw new Error("invalid attention receipt");
      }
      const keys = payload.keys as string[];
      const receiptState = payload.state as "seen" | "dismissed";
      return afterReady(options.ready, () => {
        options.attention!.markReceipts(keys, receiptState);
        return { ok: true };
      });
    });
  }
  const unsubscribe = options.aggregator.subscribe((event) => {
    for (const window of options.windows()) {
      if (!window.isDestroyed()) window.webContents.send(PET_EVENT_CHANNEL, event);
    }
  });
  const unsubscribeAttention = options.attention?.subscribe((event) => {
    for (const window of options.windows()) {
      if (!window.isDestroyed()) window.webContents.send(PET_ATTENTION_EVENT_CHANNEL, event);
    }
  });
  return () => {
    unsubscribe();
    unsubscribeAttention?.();
    options.ipcMain.removeHandler(PET_SNAPSHOT_CHANNEL);
    options.ipcMain.removeHandler(PET_OPEN_SESSION_CHANNEL);
    if (options.dispatcher) options.ipcMain.removeHandler(PET_DISPATCH_CHANNEL);
    if (options.attention) {
      options.ipcMain.removeHandler(PET_ATTENTION_SNAPSHOT_CHANNEL);
      options.ipcMain.removeHandler(PET_ACTIVE_SESSION_CHANNEL);
      options.ipcMain.removeHandler(PET_ATTENTION_RECEIPT_CHANNEL);
    }
  };
}
