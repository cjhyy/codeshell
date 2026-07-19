import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
  PetNavigationRequest,
  PetNavigationResult,
} from "./pet-state-aggregator.js";
import type { PetDispatchCommand, PetDispatchResult } from "./pet-dispatch-service.js";
import type { PetAttentionEvent, PetAttentionSnapshot } from "./pet-attention-policy.js";
import {
  type PetLongTaskControlRequest,
  type PetLongTaskControlResult,
  type PetLongTaskSnapshot,
} from "@cjhyy/code-shell-pet";
import {
  isPetWorkItemId,
  MAX_PET_WORK_INBOX_DISMISSED_ITEMS,
  type PetWorkInboxSnapshot,
} from "./pet-work-inbox-store.js";
import { randomUUID } from "node:crypto";

export const PET_SNAPSHOT_CHANNEL = "pet:get-snapshot";
export const PET_WORK_MEMORY_CHANNEL = "pet:get-work-memory";
export const PET_EVENT_CHANNEL = "pet:projection-event";
export const PET_OPEN_SESSION_CHANNEL = "pet:open-session";
export const PET_DISPATCH_CHANNEL = "pet:dispatch";
export const PET_ATTENTION_SNAPSHOT_CHANNEL = "pet:get-attention";
export const PET_ATTENTION_EVENT_CHANNEL = "pet:attention-event";
export const PET_ACTIVE_SESSION_CHANNEL = "pet:set-active-session";
export const PET_ATTENTION_RECEIPT_CHANNEL = "pet:attention-receipt";
export const PET_CHAT_EVENT_CHANNEL = "pet:chat-event";
export const PET_WORK_INBOX_SNAPSHOT_CHANNEL = "pet:work-inbox-dismissed-get";
export const PET_WORK_INBOX_UPDATE_CHANNEL = "pet:work-inbox-dismissed-update";
export const PET_WORK_INBOX_EVENT_CHANNEL = "pet:work-inbox-dismissed-changed";
export const PET_LONG_TASK_SNAPSHOT_CHANNEL = "pet:long-tasks-get";
export const PET_LONG_TASK_CONTROL_CHANNEL = "pet:long-task-control";
export const PET_LONG_TASK_EVENT_CHANNEL = "pet:long-tasks-changed";

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

export interface PetIpcWorkInbox {
  getSnapshot(): PetWorkInboxSnapshot;
  add(ids: readonly string[]): PetWorkInboxSnapshot;
  clear(): PetWorkInboxSnapshot;
}

export interface PetIpcLongTasks {
  getSnapshot(): PetLongTaskSnapshot;
  control(request: PetLongTaskControlRequest): Promise<PetLongTaskControlResult>;
  subscribe(listener: (snapshot: PetLongTaskSnapshot) => void): () => void;
}

/**
 * Read-only view of the topic-segment / work-memory state the Mimi chat UI can
 * surface. Backed by PetWorkMemoryStore. `segments` carries chat-message-keyed
 * boundaries; it is empty until the store records a segment start's message id
 * (see PetWorkMemorySegment) — the renderer skips unmatched boundaries.
 */
export interface PetIpcWorkMemory {
  getActiveSegmentId(): string | null;
  getSegments(): { boundaryBeforeMessageId: string; brief?: string }[];
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
            key !== "model" &&
            key !== "preferredProjectPath",
        ) ||
        typeof record.message !== "string" ||
        !record.message.trim() ||
        (record.clientMessageId !== undefined &&
          (typeof record.clientMessageId !== "string" || !record.clientMessageId.trim())) ||
        (record.model !== undefined &&
          (typeof record.model !== "string" ||
            !record.model.trim() ||
            record.model !== record.model.trim() ||
            record.model.length > 256 ||
            /[\u0000-\u001f\u007f]/u.test(record.model))) ||
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
        ...(typeof record.model === "string" ? { model: record.model } : {}),
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

function parseWorkInboxUpdate(
  value: unknown,
): { action: "add"; ids: string[] } | { action: "clear" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid work inbox update");
  }
  const record = value as Record<string, unknown>;
  if (record.action === "clear") {
    if (Object.keys(record).length !== 1) throw new Error("invalid work inbox update");
    return { action: "clear" };
  }
  if (
    record.action !== "add" ||
    Object.keys(record).some((key) => key !== "action" && key !== "ids") ||
    !Array.isArray(record.ids) ||
    record.ids.length > MAX_PET_WORK_INBOX_DISMISSED_ITEMS ||
    record.ids.some((id) => !isPetWorkItemId(id))
  ) {
    throw new Error("invalid work inbox update");
  }
  return { action: "add", ids: record.ids as string[] };
}

function parseLongTaskControl(value: unknown): PetLongTaskControlRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Pet long-task control");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "taskId" && key !== "action") ||
    typeof record.taskId !== "string" ||
    !/^pet-task-[a-f0-9]{24}$/u.test(record.taskId) ||
    (record.action !== "pause" &&
      record.action !== "resume" &&
      record.action !== "retry" &&
      record.action !== "cancel")
  ) {
    throw new Error("invalid Pet long-task control");
  }
  return { taskId: record.taskId, action: record.action };
}

export function registerPetIpc(options: {
  ipcMain: PetIpcMainLike;
  aggregator: PetIpcAggregator;
  windows: () => readonly PetIpcWindowLike[];
  dispatcher?: PetIpcDispatcher;
  attention?: PetIpcAttention;
  workInbox?: PetIpcWorkInbox;
  workMemory?: PetIpcWorkMemory;
  longTasks?: PetIpcLongTasks;
  /** Register handlers immediately while their backing indexes hydrate. */
  ready?: Promise<void>;
}): () => void {
  options.ipcMain.handle(PET_SNAPSHOT_CHANNEL, (_event, ...args) => {
    if (args.length > 0) throw new Error("pet:getSnapshot does not accept arguments");
    return afterReady(options.ready, () => options.aggregator.getSnapshot());
  });
  options.ipcMain.handle(PET_WORK_MEMORY_CHANNEL, (_event, ...args) => {
    if (args.length > 0) throw new Error("pet:get-work-memory does not accept arguments");
    return afterReady(options.ready, () => ({
      activeSegmentId: options.workMemory?.getActiveSegmentId() ?? null,
      segments: options.workMemory?.getSegments() ?? [],
    }));
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
        if (result.ok && result.type === "chat") {
          const delegations = result.delegations ?? (result.delegation ? [result.delegation] : []);
          if (delegations.length > 0) {
            const delegationEvent = {
              kind: "delegation-started" as const,
              originClientMessageId:
                command.clientMessageId ?? delegations[0]?.clientMessageId ?? randomUUID(),
              delegations,
              createdAt: Date.now(),
            };
            for (const window of options.windows()) {
              if (!window.isDestroyed()) {
                window.webContents.send(PET_CHAT_EVENT_CHANNEL, delegationEvent);
              }
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
  if (options.workInbox) {
    options.ipcMain.handle(PET_WORK_INBOX_SNAPSHOT_CHANNEL, (_event, ...args) => {
      if (args.length !== 0) throw new Error("work inbox snapshot does not accept arguments");
      return afterReady(options.ready, () => options.workInbox!.getSnapshot());
    });
    options.ipcMain.handle(PET_WORK_INBOX_UPDATE_CHANNEL, (_event, ...args) => {
      if (args.length !== 1) throw new Error("invalid work inbox update");
      const update = parseWorkInboxUpdate(args[0]);
      return afterReady(options.ready, () => {
        const snapshot =
          update.action === "clear"
            ? options.workInbox!.clear()
            : options.workInbox!.add(update.ids);
        for (const window of options.windows()) {
          if (!window.isDestroyed())
            window.webContents.send(PET_WORK_INBOX_EVENT_CHANNEL, snapshot);
        }
        return snapshot;
      });
    });
  }
  if (options.longTasks) {
    options.ipcMain.handle(PET_LONG_TASK_SNAPSHOT_CHANNEL, (_event, ...args) => {
      if (args.length !== 0) throw new Error("Pet long-task snapshot does not accept arguments");
      return afterReady(options.ready, () => options.longTasks!.getSnapshot());
    });
    options.ipcMain.handle(PET_LONG_TASK_CONTROL_CHANNEL, (_event, ...args) => {
      if (args.length !== 1) throw new Error("invalid Pet long-task control");
      const request = parseLongTaskControl(args[0]);
      return afterReady(options.ready, () => options.longTasks!.control(request));
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
  const unsubscribeLongTasks = options.longTasks?.subscribe((snapshot) => {
    for (const window of options.windows()) {
      if (!window.isDestroyed()) window.webContents.send(PET_LONG_TASK_EVENT_CHANNEL, snapshot);
    }
  });
  return () => {
    unsubscribe();
    unsubscribeAttention?.();
    unsubscribeLongTasks?.();
    options.ipcMain.removeHandler(PET_SNAPSHOT_CHANNEL);
    options.ipcMain.removeHandler(PET_WORK_MEMORY_CHANNEL);
    options.ipcMain.removeHandler(PET_OPEN_SESSION_CHANNEL);
    if (options.dispatcher) options.ipcMain.removeHandler(PET_DISPATCH_CHANNEL);
    if (options.attention) {
      options.ipcMain.removeHandler(PET_ATTENTION_SNAPSHOT_CHANNEL);
      options.ipcMain.removeHandler(PET_ACTIVE_SESSION_CHANNEL);
      options.ipcMain.removeHandler(PET_ATTENTION_RECEIPT_CHANNEL);
    }
    if (options.workInbox) {
      options.ipcMain.removeHandler(PET_WORK_INBOX_SNAPSHOT_CHANNEL);
      options.ipcMain.removeHandler(PET_WORK_INBOX_UPDATE_CHANNEL);
    }
    if (options.longTasks) {
      options.ipcMain.removeHandler(PET_LONG_TASK_SNAPSHOT_CHANNEL);
      options.ipcMain.removeHandler(PET_LONG_TASK_CONTROL_CHANNEL);
    }
  };
}
